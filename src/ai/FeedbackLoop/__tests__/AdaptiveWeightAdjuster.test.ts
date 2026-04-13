import { describe, it, expect } from 'vitest';
import { AdaptiveWeightAdjuster } from '../AdaptiveWeightAdjuster';
import { DEFAULT_WEIGHTS } from '../WeightStore';
import type { ComponentStats } from '../ComponentPerformanceTracker';

const adjuster = new AdaptiveWeightAdjuster();

function makeStats(overrides: Partial<ComponentStats>): ComponentStats {
  const defaultStat = { total: 10, wins: 5, winRate: 0.5 };
  return {
    ema: defaultStat,
    rsi: { ...defaultStat, lossStreak: 0 },
    momentum: defaultStat,
    imbalance: defaultStat,
    computedAt: new Date().toISOString(),
    lookbackN: 10,
    ...overrides,
  };
}

describe('AdaptiveWeightAdjuster', () => {
  // 1. High win rate increases ema weight (before normalisation)
  it('increases ema weight when ema winRate > 0.60 with total >= 5', () => {
    const stats = makeStats({ ema: { total: 10, wins: 7, winRate: 0.70 } });
    const result = adjuster.adjustWeights(stats, { ...DEFAULT_WEIGHTS });

    // After normalisation the ema weight should be higher than the default ema proportion
    // We verify by comparing to a neutral run (no adjustments)
    const neutral = makeStats({});
    const neutralResult = adjuster.adjustWeights(neutral, { ...DEFAULT_WEIGHTS });

    expect(result.ema).toBeGreaterThan(neutralResult.ema);
  });

  // 2. Low win rate decreases ema weight
  it('decreases ema weight when ema winRate < 0.40 with total >= 5', () => {
    const stats = makeStats({ ema: { total: 10, wins: 3, winRate: 0.30 } });
    const result = adjuster.adjustWeights(stats, { ...DEFAULT_WEIGHTS });

    const neutral = makeStats({});
    const neutralResult = adjuster.adjustWeights(neutral, { ...DEFAULT_WEIGHTS });

    expect(result.ema).toBeLessThan(neutralResult.ema);
  });

  // 3. RSI loss streak decreases RSI weight
  it('decreases rsi weight when rsi lossStreak > 3 with total >= 5', () => {
    const stats = makeStats({
      rsi: { total: 10, wins: 5, winRate: 0.5, lossStreak: 4 },
    });
    const result = adjuster.adjustWeights(stats, { ...DEFAULT_WEIGHTS });

    const neutral = makeStats({});
    const neutralResult = adjuster.adjustWeights(neutral, { ...DEFAULT_WEIGHTS });

    expect(result.rsi).toBeLessThan(neutralResult.rsi);
  });

  // 4a. Clamping at MIN_WEIGHT (0.05)
  it('clamps weight at MIN_WEIGHT (0.05) when adjustment would go below it', () => {
    // Start with ema at minimum and force a decrease
    const lowEmaWeights = { ema: 0.05, rsi: 0.35, momentum: 0.35, imbalance: 0.25 };
    const stats = makeStats({ ema: { total: 10, wins: 2, winRate: 0.20 } });
    const result = adjuster.adjustWeights(stats, lowEmaWeights);

    // After normalisation ema should still be >= MIN_WEIGHT / 1 (it's clamped before normalisation)
    // The raw clamped value is 0.05, so after normalisation it will be > 0 but we verify
    // the pre-normalisation clamp worked by checking the result is positive and reasonable
    expect(result.ema).toBeGreaterThan(0);
    // The normalised ema should be at least the fraction that 0.05 represents of the total
    const minFraction = 0.05 / (0.05 + 0.35 + 0.35 + 0.25); // ~0.0476
    expect(result.ema).toBeGreaterThanOrEqual(minFraction - 0.001);
  });

  // 4b. Clamping at MAX_WEIGHT (0.60)
  it('clamps weight at MAX_WEIGHT (0.60) when adjustment would exceed it', () => {
    // Start with ema near max and force an increase
    const highEmaWeights = { ema: 0.60, rsi: 0.15, momentum: 0.15, imbalance: 0.10 };
    const stats = makeStats({ ema: { total: 10, wins: 8, winRate: 0.80 } });
    const result = adjuster.adjustWeights(stats, highEmaWeights);

    // Pre-normalisation ema is clamped at 0.60; after normalisation it will be <= 0.60
    expect(result.ema).toBeLessThanOrEqual(0.60 + 0.001);
  });

  // 5. Normalisation: output weights always sum to 1.0 (±0.001)
  it('output weights always sum to 1.0 after adjustment', () => {
    const stats = makeStats({
      ema: { total: 10, wins: 8, winRate: 0.80 },
      rsi: { total: 10, wins: 2, winRate: 0.20, lossStreak: 5 },
      momentum: { total: 10, wins: 7, winRate: 0.70 },
      imbalance: { total: 10, wins: 3, winRate: 0.30 },
    });
    const result = adjuster.adjustWeights(stats, { ...DEFAULT_WEIGHTS });
    const sum = result.ema + result.rsi + result.momentum + result.imbalance;

    expect(Math.abs(sum - 1.0)).toBeLessThanOrEqual(0.001);
  });

  it('output weights sum to 1.0 with neutral stats', () => {
    const stats = makeStats({});
    const result = adjuster.adjustWeights(stats, { ...DEFAULT_WEIGHTS });
    const sum = result.ema + result.rsi + result.momentum + result.imbalance;

    expect(Math.abs(sum - 1.0)).toBeLessThanOrEqual(0.001);
  });

  // 6. Component with total < MIN_STAT_TRADES (5) is NOT adjusted
  it('does not adjust ema weight when ema total < 5', () => {
    // ema has high win rate but total < 5 — should not be adjusted
    const stats = makeStats({ ema: { total: 4, wins: 4, winRate: 1.0 } });
    const result = adjuster.adjustWeights(stats, { ...DEFAULT_WEIGHTS });

    // Compare to a run where ema total is exactly 5 (should be adjusted)
    const statsWithEnough = makeStats({ ema: { total: 5, wins: 5, winRate: 1.0 } });
    const resultWithEnough = adjuster.adjustWeights(statsWithEnough, { ...DEFAULT_WEIGHTS });

    // With total < 5, ema should NOT have been bumped up, so it should be lower
    expect(result.ema).toBeLessThan(resultWithEnough.ema);
  });

  it('does not adjust rsi weight when rsi total < 5', () => {
    // rsi has high loss streak but total < 5 — should not be adjusted
    const stats = makeStats({
      rsi: { total: 3, wins: 0, winRate: 0.0, lossStreak: 10 },
    });
    const result = adjuster.adjustWeights(stats, { ...DEFAULT_WEIGHTS });

    const statsWithEnough = makeStats({
      rsi: { total: 5, wins: 0, winRate: 0.0, lossStreak: 10 },
    });
    const resultWithEnough = adjuster.adjustWeights(statsWithEnough, { ...DEFAULT_WEIGHTS });

    // With total < 5, rsi should NOT have been decreased
    expect(result.rsi).toBeGreaterThan(resultWithEnough.rsi);
  });
});

// ─── Property-Based Tests ────────────────────────────────────────────────────
// Validates: Requirements 3.3
import * as fc from 'fast-check';

/**
 * Arbitrary for a valid SignalWeights:
 * - each weight ∈ [0.05, 0.60]
 * - all four weights sum to 1.0
 */
const validWeightsArb = fc.tuple(
  fc.float({ min: Math.fround(0.05), max: Math.fround(0.60), noNaN: true }),
  fc.float({ min: Math.fround(0.05), max: Math.fround(0.60), noNaN: true }),
  fc.float({ min: Math.fround(0.05), max: Math.fround(0.60), noNaN: true }),
  fc.float({ min: Math.fround(0.05), max: Math.fround(0.60), noNaN: true }),
).map(([a, b, c, d]) => {
  const sum = a + b + c + d;
  return { ema: a / sum, rsi: b / sum, momentum: c / sum, imbalance: d / sum };
}).filter(w =>
  w.ema >= 0.05 && w.ema <= 0.60 &&
  w.rsi >= 0.05 && w.rsi <= 0.60 &&
  w.momentum >= 0.05 && w.momentum <= 0.60 &&
  w.imbalance >= 0.05 && w.imbalance <= 0.60
);

/**
 * Arbitrary for ComponentStats with realistic values:
 * - total ∈ [0, 100], wins ∈ [0, total], winRate = wins/total (or 0)
 * - lossStreak ∈ [0, 20] for RSI
 */
const componentStatArb = fc.integer({ min: 0, max: 100 }).chain(total =>
  fc.integer({ min: 0, max: total }).map(wins => ({
    total,
    wins,
    winRate: total > 0 ? wins / total : 0,
  }))
);

const componentStatsArb = fc.record({
  ema: componentStatArb,
  rsi: fc.integer({ min: 0, max: 100 }).chain(total =>
    fc.integer({ min: 0, max: total }).chain(wins =>
      fc.integer({ min: 0, max: 20 }).map(lossStreak => ({
        total,
        wins,
        winRate: total > 0 ? wins / total : 0,
        lossStreak,
      }))
    )
  ),
  momentum: componentStatArb,
  imbalance: componentStatArb,
  computedAt: fc.constant(new Date().toISOString()),
  lookbackN: fc.integer({ min: 0, max: 100 }),
});

describe('AdaptiveWeightAdjuster — property-based tests', () => {
  /**
   * Property 1: output weights always sum to [0.999, 1.001]
   * Validates: Requirements 3.3
   */
  it('output weights always sum to ~1.0 for any valid SignalWeights and any ComponentStats', () => {
    fc.assert(
      fc.property(validWeightsArb, componentStatsArb, (weights, stats) => {
        const result = adjuster.adjustWeights(stats, weights);
        const sum = result.ema + result.rsi + result.momentum + result.imbalance;
        return sum >= 0.999 && sum <= 1.001;
      }),
      { numRuns: 500 }
    );
  });

  /**
   * Property 2: each output weight is in (0, 1)
   * Validates: Requirements 3.3
   */
  it('each output weight is in (0, 1) for any valid SignalWeights and any ComponentStats', () => {
    fc.assert(
      fc.property(validWeightsArb, componentStatsArb, (weights, stats) => {
        const result = adjuster.adjustWeights(stats, weights);
        return (
          result.ema > 0 && result.ema < 1 &&
          result.rsi > 0 && result.rsi < 1 &&
          result.momentum > 0 && result.momentum < 1 &&
          result.imbalance > 0 && result.imbalance < 1
        );
      }),
      { numRuns: 500 }
    );
  });
});
