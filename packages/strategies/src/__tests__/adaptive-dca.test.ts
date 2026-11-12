import { Decimal } from "@drift/shared";
import { describe, expect, it } from "vitest";

import {
  ADCA,
  adaptiveDca,
  adcaBreakEven,
  adcaDecision,
  adcaMarket,
  adcaSafetyPrice,
  regimeAllows,
  rsi,
  type AdaptiveDcaState,
} from "../adaptive-dca";
import { adaptiveDcaSchema, type AdaptiveDcaConfig } from "../adaptive-dca/schema";
import type { MinuteCandle, StepContext, StrategyAction, StrategyEvent } from "../core/types";

// S11 AI Adaptive DCA (DEC-107): quy tắc cố định, kiểm từng nhánh của state machine.

const ctx: StepContext = {
  botId: "adca-bot",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "1", stepSize: "0.00001", minQuantity: "0.00001", minNotional: "10" },
  },
  feeRate: "0.0002",
};
const T0 = Date.parse("2026-11-01T00:00:00Z");
const cfg = (over: Partial<Record<string, unknown>> = {}): AdaptiveDcaConfig =>
  adaptiveDcaSchema.parse({
    market: "BTC-USD",
    leverage: 2,
    baseOrder: "100",
    safetyOrder: "100",
    maxExposure: "1000",
    maxLoss: "150",
    ...over,
  });

/** 120 nến 1 phút đi ngang quanh 80.000 (dao động ±0.05%), kết thúc ở `end`; nến cuối đóng ngay trước T0. */
function candles(end: number, wave = 40): MinuteCandle[] {
  return Array.from({ length: 120 }, (_, i) => {
    const mid = (k: number) =>
      80_000 + Math.sin(k / 3) * wave + ((end - 80_000) * Math.max(0, k - 110)) / 10;
    const o = mid(i);
    const c = mid(i + 1);
    return {
      t: T0 - (120 - i) * 60_000,
      o: o.toFixed(1),
      h: (Math.max(o, c) + 5).toFixed(1),
      l: (Math.min(o, c) - 5).toFixed(1),
      c: c.toFixed(1),
      v: "10",
    };
  });
}
const timer = (at: number, list = candles(79_950)): StrategyEvent => ({
  type: "timer",
  at,
  market: { market: "BTC-USD", candles: list, book: null },
});
const tick = (at: number, price: string): StrategyEvent => ({
  type: "tick",
  at,
  market: "BTC-USD",
  price,
});

function run(c: AdaptiveDcaConfig, events: StrategyEvent[], start?: AdaptiveDcaState) {
  let s = start ?? adaptiveDca.initialState(c);
  const all: StrategyAction[] = [];
  for (const e of events) {
    const r = adaptiveDca.step(c, s, e, ctx);
    s = r.state;
    all.push(...r.actions);
  }
  return { s, all };
}
const places = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "place" ? [x.order] : []));
const logs = (a: StrategyAction[]) => a.flatMap((x) => (x.type === "log" ? [x] : []));
function fill(s: AdaptiveDcaState, id: string | null, price: string, qty: string, at: number) {
  return { type: "fill", at, clOrdID: id ?? "", price, quantity: qty, fee: "0.01" } as const;
}

/** Vào chu kỳ ở 79.950 và khớp lệnh đầu. */
function entered(c = cfg()) {
  let r = run(c, [tick(T0 - 1000, "79950"), timer(T0)]);
  const base = places(r.all)[0];
  if (base === undefined) throw new Error("expected a first order");
  r = run(c, [fill(r.s, base.clOrdID, "79950", base.quantity, T0 + 1000)], r.s);
  return r;
}

describe("indicators and rules", () => {
  it("computes RSI from closes", () => {
    expect(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])).toBe(100);
    expect(rsi([15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])).toBe(0);
    expect(rsi([1, 2, 3])).toBeNull();
  });

  it("lets a long start only in sideways or rising markets, a short only in sideways or falling ones", () => {
    expect(regimeAllows("long", "SIDEWAY")).toBe(true);
    expect(regimeAllows("long", "TREND_UP")).toBe(true);
    expect(regimeAllows("long", "TREND_DOWN")).toBe(false);
    expect(regimeAllows("long", "HIGH_VOLATILITY")).toBe(false);
    expect(regimeAllows("short", "TREND_DOWN")).toBe(true);
    expect(regimeAllows("short", "TREND_UP")).toBe(false);
  });

  it("decides continue / reduce / exit with fixed rules", () => {
    const base = {
      direction: "long" as const,
      safetiesFilled: 1,
      maxSafetyOrders: 5,
      againstMinutes: 0,
    };
    expect(adcaDecision({ ...base, regime: "SIDEWAY" })).toBe("continue");
    expect(adcaDecision({ ...base, regime: "TREND_DOWN", againstMinutes: 30 })).toBe("reduce");
    expect(
      adcaDecision({ ...base, regime: "TREND_DOWN", againstMinutes: ADCA.exitAfterMinutes }),
    ).toBe("exit");
    expect(adcaDecision({ ...base, regime: "HIGH_VOLATILITY", safetiesFilled: 3 })).toBe(
      "continue",
    );
    expect(adcaDecision({ ...base, regime: "HIGH_VOLATILITY", safetiesFilled: 4 })).toBe("reduce");
    expect(
      adcaDecision({ ...base, direction: "short", regime: "TREND_UP", againstMinutes: 5 }),
    ).toBe("reduce");
  });

  it("spaces extra buys by ATR, wider for later buys, never closer than the minimum step", () => {
    expect(adcaSafetyPrice("long", "80000", "100", "2", 1).toString()).toBe("79760");
    expect(adcaSafetyPrice("long", "80000", "200", "2", 1).toString()).toBe("79600");
    expect(adcaSafetyPrice("long", "80000", "200", "2", 2).toString()).toBe("79520");
    expect(adcaSafetyPrice("short", "80000", "200", "2", 1).toString()).toBe("80400");
    // ATR rất nhỏ: dùng khoảng tối thiểu 0.3%.
    expect(adcaSafetyPrice("long", "80000", "1", "2", 1).toString()).toBe("79760");
  });

  it("computes the cycle break-even with fees, funding and the closing fee", () => {
    const ledger = {
      position: "0.0025",
      avgCost: "80000",
      realized: "0",
      fees: "0.15",
      funding: "0.02",
      invested: "200",
    };
    const p = adcaBreakEven("long", ledger, "0.1", "0.01", "0.0002");
    // Đóng ở giá này: lãi giao dịch − phí lệnh đóng = phí (0.05) + funding (0.01) của chu kỳ.
    const net = p.sub("80000").mul("0.0025").sub(p.mul("0.0025").mul("0.0002"));
    expect(net.toDecimalPlaces(10).toString()).toBe("0.06");
    const short = adcaBreakEven(
      "short",
      { ...ledger, position: "-0.0025" },
      "0.1",
      "0.01",
      "0.0002",
    );
    const netShort = new Decimal("80000")
      .sub(short)
      .mul("0.0025")
      .sub(short.mul("0.0025").mul("0.0002"));
    expect(netShort.toDecimalPlaces(10).toString()).toBe("0.06");
  });

  it("reads regime, ATR and RSI from 1-minute candles", () => {
    const m = adcaMarket(candles(79_950), T0);
    expect(m.regime).not.toBe("UNKNOWN");
    expect(m.atr).not.toBeNull();
    expect(m.rsi).not.toBeNull();
  });
});

describe("adaptive DCA cycle", () => {
  it("waits for a suitable market and RSI before the first order", () => {
    const strict = run(cfg({ entryRsi: "10" }), [tick(T0 - 1000, "79950"), timer(T0)]);
    expect(places(strict.all)).toHaveLength(0);
    expect(logs(strict.all)[0]?.why).toMatch(/^(RSI|REGIME)/);
    const ok = run(cfg({ entryRsi: "90" }), [tick(T0 - 1000, "79950"), timer(T0)]);
    expect(places(ok.all)[0]).toMatchObject({ side: "buy", type: "market", engine: "perps" });
    expect(ok.s.phase).toBe("entering");
  });

  it("does not start a long DCA in a falling market, even with a low RSI", () => {
    const down = candles(79_000);
    expect(adcaMarket(down, T0).regime).toBe("TREND_DOWN");
    const r = run(cfg({ entryRsi: "90" }), [tick(T0 - 1000, "79000"), timer(T0, down)]);
    expect(places(r.all)).toHaveLength(0);
    expect(logs(r.all)[0]?.why).toMatch(/^REGIME: TREND_DOWN/);
    // Cùng thị trường đó, bot short được vào.
    const short = run(cfg({ entryRsi: "90", direction: "short" }), [
      tick(T0 - 1000, "79000"),
      timer(T0, down),
    ]);
    expect(places(short.all)[0]).toMatchObject({ side: "sell", type: "market" });
  });

  it("after the first fill, places a reduce-only take profit and one ATR-spaced extra buy", () => {
    const r = entered(cfg({ entryRsi: "90" }));
    const [tp, so] = places(r.all);
    expect(tp).toMatchObject({ side: "sell", reduceOnly: true, price: "81149" });
    expect(so).toMatchObject({ side: "buy", type: "limit" });
    expect(Number(so?.price)).toBeLessThan(79950);
    expect(r.s).toMatchObject({ phase: "in_cycle", nextSafety: 1 });
    expect(r.s.safetyId).toBe(so?.clOrdID);
  });

  it("never passes the exposure cap", () => {
    // Trần 250: lệnh đầu 100 + lệnh thêm 100 = 200 ≤ 250; lệnh thêm thứ hai 150 sẽ vượt.
    let r = entered(cfg({ entryRsi: "90", maxExposure: "250" }));
    const so1 = places(r.all)[1];
    r = run(
      cfg({ entryRsi: "90", maxExposure: "250" }),
      [fill(r.s, so1?.clOrdID ?? "", so1?.price ?? "0", so1?.quantity ?? "0", T0 + 2000)],
      r.s,
    );
    expect(places(r.all).filter((o) => o.tag.includes(":so"))).toHaveLength(0);
    expect(logs(r.all).map((l) => l.decision)).toContain("Holding");
  });

  it("reduces when the market turns against it, then exits if it stays that way", () => {
    const c = cfg({ entryRsi: "90" });
    let r = entered(c);
    const down = candles(79_000);
    r = run(c, [timer(T0 + 60_000, down)], r.s);
    if (r.s.regime !== "TREND_DOWN") throw new Error(`expected TREND_DOWN, got ${r.s.regime}`);
    expect(logs(r.all).map((l) => l.decision)).toContain("Reduce");
    expect(r.s.reduced).toBe(true);
    expect(r.all.some((a) => a.type === "cancel")).toBe(true);
    // Take profit về hoà vốn + phí.
    const tp = places(r.all).find((o) => o.tag.includes(":tp:"));
    expect(Number(tp?.price)).toBeLessThan(81_000);
    r = run(c, [timer(T0 + 60_000 + ADCA.exitAfterMinutes * 60_000, down)], r.s);
    expect(r.s.phase).toBe("exiting");
    expect(places(r.all).at(-1)).toMatchObject({ type: "market", reduceOnly: true, side: "sell" });
  });

  it("closes at market on the hard stop and waits out the cooldown", () => {
    const c = cfg({ entryRsi: "90", hardStopLossPct: "2" });
    let r = entered(c);
    r = run(c, [tick(T0 + 5000, "78300")], r.s);
    expect(r.s.phase).toBe("exiting");
    const exit = places(r.all).at(-1);
    expect(exit).toMatchObject({ type: "market", reduceOnly: true });
    r = run(c, [fill(r.s, exit?.clOrdID ?? "", "78300", exit?.quantity ?? "0", T0 + 6000)], r.s);
    expect(r.s).toMatchObject({ phase: "idle", exits: 1 });
    expect(r.s.cooldownUntil).toBe(T0 + 6000 + 30 * 60_000);
    // Trong cooldown: không vào chu kỳ mới.
    expect(places(run(c, [timer(T0 + 60_000)], r.s).all)).toHaveLength(0);
  });

  it("completes a cycle at take profit and can start the next one right away", () => {
    const c = cfg({ entryRsi: "90" });
    let r = entered(c);
    const tp = places(r.all)[0];
    r = run(
      c,
      [fill(r.s, tp?.clOrdID ?? "", tp?.price ?? "0", tp?.quantity ?? "0", T0 + 9000)],
      r.s,
    );
    expect(r.s).toMatchObject({ phase: "idle", completedCycles: 1, exits: 0 });
    expect(r.all.some((a) => a.type === "cancel")).toBe(true);
    expect(places(run(c, [timer(T0 + 70_000)], r.s).all)).toHaveLength(1);
  });

  it("stops the bot and closes the position at the max loss", () => {
    const c = cfg({ entryRsi: "90", maxLoss: "20", hardStopLossPct: "50" });
    let r = entered(c);
    r = run(c, [tick(T0 + 5000, "60000")], r.s);
    expect(r.all.find((a) => a.type === "stop")).toMatchObject({ close: true });
    expect(r.s.phase).toBe("halted");
  });

  it("places nothing after the max loss stop, even when a late fill arrives", () => {
    const c = cfg({ entryRsi: "90", maxLoss: "20", hardStopLossPct: "50" });
    let r = entered(c);
    const tp = places(r.all)[0];
    r = run(c, [tick(T0 + 5000, "60000")], r.s);
    expect(r.s.phase).toBe("halted");
    const late = run(
      c,
      [fill(r.s, tp?.clOrdID ?? "", "60000", tp?.quantity ?? "0", T0 + 6000)],
      r.s,
    );
    expect(places(late.all)).toHaveLength(0);
    expect(late.s.phase).toBe("halted");
    expect(Number(late.s.ledger.position)).toBe(0);
  });

  it("books a take profit that fills after it was cancelled, so the exit can finish", () => {
    const c = cfg({ entryRsi: "90", hardStopLossPct: "2" });
    let r = entered(c);
    const tp = places(r.all)[0];
    const qty = Number(r.s.ledger.position);
    r = run(c, [tick(T0 + 5000, "78300")], r.s);
    expect(r.s.phase).toBe("exiting");
    const exit = places(r.all).at(-1);
    // Lệnh chốt cũ khớp một nửa trước khi SoDEX huỷ xong; lệnh đóng chỉ khớp phần còn lại (reduce-only).
    const half = String(qty / 2);
    r = run(c, [fill(r.s, tp?.clOrdID ?? "", "78300", half, T0 + 5500)], r.s);
    expect(Number(r.s.ledger.position)).toBeCloseTo(qty / 2, 8);
    r = run(c, [fill(r.s, exit?.clOrdID ?? "", "78300", half, T0 + 6000)], r.s);
    expect(r.s.phase).toBe("idle");
    r = run(c, [{ type: "orderDone", at: T0 + 7000, clOrdID: tp?.clOrdID ?? "" }], r.s);
    expect(r.s.cancelled?.[tp?.clOrdID ?? ""]).toBeUndefined();
  });

  it("pauses after SoDEX rejects the first order three times in a row", () => {
    const c = cfg({ entryRsi: "90" });
    let s = adaptiveDca.initialState(c);
    let all: StrategyAction[] = [];
    for (let i = 0; i < ADCA.maxBaseRejects; i += 1) {
      const r = run(c, [tick(T0 + i * 60_000, "80000"), timer(T0 + i * 60_000 + 1)], s);
      const base = places(r.all).find((o) => o.tag.includes(":base"));
      const rej = run(
        c,
        [{ type: "orderReject", at: T0 + i * 60_000 + 2, clOrdID: base?.clOrdID ?? "", code: "X" }],
        r.s,
      );
      s = rej.s;
      all = rej.all;
    }
    expect(all.some((a) => a.type === "pause")).toBe(true);
    expect(s.phase).toBe("halted");
  });

  it("rejects a cap below the first order", () => {
    expect(adaptiveDcaSchema.safeParse({ ...cfg(), maxExposure: "50" }).success).toBe(false);
  });
});
