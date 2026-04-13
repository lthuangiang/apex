import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { RegimeDetector, getRegimeStrategyConfig, Regime } from '../RegimeDetector';
import { config } from '../../config';

const detector = new RegimeDetector();

const VALID_REGIMES: Regime[] = ['TREND_UP', 'TREND_DOWN', 'SIDEWAY', 'HIGH_VOLATILITY'];

// ── Arbitraries ───────────────────────────────────────────────────────────────

/** Generates an array of positive prices of a given length */
const positivePrice = fc.float({ min: Math.fround(1), max: Math.fround(100_000), noNaN: true, noDefaultInfinity: true });

/** Generates candle arrays (closes, highs, lows) of length >= minLen with small spreads (low ATR) */
function candleArrays(minLen: number) {
  return fc
    .integer({ min: minLen, max: minLen + 30 })
    .chain(len =>
      fc.array(positivePrice, { minLength: len, maxLength: len }).chain(closes => {
        // small spread so ATR stays low
        const spreadArb = fc.float({ min: Math.fround(0.0001), max: Math.fround(0.001), noNaN: true, noDefaultInfinity: true });
        return fc
          .array(spreadArb, { minLength: len, maxLength: len })
          .map(spreads => ({
            closes,
            highs: closes.map((c, i) => c + spreads[i]),
            lows: closes.map((c, i) => Math.max(0.0001, c - spreads[i])),
            volumes: closes.map(() => 100),
          }));
      })
    );
}

/** Generates candle arrays where ATR/price > REGIME_HIGH_VOL_THRESHOLD (0.005) */
function highVolCandles() {
  return fc
    .integer({ min: 20, max: 50 })
    .chain(len =>
      fc.array(positivePrice, { minLength: len, maxLength: len }).chain(closes => {
        // spread > price * 0.005 guarantees atrPct > threshold
        return fc
          .array(
            fc.float({ min: Math.fround(0.006), max: Math.fround(0.05), noNaN: true, noDefaultInfinity: true }),
            { minLength: len, maxLength: len }
          )
          .map(spreadPcts => {
            const highs = closes.map((c, i) => c + c * spreadPcts[i]);
            const lows = closes.map((c, i) => Math.max(0.0001, c - c * spreadPcts[i]));
            return { closes, highs, lows, volumes: closes.map(() => 100) };
          });
      })
    );
}

/** Generates a valid volumes array with length >= 2 */
const volumesGe2 = fc.array(
  fc.float({ min: Math.fround(0), max: Math.fround(1_000_000), noNaN: true, noDefaultInfinity: true }),
  { minLength: 2, maxLength: 50 }
);

/** Generates a volumes array with length < 2 (0 or 1 element) */
const volumesLt2 = fc.oneof(
  fc.constant([] as number[]),
  fc.array(fc.float({ min: Math.fround(0), max: Math.fround(1_000_000), noNaN: true, noDefaultInfinity: true }), {
    minLength: 1,
    maxLength: 1,
  })
);

/** Generates a valid closes array for BB computation */
const closesArray = fc.array(
  fc.float({ min: Math.fround(0.01), max: Math.fround(100_000), noNaN: true, noDefaultInfinity: true }),
  { minLength: 1, maxLength: 50 }
);

// ── Properties ────────────────────────────────────────────────────────────────

describe('RegimeDetector — property-based tests', () => {
  /**
   * Property 1 (regime completeness): for any candle arrays of length >= 20,
   * detect() returns one of the four valid regime values.
   * Validates: Requirements 4.1
   */
  it('Property 1: detect() always returns a valid regime value', () => {
    fc.assert(
      fc.property(candleArrays(20), ({ closes, highs, lows, volumes }) => {
        const ema21Last = closes[closes.length - 1]; // neutral EMA
        const result = detector.detect(closes, highs, lows, volumes, ema21Last);
        return VALID_REGIMES.includes(result.regime);
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 2 (HIGH_VOLATILITY priority): for any candle arrays where
   * computed atrPct > REGIME_HIGH_VOL_THRESHOLD, detect().regime === 'HIGH_VOLATILITY'.
   * Validates: Requirements 4.2
   */
  it('Property 2: HIGH_VOLATILITY wins when atrPct exceeds threshold', () => {
    fc.assert(
      fc.property(highVolCandles(), ({ closes, highs, lows, volumes }) => {
        const ema21Last = closes[closes.length - 1];
        const result = detector.detect(closes, highs, lows, volumes, ema21Last);
        // Only assert HIGH_VOLATILITY if atrPct actually exceeded the threshold
        if (result.atrPct > config.REGIME_HIGH_VOL_THRESHOLD) {
          return result.regime === 'HIGH_VOLATILITY';
        }
        return true; // generator didn't produce high enough ATR — skip
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3 (ATR non-negativity): for any valid candle arrays,
   * computeATR() returns >= 0.
   * Validates: Requirements 1.3
   */
  it('Property 3: computeATR() always returns >= 0', () => {
    fc.assert(
      fc.property(candleArrays(2), ({ closes, highs, lows }) => {
        const atr = detector.computeATR(highs, lows, closes, config.REGIME_ATR_PERIOD);
        return atr >= 0;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 4 (BB width non-negativity): for any valid closes array,
   * computeBBWidth() returns >= 0.
   * Validates: Requirements 2.2
   */
  it('Property 4: computeBBWidth() always returns >= 0', () => {
    fc.assert(
      fc.property(closesArray, closes => {
        const bbWidth = detector.computeBBWidth(closes, config.REGIME_BB_PERIOD, config.REGIME_BB_STD_DEV);
        return bbWidth >= 0;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 5 (volume ratio non-negativity): for any volumes array with length >= 2,
   * computeVolumeRatio() returns >= 0.
   * Validates: Requirements 3.2
   */
  it('Property 5: computeVolumeRatio() returns >= 0 for volumes.length >= 2', () => {
    fc.assert(
      fc.property(volumesGe2, volumes => {
        const ratio = detector.computeVolumeRatio(volumes, config.REGIME_VOL_LOOKBACK);
        return ratio >= 0;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 6 (volume ratio neutral): for any volumes array with length < 2,
   * computeVolumeRatio() returns 1.0.
   * Validates: Requirements 3.3
   */
  it('Property 6: computeVolumeRatio() returns 1.0 when volumes.length < 2', () => {
    fc.assert(
      fc.property(volumesLt2, volumes => {
        const ratio = detector.computeVolumeRatio(volumes, config.REGIME_VOL_LOOKBACK);
        return ratio === 1.0;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7 (SL never tightens): for all four regime values,
   * getRegimeStrategyConfig(regime).slBufferMultiplier >= 1.0.
   * Validates: Requirements 5.4
   */
  it('Property 7: slBufferMultiplier >= 1.0 for all regimes', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_REGIMES), regime => {
        const cfg = getRegimeStrategyConfig(regime);
        return cfg.slBufferMultiplier >= 1.0;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 8 (sizing factor never amplifies): for all four regime values,
   * getRegimeStrategyConfig(regime).volatilitySizingFactor ∈ (0, 1].
   * Validates: Requirements 5.5
   */
  it('Property 8: volatilitySizingFactor is in (0, 1] for all regimes', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_REGIMES), regime => {
        const cfg = getRegimeStrategyConfig(regime);
        return cfg.volatilitySizingFactor > 0 && cfg.volatilitySizingFactor <= 1.0;
      }),
      { numRuns: 100 }
    );
  });

  /**
   * Property 9 (config completeness): for all four regime values,
   * getRegimeStrategyConfig(regime) has no undefined fields.
   * Validates: Requirements 5.6
   */
  it('Property 9: getRegimeStrategyConfig() returns no undefined fields for all regimes', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_REGIMES), regime => {
        const cfg = getRegimeStrategyConfig(regime);
        return (
          cfg.entryScoreEdge !== undefined &&
          cfg.skipEntry !== undefined &&
          cfg.volatilitySizingFactor !== undefined &&
          cfg.holdMultiplier !== undefined &&
          cfg.slBufferMultiplier !== undefined &&
          cfg.suppressEarlyExit !== undefined
        );
      }),
      { numRuns: 100 }
    );
  });
});
