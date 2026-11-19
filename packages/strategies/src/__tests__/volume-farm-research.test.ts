import { describe, expect, it } from "vitest";

import { runBacktest, type Candle } from "../backtest/run";
import type {
  BookTop,
  MinuteCandle,
  StepContext,
  StrategyAction,
  StrategyEvent,
  VbResearchOptions,
} from "../core/types";
import { farmRandom, volumeFarm, type VolumeFarmState } from "../volume-farm";
import { volumeFarmSchema, type VolumeFarmConfig } from "../volume-farm/schema";
import { counterTrendBlocked, farmSignal } from "../volume-farm/signal";

// #282: biến thể bộ chặn ngược xu hướng chỉ cho công cụ nghiên cứu. Mặc định (không có `ctx.vbResearch`) phải giữ đúng
// hành vi bot thật; test volume-farm.test.ts không đổi.

const ctx: StepContext = {
  botId: "vf-bot",
  version: 1,
  rules: {
    "BTC-USD": { tickSize: "1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" },
  },
  feeRate: "0.00012",
};
const withMode = (r: VbResearchOptions): StepContext => ({ ...ctx, vbResearch: r });

const cfg = (over: Partial<Record<string, unknown>> = {}): VolumeFarmConfig =>
  volumeFarmSchema.parse({
    market: "BTC-USD",
    leverage: 20,
    marginMode: "cross",
    orderSizeMinUsd: "100",
    orderSizeMaxUsd: "200",
    minHoldSecs: 120,
    maxHoldSecs: 180,
    cooldownSecs: 30,
    maxLoss: "20",
    maxSpreadBps: "200",
    ...over,
  });

const T0 = Date.parse("2026-10-30T03:00:00Z");

/** 120 nến 1 phút trôi `drift` mỗi nến; 3 nến cuối trôi `tail` (đảo chiều ngắn hạn khi khác dấu). */
function candles(drift: number, tail: number): MinuteCandle[] {
  const count = 120;
  return Array.from({ length: count }, (_, i) => {
    const t = T0 - (count - i) * 60_000;
    const k = i - (count - 3);
    const o = 80_000 * (1 + drift * i + (k >= 0 ? (tail - drift) * k : 0));
    const c = o * (1 + (k >= 0 ? tail : drift));
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
/** Sổ quanh giá đóng cuối, hai bên cân nhau (thành phần sổ lệnh trung tính). */
function bookAt(cs: readonly MinuteCandle[]): BookTop {
  const bid = Math.round(Number(cs.at(-1)?.c ?? "0"));
  return { bid: String(bid), ask: String(bid + 1), bidNotional: "500000", askNotional: "500000" };
}
const timerOf = (cs: MinuteCandle[]): StrategyEvent => ({
  type: "timer",
  at: T0,
  market: { market: "BTC-USD", candles: cs, book: bookAt(cs) },
});

/** Xu hướng tăng, 3 phút cuối giảm: tín hiệu short yếu (≈ 0.40) trong TREND_UP. */
const UP_DIP = candles(0.0001, -0.0005);
/** Xu hướng tăng, 3 phút cuối tăng mạnh hơn: tín hiệu long (≈ 0.62) trong TREND_UP. */
const UP_RUN = candles(0.0001, 0.0005);
/** Xu hướng giảm, 3 phút cuối hồi: tín hiệu long yếu trong TREND_DOWN. */
const DOWN_BOUNCE = candles(-0.0001, 0.0005);

function run(c: VolumeFarmConfig, e: StrategyEvent, cx: StepContext, start?: VolumeFarmState) {
  const r = volumeFarm.step(c, start ?? volumeFarm.initialState(c), e, cx);
  return r;
}
const sideOf = (a: readonly StrategyAction[]) => {
  const p = a.find((x): x is Extract<StrategyAction, { type: "place" }> => x.type === "place");
  return p?.order.side ?? null;
};
const skipOf = (a: readonly StrategyAction[]) =>
  a.flatMap((x) => (x.type === "log" && x.decision === "Skipped entry" ? [x.why] : []))[0] ?? null;
const balancedStart = (c: VolumeFarmConfig): VolumeFarmState => ({
  ...volumeFarm.initialState(c),
  netExposure: "300",
  lastSide: "long",
});

describe("counterTrendBlocked (apex threshold 0.70)", () => {
  it("blocks weak shorts in an uptrend and weak longs in a downtrend only", () => {
    expect(counterTrendBlocked("TREND_UP", "short", 0.31)).toBe(true);
    expect(counterTrendBlocked("TREND_UP", "short", 0.3)).toBe(false);
    expect(counterTrendBlocked("TREND_UP", "long", 0.6)).toBe(false);
    expect(counterTrendBlocked("TREND_DOWN", "long", 0.69)).toBe(true);
    expect(counterTrendBlocked("TREND_DOWN", "long", 0.7)).toBe(false);
    expect(counterTrendBlocked("TREND_DOWN", "short", 0.4)).toBe(false);
    expect(counterTrendBlocked("SIDEWAY", "short", 0.45)).toBe(false);
    expect(counterTrendBlocked("HIGH_VOLATILITY", "long", 0.55)).toBe(false);
  });
});

describe("farmSignal counterTrend option", () => {
  it("default and counterTrend: true are identical", () => {
    for (const cs of [UP_DIP, UP_RUN, DOWN_BOUNCE]) {
      const b = bookAt(cs);
      expect(farmSignal(cs, b, T0, 200, { counterTrend: true })).toEqual(
        farmSignal(cs, b, T0, 200),
      );
    }
  });

  it("counterTrend: false keeps the scored direction instead of COUNTER_TREND_BLOCKED", () => {
    const dip = farmSignal(UP_DIP, bookAt(UP_DIP), T0, 200);
    expect(dip.regime).toBe("TREND_UP");
    expect(dip.reason).toMatch(/^COUNTER_TREND_BLOCKED/);
    const off = farmSignal(UP_DIP, bookAt(UP_DIP), T0, 200, { counterTrend: false });
    expect(off.direction).toBe("short");
    expect(off.score).toBe(dip.score);
    expect(off.regime).toBe(dip.regime);
    const bounce = farmSignal(DOWN_BOUNCE, bookAt(DOWN_BOUNCE), T0, 200, { counterTrend: false });
    expect(bounce.regime).toBe("TREND_DOWN");
    expect(bounce.direction).toBe("long");
  });
});

describe("volume farm research variants (#282)", () => {
  const cases: [string, MinuteCandle[], boolean, boolean][] = [
    ["up dip", UP_DIP, false, false],
    ["up dip, reverse", UP_DIP, true, false],
    ["up run", UP_RUN, false, false],
    ["up run, reverse", UP_RUN, true, false],
    ["up run, balance", UP_RUN, false, true],
    ["down bounce, reverse", DOWN_BOUNCE, true, false],
  ];

  it("pre_and_post is exactly the live behaviour (no vbResearch)", () => {
    for (const [, cs, reverse, balanced] of cases) {
      const c = cfg({ reverseSignal: reverse });
      const start = balanced ? balancedStart(c) : undefined;
      expect(run(c, timerOf(cs), withMode({ counterTrendMode: "pre_and_post" }), start)).toEqual(
        run(c, timerOf(cs), ctx, start),
      );
    }
  });

  // Hướng vào (buy / sell) hoặc null = bỏ lượt, theo biến thể A–D.
  const expected: Record<string, Record<"A" | "B" | "C" | "D", "buy" | "sell" | null>> = {
    // Tín hiệu short yếu trong uptrend, giá vừa giảm 3 phút.
    "up dip": { A: null, B: null, C: "sell", D: null },
    // Reverse → long, cùng xu hướng; A vẫn chặn vì bước chặn trước khi đảo.
    "up dip, reverse": { A: null, B: "buy", C: "buy", D: "buy" },
    "up run": { A: "buy", B: "buy", C: "buy", D: null },
    "up run, reverse": { A: null, B: null, C: "sell", D: "sell" },
    // Cân long / short buộc short trong uptrend: A cho qua (chặn trên hướng tín hiệu), B chặn hướng cuối.
    "up run, balance": { A: "sell", B: null, C: "sell", D: "sell" },
    "down bounce, reverse": { A: null, B: "sell", C: "sell", D: "sell" },
  };
  const modes = { A: "pre_and_post", B: "final_only", C: "off", D: "fade" } as const;

  for (const [name, cs, reverse, balanced] of cases)
    it(`enters as expected per variant: ${name}`, () => {
      const c = cfg({ reverseSignal: reverse });
      const start = balanced ? balancedStart(c) : undefined;
      const want = expected[name];
      if (want === undefined) throw new Error(`missing expectation for ${name}`);
      for (const k of ["A", "B", "C", "D"] as const) {
        const r = run(c, timerOf(cs), withMode({ counterTrendMode: modes[k] }), start);
        expect([k, sideOf(r.actions)]).toEqual([k, want[k]]);
        if (want[k] === null) expect(skipOf(r.actions)).not.toBeNull();
      }
    });

  it("fade explains the skip and blocks on the final direction", () => {
    const r = run(cfg(), timerOf(UP_RUN), withMode({ counterTrendMode: "fade" }));
    expect(r.state.lastSkip).toBe("FADE_WITH_MOVE");
    expect(skipOf(r.actions)).toMatch(/does not fade the last 3 min move/);
  });

  it("random direction ignores the signal, Reverse and balance", () => {
    const want = farmRandom(ctx.botId, 1, "dir") < 0.5 ? "buy" : "sell";
    for (const [, cs, reverse, balanced] of cases) {
      const c = cfg({ reverseSignal: reverse });
      const start = balanced ? balancedStart(c) : undefined;
      const r = run(c, timerOf(cs), withMode({ randomDirection: true }), start);
      expect(sideOf(r.actions)).toBe(want);
    }
  });

  it("a full backtest is unchanged with pre_and_post", () => {
    // Đường giá có cả đoạn tăng, giảm và đi ngang (tất định).
    const ks: Candle[] = [];
    let p = 80_000;
    const start = Date.parse("2026-11-01T00:00:00Z");
    for (let i = 0; i < 600; i += 1) {
      const drift = i < 200 ? 0.0002 : i < 400 ? -0.0002 : 0;
      const wave = Math.sin(i / 7) * 0.0006;
      const o = p;
      const c = p * (1 + drift + wave);
      ks.push({
        t: start + i * 60_000,
        o: o.toFixed(1),
        h: (Math.max(o, c) * 1.0004).toFixed(1),
        l: (Math.min(o, c) * 0.9996).toFixed(1),
        c: c.toFixed(1),
        v: String(5 + (i % 11)),
      });
      p = c;
    }
    const base = {
      module: volumeFarm,
      markets: {
        "BTC-USD": {
          engine: "perps" as const,
          candles: ks,
          rules: { tickSize: "0.1", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" },
        },
      },
      funding: {},
      fees: {
        spot: { maker: "0.00035", taker: "0.00065" },
        perps: { maker: "0.00012", taker: "0.0004" },
        builder: "0.00005",
      },
      slippage: "0.0005",
      intervalMs: 60_000,
      capital: "10000",
      snapshotCandles: 120,
    };
    for (const reverse of [false, true]) {
      const config = cfg({ reverseSignal: reverse, maxLoss: "100000", maxSpreadBps: "10" });
      const live = runBacktest({ ...base, config });
      const a = runBacktest({ ...base, config, vbResearch: { counterTrendMode: "pre_and_post" } });
      expect(live.fills.length).toBeGreaterThan(10);
      expect(a.actions).toEqual(live.actions);
      expect(a.fills).toEqual(live.fills);
      // Biến thể khác thật sự đổi kết quả trên cùng dữ liệu (test không rỗng nghĩa).
      const off = runBacktest({ ...base, config, vbResearch: { counterTrendMode: "off" } });
      expect(off.fills).not.toEqual(live.fills);
    }
  }, 30_000);
});
