import { describe, it, expect } from 'vitest';
import { RegimeDetector, getRegimeStrategyConfig, Regime } from '../RegimeDetector';

const detector = new RegimeDetector();

// ── computeATR ────────────────────────────────────────────────────────────────

describe('computeATR', () => {
  it('computes true range correctly for a known candle (high=105, low=95, prevClose=100 → TR=10)', () => {
    // Two candles: candle 0 is the "prev", candle 1 is the one we measure
    // TR = max(105-95, |105-100|, |95-100|) = max(10, 5, 5) = 10
    const highs = [100, 105];
    const lows  = [100,  95];
    const closes = [100, 102];
    const atr = detector.computeATR(highs, lows, closes, 1);
    expect(atr).toBe(10);
  });

  it('averages only the last `period` true ranges', () => {
    // 4 candles → 3 true ranges: TR1=5, TR2=10, TR3=15
    // period=2 → avg of last 2 = (10+15)/2 = 12.5
    const highs  = [100, 105, 110, 115];
    const lows   = [100, 100, 100, 100];
    const closes = [100, 100, 100, 100];
    // TR1 = max(105-100, |105-100|, |100-100|) = 5
    // TR2 = max(110-100, |110-100|, |100-100|) = 10
    // TR3 = max(115-100, |115-100|, |100-100|) = 15
    const atr = detector.computeATR(highs, lows, closes, 2);
    expect(atr).toBe(12.5);
  });

  it('returns 0 for zero-range candles (all identical OHLC)', () => {
    const highs  = [100, 100, 100];
    const lows   = [100, 100, 100];
    const closes = [100, 100, 100];
    const atr = detector.computeATR(highs, lows, closes, 2);
    expect(atr).toBe(0);
  });
});

// ── computeBBWidth ────────────────────────────────────────────────────────────

describe('computeBBWidth', () => {
  it('computes band width correctly for known closes', () => {
    // closes = [100, 100, 100, 100, 102], period=5, stdDevMult=2
    // mean = (100+100+100+100+102)/5 = 100.4
    // variance = ((0.4^2)*4 + (1.6^2)) / 5 = (0.64 + 2.56) / 5 = 0.64
    // std = sqrt(0.64) = 0.8
    // bbWidth = (2 * 2 * 0.8) / 100.4
    const closes = [100, 100, 100, 100, 102];
    const mean = 100.4;
    const variance = (4 * 0.4 ** 2 + 1.6 ** 2) / 5;
    const std = Math.sqrt(variance);
    const expected = (2 * 2 * std) / mean;

    const bbWidth = detector.computeBBWidth(closes, 5, 2);
    expect(bbWidth).toBeCloseTo(expected, 10);
  });

  it('returns 0 when all closes are identical (std=0 → bbWidth=0)', () => {
    const closes = [100, 100, 100, 100, 100];
    const bbWidth = detector.computeBBWidth(closes, 5, 2);
    expect(bbWidth).toBe(0);
  });

  it('result is dimensionless (normalised by mean)', () => {
    // Scaling all closes by a constant should not change bbWidth
    const closes = [100, 102, 98, 101, 99];
    const scaledCloses = closes.map(c => c * 10);
    const bbWidth1 = detector.computeBBWidth(closes, 5, 2);
    const bbWidth2 = detector.computeBBWidth(scaledCloses, 5, 2);
    expect(bbWidth1).toBeCloseTo(bbWidth2, 10);
  });
});

// ── computeVolumeRatio ────────────────────────────────────────────────────────

describe('computeVolumeRatio', () => {
  it('computes ratio correctly (volumes=[10,10,10,10,20] → ratio=2.0)', () => {
    // lookback=4: priorSlice = volumes.slice(-5, -1) = [10,10,10,10], avg=10
    // currentVol = 20, ratio = 20/10 = 2.0
    const volumes = [10, 10, 10, 10, 20];
    const ratio = detector.computeVolumeRatio(volumes, 4);
    expect(ratio).toBe(2.0);
  });

  it('returns 1.0 when volumes.length < 2', () => {
    expect(detector.computeVolumeRatio([], 10)).toBe(1.0);
    expect(detector.computeVolumeRatio([100], 10)).toBe(1.0);
  });

  it('returns 1.0 when average of prior slice is 0', () => {
    const volumes = [0, 0, 0, 0, 50];
    const ratio = detector.computeVolumeRatio(volumes, 4);
    expect(ratio).toBe(1.0);
  });
});

// ── detect ────────────────────────────────────────────────────────────────────

describe('detect', () => {
  // Helper: build flat candle arrays of given length at a given price
  function flatCandles(price: number, length: number) {
    return {
      closes: Array(length).fill(price),
      highs:  Array(length).fill(price),
      lows:   Array(length).fill(price),
      volumes: Array(length).fill(100),
    };
  }

  it('classifies HIGH_VOLATILITY when atrPct exceeds threshold, even when price is above EMA', () => {
    // Use a large high-low spread to push ATR above REGIME_HIGH_VOL_THRESHOLD (0.005)
    // price=100, ATR needs to be > 0.5 (0.5% of 100)
    const length = 20;
    const closes  = Array(length).fill(100);
    const highs   = Array(length).fill(101);   // high-low spread = 2 → TR=2 → atrPct=0.02 >> 0.005
    const lows    = Array(length).fill(99);
    const volumes = Array(length).fill(100);
    // ema21Last well below price to also satisfy TREND_UP condition — HIGH_VOL should win
    const result = detector.detect(closes, highs, lows, volumes, 90);
    expect(result.regime).toBe('HIGH_VOLATILITY');
  });

  it('classifies TREND_UP when price is above EMA band and bbWidth is sufficient', () => {
    // To get TREND_UP we need:
    //   1. atrPct <= 0.005 (HIGH_VOL threshold)
    //   2. price > ema21Last * 1.002
    //   3. bbWidth > 0.01
    //
    // Use 5 candles at 95 then 15 candles at 105 (last close = 105).
    // The block-transition TR spike falls outside the last 14 TRs window,
    // so ATR is tiny (≈ 0.002 / 105 << 0.005).
    // BB period=20 spans both blocks → std=5, bbWidth=0.2 >> 0.01 ✓
    const closes  = [...Array(5).fill(95), ...Array(15).fill(105)];
    const highs   = closes.map(c => c + 0.001);
    const lows    = closes.map(c => c - 0.001);
    const volumes = Array(closes.length).fill(100);
    // ema21Last = 102 → 105 > 102 * 1.002 = 102.204 ✓
    const result = detector.detect(closes, highs, lows, volumes, 102);
    expect(result.regime).toBe('TREND_UP');
  });

  it('classifies TREND_DOWN when price is below EMA band and bbWidth is sufficient', () => {
    // Mirror: 5 candles at 105, then 15 at 95 (last close = 95)
    // ema21Last = 98 → 95 < 98 * (1 - 0.002) = 97.804 ✓
    const closes  = [...Array(5).fill(105), ...Array(15).fill(95)];
    const highs   = closes.map(c => c + 0.001);
    const lows    = closes.map(c => c - 0.001);
    const volumes = Array(closes.length).fill(100);
    const result = detector.detect(closes, highs, lows, volumes, 98);
    expect(result.regime).toBe('TREND_DOWN');
  });

  it('classifies SIDEWAY as default when no other condition is met', () => {
    // Flat candles: atrPct=0, bbWidth=0, price == ema → SIDEWAY
    const { closes, highs, lows, volumes } = flatCandles(100, 25);
    const result = detector.detect(closes, highs, lows, volumes, 100);
    expect(result.regime).toBe('SIDEWAY');
  });

  it('returns all four regime types under appropriate conditions', () => {
    const regimes = new Set<string>();

    // SIDEWAY
    const flat = flatCandles(100, 25);
    regimes.add(detector.detect(flat.closes, flat.highs, flat.lows, flat.volumes, 100).regime);

    // HIGH_VOLATILITY
    const hvCloses  = Array(20).fill(100);
    const hvHighs   = Array(20).fill(102);
    const hvLows    = Array(20).fill(98);
    const hvVols    = Array(20).fill(100);
    regimes.add(detector.detect(hvCloses, hvHighs, hvLows, hvVols, 90).regime);

    // TREND_UP — spike candle pushed out of 14-period ATR window
    const tuCloses  = [...Array(5).fill(95), ...Array(15).fill(105)];
    const tuHighs   = tuCloses.map(c => c + 0.001);
    const tuLows    = tuCloses.map(c => c - 0.001);
    const tuVols    = Array(tuCloses.length).fill(100);
    regimes.add(detector.detect(tuCloses, tuHighs, tuLows, tuVols, 102).regime);

    // TREND_DOWN — mirror
    const tdCloses  = [...Array(5).fill(105), ...Array(15).fill(95)];
    const tdHighs   = tdCloses.map(c => c + 0.001);
    const tdLows    = tdCloses.map(c => c - 0.001);
    const tdVols    = Array(tdCloses.length).fill(100);
    regimes.add(detector.detect(tdCloses, tdHighs, tdLows, tdVols, 98).regime);

    expect(regimes).toContain('SIDEWAY');
    expect(regimes).toContain('HIGH_VOLATILITY');
    expect(regimes).toContain('TREND_UP');
    expect(regimes).toContain('TREND_DOWN');
  });
});

// ── getRegimeStrategyConfig ───────────────────────────────────────────────────

describe('getRegimeStrategyConfig', () => {
  const regimes: Regime[] = ['TREND_UP', 'TREND_DOWN', 'SIDEWAY', 'HIGH_VOLATILITY'];

  it('returns a complete config with no undefined fields for all four regimes', () => {
    for (const regime of regimes) {
      const cfg = getRegimeStrategyConfig(regime);
      expect(cfg.entryScoreEdge).toBeDefined();
      expect(cfg.skipEntry).toBeDefined();
      expect(cfg.volatilitySizingFactor).toBeDefined();
      expect(cfg.holdMultiplier).toBeDefined();
      expect(cfg.slBufferMultiplier).toBeDefined();
      expect(cfg.suppressEarlyExit).toBeDefined();
    }
  });

  it('slBufferMultiplier >= 1.0 for all regimes', () => {
    for (const regime of regimes) {
      const cfg = getRegimeStrategyConfig(regime);
      expect(cfg.slBufferMultiplier).toBeGreaterThanOrEqual(1.0);
    }
  });

  it('volatilitySizingFactor <= 1.0 for all regimes', () => {
    for (const regime of regimes) {
      const cfg = getRegimeStrategyConfig(regime);
      expect(cfg.volatilitySizingFactor).toBeLessThanOrEqual(1.0);
    }
  });
});
