import { describe, it, expect, vi, afterEach } from 'vitest';
import { PositionSizer } from '../PositionSizer';

// Config constants (from src/config.ts defaults)
const ORDER_SIZE_MIN = 0.003;
const SIZING_MIN_MULTIPLIER = 0.5;
const SIZING_MAX_MULTIPLIER = 2.0;
const SIZING_DRAWDOWN_THRESHOLD = -3.0;
const SIZING_MAX_BTC = 0.008;
const MIN_CONFIDENCE = 0.65;

const sizer = new PositionSizer();

// ─── confidenceMultiplier ────────────────────────────────────────────────────

describe('confidenceMultiplier', () => {
  describe('farm mode dampening', () => {
    it('confidence 0.5 → ~1.0', () => {
      const result = sizer.confidenceMultiplier(0.5, 'farm');
      expect(result).toBeCloseTo(1.0, 5);
    });

    it('confidence 1.0 → ~1.3', () => {
      const result = sizer.confidenceMultiplier(1.0, 'farm');
      // 1.0 + (1.0 - 0.5) * 0.6 = 1.3
      expect(result).toBeCloseTo(1.3, 5);
    });
  });

  describe('trade mode scaling', () => {
    it('confidence at MIN_CONFIDENCE → ~1.0', () => {
      const result = sizer.confidenceMultiplier(MIN_CONFIDENCE, 'trade');
      expect(result).toBeCloseTo(1.0, 5);
    });

    it('confidence 1.0 → SIZING_MAX_MULTIPLIER (2.0)', () => {
      const result = sizer.confidenceMultiplier(1.0, 'trade');
      expect(result).toBeCloseTo(SIZING_MAX_MULTIPLIER, 5);
    });
  });

  describe('boundary values', () => {
    it('confidence 0 in farm mode → clamped to SIZING_MIN_MULTIPLIER', () => {
      // 1.0 + (0 - 0.5) * 0.6 = 0.7 → above SIZING_MIN_MULTIPLIER
      const result = sizer.confidenceMultiplier(0, 'farm');
      expect(result).toBeGreaterThanOrEqual(SIZING_MIN_MULTIPLIER);
      expect(result).toBeLessThanOrEqual(SIZING_MAX_MULTIPLIER);
    });

    it('confidence 0 in trade mode → clamped to SIZING_MIN_MULTIPLIER', () => {
      // normalised = (0 - 0.65) / 0.35 = negative → multiplier < 1.0 → clamped
      const result = sizer.confidenceMultiplier(0, 'trade');
      expect(result).toBe(SIZING_MIN_MULTIPLIER);
    });

    it('confidence MIN_CONFIDENCE in trade mode → 1.0', () => {
      const result = sizer.confidenceMultiplier(MIN_CONFIDENCE, 'trade');
      expect(result).toBeCloseTo(1.0, 5);
    });

    it('confidence 1.0 in trade mode → SIZING_MAX_MULTIPLIER', () => {
      const result = sizer.confidenceMultiplier(1.0, 'trade');
      expect(result).toBeCloseTo(SIZING_MAX_MULTIPLIER, 5);
    });
  });

  describe('clamp at bounds', () => {
    it('result is always >= SIZING_MIN_MULTIPLIER', () => {
      for (const conf of [0, 0.1, 0.5, 0.65, 0.9, 1.0]) {
        for (const mode of ['farm', 'trade'] as const) {
          expect(sizer.confidenceMultiplier(conf, mode)).toBeGreaterThanOrEqual(SIZING_MIN_MULTIPLIER);
        }
      }
    });

    it('result is always <= SIZING_MAX_MULTIPLIER', () => {
      for (const conf of [0, 0.1, 0.5, 0.65, 0.9, 1.0]) {
        for (const mode of ['farm', 'trade'] as const) {
          expect(sizer.confidenceMultiplier(conf, mode)).toBeLessThanOrEqual(SIZING_MAX_MULTIPLIER);
        }
      }
    });
  });
});

// ─── performanceMultiplier ───────────────────────────────────────────────────

describe('performanceMultiplier', () => {
  it('0% win rate (all negative PnLs, no drawdown) → ~0.7 × profileBias (NORMAL)', () => {
    const result = sizer.performanceMultiplier([-1, -2, -0.5], 0, 'NORMAL');
    // winRateMult = 0.7 + 0 * 0.6 = 0.7, drawdownMult = 1.0, profileBias = 1.0
    expect(result).toBeCloseTo(0.7, 5);
  });

  it('50% win rate → ~1.0 × profileBias (NORMAL)', () => {
    const result = sizer.performanceMultiplier([1, -1, 1, -1], 0, 'NORMAL');
    // winRateMult = 0.7 + 0.5 * 0.6 = 1.0, drawdownMult = 1.0, profileBias = 1.0
    expect(result).toBeCloseTo(1.0, 5);
  });

  it('100% win rate → ~1.3 × profileBias (NORMAL)', () => {
    const result = sizer.performanceMultiplier([1, 2, 0.5, 1.5, 0.3], 0, 'NORMAL');
    // winRateMult = 0.7 + 1.0 * 0.6 = 1.3, drawdownMult = 1.0, profileBias = 1.0
    expect(result).toBeCloseTo(1.3, 5);
  });

  it('drawdown floor activation: sessionPnl <= SIZING_DRAWDOWN_THRESHOLD → multiplier < 1.0', () => {
    const result = sizer.performanceMultiplier([], SIZING_DRAWDOWN_THRESHOLD, 'NORMAL');
    expect(result).toBeLessThan(1.0);
  });

  it('deep drawdown: sessionPnl well below threshold → multiplier clamped to SIZING_MIN_MULTIPLIER', () => {
    const result = sizer.performanceMultiplier([], -100, 'NORMAL');
    expect(result).toBe(SIZING_MIN_MULTIPLIER);
  });

  describe('profile bias ordering', () => {
    const pnls = [1, 1, 1]; // 100% win rate, no drawdown
    const sessionPnl = 0;

    it('RUNNER > NORMAL', () => {
      const runner = sizer.performanceMultiplier(pnls, sessionPnl, 'RUNNER');
      const normal = sizer.performanceMultiplier(pnls, sessionPnl, 'NORMAL');
      expect(runner).toBeGreaterThan(normal);
    });

    it('NORMAL > DEGEN', () => {
      const normal = sizer.performanceMultiplier(pnls, sessionPnl, 'NORMAL');
      const degen = sizer.performanceMultiplier(pnls, sessionPnl, 'DEGEN');
      expect(normal).toBeGreaterThan(degen);
    });

    it('DEGEN > SCALP', () => {
      const degen = sizer.performanceMultiplier(pnls, sessionPnl, 'DEGEN');
      const scalp = sizer.performanceMultiplier(pnls, sessionPnl, 'SCALP');
      expect(degen).toBeGreaterThan(scalp);
    });
  });

  it('empty recentPnLs with sessionPnl above threshold and NORMAL profile → exactly 1.0', () => {
    const result = sizer.performanceMultiplier([], 0, 'NORMAL');
    expect(result).toBe(1.0);
  });
});

// ─── applyRiskCaps ───────────────────────────────────────────────────────────

describe('applyRiskCaps', () => {
  it('rawSize > SIZING_MAX_BTC → size = SIZING_MAX_BTC, cappedBy = btc_cap', () => {
    const { size, cappedBy } = sizer.applyRiskCaps(0.01);
    expect(size).toBe(SIZING_MAX_BTC);
    expect(cappedBy).toBe('btc_cap');
  });

  it('rawSize < ORDER_SIZE_MIN → size = ORDER_SIZE_MIN', () => {
    const { size } = sizer.applyRiskCaps(0.001);
    expect(size).toBe(ORDER_SIZE_MIN);
  });

  it('rawSize within bounds → cappedBy = none', () => {
    const { size, cappedBy } = sizer.applyRiskCaps(0.004);
    expect(size).toBe(0.004);
    expect(cappedBy).toBe('none');
  });
});

// ─── computeSize — volatilityFactor ─────────────────────────────────────────

describe('computeSize — volatilityFactor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('omitting volatilityFactor produces the same result as volatilityFactor: 1.0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const base: Parameters<typeof sizer.computeSize>[0] = {
      confidence: 0.8,
      recentPnLs: [1, -1, 1],
      sessionPnl: 0,
      balance: 500,
      mode: 'trade',
      profile: 'NORMAL',
    };
    const withoutFactor = sizer.computeSize(base);
    const withFactor1 = sizer.computeSize({ ...base, volatilityFactor: 1.0 });
    expect(withoutFactor.size).toBe(withFactor1.size);
    expect(withoutFactor.volatilityFactor).toBe(1.0);
    expect(withFactor1.volatilityFactor).toBe(1.0);
  });

  it('volatilityFactor: 0.5 produces size <= same call with volatilityFactor: 1.0', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const base: Parameters<typeof sizer.computeSize>[0] = {
      confidence: 0.8,
      recentPnLs: [1, -1, 1],
      sessionPnl: 0,
      balance: 500,
      mode: 'trade',
      profile: 'NORMAL',
    };
    const half = sizer.computeSize({ ...base, volatilityFactor: 0.5 });
    const full = sizer.computeSize({ ...base, volatilityFactor: 1.0 });
    expect(half.size).toBeLessThanOrEqual(full.size);
  });

  it('volatilityFactor: 0.0 is clamped to 0.1 and reflected in SizingResult.volatilityFactor', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const result = sizer.computeSize({
      confidence: 0.8,
      recentPnLs: [],
      sessionPnl: 0,
      balance: 500,
      mode: 'trade',
      profile: 'NORMAL',
      volatilityFactor: 0.0,
    });
    expect(result.volatilityFactor).toBe(0.1);
  });

  it('volatilityFactor: 1.5 is clamped to 1.0 and reflected in SizingResult.volatilityFactor', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const result = sizer.computeSize({
      confidence: 0.8,
      recentPnLs: [],
      sessionPnl: 0,
      balance: 500,
      mode: 'trade',
      profile: 'NORMAL',
      volatilityFactor: 1.5,
    });
    expect(result.volatilityFactor).toBe(1.0);
  });
});

// ─── computeSize end-to-end ──────────────────────────────────────────────────

describe('computeSize', () => {
  it('high-confidence winning streak: all result fields populated and size in valid range', () => {
    const result = sizer.computeSize({
      confidence: 0.9,
      recentPnLs: [0.4, 0.6, 0.3, 0.5, 0.2],
      sessionPnl: 2.0,
      balance: 500,
      mode: 'trade',
      profile: 'RUNNER',
    });

    expect(result.size).toBeDefined();
    expect(result.confidenceMultiplier).toBeDefined();
    expect(result.performanceMultiplier).toBeDefined();
    expect(result.combinedMultiplier).toBeDefined();
    expect(result.cappedBy).toBeDefined();

    expect(result.size).toBeGreaterThanOrEqual(ORDER_SIZE_MIN);
    expect(result.size).toBeLessThanOrEqual(SIZING_MAX_BTC);
  });

  it('deep drawdown scenario: size is reduced (at or near minimum)', () => {
    const normalResult = sizer.computeSize({
      confidence: 0.7,
      recentPnLs: [0.5, 0.5, 0.5],
      sessionPnl: 1.0,
      balance: 500,
      mode: 'trade',
      profile: 'NORMAL',
    });

    const drawdownResult = sizer.computeSize({
      confidence: 0.7,
      recentPnLs: [-0.5, -0.5, -0.5],
      sessionPnl: -5.0,
      balance: 500,
      mode: 'trade',
      profile: 'NORMAL',
    });

    // Drawdown result should have a lower or equal combined multiplier
    expect(drawdownResult.combinedMultiplier).toBeLessThanOrEqual(normalResult.combinedMultiplier);
    // Size should still be within valid range
    expect(drawdownResult.size).toBeGreaterThanOrEqual(ORDER_SIZE_MIN);
    expect(drawdownResult.size).toBeLessThanOrEqual(SIZING_MAX_BTC);
  });

  it('result.size is always in [ORDER_SIZE_MIN, SIZING_MAX_BTC] across varied inputs', () => {
    const inputs = [
      { confidence: 0.0, recentPnLs: [], sessionPnl: 0, balance: 500, mode: 'farm' as const, profile: 'SCALP' as const },
      { confidence: 1.0, recentPnLs: [1, 1, 1, 1, 1], sessionPnl: 10, balance: 500, mode: 'trade' as const, profile: 'RUNNER' as const },
      { confidence: 0.65, recentPnLs: [-1, -1, -1], sessionPnl: -10, balance: 500, mode: 'trade' as const, profile: 'DEGEN' as const },
      { confidence: 0.5, recentPnLs: [1, -1], sessionPnl: -3.0, balance: 500, mode: 'farm' as const, profile: 'NORMAL' as const },
    ];

    for (const input of inputs) {
      const result = sizer.computeSize(input);
      expect(result.size).toBeGreaterThanOrEqual(ORDER_SIZE_MIN);
      expect(result.size).toBeLessThanOrEqual(SIZING_MAX_BTC);
    }
  });
});
