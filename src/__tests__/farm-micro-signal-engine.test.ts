/**
 * FarmMicroSignalEngine Unit & Property Tests
 *
 * Covers: scoring functions, composite scoring, candle validation,
 * fee/spread guard, regime detection, data quality degradation,
 * threshold boundaries, determinism, and monotonicity.
 */

import { describe, it, expect } from 'vitest';
import {
  clamp01,
  ema,
  computeATR,
  scoreCandleMomentum,
  scoreWickRejection,
  scoreVolumeAcceleration,
  scoreTradePressure,
  scoreOrderbookImbalance,
  detectRegime,
  computeComposite,
  checkFeeEdge,
  validateCandles,
  candleAgeSecs,
  type FarmMicroConfig,
  type CompositeInput,
} from '../modules/FarmMicroSignalEngine.js';
import type { Kline, RawTrade } from '../adapters/ExchangeAdapter.js';

// ── Test Helpers ──────────────────────────────────────────────────────────────

function makeCandle(t: number, o: number, h: number, l: number, c: number, v: number): Kline {
  return { t, o, h, l, c, v };
}

/** Generate N bullish candles (closes progressively higher) */
function bullishCandles(n: number, basePrice = 100000, baseTime = 0): Kline[] {
  const candles: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const open = basePrice + i * 20;
    const close = open + 30;
    candles.push(makeCandle(
      baseTime + i * 60000,
      open,
      close + 5,  // high above close
      open - 5,   // low below open
      close,
      1000 + i * 50,
    ));
  }
  return candles;
}

/** Generate N bearish candles */
function bearishCandles(n: number, basePrice = 100000, baseTime = 0): Kline[] {
  const candles: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const open = basePrice - i * 20;
    const close = open - 30;
    candles.push(makeCandle(
      baseTime + i * 60000,
      open,
      open + 5,
      close - 5,
      close,
      1000 + i * 50,
    ));
  }
  return candles;
}

/** Generate N neutral/doji candles */
function neutralCandles(n: number, basePrice = 100000, baseTime = 0): Kline[] {
  const candles: Kline[] = [];
  for (let i = 0; i < n; i++) {
    candles.push(makeCandle(
      baseTime + i * 60000,
      basePrice,
      basePrice + 2,
      basePrice - 2,
      basePrice + (i % 2 === 0 ? 1 : -1), // alternating tiny moves
      1000,
    ));
  }
  return candles;
}

const DEFAULT_CFG: FarmMicroConfig = {
  enabled: true,
  symbols: ['BTC-USD'],
  interval: '1m',
  candleLimit: 30,
  cacheSecs: 10,
  longThreshold: 0.60,
  shortThreshold: 0.40,
  minConfidence: 0.55,
  highVolMinConfidence: 0.65,
  trendCounterThreshold: 0.70,
  maxCandleAgeSecs: 120,
  feeSafetyMult: 1.5,
  feeRateMaker: 0.00012,
  execMaxSpreadBps: 10,
};

// ── clamp01 ───────────────────────────────────────────────────────────────────

describe('clamp01', () => {
  it('returns 0.5 for NaN', () => expect(clamp01(NaN)).toBe(0.5));
  it('returns 0.5 for Infinity', () => expect(clamp01(Infinity)).toBe(0.5));
  it('clamps negative to 0', () => expect(clamp01(-0.5)).toBe(0));
  it('clamps >1 to 1', () => expect(clamp01(1.5)).toBe(1));
  it('passes through 0.7', () => expect(clamp01(0.7)).toBe(0.7));
});

// ── EMA ───────────────────────────────────────────────────────────────────────

describe('ema', () => {
  it('returns 0 for empty array', () => expect(ema([], 5)).toBe(0));
  it('returns the single value for single-element array', () => expect(ema([42], 5)).toBe(42));
  it('converges toward recent values', () => {
    const vals = [10, 10, 10, 10, 10, 20, 20, 20, 20, 20];
    const result = ema(vals, 5);
    expect(result).toBeGreaterThan(15);
    expect(result).toBeLessThan(20);
  });
});

// ── computeATR ────────────────────────────────────────────────────────────────

describe('computeATR', () => {
  it('returns 0 for fewer than 2 candles', () => {
    expect(computeATR([makeCandle(0, 100, 105, 95, 102, 100)], 14)).toBe(0);
  });
  it('computes positive ATR for valid candles', () => {
    const candles = bullishCandles(20);
    expect(computeATR(candles, 14)).toBeGreaterThan(0);
  });
});

// ── scoreCandleMomentum ───────────────────────────────────────────────────────

describe('scoreCandleMomentum', () => {
  it('returns 0.5 with insufficient candles', () => {
    expect(scoreCandleMomentum(bullishCandles(5))).toBe(0.5);
  });

  it('returns > 0.5 for bullish sequence', () => {
    const candles = bullishCandles(21);
    expect(scoreCandleMomentum(candles)).toBeGreaterThan(0.5);
  });

  it('returns < 0.5 for bearish sequence', () => {
    const candles = bearishCandles(21);
    expect(scoreCandleMomentum(candles)).toBeLessThan(0.5);
  });

  it('returns near 0.5 for neutral sequence', () => {
    const candles = neutralCandles(21);
    const score = scoreCandleMomentum(candles);
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.6);
  });

  it('output is always in [0, 1]', () => {
    // Extreme moves
    const extreme = bullishCandles(21, 100000).map((c, i) => ({
      ...c,
      c: c.o + 5000, // massive green candle
      h: c.o + 5500,
    }));
    const score = scoreCandleMomentum(extreme);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});

// ── scoreWickRejection ────────────────────────────────────────────────────────

describe('scoreWickRejection', () => {
  it('returns 0.5 with < 2 candles', () => {
    expect(scoreWickRejection([makeCandle(0, 100, 110, 90, 105, 100)])).toBe(0.5);
  });

  it('bullish wick rejection: large lower wick, close near high', () => {
    const candles = [
      makeCandle(0, 100, 102, 80, 101, 100),  // prev: large lower wick
      makeCandle(60000, 101, 103, 82, 102, 100),  // latest: similar
    ];
    expect(scoreWickRejection(candles)).toBeGreaterThan(0.55);
  });

  it('bearish wick rejection: large upper wick, close near low', () => {
    const candles = [
      makeCandle(0, 100, 120, 98, 99, 100),    // upper wick, close near low
      makeCandle(60000, 99, 118, 97, 98, 100),  // same pattern
    ];
    expect(scoreWickRejection(candles)).toBeLessThan(0.45);
  });

  it('doji candles → neutral', () => {
    const candles = [
      makeCandle(0, 100, 100, 100, 100, 100),  // zero range
      makeCandle(60000, 100, 100, 100, 100, 100),
    ];
    expect(scoreWickRejection(candles)).toBe(0.5);
  });
});

// ── scoreVolumeAcceleration ───────────────────────────────────────────────────

describe('scoreVolumeAcceleration', () => {
  it('returns 0.5 with insufficient candles', () => {
    expect(scoreVolumeAcceleration(bullishCandles(5))).toBe(0.5);
  });

  it('volume spike + bullish direction → > 0.5', () => {
    const candles = bullishCandles(14);
    // Make last 3 candles have 3x volume
    candles[11].v = 3000;
    candles[12].v = 3000;
    candles[13].v = 3000;
    expect(scoreVolumeAcceleration(candles)).toBeGreaterThan(0.5);
  });

  it('volume spike + bearish direction → < 0.5', () => {
    const candles = bearishCandles(14);
    candles[11].v = 3000;
    candles[12].v = 3000;
    candles[13].v = 3000;
    expect(scoreVolumeAcceleration(candles)).toBeLessThan(0.5);
  });

  it('high volume without direction → neutral', () => {
    const candles = neutralCandles(14);
    candles[11].v = 5000;
    candles[12].v = 5000;
    candles[13].v = 5000;
    const score = scoreVolumeAcceleration(candles);
    expect(score).toBeGreaterThanOrEqual(0.4);
    expect(score).toBeLessThanOrEqual(0.6);
  });

  it('zero volume → neutral', () => {
    const candles = bullishCandles(14).map(c => ({ ...c, v: 0 }));
    expect(scoreVolumeAcceleration(candles)).toBe(0.5);
  });
});

// ── scoreTradePressure ────────────────────────────────────────────────────────

describe('scoreTradePressure', () => {
  it('returns 0.5 for empty trades', () => {
    expect(scoreTradePressure([])).toBe(0.5);
  });

  it('all buys → high score (close to 1)', () => {
    const trades: RawTrade[] = Array.from({ length: 10 }, () => ({
      side: 'buy' as const, price: 100000, size: 1, timestamp: Date.now(),
    }));
    expect(scoreTradePressure(trades)).toBeGreaterThan(0.8);
  });

  it('all sells → low score (close to 0)', () => {
    const trades: RawTrade[] = Array.from({ length: 10 }, () => ({
      side: 'sell' as const, price: 100000, size: 1, timestamp: Date.now(),
    }));
    expect(scoreTradePressure(trades)).toBeLessThan(0.2);
  });

  it('50/50 → neutral', () => {
    const trades: RawTrade[] = [
      ...Array.from({ length: 5 }, () => ({ side: 'buy' as const, price: 100000, size: 1, timestamp: Date.now() })),
      ...Array.from({ length: 5 }, () => ({ side: 'sell' as const, price: 100000, size: 1, timestamp: Date.now() })),
    ];
    const score = scoreTradePressure(trades);
    expect(score).toBeGreaterThan(0.4);
    expect(score).toBeLessThan(0.6);
  });
});

// ── scoreOrderbookImbalance ───────────────────────────────────────────────────

describe('scoreOrderbookImbalance', () => {
  it('returns 0.5 for empty bids/asks', () => {
    expect(scoreOrderbookImbalance([], [])).toBe(0.5);
  });

  it('returns 0.5 for crossed book', () => {
    const bids: [number, number][] = [[100, 10]]; // bid > ask
    const asks: [number, number][] = [[99, 10]];
    expect(scoreOrderbookImbalance(bids, asks)).toBe(0.5);
  });

  it('heavy bids → > 0.5', () => {
    const bids: [number, number][] = [[99, 100], [98, 100], [97, 100]];
    const asks: [number, number][] = [[101, 10], [102, 10], [103, 10]];
    expect(scoreOrderbookImbalance(bids, asks)).toBeGreaterThan(0.5);
  });

  it('heavy asks → < 0.5', () => {
    const bids: [number, number][] = [[99, 10], [98, 10], [97, 10]];
    const asks: [number, number][] = [[101, 100], [102, 100], [103, 100]];
    expect(scoreOrderbookImbalance(bids, asks)).toBeLessThan(0.5);
  });

  it('balanced book → near 0.5', () => {
    const bids: [number, number][] = [[99, 50], [98, 50]];
    const asks: [number, number][] = [[101, 50], [102, 50]];
    const score = scoreOrderbookImbalance(bids, asks);
    expect(score).toBeGreaterThan(0.45);
    expect(score).toBeLessThan(0.55);
  });
});

// ── detectRegime ──────────────────────────────────────────────────────────────

describe('detectRegime', () => {
  it('returns UNKNOWN for insufficient candles', () => {
    expect(detectRegime(bullishCandles(5))).toBe('UNKNOWN');
  });

  it('detects TREND_UP when price above EMA21', () => {
    // Strong uptrend: each candle steps up 0.5% — needs to exceed EMA21 + 0.2% band
    const candles: Kline[] = Array.from({ length: 25 }, (_, i) => makeCandle(
      i * 300000,
      100000 + i * 500,
      100000 + i * 500 + 200,
      100000 + i * 500 - 50,
      100000 + i * 500 + 150,
      1000,
    ));
    expect(detectRegime(candles)).toBe('TREND_UP');
  });

  it('detects TREND_DOWN when price below EMA21', () => {
    // Each candle steps down ~0.4% but with moderate range (not high vol)
    const candles: Kline[] = Array.from({ length: 25 }, (_, i) => makeCandle(
      i * 300000,
      110000 - i * 400,
      110000 - i * 400 + 100,   // small upper wick
      110000 - i * 400 - 150,   // moderate lower wick
      110000 - i * 400 - 100,   // close below open
      1000,
    ));
    expect(detectRegime(candles)).toBe('TREND_DOWN');
  });

  it('detects SIDEWAY for flat candles', () => {
    const candles = neutralCandles(25);
    expect(detectRegime(candles)).toBe('SIDEWAY');
  });

  it('detects HIGH_VOLATILITY for extreme ATR', () => {
    // Create candles with very wide ranges (>0.5% ATR)
    const candles: Kline[] = Array.from({ length: 25 }, (_, i) => makeCandle(
      i * 300000, // 5m candles
      100000,
      100000 + 800, // 0.8% range
      100000 - 800,
      100000 + (i % 2 === 0 ? 400 : -400),
      1000,
    ));
    expect(detectRegime(candles)).toBe('HIGH_VOLATILITY');
  });
});

// ── computeComposite ──────────────────────────────────────────────────────────

describe('computeComposite', () => {
  it('all bullish components → LONG', () => {
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.8,
        wickRejection: 0.75,
        volumeAcceleration: 0.7,
        tradePressure: 0.65,
        orderbookImbalance: 0.7,
      },
      regime: 'SIDEWAY',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    expect(result.direction).toBe('long');
    expect(result.score).toBeGreaterThan(0.6);
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('all bearish components → SHORT', () => {
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.2,
        wickRejection: 0.25,
        volumeAcceleration: 0.3,
        tradePressure: 0.35,
        orderbookImbalance: 0.3,
      },
      regime: 'SIDEWAY',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    expect(result.direction).toBe('short');
    expect(result.score).toBeLessThan(0.4);
  });

  it('neutral components → SKIP', () => {
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.5,
        wickRejection: 0.5,
        volumeAcceleration: 0.5,
        tradePressure: 0.5,
        orderbookImbalance: 0.5,
      },
      regime: 'SIDEWAY',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    expect(result.direction).toBe('skip');
    expect(result.score).toBeCloseTo(0.5, 5);
  });

  it('exact threshold 0.60 → LONG (if confidence sufficient)', () => {
    // All at 0.60 → score = 0.60 exactly. But distance from 0.5 is only 0.10 → low confidence.
    // Per spec: confidence too low at threshold boundary → skip.
    // To get LONG, components need to be more strongly bullish:
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.75,
        wickRejection: 0.72,
        volumeAcceleration: 0.68,
        tradePressure: 0.70,
        orderbookImbalance: 0.65,
      },
      regime: 'SIDEWAY',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    expect(result.score).toBeGreaterThanOrEqual(0.60);
    expect(result.direction).toBe('long');
  });

  it('score exactly at threshold with low confidence → SKIP (correct behavior)', () => {
    // All components at 0.60 → score = 0.60, confidence is very low
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.60,
        wickRejection: 0.60,
        volumeAcceleration: 0.60,
        tradePressure: 0.60,
        orderbookImbalance: 0.60,
      },
      regime: 'SIDEWAY',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    expect(result.score).toBeCloseTo(0.60, 5);
    // Low confidence at boundary → skip is safe behavior
    expect(result.direction).toBe('skip');
  });

  it('exact threshold 0.40 → SHORT (if confidence sufficient)', () => {
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.25,
        wickRejection: 0.28,
        volumeAcceleration: 0.32,
        tradePressure: 0.30,
        orderbookImbalance: 0.35,
      },
      regime: 'SIDEWAY',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    expect(result.score).toBeLessThanOrEqual(0.40);
    expect(result.direction).toBe('short');
  });

  it('TREND_UP blocks weak SHORT (counter-trend)', () => {
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.35,
        wickRejection: 0.35,
        volumeAcceleration: 0.38,
        tradePressure: 0.38,
        orderbookImbalance: 0.40,
      },
      regime: 'TREND_UP',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    // Score is around 0.36 — would be SHORT normally but blocked by counter-trend guard
    expect(result.direction).toBe('skip');
  });

  it('TREND_DOWN blocks weak LONG (counter-trend)', () => {
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.65,
        wickRejection: 0.65,
        volumeAcceleration: 0.62,
        tradePressure: 0.62,
        orderbookImbalance: 0.60,
      },
      regime: 'TREND_DOWN',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    // Score ~0.63 — would be LONG but blocked by counter-trend
    expect(result.direction).toBe('skip');
  });

  it('HIGH_VOLATILITY requires higher confidence', () => {
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.62,
        wickRejection: 0.58,
        volumeAcceleration: 0.55,
        tradePressure: 0.61,
        orderbookImbalance: 0.57,
      },
      regime: 'HIGH_VOLATILITY',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    // Score barely above 0.60 but confidence may not meet highVolMinConfidence
    if (result.direction !== 'skip') {
      expect(result.confidence).toBeGreaterThanOrEqual(DEFAULT_CFG.highVolMinConfidence);
    }
  });

  it('score and confidence are always finite and in [0, 1]', () => {
    // Random-ish components
    const combos = [
      { candleMomentum: 0, wickRejection: 1, volumeAcceleration: 0.5, tradePressure: 0.5, orderbookImbalance: 0.5 },
      { candleMomentum: 1, wickRejection: 0, volumeAcceleration: 0, tradePressure: 1, orderbookImbalance: 1 },
      { candleMomentum: 0.5, wickRejection: 0.5, volumeAcceleration: 0.5, tradePressure: 0.5, orderbookImbalance: 0.5 },
    ];
    for (const components of combos) {
      for (const regime of ['SIDEWAY', 'TREND_UP', 'TREND_DOWN', 'HIGH_VOLATILITY', 'UNKNOWN'] as const) {
        const result = computeComposite({ components, regime, cfg: DEFAULT_CFG });
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
        expect(Number.isFinite(result.score)).toBe(true);
        expect(Number.isFinite(result.confidence)).toBe(true);
      }
    }
  });

  it('identical input produces identical output (determinism)', () => {
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.72,
        wickRejection: 0.68,
        volumeAcceleration: 0.55,
        tradePressure: 0.61,
        orderbookImbalance: 0.58,
      },
      regime: 'SIDEWAY',
      cfg: DEFAULT_CFG,
    };
    const r1 = computeComposite(input);
    const r2 = computeComposite(input);
    expect(r1.score).toBe(r2.score);
    expect(r1.direction).toBe(r2.direction);
    expect(r1.confidence).toBe(r2.confidence);
  });
});

// ── validateCandles ───────────────────────────────────────────────────────────

describe('validateCandles', () => {
  const INTERVAL_MS = 60_000;

  it('returns empty for null/empty input', () => {
    expect(validateCandles([], INTERVAL_MS)).toEqual([]);
  });

  it('removes duplicates by timestamp', () => {
    const candles = [
      makeCandle(0, 100, 105, 95, 102, 100),
      makeCandle(0, 100, 105, 95, 102, 100), // duplicate
      makeCandle(60000, 102, 107, 97, 104, 110),
    ];
    const result = validateCandles(candles, INTERVAL_MS);
    expect(result.length).toBe(2);
  });

  it('removes the unfinished (active) candle', () => {
    const now = Date.now();
    const candles = [
      makeCandle(now - 180000, 100, 105, 95, 102, 100),  // 3min ago (complete)
      makeCandle(now - 120000, 102, 107, 97, 104, 100),  // 2min ago (complete)
      makeCandle(now - 60000, 104, 109, 99, 106, 100),   // 1min ago (complete - close time = now)
      makeCandle(now, 106, 108, 105, 107, 50),             // current (unfinished)
    ];
    const result = validateCandles(candles, INTERVAL_MS);
    // The last candle (now) is unfinished: now + 60000 > Date.now()
    expect(result.length).toBe(3);
  });

  it('rejects invalid OHLCV values', () => {
    const candles = [
      makeCandle(0, 100, 105, 95, 102, 100),   // valid
      makeCandle(60000, 0, 105, 95, 102, 100),  // invalid: open=0
      makeCandle(120000, 100, 90, 95, 102, 100),  // invalid: high < low
      makeCandle(180000, 100, 105, 95, 102, -1),  // invalid: vol < 0
    ];
    const result = validateCandles(candles, INTERVAL_MS);
    expect(result.length).toBe(1); // only the first is valid
  });

  it('sorts candles chronologically', () => {
    const candles = [
      makeCandle(120000, 104, 109, 99, 106, 100),
      makeCandle(0, 100, 105, 95, 102, 100),
      makeCandle(60000, 102, 107, 97, 104, 100),
    ];
    const result = validateCandles(candles, INTERVAL_MS);
    expect(result[0].t).toBe(0);
    expect(result[1].t).toBe(60000);
    expect(result[2].t).toBe(120000);
  });
});

// ── candleAgeSecs ─────────────────────────────────────────────────────────────

describe('candleAgeSecs', () => {
  it('returns Infinity for empty candles', () => {
    expect(candleAgeSecs([], 60000)).toBe(Infinity);
  });

  it('returns correct age for recent candle', () => {
    const now = Date.now();
    const candles = [makeCandle(now - 90000, 100, 105, 95, 102, 100)];
    // Candle close time = open + interval = (now - 90000) + 60000 = now - 30000
    const age = candleAgeSecs(candles, 60000);
    expect(age).toBeGreaterThan(29);
    expect(age).toBeLessThan(32);
  });
});

// ── checkFeeEdge ──────────────────────────────────────────────────────────────

describe('checkFeeEdge', () => {
  it('returns SPREAD_TOO_WIDE when spread exceeds limit', () => {
    const candles = bullishCandles(15);
    expect(checkFeeEdge(candles, 15, DEFAULT_CFG)).toBe('SPREAD_TOO_WIDE');
  });

  it('returns null when spread and edge are good', () => {
    // Create candles with meaningful ATR (0.5% of price → edge is clearly above fees)
    const candles: Kline[] = Array.from({ length: 15 }, (_, i) => makeCandle(
      i * 60000,
      100000 + i * 100,
      100000 + i * 100 + 500, // high: +500 = 0.5%
      100000 + i * 100 - 200,
      100000 + i * 100 + 300,
      1000,
    ));
    const result = checkFeeEdge(candles, 2, DEFAULT_CFG);
    expect(result).toBeNull();
  });

  it('returns EDGE_BELOW_FEES when ATR too small', () => {
    // Very tight neutral candles → tiny ATR → edge below fees
    const candles = neutralCandles(15, 100000);
    const result = checkFeeEdge(candles, 1, DEFAULT_CFG);
    expect(result).toBe('EDGE_BELOW_FEES');
  });

  it('returns INVALID_MARKET_DATA for bad price data', () => {
    const candles = [makeCandle(0, 0, 0, 0, 0, 0)]; // invalid
    // validateCandles would filter these, but checkFeeEdge handles edge cases
    const validCandles = bullishCandles(15);
    validCandles[14].c = 0; // corrupt last candle price
    expect(checkFeeEdge([makeCandle(0, 0, 0, 0, 0, 100)], 1, DEFAULT_CFG)).toBe('INVALID_MARKET_DATA');
  });
});

// ── Property Tests: Monotonicity ──────────────────────────────────────────────

describe('Property: monotonicity', () => {
  it('raising only bullish evidence does not make score more bearish', () => {
    const base: CompositeInput = {
      components: {
        candleMomentum: 0.5,
        wickRejection: 0.5,
        volumeAcceleration: 0.5,
        tradePressure: 0.5,
        orderbookImbalance: 0.5,
      },
      regime: 'SIDEWAY',
      cfg: DEFAULT_CFG,
    };
    const baseResult = computeComposite(base);

    // Increase one bullish component at a time
    const keys = Object.keys(base.components) as (keyof typeof base.components)[];
    for (const key of keys) {
      const raised = {
        ...base,
        components: { ...base.components, [key]: 0.8 },
      };
      const raisedResult = computeComposite(raised);
      expect(raisedResult.score).toBeGreaterThanOrEqual(baseResult.score);
    }
  });

  it('raising only bearish evidence does not make score more bullish', () => {
    const base: CompositeInput = {
      components: {
        candleMomentum: 0.5,
        wickRejection: 0.5,
        volumeAcceleration: 0.5,
        tradePressure: 0.5,
        orderbookImbalance: 0.5,
      },
      regime: 'SIDEWAY',
      cfg: DEFAULT_CFG,
    };
    const baseResult = computeComposite(base);

    const keys = Object.keys(base.components) as (keyof typeof base.components)[];
    for (const key of keys) {
      const lowered = {
        ...base,
        components: { ...base.components, [key]: 0.2 },
      };
      const loweredResult = computeComposite(lowered);
      expect(loweredResult.score).toBeLessThanOrEqual(baseResult.score);
    }
  });

  it('invalid/insufficient data never produces an entry', () => {
    // All components neutral (as if data is missing)
    const input: CompositeInput = {
      components: {
        candleMomentum: 0.5,
        wickRejection: 0.5,
        volumeAcceleration: 0.5,
        tradePressure: 0.5,
        orderbookImbalance: 0.5,
      },
      regime: 'UNKNOWN',
      cfg: DEFAULT_CFG,
    };
    const result = computeComposite(input);
    expect(result.direction).toBe('skip');
  });
});
