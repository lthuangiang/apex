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
import { FARM_TIMING, farmRandom, volumeFarm, type VolumeFarmState } from "../volume-farm";
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

describe("volume farm — inventory rebalance (netExposure hard block)", () => {
  it("buộc short khi netExposure > orderSizeMaxUsd (nhiều long đã đóng)", () => {
    // netExposure = 300 USDC > orderSizeMaxUsd 200 USDC, lastSide = long → phải flip sang short
    const start: VolumeFarmState = {
      ...volumeFarm.initialState(cfg()),
      netExposure: "300",
      lastSide: "long",
    };
    const { all } = run(cfg(), [timer(T0)], start);
    const order = places(all)[0];
    expect(order?.side).toBe("sell");
    const log = all.find((a): a is Extract<StrategyAction, { type: "log" }> => a.type === "log");
    expect(log?.why).toMatch(/inventory rebalance/);
  });

  it("không flip khi netExposure ≤ orderSizeMaxUsd", () => {
    const start: VolumeFarmState = {
      ...volumeFarm.initialState(cfg()),
      netExposure: "150", // < 200 → không cần flip
      lastSide: "long",
    };
    const { all } = run(cfg(), [timer(T0)], start);
    // Uptrend signal → vẫn long bình thường
    expect(places(all)[0]?.side).toBe("buy");
  });

  it("netExposure âm lớn (nhiều short đã đóng) buộc long", () => {
    // netExposure = -300 và lastSide = short → buộc long
    const start: VolumeFarmState = {
      ...volumeFarm.initialState(cfg()),
      netExposure: "-300",
      lastSide: "short",
    };
    const { all } = run(cfg(), [timer(T0)], start);
    const order = places(all)[0];
    // Inventory block phải thắng reverseSignal: long
    expect(order?.side).toBe("buy");
    const log = all.find((a): a is Extract<StrategyAction, { type: "log" }> => a.type === "log");
    expect(log?.why).toMatch(/inventory rebalance/);
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

  it("reads old scalp configs with the apex exits and only allows 1–10 misses before taker", () => {
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
    expect(volumeFarmSchema.safeParse({ ...old, takerAfter: 0 }).success).toBe(false);
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
      /^post-only at 80000;/,
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
    expect(skips(all)).toEqual(["COUNTER_TREND_BLOCKED: TREND_UP blocked reversed short"]);
  });

  it("still reverses when the market moves sideways", () => {
    const { all } = run(cfg({ reverseSignal: true }), [at(0.00003)]);
    expect(places(all)[0]).toMatchObject({ side: "sell" });
  });

  it("skips entries outside a sideways market when Only trade sideways is on", () => {
    const trend = run(cfg({ sidewaysOnly: true }), [at(0.0001)]);
    expect(places(trend.all)).toEqual([]);
    expect(skips(trend.all)).toEqual(["SIDEWAYS_ONLY: regime TREND_UP"]);
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
