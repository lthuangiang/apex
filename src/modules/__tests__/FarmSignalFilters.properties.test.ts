import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  FilterInput,
  FilterResult,
  regimeConfidenceThreshold,
  tradePressureGate,
  fallbackQualityGate,
  feeAwareEntryFilter,
  llmMomentumAdjuster,
  computeDynamicMinHold,
  evaluateFarmEntryFilters,
} from '../FarmSignalFilters';
import { AnalyticsEngine, FilterSkipStats } from '../../ai/AnalyticsEngine';
import { TradeRecord } from '../../ai/TradeLogger';
import { validateOverrides } from '../../config/validateOverrides';
import { config } from '../../config';

/**
 * Property-based tests for FarmSignalFilters
 * Feature: farm-signal-cost-optimizer
 * Uses fast-check to verify correctness properties across all valid inputs.
 */

// ─── Config Constants ─────────────────────────────────────────────────────────

const FEE_RATE_MAKER = 0.00012;
const FARM_MIN_CONFIDENCE_PRESSURE_GATE = 0.55;
const FARM_MIN_FALLBACK_CONFIDENCE = 0.25;
const FARM_SIDEWAY_MIN_CONFIDENCE = 0.45;
const FARM_TREND_MIN_CONFIDENCE = 0.35;
const FARM_MIN_HOLD_SECS = 120;
const FARM_MAX_HOLD_SECS = 480;

// ─── Arbitraries ─────────────────────────────────────────────────────────────

const arbMode = fc.constantFrom('farm', 'trade') as fc.Arbitrary<'farm' | 'trade'>;
const arbRegime = fc.constantFrom('TREND_UP', 'TREND_DOWN', 'SIDEWAY', 'HIGH_VOLATILITY') as fc.Arbitrary<
  'TREND_UP' | 'TREND_DOWN' | 'SIDEWAY' | 'HIGH_VOLATILITY'
>;
const arbConfidence = fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true });
const arbMomentumScore = fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true });
const arbTradePressure = fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true });
const arbFallback = fc.boolean();
const arbLlmMatchesMomentum = fc.option(fc.boolean(), { nil: null });
const arbAtrPct = fc.option(fc.float({ min: Math.fround(0), max: Math.fround(0.1), noNaN: true }), { nil: undefined });

const arbFilterInput: fc.Arbitrary<FilterInput> = fc.record({
  regime: arbRegime,
  confidence: arbConfidence,
  momentumScore: arbMomentumScore,
  tradePressure: arbTradePressure,
  fallback: arbFallback,
  llmMatchesMomentum: arbLlmMatchesMomentum,
  atrPct: arbAtrPct,
  mode: arbMode,
  FEE_RATE_MAKER: fc.constant(FEE_RATE_MAKER),
  FARM_MIN_CONFIDENCE_PRESSURE_GATE: fc.constant(FARM_MIN_CONFIDENCE_PRESSURE_GATE),
  FARM_MIN_FALLBACK_CONFIDENCE: fc.constant(FARM_MIN_FALLBACK_CONFIDENCE),
  FARM_SIDEWAY_MIN_CONFIDENCE: fc.constant(FARM_SIDEWAY_MIN_CONFIDENCE),
  FARM_TREND_MIN_CONFIDENCE: fc.constant(FARM_TREND_MIN_CONFIDENCE),
  FARM_MIN_HOLD_SECS: fc.constant(FARM_MIN_HOLD_SECS),
  FARM_MAX_HOLD_SECS: fc.constant(FARM_MAX_HOLD_SECS),
});

// ─── Property 1 & 2: Fee filter rejects/passes based on expectedEdge vs threshold ───

describe('Feature: farm-signal-cost-optimizer, Property 1: Fee filter rejects low-edge signals', () => {
  it('feeAwareEntryFilter rejects when expectedEdge <= minRequiredMove × 1.5', () => {
    fc.assert(
      fc.property(arbFilterInput, (input) => {
        if (input.mode !== 'farm') return; // Skip trade mode

        const minRequiredMove = input.FEE_RATE_MAKER * 2;
        const atrPct = input.atrPct ?? 0;
        const expectedEdge = Math.abs(input.momentumScore - 0.5) * 2 * atrPct;
        const threshold = minRequiredMove * 1.5;

        const result = feeAwareEntryFilter(input);

        if (expectedEdge <= threshold) {
          expect(result.pass).toBe(false);
          expect(result.reason).toContain('[FeeFilter] SKIP');
        }
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: farm-signal-cost-optimizer, Property 2: Fee filter passes sufficient-edge signals', () => {
  it('feeAwareEntryFilter passes when expectedEdge > minRequiredMove × 1.5', () => {
    fc.assert(
      fc.property(arbFilterInput, (input) => {
        if (input.mode !== 'farm') return; // Skip trade mode

        const minRequiredMove = input.FEE_RATE_MAKER * 2;
        const atrPct = input.atrPct ?? 0;
        const expectedEdge = Math.abs(input.momentumScore - 0.5) * 2 * atrPct;
        const threshold = minRequiredMove * 1.5;

        const result = feeAwareEntryFilter(input);

        if (expectedEdge > threshold) {
          expect(result.pass).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 3: All filters are no-ops in trade mode ────────────────────────

describe('Feature: farm-signal-cost-optimizer, Property 3: All filters are no-ops in trade mode', () => {
  it('all gate filters return pass=true for mode=trade regardless of signal values', () => {
    const arbTradeInput = arbFilterInput.map((input) => ({ ...input, mode: 'trade' as const }));

    fc.assert(
      fc.property(arbTradeInput, (input) => {
        expect(regimeConfidenceThreshold(input).pass).toBe(true);
        expect(tradePressureGate(input).pass).toBe(true);
        expect(fallbackQualityGate(input).pass).toBe(true);
        expect(feeAwareEntryFilter(input).pass).toBe(true);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 4 & 5: Pressure gate rejects/passes based on tradePressure and confidence ───

describe('Feature: farm-signal-cost-optimizer, Property 4: Pressure gate rejects zero-pressure low-confidence signals', () => {
  it('tradePressureGate rejects when tradePressure=0 AND confidence < threshold', () => {
    const arbZeroPressureLowConf = arbFilterInput.map((input) => ({
      ...input,
      mode: 'farm' as const,
      tradePressure: 0,
      confidence: fc.sample(fc.float({ min: Math.fround(0), max: Math.fround(FARM_MIN_CONFIDENCE_PRESSURE_GATE - 0.01), noNaN: true }), 1)[0],
    }));

    fc.assert(
      fc.property(arbZeroPressureLowConf, (input) => {
        const result = tradePressureGate(input);
        expect(result.pass).toBe(false);
        expect(result.reason).toContain('[PressureGate] SKIP');
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: farm-signal-cost-optimizer, Property 5: Pressure gate passes non-zero-pressure or high-confidence signals', () => {
  it('tradePressureGate passes when tradePressure > 0 OR confidence >= threshold', () => {
    fc.assert(
      fc.property(arbFilterInput, (input) => {
        if (input.mode !== 'farm') return;

        const result = tradePressureGate(input);

        if (input.tradePressure > 0 || input.confidence >= input.FARM_MIN_CONFIDENCE_PRESSURE_GATE) {
          expect(result.pass).toBe(true);
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 6, 7, 8: LLM adjuster applies correct boost/penalty/identity ───

describe('Feature: farm-signal-cost-optimizer, Property 6: LLM mismatch penalty is applied correctly', () => {
  it('llmMomentumAdjuster applies 0.80 penalty when llmMatchesMomentum=false AND confidence < 0.65', () => {
    const arbMismatchLowConf = fc.record({
      confidence: fc.float({ min: Math.fround(0), max: Math.fround(0.649), noNaN: true }),
      llmMatchesMomentum: fc.constant(false),
    });

    fc.assert(
      fc.property(arbMismatchLowConf, ({ confidence, llmMatchesMomentum }) => {
        const input = {
          ...fc.sample(arbFilterInput, 1)[0],
          confidence,
          llmMatchesMomentum,
        };
        const result = llmMomentumAdjuster(input);
        expect(result).toBeCloseTo(confidence * 0.80, 5);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: farm-signal-cost-optimizer, Property 7: LLM match boost is applied correctly and capped at 1.0', () => {
  it('llmMomentumAdjuster applies 1.10 boost capped at 1.0 when llmMatchesMomentum=true', () => {
    const arbMatchConf = fc.record({
      confidence: arbConfidence,
      llmMatchesMomentum: fc.constant(true),
    });

    fc.assert(
      fc.property(arbMatchConf, ({ confidence, llmMatchesMomentum }) => {
        const input = {
          ...fc.sample(arbFilterInput, 1)[0],
          confidence,
          llmMatchesMomentum,
        };
        const result = llmMomentumAdjuster(input);
        const expected = Math.min(1.0, confidence * 1.10);
        expect(result).toBeCloseTo(expected, 5);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: farm-signal-cost-optimizer, Property 8: LLM adjuster is identity for null/undefined and high-confidence mismatch', () => {
  it('llmMomentumAdjuster returns confidence unchanged for null/undefined or (false AND confidence >= 0.65)', () => {
    const arbIdentityCases = fc.oneof(
      // Case 1: llmMatchesMomentum is null
      fc.record({
        confidence: arbConfidence,
        llmMatchesMomentum: fc.constant(null),
      }),
      // Case 2: llmMatchesMomentum is undefined
      fc.record({
        confidence: arbConfidence,
        llmMatchesMomentum: fc.constant(undefined),
      }),
      // Case 3: llmMatchesMomentum is false AND confidence >= 0.65
      // Use Math.fround(0.6500001) as min to ensure the float32 value is >= 0.65
      // (Math.fround(0.65) = 0.6499999761581421 which is < 0.65 and would trigger penalty)
      fc.record({
        confidence: fc.float({ min: Math.fround(0.6500001), max: Math.fround(1.0), noNaN: true }),
        llmMatchesMomentum: fc.constant(false),
      })
    );

    fc.assert(
      fc.property(arbIdentityCases, ({ confidence, llmMatchesMomentum }) => {
        const input = {
          ...fc.sample(arbFilterInput, 1)[0],
          confidence,
          llmMatchesMomentum,
        };
        const result = llmMomentumAdjuster(input);
        expect(result).toBe(confidence);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 9: Fallback gate rejects low-confidence fallback signals ───────

describe('Feature: farm-signal-cost-optimizer, Property 9: Fallback gate rejects low-confidence fallback signals', () => {
  it('fallbackQualityGate rejects when fallback=true AND confidence < threshold', () => {
    const arbFallbackLowConf = arbFilterInput.map((input) => ({
      ...input,
      mode: 'farm' as const,
      fallback: true,
      confidence: fc.sample(fc.float({ min: Math.fround(0), max: Math.fround(FARM_MIN_FALLBACK_CONFIDENCE - 0.01), noNaN: true }), 1)[0],
    }));

    fc.assert(
      fc.property(arbFallbackLowConf, (input) => {
        const result = fallbackQualityGate(input);
        expect(result.pass).toBe(false);
        expect(result.reason).toContain('[FallbackGate] SKIP');
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 10: Regime gate rejects low-confidence signals per regime ──────

describe('Feature: farm-signal-cost-optimizer, Property 10: Regime gate rejects low-confidence signals per regime', () => {
  it('regimeConfidenceThreshold rejects SIDEWAY signals with confidence < FARM_SIDEWAY_MIN_CONFIDENCE', () => {
    const arbSidewayLowConf = arbFilterInput.map((input) => ({
      ...input,
      mode: 'farm' as const,
      regime: 'SIDEWAY' as const,
      confidence: fc.sample(fc.float({ min: Math.fround(0), max: Math.fround(FARM_SIDEWAY_MIN_CONFIDENCE - 0.01), noNaN: true }), 1)[0],
    }));

    fc.assert(
      fc.property(arbSidewayLowConf, (input) => {
        const result = regimeConfidenceThreshold(input);
        expect(result.pass).toBe(false);
        expect(result.reason).toContain('[RegimeGate] SKIP');
      }),
      { numRuns: 100 }
    );
  });

  it('regimeConfidenceThreshold rejects TREND signals with confidence < FARM_TREND_MIN_CONFIDENCE', () => {
    const arbTrendLowConf = arbFilterInput.map((input) => ({
      ...input,
      mode: 'farm' as const,
      regime: fc.sample(fc.constantFrom('TREND_UP' as const, 'TREND_DOWN' as const), 1)[0],
      confidence: fc.sample(fc.float({ min: Math.fround(0), max: Math.fround(FARM_TREND_MIN_CONFIDENCE - 0.01), noNaN: true }), 1)[0],
    }));

    fc.assert(
      fc.property(arbTrendLowConf, (input) => {
        const result = regimeConfidenceThreshold(input);
        expect(result.pass).toBe(false);
        expect(result.reason).toContain('[RegimeGate] SKIP');
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 11 & 12: dynamicMinHold is bounded and falls back correctly ────

describe('Feature: farm-signal-cost-optimizer, Property 11: dynamicMinHold is bounded between FARM_MIN_HOLD_SECS and FARM_MAX_HOLD_SECS', () => {
  it('computeDynamicMinHold always returns value in [FARM_MIN_HOLD_SECS, FARM_MAX_HOLD_SECS]', () => {
    fc.assert(
      fc.property(arbFilterInput, (input) => {
        const result = computeDynamicMinHold(input);
        expect(result).toBeGreaterThanOrEqual(input.FARM_MIN_HOLD_SECS);
        expect(result).toBeLessThanOrEqual(input.FARM_MAX_HOLD_SECS);
      }),
      { numRuns: 100 }
    );
  });
});

describe('Feature: farm-signal-cost-optimizer, Property 12: dynamicMinHold falls back to FARM_MIN_HOLD_SECS when atrPct is zero or unavailable', () => {
  it('computeDynamicMinHold returns exactly FARM_MIN_HOLD_SECS when atrPct is 0, null, or undefined', () => {
    const arbZeroAtr = arbFilterInput.map((input) => ({
      ...input,
      atrPct: fc.sample(fc.constantFrom(0, null, undefined), 1)[0],
    }));

    fc.assert(
      fc.property(arbZeroAtr, (input) => {
        const result = computeDynamicMinHold(input);
        expect(result).toBe(input.FARM_MIN_HOLD_SECS);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 13: Pipeline short-circuits on first rejection ─────────────────

describe('Feature: farm-signal-cost-optimizer, Property 13: Pipeline short-circuits on first rejection', () => {
  it('evaluateFarmEntryFilters returns reason from first failing filter, not subsequent filters', () => {
    // Generate inputs that fail at each filter stage
    const arbFailAtRegime = arbFilterInput.map((input) => ({
      ...input,
      mode: 'farm' as const,
      regime: 'SIDEWAY' as const,
      confidence: 0.1, // Below FARM_SIDEWAY_MIN_CONFIDENCE (0.45)
      tradePressure: 0,
      fallback: true,
      atrPct: 0, // Would fail fee filter too
    }));

    fc.assert(
      fc.property(arbFailAtRegime, (input) => {
        const result = evaluateFarmEntryFilters(input);
        if (!result.pass) {
          // Should fail at regime gate (first filter)
          expect(result.reason).toContain('[RegimeGate]');
          expect(result.reason).not.toContain('[PressureGate]');
          expect(result.reason).not.toContain('[FallbackGate]');
          expect(result.reason).not.toContain('[FeeFilter]');
        }
      }),
      { numRuns: 100 }
    );
  });

  it('pipeline stops at pressure gate when regime passes but pressure fails', () => {
    const arbFailAtPressure = arbFilterInput.map((input) => ({
      ...input,
      mode: 'farm' as const,
      regime: 'TREND_UP' as const,
      confidence: 0.4, // Above FARM_TREND_MIN_CONFIDENCE (0.35) but below FARM_MIN_CONFIDENCE_PRESSURE_GATE (0.55)
      tradePressure: 0, // Fails pressure gate
      fallback: true, // Would fail fallback gate too
      atrPct: 0, // Would fail fee filter too
    }));

    fc.assert(
      fc.property(arbFailAtPressure, (input) => {
        const result = evaluateFarmEntryFilters(input);
        if (!result.pass) {
          expect(result.reason).toContain('[PressureGate]');
          expect(result.reason).not.toContain('[FallbackGate]');
          expect(result.reason).not.toContain('[FeeFilter]');
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 14: filterSkipStats counts match trade records ─────────────────

describe('Feature: farm-signal-cost-optimizer, Property 14: filterSkipStats counts match trade records', () => {
  it('AnalyticsEngine.compute() filterSkipStats counts match filterResult prefixes in trade records', () => {
    // Generate a collection of trade records with various filterResult values
    const arbTradeRecords = fc.array(
      fc.record({
        id: fc.uuid(),
        timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true }).map((d) => d.toISOString()),
        symbol: fc.constant('BTC-USD'),
        direction: fc.constantFrom('long', 'short') as fc.Arbitrary<'long' | 'short'>,
        confidence: arbConfidence,
        reasoning: fc.constant('test'),
        fallback: arbFallback,
        entryPrice: fc.float({ min: Math.fround(10000), max: Math.fround(100000), noNaN: true }),
        exitPrice: fc.float({ min: Math.fround(10000), max: Math.fround(100000), noNaN: true }),
        pnl: fc.float({ min: Math.fround(-100), max: Math.fround(100), noNaN: true }),
        sessionPnl: fc.float({ min: Math.fround(-100), max: Math.fround(100), noNaN: true }),
        mode: fc.constant('farm') as fc.Arbitrary<'farm'>,
        filterResult: fc.option(
          fc.constantFrom(
            '[RegimeGate] SKIP: regime=SIDEWAY, confidence=0.4 < 0.45',
            '[PressureGate] SKIP: tradePressure=0, confidence=0.5 < 0.55',
            '[FallbackGate] SKIP: fallback=true, confidence=0.2 < 0.25',
            '[FeeFilter] SKIP: edge=0.001 <= minMove×1.5=0.00036',
            'pass'
          ),
          { nil: undefined }
        ),
      }) as fc.Arbitrary<TradeRecord>,
      { minLength: 0, maxLength: 50 }
    );

    fc.assert(
      fc.property(arbTradeRecords, (trades) => {
        const engine = new AnalyticsEngine();
        const summary = engine.compute(trades);

        // Manually count expected values
        const expectedRegime = trades.filter((t) => t.filterResult?.startsWith('[RegimeGate]')).length;
        const expectedPressure = trades.filter((t) => t.filterResult?.startsWith('[PressureGate]')).length;
        const expectedFallback = trades.filter((t) => t.filterResult?.startsWith('[FallbackGate]')).length;
        const expectedFee = trades.filter((t) => t.filterResult?.startsWith('[FeeFilter]')).length;

        expect(summary.filterSkipStats.regimeGate).toBe(expectedRegime);
        expect(summary.filterSkipStats.pressureGate).toBe(expectedPressure);
        expect(summary.filterSkipStats.fallbackGate).toBe(expectedFallback);
        expect(summary.filterSkipStats.feeFilter).toBe(expectedFee);
        expect(summary.filterSkipStats.total).toBe(expectedRegime + expectedPressure + expectedFallback + expectedFee);
      }),
      { numRuns: 100 }
    );
  });
});

// ─── Property 15: Config validation rejects out-of-range values ──────────────

describe('Feature: farm-signal-cost-optimizer, Property 15: Config validation rejects out-of-range values', () => {
  it('validateOverrides rejects FARM_MIN_CONFIDENCE_PRESSURE_GATE outside [0, 1]', () => {
    const arbOutOfRange = fc.oneof(
      fc.float({ min: Math.fround(-10), max: Math.fround(-0.001), noNaN: true }),
      fc.float({ min: Math.fround(1.001), max: Math.fround(10), noNaN: true })
    );

    fc.assert(
      fc.property(arbOutOfRange, (value) => {
        const patch = { FARM_MIN_CONFIDENCE_PRESSURE_GATE: value };
        const effective = {
          ...config,
          MODE: config.MODE as 'farm' | 'trade',
        };
        const errors = validateOverrides(patch, effective as any);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.field === 'FARM_MIN_CONFIDENCE_PRESSURE_GATE')).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('validateOverrides rejects FARM_MIN_FALLBACK_CONFIDENCE outside [0, 1]', () => {
    const arbOutOfRange = fc.oneof(
      fc.float({ min: Math.fround(-10), max: Math.fround(-0.001), noNaN: true }),
      fc.float({ min: Math.fround(1.001), max: Math.fround(10), noNaN: true })
    );

    fc.assert(
      fc.property(arbOutOfRange, (value) => {
        const patch = { FARM_MIN_FALLBACK_CONFIDENCE: value };
        const effective = {
          ...config,
          MODE: config.MODE as 'farm' | 'trade',
        };
        const errors = validateOverrides(patch, effective as any);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.field === 'FARM_MIN_FALLBACK_CONFIDENCE')).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('validateOverrides rejects FARM_SIDEWAY_MIN_CONFIDENCE outside [0, 1]', () => {
    const arbOutOfRange = fc.oneof(
      fc.float({ min: Math.fround(-10), max: Math.fround(-0.001), noNaN: true }),
      fc.float({ min: Math.fround(1.001), max: Math.fround(10), noNaN: true })
    );

    fc.assert(
      fc.property(arbOutOfRange, (value) => {
        const patch = { FARM_SIDEWAY_MIN_CONFIDENCE: value };
        const effective = {
          ...config,
          MODE: config.MODE as 'farm' | 'trade',
        };
        const errors = validateOverrides(patch, effective as any);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.field === 'FARM_SIDEWAY_MIN_CONFIDENCE')).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('validateOverrides rejects FARM_TREND_MIN_CONFIDENCE outside [0, 1]', () => {
    const arbOutOfRange = fc.oneof(
      fc.float({ min: Math.fround(-10), max: Math.fround(-0.001), noNaN: true }),
      fc.float({ min: Math.fround(1.001), max: Math.fround(10), noNaN: true })
    );

    fc.assert(
      fc.property(arbOutOfRange, (value) => {
        const patch = { FARM_TREND_MIN_CONFIDENCE: value };
        const effective = {
          ...config,
          MODE: config.MODE as 'farm' | 'trade',
        };
        const errors = validateOverrides(patch, effective as any);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => e.field === 'FARM_TREND_MIN_CONFIDENCE')).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('validateOverrides accepts all four config keys when in [0, 1]', () => {
    const arbInRange = fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true });

    fc.assert(
      fc.property(arbInRange, arbInRange, arbInRange, arbInRange, (v1, v2, v3, v4) => {
        const patch = {
          FARM_MIN_CONFIDENCE_PRESSURE_GATE: v1,
          FARM_MIN_FALLBACK_CONFIDENCE: v2,
          FARM_SIDEWAY_MIN_CONFIDENCE: v3,
          FARM_TREND_MIN_CONFIDENCE: v4,
        };
        const effective = {
          ...config,
          MODE: config.MODE as 'farm' | 'trade',
        };
        const errors = validateOverrides(patch, effective as any);
        // Should have no errors for these fields (may have other errors from cross-field validation)
        const relevantErrors = errors.filter((e) =>
          [
            'FARM_MIN_CONFIDENCE_PRESSURE_GATE',
            'FARM_MIN_FALLBACK_CONFIDENCE',
            'FARM_SIDEWAY_MIN_CONFIDENCE',
            'FARM_TREND_MIN_CONFIDENCE',
          ].includes(e.field)
        );
        expect(relevantErrors.length).toBe(0);
      }),
      { numRuns: 100 }
    );
  });
});
