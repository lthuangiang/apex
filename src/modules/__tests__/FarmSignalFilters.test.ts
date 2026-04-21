import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FilterInput,
  regimeConfidenceThreshold,
  tradePressureGate,
  fallbackQualityGate,
  feeAwareEntryFilter,
  llmMomentumAdjuster,
  computeDynamicMinHold,
  evaluateFarmEntryFilters,
} from '../FarmSignalFilters';
import { AnalyticsEngine } from '../../ai/AnalyticsEngine';
import { config } from '../../config';
import { ConfigStore } from '../../config/ConfigStore';

// ─── Shared base input ────────────────────────────────────────────────────────

const BASE_INPUT: FilterInput = {
  regime: 'TREND_UP',
  confidence: 0.8,
  momentumScore: 0.9,
  tradePressure: 0.6,
  fallback: false,
  llmMatchesMomentum: true,
  atrPct: 0.02,
  mode: 'farm',
  FEE_RATE_MAKER: 0.00012,
  FARM_MIN_CONFIDENCE_PRESSURE_GATE: 0.55,
  FARM_MIN_FALLBACK_CONFIDENCE: 0.25,
  FARM_SIDEWAY_MIN_CONFIDENCE: 0.45,
  FARM_TREND_MIN_CONFIDENCE: 0.35,
  FARM_MIN_HOLD_SECS: 120,
  FARM_MAX_HOLD_SECS: 480,
};

// ─── 7.2 Default config values ────────────────────────────────────────────────

describe('7.2 Default config values (Requirements 2.3, 4.3, 5.3, 5.4, 8.1)', () => {
  it('FARM_MIN_CONFIDENCE_PRESSURE_GATE defaults to 0.55', () => {
    expect(config.FARM_MIN_CONFIDENCE_PRESSURE_GATE).toBe(0.55);
  });

  it('FARM_MIN_FALLBACK_CONFIDENCE defaults to 0.25', () => {
    expect(config.FARM_MIN_FALLBACK_CONFIDENCE).toBe(0.25);
  });

  it('FARM_SIDEWAY_MIN_CONFIDENCE defaults to 0.45', () => {
    expect(config.FARM_SIDEWAY_MIN_CONFIDENCE).toBe(0.45);
  });

  it('FARM_TREND_MIN_CONFIDENCE defaults to 0.35', () => {
    expect(config.FARM_TREND_MIN_CONFIDENCE).toBe(0.35);
  });
});

// ─── 7.3 Log output format when each filter rejects ──────────────────────────

describe('7.3 Log output format when each filter rejects', () => {
  it('RegimeConfidenceThreshold: reason contains correct log prefix for SIDEWAY', () => {
    const input: FilterInput = {
      ...BASE_INPUT,
      regime: 'SIDEWAY',
      confidence: 0.40,
      FARM_SIDEWAY_MIN_CONFIDENCE: 0.45,
    };
    const result = regimeConfidenceThreshold(input);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('[RegimeGate] SKIP: regime=SIDEWAY, confidence=0.4 < 0.45');
  });

  it('TradePressureGate: reason contains correct log prefix', () => {
    const input: FilterInput = {
      ...BASE_INPUT,
      tradePressure: 0,
      confidence: 0.50,
      FARM_MIN_CONFIDENCE_PRESSURE_GATE: 0.55,
    };
    const result = tradePressureGate(input);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('[PressureGate] SKIP: tradePressure=0, confidence=0.5 < 0.55');
  });

  it('FallbackQualityGate: reason contains correct log prefix', () => {
    const input: FilterInput = {
      ...BASE_INPUT,
      fallback: true,
      confidence: 0.20,
      FARM_MIN_FALLBACK_CONFIDENCE: 0.25,
    };
    const result = fallbackQualityGate(input);
    expect(result.pass).toBe(false);
    expect(result.reason).toBe('[FallbackGate] SKIP: fallback=true, confidence=0.2 < 0.25');
  });

  it('FeeAwareEntryFilter: reason starts with [FeeFilter] SKIP: edge=', () => {
    // atrPct=0 → expectedEdge=0 → always fails fee filter
    const input: FilterInput = {
      ...BASE_INPUT,
      atrPct: 0,
      FEE_RATE_MAKER: 0.00012,
    };
    const result = feeAwareEntryFilter(input);
    expect(result.pass).toBe(false);
    expect(result.reason).toMatch(/^\[FeeFilter\] SKIP: edge=/);
  });
});

// ─── 7.4 Log output when all filters pass ────────────────────────────────────

describe('7.4 Log output when all filters pass', () => {
  it('evaluateFarmEntryFilters returns pass=true and reason is undefined when all filters pass', () => {
    // BASE_INPUT is designed to pass all filters:
    // - regime=TREND_UP, confidence=0.8 >= FARM_TREND_MIN_CONFIDENCE=0.35 ✓
    // - tradePressure=0.6 > 0 ✓
    // - fallback=false ✓
    // - atrPct=0.02, momentumScore=0.9 → edge = |0.9-0.5|*2*0.02 = 0.016 > 0.00012*2*1.5=0.00036 ✓
    const result = evaluateFarmEntryFilters(BASE_INPUT);
    expect(result.pass).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

// ─── 7.5 Pipeline happy path ──────────────────────────────────────────────────

describe('7.5 Pipeline happy path: signal passes all filters', () => {
  it('passes all filters and returns boosted effectiveConfidence and computed dynamicMinHold', () => {
    const input: FilterInput = {
      ...BASE_INPUT,
      regime: 'TREND_UP',
      confidence: 0.8,
      momentumScore: 0.9,
      tradePressure: 0.6,
      fallback: false,
      atrPct: 0.02,
      llmMatchesMomentum: true,
    };

    const result = evaluateFarmEntryFilters(input);

    expect(result.pass).toBe(true);

    // LLM boost: min(1.0, 0.8 * 1.1) = 0.88
    expect(result.effectiveConfidence).toBeCloseTo(0.88, 5);

    // dynamicMinHold: feeBreakEvenSecs = (0.00012 * 2 / 0.02) * 300 = 3.6s
    // max(120, 3.6) = 120, min(480, 120) = 120
    expect(result.dynamicMinHold).toBe(120);
  });

  it('effectiveConfidence is capped at 1.0 when boost would exceed it', () => {
    const input: FilterInput = {
      ...BASE_INPUT,
      confidence: 0.95,
      llmMatchesMomentum: true,
    };
    const result = evaluateFarmEntryFilters(input);
    expect(result.pass).toBe(true);
    // min(1.0, 0.95 * 1.1) = min(1.0, 1.045) = 1.0
    expect(result.effectiveConfidence).toBe(1.0);
  });

  it('dynamicMinHold is computed from ATR when atrPct is large enough to produce a value above FARM_MIN_HOLD_SECS', () => {
    // feeBreakEvenSecs = (0.00012 * 2 / 0.001) * 300 = 72s → below FARM_MIN_HOLD_SECS=120
    // so dynamicMinHold = max(120, 72) = 120
    const input: FilterInput = {
      ...BASE_INPUT,
      atrPct: 0.001,
    };
    const result = evaluateFarmEntryFilters(input);
    expect(result.pass).toBe(true);
    expect(result.dynamicMinHold).toBe(120);
  });

  it('computeDynamicMinHold is capped at FARM_MAX_HOLD_SECS when feeBreakEvenSecs is very large', () => {
    // feeBreakEvenSecs = (0.00012 * 2 / 0.00001) * 300 = 720000s → capped at 480
    const input: FilterInput = {
      ...BASE_INPUT,
      atrPct: 0.00001,
    };
    const hold = computeDynamicMinHold(input);
    expect(hold).toBe(480);
  });
});

// ─── 7.6 Config warning when FARM_SIDEWAY_MIN_CONFIDENCE < FARM_TREND_MIN_CONFIDENCE ───

describe('7.6 Config warning when FARM_SIDEWAY_MIN_CONFIDENCE < FARM_TREND_MIN_CONFIDENCE', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('logs a warning when FARM_SIDEWAY_MIN_CONFIDENCE is set below FARM_TREND_MIN_CONFIDENCE', () => {
    const store = new ConfigStore();

    // Set sideway threshold below trend threshold — should trigger warning
    store.applyOverrides({
      FARM_SIDEWAY_MIN_CONFIDENCE: 0.30,
      FARM_TREND_MIN_CONFIDENCE: 0.40,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[Config] WARN: FARM_SIDEWAY_MIN_CONFIDENCE < FARM_TREND_MIN_CONFIDENCE — sideway threshold should be higher'
    );
  });

  it('does NOT log a warning when FARM_SIDEWAY_MIN_CONFIDENCE >= FARM_TREND_MIN_CONFIDENCE', () => {
    const store = new ConfigStore();

    // Normal case: sideway threshold is higher than trend threshold
    store.applyOverrides({
      FARM_SIDEWAY_MIN_CONFIDENCE: 0.45,
      FARM_TREND_MIN_CONFIDENCE: 0.35,
    });

    const warnCalls = warnSpy.mock.calls.filter((args) =>
      typeof args[0] === 'string' && args[0].includes('FARM_SIDEWAY_MIN_CONFIDENCE')
    );
    expect(warnCalls.length).toBe(0);
  });

  it('logs a warning when only FARM_SIDEWAY_MIN_CONFIDENCE is overridden to be below the effective FARM_TREND_MIN_CONFIDENCE', () => {
    const store = new ConfigStore();

    // Default FARM_TREND_MIN_CONFIDENCE is 0.35; set sideway below it
    store.applyOverrides({
      FARM_SIDEWAY_MIN_CONFIDENCE: 0.20,
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[Config] WARN: FARM_SIDEWAY_MIN_CONFIDENCE < FARM_TREND_MIN_CONFIDENCE — sideway threshold should be higher'
    );
  });
});

// ─── 7.7 AnalyticsSummary has all 3 new fields ───────────────────────────────

describe('7.7 AnalyticsSummary has all 3 new fields', () => {
  it('AnalyticsEngine.compute([]) returns filterSkipStats with all counters at 0', () => {
    const engine = new AnalyticsEngine();
    const summary = engine.compute([]);

    expect(summary.filterSkipStats).toBeDefined();
    expect(summary.filterSkipStats.regimeGate).toBe(0);
    expect(summary.filterSkipStats.pressureGate).toBe(0);
    expect(summary.filterSkipStats.fallbackGate).toBe(0);
    expect(summary.filterSkipStats.feeFilter).toBe(0);
    expect(summary.filterSkipStats.total).toBe(0);
  });

  it('AnalyticsEngine.compute([]) returns effectiveConfidenceStats with all fields present', () => {
    const engine = new AnalyticsEngine();
    const summary = engine.compute([]);

    expect(summary.effectiveConfidenceStats).toBeDefined();
    expect(typeof summary.effectiveConfidenceStats.avgRawConfidence).toBe('number');
    expect(typeof summary.effectiveConfidenceStats.avgEffectiveConfidence).toBe('number');
    expect(typeof summary.effectiveConfidenceStats.adjustedTradeCount).toBe('number');
  });

  it('AnalyticsEngine.compute([]) returns dynamicMinHoldStats with all fields present', () => {
    const engine = new AnalyticsEngine();
    const summary = engine.compute([]);

    expect(summary.dynamicMinHoldStats).toBeDefined();
    expect(typeof summary.dynamicMinHoldStats.avgDynamicMinHold).toBe('number');
    expect(typeof summary.dynamicMinHoldStats.avgActualHoldSecs).toBe('number');
    expect(typeof summary.dynamicMinHoldStats.earlyExitRate).toBe('number');
  });

  it('filterSkipStats.total equals sum of all per-filter counts', () => {
    const engine = new AnalyticsEngine();
    const summary = engine.compute([]);

    const { regimeGate, pressureGate, fallbackGate, feeFilter, total } = summary.filterSkipStats;
    expect(total).toBe(regimeGate + pressureGate + fallbackGate + feeFilter);
  });

  it('filterSkipStats counts are correct for trades with known filterResult values', () => {
    const engine = new AnalyticsEngine();

    const makeTrade = (filterResult: string) => ({
      id: 'test-id',
      timestamp: '2024-01-01T00:00:00.000Z',
      symbol: 'BTC-USD',
      direction: 'long' as const,
      confidence: 0.7,
      reasoning: 'test',
      fallback: false,
      entryPrice: 50000,
      exitPrice: 50100,
      pnl: 0.5,
      sessionPnl: 0.5,
      mode: 'farm' as const,
      filterResult,
    });

    const trades = [
      makeTrade('[RegimeGate] SKIP: regime=SIDEWAY, confidence=0.4 < 0.45'),
      makeTrade('[RegimeGate] SKIP: regime=TREND_UP, confidence=0.3 < 0.35'),
      makeTrade('[PressureGate] SKIP: tradePressure=0, confidence=0.5 < 0.55'),
      makeTrade('[FallbackGate] SKIP: fallback=true, confidence=0.2 < 0.25'),
      makeTrade('[FeeFilter] SKIP: edge=0 <= minMove×1.5=0.00036'),
      makeTrade('pass'),
    ];

    const summary = engine.compute(trades);

    expect(summary.filterSkipStats.regimeGate).toBe(2);
    expect(summary.filterSkipStats.pressureGate).toBe(1);
    expect(summary.filterSkipStats.fallbackGate).toBe(1);
    expect(summary.filterSkipStats.feeFilter).toBe(1);
    expect(summary.filterSkipStats.total).toBe(5);
  });
});
