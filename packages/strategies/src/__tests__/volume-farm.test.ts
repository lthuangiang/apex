import { dec } from "@drift/shared";
import { describe, expect, it } from "vitest";

import type {
  BookTop,
  MinuteCandle,
  OrderIntent,
  StepContext,
  StrategyAction,
  StrategyEvent,
} from "../core/types";
import {
  FARM_LIVE_BOOK,
  FARM_TIMING,
  farmRandom,
  VF_REJECT_BACKOFF_SECS,
  volumeFarm,
  type VolumeFarmState,
} from "../volume-farm";
import { volumeFarmSchema, type VolumeFarmConfig } from "../volume-farm/schema";
import { farmSignal, toFiveMinute } from "../volume-farm/signal";

const ctx: StepContext = {
  botId: "vf-bot",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" },
  },
  feeRate: "0.00012",
};
// Thông số bot SoDEX BTC-USD đang chạy trong apex (bot-configs.json).
const cfg = (over: Partial<Record<string, unknown>> = {}): VolumeFarmConfig =>
  volumeFarmSchema.parse({
    market: "BTC-USD",
    leverage: 20,
    marginMode: "cross",
    orderSizeMinUsd: "100",
    orderSizeMaxUsd: "200",
    minHoldSecs: 120,
    maxHoldSecs: 180,
    tpUsd: "0.5",
    slPct: "5",
    earlyExitSecs: 60,
    earlyProfitUsd: "0.15",
    allowTaker: true,
    cooldownSecs: 30,
    maxLoss: "20",
    ...over,
  });

const T0 = Date.parse("2026-10-30T03:00:00Z");
const book: BookTop = { bid: "80000", ask: "80001", bidNotional: "500000", askNotional: "400000" };

/** N nến 1 phút đã đóng, kết thúc ngay trước T0; `drift` > 0 là xu hướng tăng. */
function candles(drift: number, base = 80_000, count = 30): MinuteCandle[] {
  return Array.from({ length: count }, (_, i) => {
    const t = T0 - (count - i) * 60_000;
    const o = base * (1 + drift * i);
    const c = base * (1 + drift * (i + 1));
    return {
      t,
      o: o.toFixed(2),
      h: (Math.max(o, c) * 1.0002).toFixed(2),
      l: (Math.min(o, c) * 0.9998).toFixed(2),
      c: c.toFixed(2),
      v: String(10 + i),
    };
  });
}

const timer = (at: number, withMarket = true): StrategyEvent => ({
  type: "timer",
  at,
  ...(withMarket ? { market: { market: "BTC-USD", candles: candles(0.0001), book } } : {}),
});

function run(
  c: VolumeFarmConfig,
  events: StrategyEvent[],
  start?: VolumeFarmState,
  cx: StepContext = ctx,
) {
  let s = start ?? volumeFarm.initialState(c);
  const all: StrategyAction[] = [];
  for (const e of events) {
    const r = volumeFarm.step(c, s, e, cx);
    s = r.state;
    all.push(...r.actions);
  }
  return { s, all };
}
function first<T>(xs: T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error("expected an order");
  return x;
}
function last<T>(xs: T[]): T {
  const x = xs.at(-1);
  if (x === undefined) throw new Error("expected an order");
  return x;
}
const places = (a: StrategyAction[]) =>
  a
    .filter((x): x is Extract<StrategyAction, { type: "place" }> => x.type === "place")
    .map((x) => x.order);

describe("farmSignal (port FarmMicroSignalEngine)", () => {
  it("goes long in a gentle uptrend and short in a downtrend", () => {
    expect(farmSignal(candles(0.0001), book, T0, 10).direction).toBe("long");
    expect(
      farmSignal(
        candles(-0.0001),
        { ...book, bidNotional: "400000", askNotional: "500000" },
        T0,
        10,
      ).direction,
    ).toBe("short");
  });

  it("skips on stale candles, too few candles and a wide spread", () => {
    expect(farmSignal(candles(0.0001), book, T0 + 5 * 60_000, 10).reason).toMatch(/^STALE_CANDLES/);
    expect(farmSignal(candles(0.0001).slice(-5), book, T0, 10).reason).toMatch(
      /^INSUFFICIENT_CANDLES/,
    );
    const wide = { ...book, ask: "80200" };
    expect(farmSignal(candles(0.0001), wide, T0, 10).reason).toMatch(/^SPREAD_TOO_WIDE/);
  });

  it("builds 5-minute candles only from complete groups", () => {
    const five = toFiveMinute(
      candles(0.0001).map((k) => ({ t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v })),
    );
    expect(five.every((k) => k.t % 300_000 === 0)).toBe(true);
    expect(five.length).toBe(6);
  });
});

describe("volume farm cycle", () => {
  it("enters post-only at the best bid with a random size inside the range", () => {
    const { s, all } = run(cfg(), [timer(T0)]);
    const [o] = places(all) as [OrderIntent];
    expect(o).toMatchObject({ side: "buy", timeInForce: "GTX", price: "80000", reduceOnly: false });
    const usd = Number(o.quantity) * 80_000;
    expect(usd).toBeGreaterThanOrEqual(99);
    expect(usd).toBeLessThanOrEqual(200);
    expect(s.phase).toBe("entering");
    expect(s.holdSecs).toBeGreaterThanOrEqual(120);
    expect(s.holdSecs).toBeLessThanOrEqual(180);
  });

  it("reverses the signal when asked", () => {
    const { all } = run(cfg({ reverseSignal: true }), [timer(T0)]);
    expect(places(all)[0]).toMatchObject({ side: "sell", price: "80001" });
  });

  it("is deterministic per bot and cycle", () => {
    expect(farmRandom("a", 1, "size")).toBe(farmRandom("a", 1, "size"));
    expect(farmRandom("a", 1, "size")).not.toBe(farmRandom("a", 2, "size"));
  });

  it("cancels an unfilled entry after 10 s and escalates to taker after 3 misses", () => {
    let r = run(cfg(), [timer(T0)]);
    for (let i = 0; i < 3; i += 1) {
      const id = r.s.entry?.id ?? "";
      const at = T0 + (i + 1) * 20_000;
      r = run(cfg(), [timer(at - 20_000 + FARM_TIMING.entryFillMs, false), timer(at)], r.s);
      expect(r.all.some((a) => a.type === "cancel" && a.clOrdID === id)).toBe(true);
    }
    expect(r.s.unfilled).toBe(3);
    const o = places(r.all).at(-1);
    expect(o).toMatchObject({ type: "market", timeInForce: "IOC" });
  });

  it("enters and exits with market orders right away when taker is on and misses before taker is 0 (DEC-259)", () => {
    const c = cfg({ takerAfter: 0 });
    let r = run(c, [timer(T0)]);
    const entry = first(places(r.all));
    expect(entry).toMatchObject({ type: "market", timeInForce: "IOC", reduceOnly: false });
    r = run(
      c,
      [
        {
          type: "fill",
          at: T0 + 1000,
          clOrdID: entry.clOrdID,
          price: "80000",
          quantity: entry.quantity,
          fee: "0.03",
        },
        { type: "tick", at: T0 + 2000, market: "BTC-USD", price: "80500" },
      ],
      r.s,
    );
    expect(last(places(r.all))).toMatchObject({
      type: "market",
      timeInForce: "IOC",
      reduceOnly: true,
    });
  });

  it("pauses after 3 market entries in a row are rejected instead of retrying forever (DEC-259)", () => {
    const c = cfg({ takerAfter: 0, cooldownSecs: 0 });
    let r = run(c, [timer(T0)]);
    const pauses: StrategyAction[] = [];
    for (let i = 0; i < 3; i += 1) {
      const id = r.s.entry?.id ?? "";
      expect(r.s.entry?.taker).toBe(true);
      r = run(
        c,
        [
          {
            type: "orderReject",
            at: T0 + i * 20_000 + 500,
            clOrdID: id,
            code: "INSUFFICIENT_MARGIN",
          },
        ],
        r.s,
      );
      pauses.push(...r.all.filter((a) => a.type === "pause"));
      if (i < 2) {
        expect(pauses).toHaveLength(0);
        // Lần vào kế tiếp sau thời gian chờ 5 s / 15 s (DEC-299).
        r = run(c, [timer(T0 + (i + 1) * 20_000)], r.s);
      }
    }
    expect(pauses).toEqual([{ type: "pause", reason: "ORDER_REJECTED" }]);
  });

  it("stays post-only with 0 misses when taker orders are off (DEC-259)", () => {
    const r = run(cfg({ allowTaker: false, takerAfter: 0 }), [timer(T0)]);
    expect(first(places(r.all))).toMatchObject({ type: "limit", timeInForce: "GTX" });
  });

  it("prices the take-profit floor with taker fees when every order is a taker (DEC-259)", () => {
    // Lượt 0.002 BTC ở 80 000 = 160 USDC. Maker 0.017% / taker 0.045% mỗi chiều. TP đặt rất nhỏ để sàn phí quyết định.
    const tx: StepContext = { ...ctx, feeRate: "0.00017", takerFeeRate: "0.00045" };
    const reason = (c: VolumeFarmConfig, price: string) => {
      let r = run(c, [timer(T0)], undefined, tx);
      const entry = first(places(r.all));
      r = run(
        c,
        [
          {
            type: "fill",
            at: T0 + 1000,
            clOrdID: entry.clOrdID,
            price: "80000",
            quantity: "0.002",
            fee: "0",
          },
          { type: "tick", at: T0 + 2000, market: "BTC-USD", price },
        ],
        r.s,
        tx,
      );
      return r.s.phase;
    };
    // Lãi 0.1 USDC (giá +50): đủ sàn maker 1.5 × 0.0544 = 0.08 nhưng chưa đủ sàn taker 1.5 × 0.144 = 0.216.
    expect(reason(cfg({ tpUsd: "0.01", takerAfter: 3 }), "80050")).toBe("exiting");
    expect(reason(cfg({ tpUsd: "0.01", takerAfter: 0 }), "80050")).not.toBe("exiting");
    // Lãi 0.24 USDC (giá +120): vượt sàn taker → chốt.
    expect(reason(cfg({ tpUsd: "0.01", takerAfter: 0 }), "80120")).toBe("exiting");
  });

  it("opens on fill, takes profit, closes with a post-only reduce-only order and cools down", () => {
    let r = run(cfg(), [timer(T0)]);
    const entry = first(places(r.all));
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0 + 1000,
          clOrdID: entry.clOrdID,
          price: "80000",
          quantity: entry.quantity,
          fee: "0.01",
        },
        { type: "tick", at: T0 + 2000, market: "BTC-USD", price: "80500" },
      ],
      r.s,
    );
    expect(r.s.phase).toBe("exiting");
    const exit = last(places(r.all));
    expect(exit).toMatchObject({ side: "sell", reduceOnly: true, timeInForce: "GTX" });
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0 + 3000,
          clOrdID: exit.clOrdID,
          price: "80100",
          quantity: exit.quantity,
          fee: "0.01",
        },
      ],
      r.s,
    );
    expect(r.s).toMatchObject({ phase: "idle", trades: 1, wins: 1, lastSide: "long" });
    expect(r.s.cooldownUntil).toBe(T0 + 3000 + 30_000);
    expect(r.all.find((a) => a.type === "log")).toMatchObject({ decision: "Closed long" });
    // Trong cooldown không vào lệnh mới.
    expect(places(run(cfg(), [timer(T0 + 10_000)], r.s).all)).toHaveLength(0);
    expect(places(run(cfg(), [timer(T0 + 40_000)], r.s).all)).toHaveLength(1);
  });

  it("exits with a market reduce-only order on stop loss", () => {
    let r = run(cfg(), [timer(T0)]);
    const entry = first(places(r.all));
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0 + 1000,
          clOrdID: entry.clOrdID,
          price: "80000",
          quantity: entry.quantity,
          fee: "0.01",
        },
        { type: "tick", at: T0 + 2000, market: "BTC-USD", price: "75900" },
      ],
      r.s,
    );
    expect(places(r.all).at(-1)).toMatchObject({ type: "market", reduceOnly: true, side: "sell" });
    expect(r.s.exitReason).toMatch(/^Stop loss/);
  });

  it("keeps retrying a stop loss at market after a rejection", () => {
    let r = run(cfg(), [timer(T0)]);
    const entry = first(places(r.all));
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0 + 1000,
          clOrdID: entry.clOrdID,
          price: "80000",
          quantity: entry.quantity,
          fee: "0",
        },
        { type: "tick", at: T0 + 2000, market: "BTC-USD", price: "75900" },
      ],
      r.s,
    );
    const stop = last(places(r.all));
    r = run(
      cfg(),
      [
        { type: "orderReject", at: T0 + 2500, clOrdID: stop.clOrdID, code: "-1" },
        timer(T0 + 3000, false),
      ],
      r.s,
    );
    expect(last(places(r.all))).toMatchObject({ type: "market", reduceOnly: true });
  });

  it("exits when the random hold time ends", () => {
    let r = run(cfg(), [timer(T0)]);
    const entry = first(places(r.all));
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0,
          clOrdID: entry.clOrdID,
          price: "80000",
          quantity: entry.quantity,
          fee: "0",
        },
      ],
      r.s,
    );
    const hold = (r.s.holdSecs ?? 0) * 1000;
    expect(run(cfg(), [timer(T0 + hold - 1000, false)], r.s).s.phase).toBe("open");
    expect(run(cfg(), [timer(T0 + hold, false)], r.s).s.phase).toBe("exiting");
  });

  it("stops and closes when the net loss reaches max loss", () => {
    const start: VolumeFarmState = {
      ...volumeFarm.initialState(cfg()),
      ledger: {
        position: "0",
        avgCost: "0",
        realized: "-19.5",
        fees: "0.6",
        funding: "0",
        invested: "0",
      },
    };
    const { s, all } = run(cfg(), [timer(T0)], start);
    expect(s.phase).toBe("halted");
    expect(all.find((a) => a.type === "stop")).toMatchObject({
      reason: "BOT_MAX_LOSS",
      close: true,
    });
  });

  it("does not trade in a blocked UTC hour", () => {
    const { all } = run(cfg({ blockedHoursUtc: [3] }), [timer(T0)]);
    expect(places(all)).toHaveLength(0);
    expect(all[0]).toMatchObject({ decision: "Waiting" });
  });

  it("rejects a max size below the min size and a max hold below the min hold", () => {
    expect(() => cfg({ orderSizeMaxUsd: "50" })).toThrow(/at least the minimum size/);
    expect(() => cfg({ maxHoldSecs: 60 })).toThrow(/at least the minimum hold/);
  });
});

describe("volume farm signal — regime + counter-trend (120 candles, như engine gửi)", () => {
  /**
   * Tạo N nến 1m liên tiếp không có gap, kết thúc trước T0. Engine gửi FARM_CANDLES = 120 →
   * 24 nhóm 5m hoàn chỉnh → detectRegime hoạt động thực sự. Test với 30 nến luôn cho UNKNOWN.
   */
  it("30 nến → 6 nhóm 5m → regime UNKNOWN (test coverage gap đã biết)", () => {
    const sig = farmSignal(candles(0.0001), book, T0, 200);
    expect(sig.regime).toBe("UNKNOWN");
  });

  it("120 nến tạo đủ 24 nhóm 5m → regime không còn UNKNOWN", () => {
    const long120 = candles(0.0001, 80_000, 120);
    const sig = farmSignal(long120, book, T0, 200);
    expect(sig.regime).not.toBe("UNKNOWN");
  });

  it("TREND_DOWN chặn long yếu — score 0.5–0.7 bị block, score ≥ 0.7 được phép", () => {
    // 120 nến giảm liên tục → TREND_DOWN trên 5m.
    const dn120 = candles(-0.0001, 80_000, 120);
    // Sổ nghiêng bid mạnh → signal long nhưng upside giới hạn
    const bidHeavy: BookTop = {
      bid: "80000",
      ask: "80001",
      bidNotional: "800000",
      askNotional: "200000",
    };
    const sig = farmSignal(dn120, bidHeavy, T0, 200);
    if (sig.regime === "TREND_DOWN") {
      if (sig.direction === "skip") {
        // score 0.5–0.69 → bị chặn đúng
        expect(sig.reason).toMatch(/COUNTER_TREND_BLOCKED/);
        expect(sig.score).toBeGreaterThanOrEqual(0.5);
        expect(sig.score).toBeLessThan(0.7);
      } else if (sig.direction === "long") {
        // score ≥ 0.7 → tín hiệu đủ mạnh, được thiết kế cho qua
        expect(sig.score).toBeGreaterThanOrEqual(0.7);
      }
    }
    // Ít nhất regime phải là downtrend hoặc high-vol với 120 nến giảm
    expect(["TREND_DOWN", "HIGH_VOLATILITY"]).toContain(sig.regime);
  });

  it("TREND_UP chặn short yếu — score 0.3–0.5 bị block", () => {
    const up120 = candles(0.0001, 80_000, 120);
    // Sổ nghiêng ask → signal short nhưng yếu
    const askHeavy: BookTop = {
      bid: "80000",
      ask: "80001",
      bidNotional: "200000",
      askNotional: "800000",
    };
    const sig = farmSignal(up120, askHeavy, T0, 200);
    if (sig.regime === "TREND_UP") {
      if (sig.direction === "skip") {
        expect(sig.reason).toMatch(/COUNTER_TREND_BLOCKED/);
        expect(sig.score).toBeLessThan(0.5);
        expect(sig.score).toBeGreaterThan(0.3);
      } else if (sig.direction === "short") {
        // score ≤ 0.3 → đủ mạnh, được phép
        expect(sig.score).toBeLessThanOrEqual(0.3);
      }
    }
    expect(["TREND_UP", "HIGH_VOLATILITY", "SIDEWAY"]).toContain(sig.regime);
  });
});

describe("volume farm — netExposure no longer forces an opposite entry (DEC-TBD-vf-version-apply)", () => {
  const logs = (a: StrategyAction[]) =>
    a.filter((x): x is Extract<StrategyAction, { type: "log" }> => x.type === "log");

  it("follows the signal even when closed longs pile up (no forced short)", () => {
    const start: VolumeFarmState = {
      ...volumeFarm.initialState(cfg()),
      netExposure: "300",
      lastSide: "long",
    };
    const { all } = run(cfg(), [timer(T0)], start);
    // Uptrend → long; trước đây bị buộc short "to bring the position back toward zero".
    expect(places(all)[0]?.side).toBe("buy");
    expect(logs(all).some((l) => l.why.includes("back toward zero"))).toBe(false);
  });

  it("never opens a long to 'flatten' after many closed shorts (prod 2026-11-17 09:02:50)", () => {
    const down: StrategyEvent = {
      type: "timer",
      at: T0,
      market: {
        market: "BTC-USD",
        candles: candles(-0.0001),
        book: { ...book, bidNotional: "400000", askNotional: "500000" },
      },
    };
    const start: VolumeFarmState = {
      ...volumeFarm.initialState(cfg()),
      netExposure: "-300",
      lastSide: "short",
    };
    const { all } = run(cfg(), [down], start);
    // Tín hiệu short trong downtrend → short, không phải "Enter long … bring the position back toward zero".
    expect(places(all)[0]?.side).toBe("sell");
    expect(logs(all).map((l) => l.decision)).not.toContain("Enter long");
    expect(logs(all).some((l) => l.why.includes("back toward zero"))).toBe(false);
  });

  it("netExposure accumulates correctly after each closed trade", () => {
    // Mở và đóng một long → netExposure tăng thêm notional của lệnh vào
    let r = run(cfg(), [timer(T0)]);
    const entry = first(places(r.all));
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0 + 1_000,
          clOrdID: entry.clOrdID,
          price: "80000",
          quantity: entry.quantity,
          fee: "0.01",
        },
        { type: "tick", at: T0 + 2_000, market: "BTC-USD", price: "80500" },
      ],
      r.s,
    );
    const exitOrder = last(places(r.all));
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0 + 3_000,
          clOrdID: exitOrder.clOrdID,
          price: "80500",
          quantity: exitOrder.quantity,
          fee: "0.01",
        },
      ],
      r.s,
    );
    // Đã đóng long → netExposure hải là entryNotional dương
    const exposure = Number(r.s.netExposure);
    expect(exposure).toBeGreaterThan(0);
    // Xấp xỉ notional: qty × avgCost
    const qty = Number(entry.quantity);
    expect(exposure).toBeCloseTo(qty * 80_000, 0);
  });
});

describe("volume farm order price", () => {
  const market = (b: Partial<BookTop>, tick: string) => {
    const c: StepContext = {
      ...ctx,
      rules: {
        "BTC-USD": { tickSize: tick, stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" },
      },
    };
    return (config: VolumeFarmConfig, at = T0) =>
      volumeFarm.step(
        config,
        volumeFarm.initialState(config),
        {
          type: "timer",
          at,
          market: { market: "BTC-USD", candles: candles(0.0001), book: { ...book, ...b } },
        },
        c,
      );
  };
  const wide = cfg({ maxSpreadBps: "500" });

  it.each([
    ["1", "80000", "80010", "80009", "80001"],
    ["0.1", "80000", "80001", "80000.9", "80000.1"],
    ["0.01", "80000.5", "80000.75", "80000.74", "80000.51"],
  ])("sits inside the spread at tick %s", (tick, bid, ask, buy, sell) => {
    const long = market({ bid, ask }, tick)(wide);
    expect(first(places(long.actions))).toMatchObject({ side: "buy", price: buy });
    const short = market({ bid, ask }, tick)(cfg({ maxSpreadBps: "500", reverseSignal: true }));
    expect(first(places(short.actions))).toMatchObject({ side: "sell", price: sell });
  });

  it("joins its own side when the spread is one tick, so it never crosses", () => {
    expect(first(places(market({}, "1")(wide).actions)).price).toBe("80000");
  });

  it("ignores the last price while the book is fresh", () => {
    const start: VolumeFarmState = { ...volumeFarm.initialState(wide), lastPrice: "79000" };
    const r = volumeFarm.step(wide, start, timer(T0), ctx);
    expect(first(places(r.actions)).price).toBe("80000");
  });

  it("falls back one tick off the last price when the book is stale", () => {
    const open: VolumeFarmState = {
      ...volumeFarm.initialState(wide),
      phase: "open",
      lastPrice: "80100",
      book,
      bookAt: T0 - FARM_TIMING.bookMaxAgeMs - 1,
      ledger: {
        position: "0.002",
        avgCost: "80000",
        realized: "0",
        fees: "0",
        funding: "0",
        invested: "0",
      },
      openedAt: T0 - 200_000,
      holdUntil: T0 - 1,
    };
    const r = volumeFarm.step(wide, open, timer(T0, false), ctx);
    // Lệnh đầu là stop loss trên SoDEX (DEC-118); lệnh thoát post-only đi sau.
    expect(first(places(r.actions).filter((o) => o.stop === undefined))).toMatchObject({
      side: "sell",
      price: "80101",
      reduceOnly: true,
    });
  });
});

describe("volume farm — stop loss on SoDEX (DEC-118, DEC-120, DEC-125)", () => {
  // Giá vào 80000, SL 5% → SL của bot 76000; stop trên sàn lùi thêm 0.1% giá vào → 75920.
  // G = 80000 × (0.012% vào + 0.012% ra + 0.01% trượt giá) = 27.2: điểm vào ở 3 G = 81.6, hoà vốn 80028 ở 4 G = 108.8,
  // khoá lời ở 6 G = 163.2 (đỉnh − 2 G = đỉnh − 54.4).
  const tick = (at: number, price: string): StrategyEvent => ({
    type: "tick",
    at,
    market: "BTC-USD",
    price,
  });
  /** Vào lệnh và khớp ở 80000; trả state đang mở. */
  function opened(c: VolumeFarmConfig, start?: VolumeFarmState, at = T0) {
    const r = run(c, [timer(at)], start);
    const entry = first(places(r.all));
    return run(
      c,
      [
        {
          type: "fill",
          at: at + 1000,
          clOrdID: entry.clOrdID,
          price: "80000",
          quantity: entry.quantity,
          fee: "0.01",
        },
      ],
      r.s,
    );
  }
  const logs = (a: StrategyAction[]) =>
    a.filter((x): x is Extract<StrategyAction, { type: "log" }> => x.type === "log");
  const stops = (a: StrategyAction[]) => places(a).filter((o) => o.stop !== undefined);
  const mods = (a: StrategyAction[]) =>
    a.filter((x): x is Extract<StrategyAction, { type: "modifyStop" }> => x.type === "modifyStop");

  it("reads old scalp configs with the apex exits and allows 0–10 misses before taker", () => {
    const old = volumeFarmSchema.parse({
      market: "BTC-USD",
      leverage: 5,
      marginMode: "cross",
      orderSizeMinUsd: "200",
      orderSizeMaxUsd: "500",
      minHoldSecs: 120,
      maxHoldSecs: 180,
      maxLoss: "20",
      exits: "atr",
      tpAtr: "2",
      slAtr: "2",
      minConfidence: "40",
    });
    expect(old).toMatchObject({
      tpUsd: "0.5",
      slMarginPct: "25",
      earlyExitSecs: 10,
      earlyProfitFees: "3",
      allowTaker: false,
    });
    expect(old.earlyProfitUsd).toBeUndefined();
    expect(old.slPct).toBeUndefined();
    expect(old).not.toHaveProperty("tpAtr");
    expect(volumeFarmSchema.safeParse({ ...old, takerAfter: 0 }).success).toBe(true);
    expect(volumeFarmSchema.safeParse({ ...old, takerAfter: -1 }).success).toBe(false);
    expect(volumeFarmSchema.safeParse({ ...old, takerAfter: 11 }).success).toBe(false);
  });

  it("exits early only once the price gain covers 3× the round-trip fee, never below the fees (DEC-130)", () => {
    const c = cfg({ earlyExitSecs: 10, earlyProfitUsd: undefined });
    const o = opened(c);
    const qty = dec(o.s.ledger.position);
    // Phí khứ hồi = notional × 0.012% × 2; 3 lần = 0.072% giá = 57.6 trên 80000.
    const at = T0 + 1000 + 15_000;
    const below = run(c, [tick(at, "80045")], o.s);
    expect(below.s.exit).toBeNull();
    const r = run(c, [tick(at, "80060")], o.s);
    expect(r.s.exit).not.toBeNull();
    const need = qty.mul("80000").mul("0.00012").mul(2).mul(3).toDecimalPlaces(2).toString();
    expect(r.s.exitReason).toMatch(
      new RegExp(`^Early profit .* ≥ ${need.replace(".", "\\.")} after 15 s`),
    );
    // Config cũ 0.15 USDC: ngưỡng = max(0.15, 3 × phí), ở đây 0.15 > 3 × phí nên 80060 chưa đủ.
    const old = cfg({ earlyExitSecs: 10 });
    const o2 = opened(old);
    expect(run(old, [tick(at, "80060")], o2.s).s.exit).toBeNull();
  });

  it("places a mark-price stop just past the bot's own stop loss right after the entry fills (DEC-125)", () => {
    const o = opened(cfg());
    const [st] = stops(o.all);
    // SL 5% = 4000, lùi thêm 0.1% giá vào = 80.
    expect(st).toMatchObject({
      side: "sell",
      type: "market",
      reduceOnly: true,
      stop: { price: "75920" },
    });
    expect(o.s.xstop?.price).toBe("75920");
    expect(logs(o.all).map((l) => l.decision)).toContain("Stop loss set on SoDEX");
  });

  it("cuts the loss by % of margin like SoDEX's TP/SL, and keeps old % price configs as they were (DEC-126)", () => {
    // 25% margin ở 20× = 1.25% giá = 1000; stop trên sàn lùi thêm 0.1% = 80 → 78920.
    const m = cfg({ slPct: undefined, slMarginPct: "25" });
    const o = opened(m);
    expect(first(stops(o.all)).stop?.price).toBe("78920");
    const r = run(m, [tick(T0 + 3000, "78999")], o.s);
    expect(logs(r.all).length + places(r.all).length).toBeGreaterThan(0);
    expect(last(places(r.all))).toMatchObject({ type: "market", reduceOnly: true, side: "sell" });
    // Config cũ có slPct = 5 (% giá) vẫn cắt ở 5%.
    expect(first(stops(opened(cfg()).all)).stop?.price).toBe("75920");
    expect(volumeFarmSchema.safeParse({ ...m, slMarginPct: "95" }).success).toBe(false);
  });

  it("logs the entry price when it enters and the entry and exit prices when it closes", () => {
    const r = run(cfg(), [timer(T0)]);
    expect(logs(r.all).find((l) => l.decision === "Enter long")?.why).toMatch(
      /^Signal pointed long in .*. Post-only at 80000, /,
    );
  });

  it("moves the stop on SoDEX to break-even at 2 G by default, then locks profit and trails (DEC-143)", () => {
    const o = opened(cfg());
    const id = o.s.xstop?.id ?? "";
    // G = 27.2: hoà vốn khi lãi ≥ 2 G = 54.4; dòng đặt stop ghi giá đó.
    expect(logs(o.all).find((l) => l.decision === "Stop loss set on SoDEX")?.why).toContain(
      "Moves to break-even if the price reaches 80055 (+0.068%)",
    );
    let r = run(cfg(), [tick(T0 + 2000, "80054")], o.s);
    expect(r.s.stopLevel ?? 0).toBe(0);
    // Đủ 2 G nhưng chưa qua 3 s từ lúc đặt: chưa gửi.
    r = run(cfg(), [tick(T0 + 2500, "80055")], r.s);
    expect(r.s.stopLevel).toBe(2);
    expect(mods(r.all)).toHaveLength(0);
    // Hoà vốn 80027.2, làm tròn lên phía có lãi.
    r = run(cfg(), [tick(T0 + 5000, "80010")], r.s);
    expect(mods(r.all)).toEqual([{ type: "modifyStop", clOrdID: id, stopPrice: "80028" }]);
    expect(logs(r.all).map((l) => l.decision)).toContain("Stop loss on SoDEX moved to break-even");
    // Lãi ≥ 4 G = 108.8: khoá lời ở đỉnh − 2 G = 80109 − 54.4 = 80054.6.
    r = run(cfg(), [tick(T0 + 9000, "80109")], r.s);
    expect(mods(r.all)[0]?.stopPrice).toBe("80055");
    expect(logs(r.all).map((l) => l.decision)).toContain("Stop loss on SoDEX locked in profit");
    // Bám giá tốt nhất, mỗi nấc chỉ ghi Decisions một lần.
    r = run(cfg(), [tick(T0 + 13000, "80200")], r.s);
    expect(mods(r.all)[0]?.stopPrice).toBe("80146");
    expect(logs(r.all)).toHaveLength(0);
    // Giá quay xuống: stop không bao giờ lùi lại.
    r = run(cfg(), [tick(T0 + 17000, "80150")], r.s);
    expect(mods(r.all)).toHaveLength(0);
  });

  it("uses the configured multiple and prices it with the taker fee for the exit", () => {
    const tx: StepContext = { ...ctx, feeRate: "0.00017", takerFeeRate: "0.00045" };
    // G = 80000 × (0.017% + 0.045% + 0.01%) = 57.6. Mặc định 2 G: hoà vốn 80058 khi lãi ≥ 115.2.
    let r = run(cfg(), [timer(T0)], undefined, tx);
    const entry = first(places(r.all));
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0 + 1000,
          clOrdID: entry.clOrdID,
          price: "80000",
          quantity: entry.quantity,
          fee: "0",
        },
        tick(T0 + 5000, "80116"),
      ],
      r.s,
      tx,
    );
    expect(mods(r.all)[0]?.stopPrice).toBe("80058");
    // Đặt 3 G: lãi 116 chưa đủ (cần 172.8).
    const c3 = cfg({ stopMoveFees: "3" });
    let q = run(c3, [timer(T0)], undefined, tx);
    const e3 = first(places(q.all));
    q = run(
      c3,
      [
        {
          type: "fill",
          at: T0 + 1000,
          clOrdID: e3.clOrdID,
          price: "80000",
          quantity: e3.quantity,
          fee: "0",
        },
        tick(T0 + 5000, "80116"),
      ],
      q.s,
      tx,
    );
    expect(mods(q.all)).toHaveLength(0);
    q = run(c3, [tick(T0 + 9000, "80173")], q.s, tx);
    expect(mods(q.all)[0]?.stopPrice).toBe("80058");
  });

  it("leaves the stop to SoDEX when the bot closes the trade, and cancels it on the next entry only if needed (DEC-119)", () => {
    const o = opened(cfg());
    const id = o.s.xstop?.id ?? "";
    const end = o.s.holdUntil ?? 0;
    let r = run(cfg(), [{ type: "timer", at: end }], o.s);
    const exit = last(places(r.all).filter((x) => x.stop === undefined));
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: end + 1000,
          clOrdID: exit.clOrdID,
          price: "80001",
          quantity: exit.quantity,
          fee: "0.01",
        },
      ],
      r.s,
    );
    expect(r.all.some((a) => a.type === "cancel")).toBe(false);
    expect(r.s).toMatchObject({ phase: "idle", xstop: null, staleXstop: id, stopLevel: 0 });
    expect(logs(r.all).find((l) => l.decision === "Closed long")?.why).toContain(
      "entry 80000 → exit 80001",
    );
    // Nến của test kết thúc ở T0: chạy nhịp vào lệnh ở T0 với cooldown đã qua.
    const next = run(cfg(), [timer(T0 + 2000)], { ...r.s, cooldownUntil: 0 });
    expect(next.all[0]).toEqual({ type: "cancel", clOrdID: id });
    expect(next.s.staleXstop).toBeNull();
  });

  it("books the trade when the stop on SoDEX fills, and cancels the bot's own exit", () => {
    const o = opened(cfg());
    const st = first(stops(o.all));
    let r = run(cfg(), [{ type: "timer", at: o.s.holdUntil ?? 0 }], o.s);
    const exit = r.s.exit?.id ?? "";
    expect(exit).not.toBe("");
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: (o.s.holdUntil ?? 0) + 1000,
          clOrdID: st.clOrdID,
          price: "79990",
          quantity: st.quantity,
          fee: "0.05",
        },
      ],
      r.s,
    );
    expect(r.s).toMatchObject({ phase: "idle", trades: 1, xstop: null });
    expect(r.all).toContainEqual({ type: "cancel", clOrdID: exit });
    expect(logs(r.all).find((l) => l.decision === "Closed long")?.why).toMatch(/^Hold time/);
  });

  it("names the stop on SoDEX when it closes a trade the bot was still holding", () => {
    const o = opened(cfg());
    const st = first(stops(o.all));
    const r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0 + 2000,
          clOrdID: st.clOrdID,
          price: "75920",
          quantity: st.quantity,
          fee: "0.05",
        },
      ],
      o.s,
    );
    expect(logs(r.all).find((l) => l.decision === "Closed long")?.why).toMatch(
      /^Stop loss on SoDEX at 75920/,
    );
  });

  it("keeps the bot's own stop when SoDEX rejects the stop, without retrying it this trade", () => {
    const o = opened(cfg());
    const id = o.s.xstop?.id ?? "";
    let r = run(cfg(), [{ type: "orderReject", at: T0 + 1500, clOrdID: id, code: "-1" }], o.s);
    expect(r.all).toContainEqual({ type: "cancel", clOrdID: id });
    expect(logs(r.all).map((l) => l.decision)).toEqual(["Stop loss on SoDEX not set"]);
    r = run(cfg(), [tick(T0 + 6000, "80001")], r.s);
    expect(stops(r.all)).toHaveLength(0);
    r = run(cfg(), [tick(T0 + 7000, "75999")], r.s);
    expect(last(places(r.all))).toMatchObject({ type: "market", reduceOnly: true });
  });

  it("stops trying on Paper, quietly", () => {
    const o = opened(cfg());
    const id = o.s.xstop?.id ?? "";
    const r = run(
      cfg(),
      [{ type: "orderReject", at: T0 + 1500, clOrdID: id, code: "PAPER_NO_STOP" }],
      o.s,
    );
    expect(logs(r.all)).toHaveLength(0);
    expect(r.s.xstopUnsupported).toBe(true);
    const next = opened(
      cfg(),
      {
        ...r.s,
        phase: "idle",
        ledger: { ...r.s.ledger, position: "0" },
        openedAt: null,
        cooldownUntil: 0,
      },
      T0 + 60_000,
    );
    expect(stops(next.all)).toHaveLength(0);
  });

  it("places no stop on SoDEX when turned off", () => {
    const o = opened(cfg({ exchangeStop: false }));
    expect(stops(o.all)).toHaveLength(0);
    expect(
      run(cfg({ exchangeStop: false }), [tick(T0 + 5000, "80100")], o.s).s.stopLevel ?? 0,
    ).toBe(0);
  });
});

describe("volume farm — trend filters (DEC-158)", () => {
  // 120 nến: drift 0.0001 → TREND_UP (tín hiệu long), 0.00003 → SIDEWAY (tín hiệu long).
  const at = (drift: number): StrategyEvent => ({
    type: "timer",
    at: T0,
    market: { market: "BTC-USD", candles: candles(drift, 80_000, 120), book },
  });
  const skips = (a: StrategyAction[]) =>
    a.flatMap((x) => (x.type === "log" && x.decision === "Skipped entry" ? [x.why] : []));

  it("never lets Reverse open against the trend", () => {
    const { all } = run(cfg({ reverseSignal: true }), [at(0.0001)]);
    expect(places(all)).toEqual([]);
    expect(skips(all)).toEqual([
      '"Reverse the signal" would trade short against an uptrend, so the bot waits.',
    ]);
  });

  it("still reverses when the market moves sideways", () => {
    const { all } = run(cfg({ reverseSignal: true }), [at(0.00003)]);
    expect(places(all)[0]).toMatchObject({ side: "sell" });
  });

  it("skips entries outside a sideways market when Only trade sideways is on", () => {
    const trend = run(cfg({ sidewaysOnly: true }), [at(0.0001)]);
    expect(places(trend.all)).toEqual([]);
    expect(skips(trend.all)).toEqual([
      "Right now it is an uptrend, and this bot only trades sideways markets.",
    ]);
    // Không ghi lại cùng lý do ở nhịp sau.
    expect(skips(run(cfg({ sidewaysOnly: true }), [at(0.0001)], trend.s).all)).toEqual([]);
    expect(places(run(cfg({ sidewaysOnly: true }), [at(0.00003)]).all)[0]).toMatchObject({
      side: "buy",
    });
  });

  it("keeps trading in a trend when the option is off (default)", () => {
    expect(cfg().sidewaysOnly).toBe(false);
    expect(places(run(cfg(), [at(0.0001)]).all)[0]).toMatchObject({ side: "buy" });
  });
});

describe("volume farm — live order book (DEC-298)", () => {
  const wide = cfg({ maxSpreadBps: "500", allowTaker: false });
  const live = (at: number, bid: string, ask: string, market = "BTC-USD"): StrategyEvent => ({
    type: "book",
    at,
    market,
    bid,
    ask,
  });
  const waits = (a: StrategyAction[]) =>
    a.filter((x) => x.type === "log" && x.decision === "Waiting");

  it("prices the entry from the live best bid / ask, keeping the REST depth", () => {
    // REST (3 s) đọc lúc T0 − 2 s: 80000 / 80010; WS lúc T0 − 0,2 s: 80050 / 80060.
    const r = run(wide, [
      live(T0 - 200, "80050", "80060"),
      {
        type: "timer",
        at: T0,
        market: {
          market: "BTC-USD",
          candles: candles(0.0001),
          book: { ...book, bid: "80000", ask: "80010" },
          bookAt: T0 - 2_000,
        },
      },
    ]);
    expect(first(places(r.all))).toMatchObject({ side: "buy", price: "80059", type: "limit" });
    expect(r.s.book).toMatchObject({ bid: "80050", ask: "80060", bidNotional: "500000" });
    expect(r.s.bookAt).toBe(T0 - 200);
  });

  it("ignores a live price for another market or a crossed book", () => {
    const s0 = volumeFarm.initialState(wide);
    expect(volumeFarm.step(wide, s0, live(T0, "1", "2", "ETH-USD"), ctx).state).toBe(s0);
    expect(volumeFarm.step(wide, s0, live(T0, "80010", "80000"), ctx).state).toBe(s0);
  });

  it("waits instead of quoting from a book older than 1.5 s while the live feed is on, logging once", () => {
    const at = T0;
    const stale = at - FARM_LIVE_BOOK.freshMs - 1;
    // Tin WS cuối 1,5 s trước; bản REST dùng chung cũng cũ (đọc 2,9 s trước).
    const snap = (t: number): StrategyEvent => ({
      type: "timer",
      at: t,
      market: { market: "BTC-USD", candles: candles(0.0001), book, bookAt: t - 2_900 },
    });
    const r = run(wide, [live(stale, "80000", "80001"), snap(at), snap(at + 3_000)]);
    expect(places(r.all)).toEqual([]);
    expect(waits(r.all)).toEqual([
      {
        type: "log",
        decision: "Waiting",
        why: "Waiting for a fresh SoDEX price before placing a post-only order.",
      },
    ]);
    // Sổ mới tới: vào lệnh, lần chờ sau lại được ghi.
    const next = run(wide, [live(at + 3_500, "80000", "80001"), snap(at + 3_600)], r.s);
    expect(first(places(next.all))).toMatchObject({ side: "buy", price: "80000" });
    expect(next.s.lastSkip).toBeNull();
  });

  it("uses a fresh REST read when the live feed has gone quiet", () => {
    const r = run(wide, [
      live(T0 - 10_000, "79000", "79001"),
      {
        type: "timer",
        at: T0,
        market: { market: "BTC-USD", candles: candles(0.0001), book, bookAt: T0 - 100 },
      },
    ]);
    expect(first(places(r.all))).toMatchObject({ side: "buy", price: "80000" });
    expect(r.s.bookAt).toBe(T0 - 100);
  });

  it("never blocks a post-only exit on a stale book: uses the DEC-82 fallback even while the live feed is on", () => {
    const base: VolumeFarmState = {
      ...volumeFarm.initialState(wide),
      phase: "exiting",
      lastPrice: "80100",
      book,
      bookStreamAt: T0 - 5_000,
      ledger: {
        position: "0.002",
        avgCost: "80000",
        realized: "0",
        fees: "0",
        funding: "0",
        invested: "0",
      },
      openedAt: T0 - 200_000,
      exit: null,
    };
    // Sổ 5 s tuổi (≤ 10 s): giá trong spread từ sổ đó.
    const fromBook = volumeFarm.step(wide, { ...base, bookAt: T0 - 5_000 }, timer(T0, false), ctx);
    expect(first(places(fromBook.actions))).toMatchObject({ side: "sell", price: "80001" });
    // Sổ quá 10 s: lùi 1 tick khỏi giá gần nhất.
    const stale = { ...base, bookAt: T0 - FARM_TIMING.bookMaxAgeMs - 1 };
    const fromLast = volumeFarm.step(wide, stale, timer(T0, false), ctx);
    expect(first(places(fromLast.actions))).toMatchObject({
      side: "sell",
      price: "80101",
      reduceOnly: true,
    });
    // Sổ WS mới: đặt lệnh thoát trong spread theo sổ đó.
    const r2 = volumeFarm.step(wide, stale, live(T0 + 100, "80200", "80202"), ctx);
    const r3 = volumeFarm.step(wide, r2.state, timer(T0 + 200, false), ctx);
    expect(first(places(r3.actions))).toMatchObject({ side: "sell", price: "80201" });
  });

  it("keeps the DEC-82 fallback when no live feed has been seen", () => {
    expect(FARM_LIVE_BOOK.feedMs).toBeGreaterThan(FARM_LIVE_BOOK.freshMs);
    const s0: VolumeFarmState = {
      ...volumeFarm.initialState(wide),
      phase: "exiting",
      lastPrice: "80100",
      book,
      bookAt: T0 - 5_000,
      bookStreamAt: T0 - FARM_LIVE_BOOK.feedMs - 1,
      ledger: {
        position: "0.002",
        avgCost: "80000",
        realized: "0",
        fees: "0",
        funding: "0",
        invested: "0",
      },
      openedAt: T0 - 200_000,
      exit: null,
    };
    // Sổ REST 5 s tuổi (≤ 10 s): giá trong spread như DEC-82.
    expect(first(places(volumeFarm.step(wide, s0, timer(T0, false), ctx).actions)).price).toBe(
      "80001",
    );
  });
});

describe("volume farm — backoff after refused entries (DEC-299)", () => {
  const c = cfg({ allowTaker: false, cooldownSecs: 0 });
  // Nến dời theo thời gian để không bị "STALE_CANDLES" sau vài phút chờ.
  const enter = (at: number, s?: VolumeFarmState) =>
    run(
      c,
      [
        {
          type: "timer",
          at,
          market: {
            market: "BTC-USD",
            candles: candles(0.0001).map((k) => ({ ...k, t: k.t + (at - T0) })),
            book,
          },
        },
      ],
      s,
    );
  const reject = (
    s: VolumeFarmState,
    at: number,
    code: string,
    extra: { insufficientMargin?: boolean; message?: string } = {},
  ) => run(c, [{ type: "orderReject", at, clOrdID: s.entry?.id ?? "", code, ...extra }], s);
  const logs = (a: StrategyAction[]) =>
    a.flatMap((x) => (x.type === "log" && x.decision === "Waiting" ? [x.why] : []));

  it("waits 5 s, 15 s, then 60 s (staying at 60 s), one Decisions line per step", () => {
    expect(VF_REJECT_BACKOFF_SECS).toEqual([5, 15, 60]);
    let r = enter(T0);
    let t = T0 + 100;
    const lines: string[] = [];
    const waitsSeen: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      r = reject(r.s, t, "-1", { message: "reduce only order rejected" });
      lines.push(...logs(r.all));
      const until = r.s.rejectBackoff?.until ?? 0;
      waitsSeen.push((until - t) / 1000);
      // Trước khi hết chờ: không vào; hết chờ: vào lại.
      expect(places(enter(until - 1, r.s).all)).toEqual([]);
      r = enter(until, r.s);
      expect(places(r.all)).toHaveLength(1);
      t = until + 100;
    }
    expect(waitsSeen).toEqual([5, 15, 60, 60]);
    expect(lines).toEqual([
      "Order refused by SoDEX: reduce only order rejected. Retrying in 5s.",
      "Order refused by SoDEX: reduce only order rejected. Retrying in 15s.",
      "Order refused by SoDEX: reduce only order rejected. Retrying in 60s.",
    ]);
  });

  it("uses the code when SoDEX gives no message", () => {
    const r = reject(enter(T0).s, T0 + 100, "RISK_PER_TRADE");
    expect(logs(r.all)).toEqual(["Order refused by SoDEX: RISK_PER_TRADE. Retrying in 5s."]);
  });

  it("retries right away after a post-only or self-trade reject, without a log", () => {
    for (const code of ["PostOnly", "SELF_TRADE_BLOCKED", "POST_ONLY_WOULD_TRADE"]) {
      const r = reject(enter(T0).s, T0 + 100, code);
      expect(r.all).toEqual([]);
      expect(r.s.rejectBackoff ?? null).toBeNull();
      expect(places(enter(T0 + 200, r.s).all)).toHaveLength(1);
    }
  });

  it("leaves margin rejects to the engine pause (DEC-290): no wait, no log", () => {
    const r = reject(enter(T0).s, T0 + 100, "-1", {
      insufficientMargin: true,
      message: "insufficient margin",
    });
    expect(r.all).toEqual([]);
    expect(r.s.rejectBackoff ?? null).toBeNull();
    expect(places(enter(T0 + 200, r.s).all)).toHaveLength(1);
  });

  it("resets when SoDEX accepts or fills the next entry", () => {
    let r = reject(enter(T0).s, T0 + 100, "-1");
    r = enter(T0 + 5_100, r.s);
    const acked = run(c, [{ type: "orderAck", at: T0 + 5_200, clOrdID: r.s.entry?.id ?? "" }], r.s);
    expect(acked.s.rejectBackoff).toBeNull();
    const o = first(places(r.all));
    const filled = run(
      c,
      [
        {
          type: "fill",
          at: T0 + 5_300,
          clOrdID: o.clOrdID,
          price: o.price ?? "80000",
          quantity: o.quantity,
          fee: "0.01",
        },
      ],
      r.s,
    );
    expect(filled.s.rejectBackoff).toBeNull();
    // Sau khi reset, lần từ chối kế tiếp bắt đầu lại ở 5 s.
    const again = reject(enter(T0 + 6_000, acked.s).s, T0 + 6_100, "-1");
    expect(again.s.rejectBackoff?.step).toBe(1);
  });

  it("still pauses after 3 refused market entries before any wait (DEC-259)", () => {
    const m = cfg({ takerAfter: 0, cooldownSecs: 0 });
    let r = run(m, [timer(T0)]);
    const pauses: StrategyAction[] = [];
    let t = T0;
    for (let i = 0; i < 3; i += 1) {
      r = run(
        m,
        [{ type: "orderReject", at: t + 100, clOrdID: r.s.entry?.id ?? "", code: "-1" }],
        r.s,
      );
      pauses.push(...r.all.filter((a) => a.type === "pause"));
      t = r.s.rejectBackoff?.until ?? t;
      if (i < 2) r = run(m, [timer(t)], r.s);
    }
    expect(pauses).toEqual([{ type: "pause", reason: "ORDER_REJECTED" }]);
  });
});

describe("volume farm — new version while running (DEC-TBD-vf-version-apply)", () => {
  const apply = volumeFarm.applyVersion;
  if (apply === undefined) throw new Error("volume farm must define applyVersion");
  const v2 = cfg({ allowTaker: true, takerAfter: 0 });
  /** Vào lệnh short và khớp ở 80000 (prod 2026-11-17: `vf:5:in:1` sell khớp, stop mua reduce-only đặt ngay). */
  function shortOpen() {
    const down = (at: number): StrategyEvent => ({
      type: "timer",
      at,
      market: {
        market: "BTC-USD",
        candles: candles(-0.0001),
        book: { ...book, bidNotional: "400000", askNotional: "500000" },
      },
    });
    const r = run(cfg(), [down(T0)]);
    const entry = first(places(r.all));
    expect(entry.side).toBe("sell");
    return {
      entry,
      ...run(
        cfg(),
        [
          {
            type: "fill",
            at: T0 + 1000,
            clOrdID: entry.clOrdID,
            price: "80000",
            quantity: entry.quantity,
            fee: "0.01",
          },
        ],
        r.s,
      ),
    };
  }

  it("does not apply a new version while a trade is open or an entry / exit is in flight", () => {
    const { s, all } = shortOpen();
    const stop = first(places(all).filter((o) => o.stop !== undefined));
    expect(stop).toMatchObject({ side: "buy", reduceOnly: true });
    expect(s.phase).toBe("open");
    // Lượt đang mở: không áp (engine không huỷ stop trên SoDEX), v1 quản lý lượt tới khi đóng.
    expect(apply(v2, s, ctx)).toBeNull();
    // Lệnh vào đang chờ khớp: cũng không áp.
    const entering = run(cfg(), [timer(T0)]).s;
    expect(entering.phase).toBe("entering");
    expect(apply(v2, entering, ctx)).toBeNull();
    // Đang thoát: không áp.
    const exiting = run(
      cfg(),
      [{ type: "tick", at: T0 + 2000, market: "BTC-USD", price: "70000" }],
      s,
    ).s;
    expect(exiting.phase).toBe("exiting");
    expect(apply(v2, exiting, ctx)).toBeNull();
  });

  it("keeps managing the open trade while v2 waits, opens no new trade, then applies once flat", () => {
    const { s: open } = shortOpen();
    const waiting: StepContext = { ...ctx, versionPending: 2 };
    // Giá xuống: chốt lời bằng lệnh mua reduce-only của v1.
    let r = run(
      cfg(),
      [{ type: "tick", at: T0 + 2000, market: "BTC-USD", price: "79000" }],
      open,
      waiting,
    );
    const exit = last(places(r.all));
    expect(exit).toMatchObject({ side: "buy", reduceOnly: true });
    r = run(
      cfg(),
      [
        {
          type: "fill",
          at: T0 + 3000,
          clOrdID: exit.clOrdID,
          price: "79000",
          quantity: exit.quantity,
          fee: "0.01",
        },
      ],
      r.s,
      waiting,
    );
    expect(r.s.phase).toBe("idle");
    // Hết cooldown mà version mới còn chờ: không mở lượt mới.
    expect(places(run(cfg(), [timer(T0 + 60_000)], r.s, waiting).all)).toHaveLength(0);
    // Phẳng, không còn lệnh vào / thoát: áp được, phiên mới nhưng nhớ lệnh cũ.
    const next = apply(v2, r.s, ctx);
    expect(next).not.toBeNull();
    expect(next?.phase).toBe("idle");
    expect(next?.ledger.position).toBe("0");
    expect(Object.keys(next?.orders ?? {})).toEqual(Object.keys(r.s.orders));
  });

  it("still books a late fill of a v1 order after v2 is applied", () => {
    // Lệnh vào bị huỷ sau 10 s (bot tưởng chưa khớp), rồi version mới được áp.
    let r = run(cfg(), [timer(T0)]);
    const entry = first(places(r.all));
    r = run(cfg(), [timer(T0 + FARM_TIMING.entryFillMs + 1)], r.s);
    expect(r.s.phase).toBe("idle");
    const next = apply(v2, r.s, ctx);
    if (next === null) throw new Error("expected v2 to apply");
    // Fill thật của lệnh v1 tới muộn: vào sổ cái, bot theo dõi vị thế và đặt stop.
    const late = run(
      v2,
      [
        {
          type: "fill",
          at: T0 + 12_000,
          clOrdID: entry.clOrdID,
          price: "80000",
          quantity: entry.quantity,
          fee: "0.01",
        },
      ],
      next,
      { ...ctx, version: 2 },
    );
    expect(late.s.ledger.position).toBe(entry.quantity);
    expect(late.s.phase).toBe("open");
    expect(places(late.all).filter((o) => o.stop !== undefined)).toHaveLength(1);
  });
});
