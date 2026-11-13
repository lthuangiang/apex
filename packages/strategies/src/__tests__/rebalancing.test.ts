import { ReasonCode } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { clOrdId } from "../core/ids";
import { currentWeights, initialBuyProgress, nextScheduled, rebalancing } from "../rebalancing";
import { rebalancingSchema } from "../rebalancing/schema";
import { runSim } from "../sim/exchange";

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

describe("rebalancing", () => {
  it("allocates to target weights once every price is known", () => {
    const r = runSim(
      rebalancing,
      base,
      ctx,
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)],
      fees,
    );
    expect(r.state.holdings).toEqual({ BTC: "5", ETH: "30" });
    expect(Number(r.state.cash)).toBeCloseTo(200, 10);
    const w = currentWeights(base, r.state);
    expect(w.BTC?.toNumber()).toBeCloseTo(50, 10);
  });

  it("rebalances when a weight drifts past the threshold, selling the winner first", () => {
    const r = runSim(
      rebalancing,
      base,
      ctx,
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
    const r = runSim(
      rebalancing,
      { ...base, maxTradePct: "1" },
      ctx,
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
    const low = runSim(
      rebalancing,
      { ...base, stopBelow: "900" },
      ctx,
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10), t(2, "vBTC_vUSDC", 70)],
      fees,
    );
    expect(low.halted).toEqual({ type: "stop", reason: ReasonCode.stopLoss, close: false });
    const tp = runSim(
      rebalancing,
      { ...base, takeProfitPct: "10" },
      ctx,
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10), t(2, "vBTC_vUSDC", 125)],
      fees,
    );
    expect(tp.halted).toEqual({ type: "stop", reason: ReasonCode.takeProfit, close: false });
  });

  it("pauses when an order is rejected", () => {
    const r = runSim(rebalancing, base, ctx, [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)], {
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
      let s = rebalancing.initialState(c);
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
    const r = runSim(
      rebalancing,
      over,
      ctx,
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)],
      fees,
    );
    // Phần 1 của 4: BTC 125 USDC, ETH 75 USDC.
    expect(r.state.holdings).toEqual({ BTC: "1.25", ETH: "7.5" });
    expect(r.state.building).toEqual({ startedAt: 1, part: 1 });

    let s = r.state;
    const early = rebalancing.step(over, s, { type: "timer", at: 1 + H - 1 }, ctx);
    expect(early.actions).toEqual([]);
    for (let k = 2; k <= 4; k += 1) {
      const step = rebalancing.step(over, s, { type: "timer", at: 1 + (k - 1) * H }, ctx);
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
    const next = rebalancing.step(over, s, { type: "timer", at: 5 * H + 1 }, ctx);
    expect(ids(next)).toContain(id("rebal:2:BTC"));
  });

  it("reports Initial buy progress for Trading Agent only while buying in parts", () => {
    const r = runSim(
      rebalancing,
      over,
      ctx,
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)],
      fees,
    );
    expect(initialBuyProgress(over, r.state)).toEqual({ done: 1, total: 4 });
    expect(initialBuyProgress(over, { building: null })).toBeNull();
    expect(initialBuyProgress(over, {})).toBeNull();
    // All now và config cũ không có tiến độ.
    expect(initialBuyProgress(base, { building: { startedAt: 1, part: 1 } })).toBeNull();
  });

  it("an old running state without `building` keeps rebalancing", () => {
    const r = runSim(
      rebalancing,
      base,
      ctx,
      [t(0, "vBTC_vUSDC", 100), t(1, "vETH_vUSDC", 10)],
      fees,
    );
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
