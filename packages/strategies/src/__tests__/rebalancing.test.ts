import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { clOrdId } from "../core/ids";
import type { StrategyEvent } from "../core/types";
import {
  currentWeights,
  initialBuyProgress,
  nextScheduled,
  REBAL_PENDING_TIMEOUT_MS,
  rebalancing,
  type RebalancingState,
} from "../rebalancing";
import { rebalancingSchema } from "../rebalancing/schema";
import { runSim, type SimOptions } from "../sim/exchange";

const rules = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "1" };
const ctx = {
  botId: "bot-rebal",
  version: 1,
  feeRate: "0",
  rules: { vBTC_vUSDC: rules, vETH_vUSDC: rules },
};
const fees = { makerFee: "0", takerFee: "0" };
const base = rebalancingSchema.parse({
  quoteAsset: "USDC",
  assets: [
    { asset: "BTC", market: "vBTC_vUSDC", weightPct: "50" },
    { asset: "ETH", market: "vETH_vUSDC", weightPct: "30" },
    { asset: "USDC", weightPct: "20" },
  ],
  rebalanceWhen: "threshold",
  thresholdPct: "5",
  investment: "1000",
  maxTradePct: "100",
});
const t = (at: number, market: string, price: number) => ({ at, market, price: String(price) });
const timers = (at: number) =>
  at % 1000 === 0 && at > 1000 ? [{ type: "timer" as const, at }] : [];
/**
 * Sổ lệnh giả cho test: ask = giá / 1,003 và bid = giá / 0,997, để giá lệnh IOC (ask × 1,003 / bid × 0,997) đúng bằng giá
 * gần nhất như các test trước khi đặt lệnh theo sổ lệnh; test riêng bên dưới kiểm cách tính giá theo ask / bid.
 */
const book = (p: string) => ({
  bid: (Math.floor((Number(p) / 0.997) * 1e8) / 1e8).toFixed(8),
  ask: (Math.ceil((Number(p) / 1.003) * 1e8) / 1e8).toFixed(8),
  bidNotional: "1000000",
  askNotional: "1000000",
});
/** Timer mang sổ lệnh của cả hai market (giá BTC 100, ETH 10 trừ khi truyền khác). */
const bookTimer = (at: number, btc = "100", eth = "10") =>
  ({
    type: "timer",
    at,
    books: { vBTC_vUSDC: book(btc), vETH_vUSDC: book(eth) },
  }) as const;
/**
 * runSim kèm sổ lệnh: mỗi tick gửi thêm một timer mang đỉnh sổ lệnh (bid = ask = giá gần nhất) của mọi market đã có giá,
 * như engine gửi mỗi 60 s. Lệnh IOC đặt ở ask × 1,003 (mua) / bid × 0,997 (bán).
 */
function sim(
  config: typeof base,
  ticks: { at: number; market: string; price: string }[],
  options: SimOptions = fees,
  extra: (at: number) => StrategyEvent[] = () => [],
) {
  const prices: Record<string, string> = {};
  const sorted = [...ticks].sort((a, b) => a.at - b.at);
  return runSim(rebalancing, config, ctx, ticks, options, (at) => {
    for (const k of sorted) if (k.at <= at) prices[k.market] = k.price;
    const books = Object.fromEntries(Object.entries(prices).map(([m, p]) => [m, book(p)]));
    const ev = extra(at);
    // Đã có timer ở thời điểm này thì gắn sổ lệnh vào nó (không thêm một nhịp rebalance thứ hai).
    if (ev.some((x) => x.type === "timer"))
      return ev.map((x) => (x.type === "timer" ? { ...x, books } : x));
    return [...ev, { type: "timer", at, books }];
  });
}

describe("rebalancing", () => {
  it("allocates to target weights once every price is known", () => {
    const r = sim(base, [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)], fees);
    expect(r.state.holdings).toEqual({ BTC: "5", ETH: "30" });
    expect(Number(r.state.cash)).toBeCloseTo(200, 10);
    const w = currentWeights(base, r.state);
    expect(w.BTC?.toNumber()).toBeCloseTo(50, 10);
  });

  it("rebalances when a weight drifts past the threshold, selling the winner first", () => {
    const r = sim(
      base,
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10), t(2000, "vBTC_vUSDC", 150)],
      fees,
      timers,
    );
    // BTC 750, ETH 300, USDC 200 → BTC 60% (> 5% drift)
    const sells = r.exchange.fills.filter((f) => f.side === "sell");
    expect(sells[0]?.tag).toBe("rebal:BTC");
    expect(r.state.rebalances).toBe(1);
    expect(currentWeights(base, r.state).BTC?.toNumber()).toBeCloseTo(50, 1);
  });

  it("caps each rebalance at the max trade size", () => {
    const r = sim(
      { ...base, maxTradePct: "1" },
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10), t(2000, "vBTC_vUSDC", 150)],
      fees,
      timers,
    );
    const traded = r.exchange.fills
      .slice(2)
      .reduce((s, f) => s + Number(f.price) * Number(f.quantity), 0);
    expect(traded).toBeLessThanOrEqual(12.5 + 1e-9);
  });

  it("stops below the floor and on take profit, keeping assets", () => {
    const low = sim(
      { ...base, stopBelow: "900" },
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10), t(2, "vBTC_vUSDC", 70)],
      fees,
    );
    expect(low.halted).toEqual({ type: "stop", reason: ReasonCode.stopLoss, close: false });
    const tp = sim(
      { ...base, takeProfitPct: "10" },
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10), t(2, "vBTC_vUSDC", 125)],
      fees,
    );
    expect(tp.halted).toEqual({ type: "stop", reason: ReasonCode.takeProfit, close: false });
  });

  it("pauses when an order is rejected", () => {
    const r = sim(base, [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)], {
      ...fees,
      rejectTags: (o) => o.tag === "rebal:ETH",
    });
    expect(r.halted).toEqual({ type: "pause", reason: ReasonCode.orderRejected });
  });

  it("requires weights to add up to 100%", () => {
    const r = rebalancingSchema.safeParse({ ...base, assets: base.assets.slice(0, 2) });
    expect(r.success ? [] : r.error.issues.map((i) => i.message)).toContain(
      "Weights must add up to 100%.",
    );
  });
});

describe("rebalancing schedule (DEC-67)", () => {
  const sched = (schedule: "daily" | "weekly" | "monthly") =>
    rebalancingSchema.parse({
      ...base,
      rebalanceWhen: "schedule",
      thresholdPct: undefined,
      schedule,
      timeZone: "Asia/Ho_Chi_Minh",
    });
  // Thứ Tư 2026-10-28 10:00 giờ Việt Nam (03:00 UTC).
  const last = Date.UTC(2026, 9, 28, 3, 0);
  it("runs at 00:00 in the user's time zone", () => {
    expect(new Date(nextScheduled(sched("daily"), last)).toISOString()).toBe(
      "2026-10-28T17:00:00.000Z",
    );
    // Weekly: thứ Hai kế tiếp.
    expect(new Date(nextScheduled(sched("weekly"), last)).toISOString()).toBe(
      "2026-11-01T17:00:00.000Z",
    );
    // Monthly: ngày 1 tháng sau.
    expect(new Date(nextScheduled(sched("monthly"), last)).toISOString()).toBe(
      "2026-10-31T17:00:00.000Z",
    );
  });
  it("keeps every-N-hours for configs without a schedule (DEC-36)", () => {
    const c = rebalancingSchema.parse({ ...base, rebalanceWhen: "schedule", scheduleHours: 6 });
    expect(nextScheduled(c, last)).toBe(last + 6 * 3_600_000);
  });
  it("requires a threshold only in threshold mode", () => {
    expect(rebalancingSchema.safeParse({ ...base, thresholdPct: undefined }).success).toBe(false);
    expect(
      rebalancingSchema.safeParse({ ...base, rebalanceWhen: "schedule", thresholdPct: undefined })
        .success,
    ).toBe(true);
  });
});

describe("rebalancing Initial buy (IMP-04, DEC-222)", () => {
  const H = 3_600_000;
  const over = rebalancingSchema.parse({ ...base, initialBuy: "over_hours", initialBuyHours: 4 });
  const id = (tag: string) => clOrdId(ctx.botId, ctx.version, tag);
  const ids = (r: { actions: { type: string; order?: { clOrdID: string } }[] }) =>
    r.actions.flatMap((a) => (a.type === "place" && a.order ? [a.order.clOrdID] : []));

  it("requires the number of hours for Over N hours", () => {
    const r = rebalancingSchema.safeParse({ ...base, initialBuy: "over_hours" });
    expect(r.success).toBe(false);
    expect(
      rebalancingSchema.safeParse({ ...base, initialBuy: "over_hours", initialBuyHours: 1 })
        .success,
    ).toBe(false);
  });

  it("All now and old configs keep the original first allocation and clOrdIDs", () => {
    const allNow = rebalancingSchema.parse({ ...base, initialBuy: "all_now" });
    for (const c of [base, allNow]) {
      let s = rebalancing.step(c, rebalancing.initialState(c), bookTimer(0), ctx).state;
      s = rebalancing.step(
        c,
        s,
        { type: "tick", at: 0, market: "vBTC_vUSDC", price: "100" },
        ctx,
      ).state;
      const r = rebalancing.step(
        c,
        s,
        { type: "tick", at: 1, market: "vETH_vUSDC", price: "10" },
        ctx,
      );
      expect(ids(r).sort()).toEqual([id("rebal:1:BTC"), id("rebal:1:ETH")].sort());
      expect(r.state.round).toBe(1);
      expect(r.actions.some((a) => a.type === "log" && a.decision === "Initial allocation")).toBe(
        true,
      );
    }
  });

  it("buys in equal hourly parts, then rebalances as usual", () => {
    const r = sim(over, [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)], fees);
    // Phần 1 của 4: BTC 125 USDC, ETH 75 USDC.
    expect(r.state.holdings).toEqual({ BTC: "1.25", ETH: "7.5" });
    expect(r.state.building).toEqual({ startedAt: 1, part: 1 });

    let s = r.state;
    const early = rebalancing.step(over, s, { type: "timer", at: 1 + H - 1 }, ctx);
    expect(early.actions).toEqual([]);
    for (let k = 2; k <= 4; k += 1) {
      const step = rebalancing.step(over, s, bookTimer(1 + (k - 1) * H), ctx);
      expect(ids(step).sort()).toEqual(
        [id(`rebal:init:${String(k)}:BTC`), id(`rebal:init:${String(k)}:ETH`)].sort(),
      );
      s = step.state;
      for (const a of step.actions) {
        if (a.type !== "place") continue;
        s = rebalancing.step(
          over,
          s,
          {
            type: "fill",
            clOrdID: a.order.clOrdID,
            price: a.order.price ?? "0",
            quantity: a.order.quantity,
            fee: "0",
            at: 1 + (k - 1) * H,
          },
          ctx,
        ).state;
      }
    }
    expect(s.holdings).toEqual({ BTC: "5", ETH: "30" });
    expect(s.building).toBeNull();
    expect(s.round).toBe(1);
    expect(s.rebalances).toBe(0);
    // Sau khi mua xong, lệch ngưỡng thì rebalance với clOrdID như bot All now.
    s = rebalancing.step(
      over,
      s,
      { type: "tick", at: 5 * H, market: "vBTC_vUSDC", price: "150" },
      ctx,
    ).state;
    const next = rebalancing.step(over, s, bookTimer(5 * H + 1), ctx);
    expect(ids(next)).toContain(id("rebal:2:BTC"));
  });

  it("reports Initial buy progress for Trading Agent only while buying in parts", () => {
    const r = sim(over, [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)], fees);
    expect(initialBuyProgress(over, r.state)).toEqual({ done: 1, total: 4 });
    expect(initialBuyProgress(over, { building: null })).toBeNull();
    expect(initialBuyProgress(over, {})).toBeNull();
    // All now và config cũ không có tiến độ.
    expect(initialBuyProgress(base, { building: { startedAt: 1, part: 1 } })).toBeNull();
  });

  it("an old running state without `building` keeps rebalancing", () => {
    const r = sim(base, [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)], fees);
    // State cũ (trước IMP-04) không có `building`.
    const old = Object.fromEntries(
      Object.entries(r.state).filter(([k]) => k !== "building"),
    ) as typeof r.state;
    const s = rebalancing.step(
      base,
      old,
      { type: "tick", at: 2, market: "vBTC_vUSDC", price: "150" },
      ctx,
    ).state;
    const next = rebalancing.step(base, s, { type: "timer", at: 3 }, ctx);
    expect(ids(next).length).toBeGreaterThan(0);
  });
});

describe("rebalancing — orders that end part-filled (P0.1)", () => {
  const step = (st: RebalancingState, e: Parameters<typeof rebalancing.step>[2]) =>
    rebalancing.step(base, st, e, ctx);
  /** Có đủ giá: đặt lô Initial allocation (BTC 5 @ 100, ETH 30 @ 10). */
  const allocated = () => {
    let st = step(rebalancing.initialState(base), bookTimer(0)).state;
    st = step(st, { type: "tick", at: 0, market: "vBTC_vUSDC", price: "100" }).state;
    const r = step(st, { type: "tick", at: 1, market: "vETH_vUSDC", price: "10" });
    const ids = Object.keys(r.state.pending);
    const btc = ids.find((id) => r.state.pending[id]?.asset === "BTC") ?? "";
    const eth = ids.find((id) => r.state.pending[id]?.asset === "ETH") ?? "";
    return { st: r.state, btc, eth };
  };
  const fill = (id: string, price: string, q: string, at: number) =>
    ({ type: "fill", at, clOrdID: id, price, quantity: q, fee: "0" }) as const;

  it("adds up several fills, ends a part-filled order on orderDone and rebalances again later", () => {
    const { st, btc, eth } = allocated();
    let s1 = step(st, fill(btc, "100", "2", 2)).state;
    s1 = step(s1, fill(btc, "100", "1", 3)).state;
    expect(s1.pending[btc]?.filled).toBe("3");
    s1 = step(s1, { type: "orderDone", at: 4, clOrdID: btc }).state;
    s1 = step(s1, fill(eth, "10", "30", 5)).state;
    expect(s1.pending).toEqual({});
    expect(s1.holdings).toEqual({ BTC: "3", ETH: "30" });
    // Không còn lệnh chờ: lần kiểm tra kế tiếp thấy BTC lệch và mua thêm.
    const next = step(s1, { type: "timer", at: 10_000 });
    expect(next.actions.some((a) => a.type === "place")).toBe(true);
  });

  it("does not get stuck when an order does not fill at all", () => {
    const { st, btc, eth } = allocated();
    let s1 = step(st, { type: "orderDone", at: 2, clOrdID: btc }).state;
    s1 = step(s1, { type: "orderDone", at: 3, clOrdID: eth }).state;
    expect(s1.pending).toEqual({});
    expect(step(s1, { type: "timer", at: 10_000 }).actions.some((a) => a.type === "place")).toBe(
      true,
    );
  });

  it("books a fill that arrives after orderDone, up to the order size", () => {
    const { st, btc } = allocated();
    const d = step(st, { type: "orderDone", at: 2, clOrdID: btc }).state;
    const late = step(d, fill(btc, "100", "5", 3)).state;
    expect(late.holdings.BTC).toBe("5");
    expect(step(late, fill(btc, "100", "1", 4)).state.holdings.BTC).toBe("5");
  });

  it("treats orders with no orderDone for 60 s as ended", () => {
    const { st, btc } = allocated();
    const a = step(st, fill(btc, "100", "1", 2)).state;
    const early = step(a, { type: "timer", at: 1 + REBAL_PENDING_TIMEOUT_MS - 1 }).state;
    expect(Object.keys(early.pending)).toHaveLength(2);
    const late = step(early, { type: "timer", at: 1 + REBAL_PENDING_TIMEOUT_MS }).state;
    expect(late.pending).toEqual({});
    expect(late.holdings.BTC).toBe("1");
  });
});

describe("rebalancing — IOC at ask / bid and waiting for the order book", () => {
  const step = (st: RebalancingState, e: Parameters<typeof rebalancing.step>[2], c = base) =>
    rebalancing.step(c, st, e, ctx);
  const realBooks = (at: number) =>
    ({
      type: "timer",
      at,
      books: {
        vBTC_vUSDC: { bid: "99.9", ask: "100.1", bidNotional: "1", askNotional: "1" },
        vETH_vUSDC: { bid: "9.99", ask: "10.01", bidNotional: "1", askNotional: "1" },
      },
    }) as const;
  const prices = (st: RebalancingState) => {
    let s1 = step(st, { type: "tick", at: 0, market: "vBTC_vUSDC", price: "100" }).state;
    s1 = step(s1, { type: "tick", at: 1, market: "vETH_vUSDC", price: "10" }).state;
    return s1;
  };

  it("does not start without an order book, then buys at ask + 0.3% once it arrives", () => {
    const waiting = prices(rebalancing.initialState(base));
    expect(waiting.phase).toBe("waiting_prices");
    const r = step(waiting, realBooks(2));
    const orders = r.actions.flatMap((a) => (a.type === "place" ? [a.order] : []));
    // 100.1 × 1.003 = 100.4003 → 100.40 (làm tròn xuống); 10.01 × 1.003 = 10.04003 → 10.04.
    expect(orders.map((o) => [o.tag, o.price]).sort()).toEqual([
      ["rebal:BTC", "100.4"],
      ["rebal:ETH", "10.04"],
    ]);
    expect(r.state.phase).toBe("running");
  });

  it("sells at bid − 0.3% when rebalancing", () => {
    let st = step(rebalancing.initialState(base), realBooks(0)).state;
    st = prices(st);
    for (const [id, o] of Object.entries(st.pending))
      st = step(st, {
        type: "fill",
        at: 3,
        clOrdID: id,
        price: o.asset === "BTC" ? "100" : "10",
        quantity: o.qty ?? "0",
        fee: "0",
      }).state;
    st = step(st, { type: "tick", at: 4, market: "vBTC_vUSDC", price: "150" }).state;
    const r = step(st, realBooks(10_000));
    const sell = r.actions
      .flatMap((a) => (a.type === "place" ? [a.order] : []))
      .find((o) => o.side === "sell");
    // 99.9 × 0.997 = 99.6003 → 99.61 (làm tròn lên).
    expect(sell?.price).toBe("99.61");
  });

  it("waits instead of using the last price when the order book is stale", () => {
    let st = step(rebalancing.initialState(base), realBooks(0)).state;
    st = prices(st);
    st = { ...st, pending: {} };
    const late = step(st, { type: "timer", at: 1_000_000 });
    expect(late.actions).toEqual([]);
  });

  it("says how much of the first allocation it bought when Max trade per rebalance caps it", () => {
    const capped = rebalancingSchema.parse({ ...base, maxTradePct: "25" });
    let st = step(rebalancing.initialState(capped), realBooks(0), capped).state;
    st = step(st, { type: "tick", at: 0, market: "vBTC_vUSDC", price: "100" }, capped).state;
    const r = step(st, { type: "tick", at: 1, market: "vETH_vUSDC", price: "10" }, capped);
    // Cần mua 800 (BTC 500 + ETH 300), trần 250 → 31%.
    expect(r.actions).toContainEqual({
      type: "log",
      decision: "Initial allocation",
      why: "Bought 31% of the target allocation; the rest follows in the next rebalances.",
    });
  });
});
