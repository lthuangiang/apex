import { describe, expect, it } from "vitest";

import { backtest, type BacktestData, type Candle } from "../backtest";

const RULES = { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "1" };
const FEES = {
  spot: { maker: "0.0004", taker: "0.0007" },
  perps: { maker: "0.00015", taker: "0.00045" },
  builder: "0.0005",
};
const MIN = 60_000;
const T0 = Date.UTC(2026, 6, 1);

const candle = (i: number, o: number, h: number, l: number, c: number): Candle => ({
  t: T0 + i * MIN,
  o: o.toFixed(2),
  h: h.toFixed(2),
  l: l.toFixed(2),
  c: c.toFixed(2),
});
const data = (
  candles: Candle[],
  engine: "spot" | "perps" = "spot",
  market = "vBTC_vUSDC",
  funding: BacktestData["funding"] = {},
): BacktestData => ({
  markets: { [market]: { engine, candles, rules: RULES } },
  funding,
  fees: FEES,
  slippage: "0.0005",
  intervalMs: MIN,
});

const grid = {
  market: "vBTC_vUSDC",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 5,
  spacing: "arithmetic",
  investment: "1000",
  maxLoss: "500",
  onStop: "keep_base",
};

/** CI của GitHub đặt `CI=true`. Package thuần không có kiểu Node nên đọc qua `globalThis`. */
const onCi =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.CI ===
  "true";

/**
 * Tải 1 phút và số CPU của máy (Node `os`, qua `process.getBuiltinModule` như `onCi`); null khi không đọc được.
 * Chỉ dùng để biết một phép đo thời gian thật có đáng tin không (#225).
 */
const machineLoad = (): { load1: number; cpus: number } | null => {
  const os = (
    globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }
  ).process?.getBuiltinModule?.("node:os") as
    { loadavg: () => number[]; cpus: () => unknown[] } | undefined;
  const load1 = os?.loadavg()[0];
  return os === undefined || load1 === undefined ? null : { load1, cpus: os.cpus().length };
};

describe("backtest fill model", () => {
  it("fills the opening market order at the next candle open plus slippage, with taker fee and no builder fee on spot buys", () => {
    const r = backtest(
      "spot_grid",
      grid,
      data([candle(0, 100, 100, 100, 100), candle(1, 101, 101, 101, 101)]),
    );
    const init = r.output.fills.find((f) => f.tag === "grid:init");
    expect(init?.price).toBe("101.0505");
    // taker 0.07%, không có builder fee ở chiều mua Spot.
    expect(Number(init?.fee)).toBeCloseTo(Number(init?.price) * Number(init?.quantity) * 0.0007, 8);
  });

  it("fills limit orders only when price trades through the level, never in the candle that placed them", () => {
    // Nến 0 đặt lưới (mua ở 95, 90; bán ở 105, 110). Nến 2 chạm đúng 95: không khớp. Nến 3 xuyên 95: khớp.
    const candles = [
      candle(0, 100, 100, 100, 100),
      candle(1, 100, 100, 100, 100),
      candle(2, 100, 100, 95, 97),
      candle(3, 97, 97, 94.99, 96),
    ];
    const r = backtest("spot_grid", grid, data(candles));
    const buys = r.output.fills.filter((f) => f.tag !== "grid:init" && f.side === "buy");
    expect(buys).toHaveLength(1);
    expect(buys[0]?.price).toBe("95");
    expect(buys[0]?.at).toBe(T0 + 3 * MIN);
    expect(buys[0]?.maker).toBe(true);
  });

  it("charges the builder fee on spot sells", () => {
    const candles = [
      candle(0, 100, 100, 100, 100),
      candle(1, 100, 100, 100, 100),
      candle(2, 100, 106, 100, 104),
    ];
    const sell = backtest("spot_grid", grid, data(candles)).output.fills.find(
      (f) => f.side === "sell",
    );
    expect(sell?.price).toBe("105");
    expect(Number(sell?.fee)).toBeCloseTo(105 * Number(sell?.quantity) * (0.0004 + 0.0005), 8);
  });

  it("pays funding on perps positions and reports it separately", () => {
    const fgrid = {
      ...grid,
      market: "BTC-USD",
      leverage: 1,
      marginMode: "isolated",
      direction: "short",
      margin: "1000",
      stopBelow: "1",
      onStop: "close_at_market",
      investment: undefined,
    };
    const candles = Array.from({ length: 10 }, (_, i) => candle(i, 100, 100.5, 99.5, 100));
    const r = backtest(
      "futures_grid",
      fgrid,
      data(candles, "perps", "BTC-USD", { "BTC-USD": [{ at: T0 + 5 * MIN, rate: "0.0001" }] }),
    );
    const short = r.output.positions["BTC-USD"] ?? "0";
    expect(Number(short)).toBeLessThan(0);
    // Short nhận funding khi rate dương: funding (trả) âm.
    expect(Number(r.funding)).toBeLessThan(0);
    expect(r.metrics.map((m) => m.key)).toEqual(["fills", "timeInRange"]);
  });

  it("is deterministic and reports drawdown, equity and grid metrics", () => {
    const candles = Array.from({ length: 600 }, (_, i) => {
      const p = 100 + 8 * Math.sin(i / 30);
      return candle(i, p, p + 0.6, p - 0.6, p + 0.1);
    });
    const a = backtest("spot_grid", grid, data(candles));
    const b = backtest("spot_grid", grid, data(candles));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.candles).toBe(600);
    expect(Number(a.metrics.find((m) => m.key === "fills")?.value)).toBeGreaterThan(5);
    expect(a.metrics.find((m) => m.key === "timeInRange")?.value).toBe("100");
    expect(Number(a.maxDrawdown)).toBeGreaterThanOrEqual(0);
    expect(a.equity.length).toBeLessThanOrEqual(201);
  });

  it("stops with the strategy's stop loss and closes the position", () => {
    const dca = {
      market: "vBTC_vUSDC",
      baseOrder: "100",
      safetyOrder: "100",
      maxSafetyOrders: 1,
      firstStepPct: "1",
      stepMultiplier: "1",
      sizeMultiplier: "1",
      takeProfitPct: "2",
      start: "immediately",
      stopLossPct: "5",
    };
    const candles = [
      candle(0, 100, 100, 100, 100),
      candle(1, 100, 100, 100, 100),
      ...Array.from({ length: 10 }, (_, i) => candle(i + 2, 100 - i, 100 - i, 99 - i, 99 - i)),
    ];
    const r = backtest("spot_dca", dca, data(candles));
    expect(r.halted).toBe("STOP_LOSS");
    expect(r.output.fills.at(-1)?.tag).toBe("close");
    expect(r.output.positions.vBTC_vUSDC).toBe("0");
  });

  it("spreads a Rebalancing Initial buy over N hours (IMP-04)", () => {
    const flat = Array.from({ length: 6 * 60 }, (_, i) => candle(i, 100, 100, 100, 100));
    const cfg = {
      quoteAsset: "USDC",
      assets: [
        { asset: "BTC", market: "vBTC_vUSDC", weightPct: "50" },
        { asset: "USDC", weightPct: "50" },
      ],
      rebalanceWhen: "threshold",
      thresholdPct: "5",
      investment: "1000",
      maxTradePct: "100",
    };
    const now = backtest("rebalancing", cfg, data(flat));
    const over = backtest(
      "rebalancing",
      { ...cfg, initialBuy: "over_hours", initialBuyHours: 4 },
      data(flat),
    );
    const hours = (r: typeof now) =>
      new Set(r.output.fills.map((f) => Math.floor((f.at - T0) / 3_600_000))).size;
    expect(hours(now)).toBe(1);
    expect(hours(over)).toBe(4);
    const bought = (r: typeof now) => r.output.fills.reduce((a, f) => a + Number(f.quantity), 0);
    expect(bought(over)).toBeCloseTo(bought(now), 2);
  });

  // Ngưỡng ROADMAP P9 "90 ngày p95 < 20 s"; runner GitHub 2 vCPU chạy test song song nên đo không đúng: kiểm ở máy dev (DEC-175).
  // Đo thời gian thật chỉ có nghĩa khi máy rảnh (#225): cùng code mất ~9 s lúc rảnh nhưng 48 s khi máy dev chạy song song
  // test của package khác / worktree khác (tải 1 phút ~60 trên 16 luồng), dù thời gian CPU của backtest không đổi so với
  // lúc DEC-175. Nên test kiểm hai điều:
  // (1) luôn kiểm: 90 ngày tốn không quá 20 lần một lần chạy 9 ngày đo ngay trước và ngay sau, cùng mức tải (tuyến tính là
  //     10 lần; chi phí mỗi nến tăng theo lịch sử thì ≥ 50 lần), nên bắt được backtest chậm đi theo độ dài dữ liệu dù máy bận;
  // (2) ngưỡng tuyệt đối 20 s chỉ kiểm khi máy không quá tải trong lúc đo (tải 1 phút ≤ số CPU, trước và sau).
  it.skipIf(onCi)(
    "runs 90 days of one-minute candles well under 20 s",
    () => {
      const days = (d: number) =>
        Array.from({ length: d * 24 * 60 }, (_, i) => {
          const p = 100 + 9 * Math.sin(i / 700) + Math.sin(i / 13);
          return candle(i, p, p + 0.3, p - 0.3, p + 0.05);
        });
      const timed = (candles: Candle[]) => {
        const started = Date.now();
        const r = backtest("spot_grid", { ...grid, gridLevels: 20 }, data(candles));
        expect(r.candles).toBe(candles.length);
        return Date.now() - started;
      };
      const short = days(9);
      const long = days(90);
      const loadBefore = machineLoad();
      const before = timed(short);
      const ms = timed(long);
      const after = timed(short);
      const loadAfter = machineLoad();
      // Lần 9 ngày đầu còn gồm thời gian JIT khởi động: chỉ làm phép so sánh dễ hơn, không gắt hơn.
      expect(ms).toBeLessThan(20 * Math.max(1, (before + after) / 2));
      const idle = [loadBefore, loadAfter].every((l) => l !== null && l.load1 <= l.cpus);
      if (idle) expect(ms).toBeLessThan(20_000);
    },
    // Trần chống treo, không phải ngưỡng hiệu năng: 108 ngày nến khi máy bận có thể quá 60 s.
    240_000,
  );
});

describe("Volume Farming backtest (DEC-102)", () => {
  // 600 nến 1 phút: dao động hình sin quanh 100 cộng xu hướng nhẹ, có khối lượng.
  const wave = Array.from({ length: 600 }, (_, i) => {
    const mid = (k: number) => 100 + Math.sin(k / 15) * 1.5 + k * 0.002;
    const o = mid(i);
    const c = mid(i + 1);
    return {
      ...candle(i, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c),
      v: String(50 + (i % 7)),
    };
  });
  const farm = {
    market: "BTC-USD",
    leverage: 5,
    marginMode: "cross",
    orderSizeMinUsd: "100",
    orderSizeMaxUsd: "150",
    minHoldSecs: 120,
    maxHoldSecs: 600,
    maxLoss: "50",
    cooldownSecs: 0,
  };

  it("feeds 1-minute candles with the timer and reports volume, trades and win rate", () => {
    const r = backtest("volume_farm", farm, data(wave, "perps", "BTC-USD"));
    const metric = (k: string) => r.metrics.find((m) => m.key === k)?.value ?? null;
    expect(Number(metric("trades"))).toBeGreaterThan(0);
    expect(Number(metric("volumeMade"))).toBeGreaterThan(0);
    expect(metric("winRate")).not.toBeNull();
    expect(r.output.fills.some((f) => f.tag.startsWith("vf:"))).toBe(true);
    // BT-01: chi phí ròng và chi phí mỗi $1M như Market Making (cost = −net; per $1M = cost ÷ volume × 1.000.000).
    const cost = Number(metric("netCost"));
    expect(cost).toBeCloseTo(-Number(r.net), 6);
    expect(Number(metric("costPerMillion"))).toBeCloseTo(
      (cost / Number(metric("volumeMade"))) * 1_000_000,
      1,
    );
  });

  it("is repeatable on the same candles", () => {
    const a = backtest("volume_farm", farm, data(wave, "perps", "BTC-USD"));
    const b = backtest("volume_farm", farm, data(wave, "perps", "BTC-USD"));
    expect(a.net).toBe(b.net);
    expect(a.metrics).toEqual(b.metrics);
  });
});
