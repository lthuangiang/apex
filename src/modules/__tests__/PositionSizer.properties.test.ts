import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { PositionSizer, SizingInput } from '../PositionSizer';

/**
 * Property-based tests for PositionSizer
 * Uses fast-check to verify correctness properties across all valid inputs.
 */

// Config defaults (mirrors src/config.ts)
const ORDER_SIZE_MIN = 0.003;
const SIZING_MIN_MULTIPLIER = 0.5;
const SIZING_MAX_MULTIPLIER = 2.0;
const SIZING_DRAWDOWN_THRESHOLD = -3.0;
const SIZING_MAX_BTC = 0.008;

const sizer = new PositionSizer();

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const arbConfidence = fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true });
const arbMode = fc.constantFrom('farm', 'trade') as fc.Arbitrary<'farm' | 'trade'>;
const arbProfile = fc.constantFrom('SCALP', 'NORMAL', 'RUNNER', 'DEGEN') as fc.Arbitrary<
  'SCALP' | 'NORMAL' | 'RUNNER' | 'DEGEN'
>;
const arbRecentPnLs = fc.array(fc.float({ min: Math.fround(-100), max: Math.fround(100), noNaN: true }), { minLength: 0, maxLength: 5 });
const arbSessionPnl = fc.float({ min: Math.fround(-100), max: Math.fround(100), noNaN: true });
const arbBalance = fc.float({ min: Math.fround(1), max: Math.fround(100_000), noNaN: true });

const arbSizingInput: fc.Arbitrary<SizingInput> = fc.record({
  confidence: arbConfidence,
  recentPnLs: arbRecentPnLs,
  sessionPnl: arbSessionPnl,
  balance: arbBalance,
  mode: arbMode,
  profile: arbProfile,
});

// ─── Property 1: Size bounds ──────────────────────────────────────────────────
// For any valid SizingInput, computeSize().size ∈ [ORDER_SIZE_MIN, SIZING_MAX_BTC]
// Validates: Requirements 1.2, 4.1

describe('Property 1: Size bounds', () => {
  it('computeSize().size is always in [ORDER_SIZE_MIN, SIZING_MAX_BTC]', () => {
    fc.assert(
      fc.property(arbSizingInput, (input) => {
        const result = sizer.computeSize(input);
        expect(result.size).toBeGreaterThanOrEqual(ORDER_SIZE_MIN);
        expect(result.size).toBeLessThanOrEqual(SIZING_MAX_BTC);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 2: Multiplier bounds ───────────────────────────────────────────
// For any valid SizingInput, all three multipliers ∈ [SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER]
// Validates: Requirements 1.3, 2.5, 3.6

describe('Property 2: Multiplier bounds', () => {
  it('all three multipliers are always in [SIZING_MIN_MULTIPLIER, SIZING_MAX_MULTIPLIER]', () => {
    fc.assert(
      fc.property(arbSizingInput, (input) => {
        const result = sizer.computeSize(input);
        expect(result.confidenceMultiplier).toBeGreaterThanOrEqual(SIZING_MIN_MULTIPLIER);
        expect(result.confidenceMultiplier).toBeLessThanOrEqual(SIZING_MAX_MULTIPLIER);
        expect(result.performanceMultiplier).toBeGreaterThanOrEqual(SIZING_MIN_MULTIPLIER);
        expect(result.performanceMultiplier).toBeLessThanOrEqual(SIZING_MAX_MULTIPLIER);
        expect(result.combinedMultiplier).toBeGreaterThanOrEqual(SIZING_MIN_MULTIPLIER);
        expect(result.combinedMultiplier).toBeLessThanOrEqual(SIZING_MAX_MULTIPLIER);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 3: Drawdown protection ─────────────────────────────────────────
// For any input where sessionPnl <= SIZING_DRAWDOWN_THRESHOLD, performanceMultiplier < 1.0
// Validates: Requirements 3.3

describe('Property 3: Drawdown protection', () => {
  it('sessionPnl <= SIZING_DRAWDOWN_THRESHOLD always produces performanceMultiplier < 1.0', () => {
    const arbDrawdownInput = fc.record({
      recentPnLs: arbRecentPnLs,
      // sessionPnl at or below threshold (threshold is -3.0, so <= -3.0)
      sessionPnl: fc.float({ min: Math.fround(-100), max: Math.fround(SIZING_DRAWDOWN_THRESHOLD), noNaN: true }),
      profile: arbProfile,
    });

    fc.assert(
      fc.property(arbDrawdownInput, ({ recentPnLs, sessionPnl, profile }) => {
        const result = sizer.performanceMultiplier(recentPnLs, sessionPnl, profile);
        expect(result).toBeLessThan(1.0);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 4: Confidence monotonicity (trade mode) ────────────────────────
// For any fixed inputs with mode = 'trade', conf_a >= conf_b implies
// confidenceMultiplier(conf_a) >= confidenceMultiplier(conf_b)
// Validates: Requirements 2.3

describe('Property 4: Confidence monotonicity', () => {
  it('higher confidence always produces >= confidenceMultiplier in trade mode', () => {
    const arbConfPair = fc.tuple(arbConfidence, arbConfidence);

    fc.assert(
      fc.property(arbConfPair, ([confA, confB]) => {
        const multA = sizer.confidenceMultiplier(confA, 'trade');
        const multB = sizer.confidenceMultiplier(confB, 'trade');
        if (confA >= confB) {
          expect(multA).toBeGreaterThanOrEqual(multB);
        } else {
          expect(multB).toBeGreaterThanOrEqual(multA);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 5: Win rate monotonicity ───────────────────────────────────────
// All-positive recentPnLs produces performanceMultiplier >= all-negative for same sessionPnl and profile
// Validates: Requirements 3.7

describe('Property 5: Win rate monotonicity', () => {
  it('all-positive recentPnLs produces performanceMultiplier >= all-negative recentPnLs', () => {
    const arbLength = fc.integer({ min: 1, max: 5 });

    fc.assert(
      fc.property(
        arbLength,
        arbSessionPnl,
        arbProfile,
        (length, sessionPnl, profile) => {
          // All-positive: array of +1 values
          const allPositive = Array(length).fill(1);
          // All-negative: array of -1 values
          const allNegative = Array(length).fill(-1);

          const multPositive = sizer.performanceMultiplier(allPositive, sessionPnl, profile);
          const multNegative = sizer.performanceMultiplier(allNegative, sessionPnl, profile);

          expect(multPositive).toBeGreaterThanOrEqual(multNegative);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── Property 6: Farm dampening ──────────────────────────────────────────────
// For any confidence, farm mode confidenceMultiplier is closer to 1.0 than trade mode
// Validates: Requirements 2.4

describe('Property 6: Farm dampening', () => {
  it('farm mode confidenceMultiplier is always closer to 1.0 than trade mode', () => {
    fc.assert(
      fc.property(arbConfidence, (confidence) => {
        const farmMult = sizer.confidenceMultiplier(confidence, 'farm');
        const tradeMult = sizer.confidenceMultiplier(confidence, 'trade');

        const farmDistance = Math.abs(farmMult - 1.0);
        const tradeDistance = Math.abs(tradeMult - 1.0);

        // Allow a tiny epsilon for floating-point rounding at boundary values
        expect(farmDistance).toBeLessThanOrEqual(tradeDistance + 1e-6);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 7: Empty history neutral ───────────────────────────────────────
// recentPnLs = [], sessionPnl > threshold, profile = 'NORMAL' → performanceMultiplier === 1.0
// Validates: Requirements 3.1

describe('Property 7: Empty history neutral', () => {
  it('empty recentPnLs with sessionPnl above threshold and NORMAL profile returns exactly 1.0', () => {
    // sessionPnl strictly above threshold (threshold is -3.0, so > -3.0)
    const arbAboveThreshold = fc.float({ min: Math.fround(SIZING_DRAWDOWN_THRESHOLD + 0.001), max: Math.fround(100), noNaN: true });

    fc.assert(
      fc.property(arbAboveThreshold, (sessionPnl) => {
        const result = sizer.performanceMultiplier([], sessionPnl, 'NORMAL');
        expect(result).toBe(1.0);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 8: Cap reporting accuracy ──────────────────────────────────────
// rawSize > SIZING_MAX_BTC iff cappedBy === 'btc_cap'
// Tests applyRiskCaps directly since computeSize uses random internally.
// Validates: Requirements 4.2, 4.3, 4.5

describe('Property 8: Cap reporting accuracy', () => {
  it('rawSize > SIZING_MAX_BTC → cappedBy === btc_cap', () => {
    // rawSize strictly above SIZING_MAX_BTC
    const arbAboveCap = fc.float({ min: Math.fround(SIZING_MAX_BTC + 0.0001), max: Math.fround(1.0), noNaN: true });

    fc.assert(
      fc.property(arbAboveCap, (rawSize) => {
        const { cappedBy } = sizer.applyRiskCaps(rawSize);
        expect(cappedBy).toBe('btc_cap');
      }),
      { numRuns: 100 }
    );
  });

  it('rawSize in [ORDER_SIZE_MIN, SIZING_MAX_BTC) → cappedBy === none', () => {
    // rawSize within valid range (strictly below cap to avoid float32 boundary issues)
    const arbWithinRange = fc.float({ min: Math.fround(ORDER_SIZE_MIN), max: Math.fround(SIZING_MAX_BTC - 0.0001), noNaN: true });

    fc.assert(
      fc.property(arbWithinRange, (rawSize) => {
        const { cappedBy } = sizer.applyRiskCaps(rawSize);
        expect(cappedBy).toBe('none');
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 9: Volatility factor monotonicity ───────────────────────────────
// For any SizingInput and f1 <= f2 both in [0.1, 1.0],
// computeSize({...input, volatilityFactor: f1}).size <= computeSize({...input, volatilityFactor: f2}).size
// Validates: Requirements 6.6

describe('Property 9: Volatility factor monotonicity', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lower volatilityFactor always produces size <= higher volatilityFactor', () => {
    // Pair of factors both in [0.1, 1.0] with f1 <= f2
    const arbFactorPair = fc
      .tuple(
        fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true }),
        fc.float({ min: Math.fround(0.1), max: Math.fround(1.0), noNaN: true })
      )
      .map(([a, b]) => (a <= b ? [a, b] : [b, a]) as [number, number]);

    fc.assert(
      fc.property(arbSizingInput, arbFactorPair, (input, [f1, f2]) => {
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        const r1 = sizer.computeSize({ ...input, volatilityFactor: f1 });
        const r2 = sizer.computeSize({ ...input, volatilityFactor: f2 });
        expect(r1.size).toBeLessThanOrEqual(r2.size);
      }),
      { numRuns: 100 }
    );
  });
});
