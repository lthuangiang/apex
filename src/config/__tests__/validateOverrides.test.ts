import { describe, it, expect } from 'vitest';
import { validateOverrides } from '../validateOverrides';
import type { OverridableConfig } from '../ConfigStore';

const baseEffective: OverridableConfig = {
  ORDER_SIZE_MIN: 0.003,
  ORDER_SIZE_MAX: 0.005,
  STOP_LOSS_PERCENT: 0.05,
  TAKE_PROFIT_PERCENT: 0.05,
  POSITION_SL_PERCENT: 0.05,
  FARM_MIN_HOLD_SECS: 120,
  FARM_MAX_HOLD_SECS: 600,
  FARM_TP_USD: 1.0,
  FARM_SL_PERCENT: 0.05,
  FARM_SCORE_EDGE: 0.03,
  FARM_MIN_CONFIDENCE: 0.50,
  FARM_EARLY_EXIT_SECS: 120,
  FARM_EARLY_EXIT_PNL: 0.4,
  FARM_EXTRA_WAIT_SECS: 30,
  FARM_BLOCKED_HOURS: [],
  TRADE_TP_PERCENT: 0.10,
  TRADE_SL_PERCENT: 0.10,
  COOLDOWN_MIN_MINS: 2,
  COOLDOWN_MAX_MINS: 10,
  MIN_POSITION_VALUE_USD: 20,
  SIZING_MIN_MULTIPLIER: 0.5,
  SIZING_MAX_MULTIPLIER: 2.0,
  SIZING_CONF_WEIGHT: 0.6,
  SIZING_PERF_WEIGHT: 0.4,
  SIZING_DRAWDOWN_THRESHOLD: -3.0,
  SIZING_DRAWDOWN_FLOOR: 0.5,
  SIZING_MAX_BTC: 0.008,
  SIZING_MAX_BALANCE_PCT: 0.02,
  REGIME_ATR_PERIOD: 14,
  REGIME_BB_PERIOD: 20,
  REGIME_BB_STD_DEV: 2.0,
  REGIME_VOL_LOOKBACK: 24,
  REGIME_HIGH_VOL_THRESHOLD: 0.03,
  REGIME_TREND_EMA_BAND: 0.005,
  REGIME_BB_TREND_MIN: 0.6,
  REGIME_TREND_HOLD_MULT: 1.5,
  REGIME_SIDEWAY_HOLD_MULT: 0.7,
  REGIME_HIGH_VOL_HOLD_MULT: 0.5,
  REGIME_HIGH_VOL_SIZE_FACTOR: 0.5,
  REGIME_SIDEWAY_SIZE_FACTOR: 0.75,
  REGIME_HIGH_VOL_SL_MULT: 1.5,
  REGIME_HIGH_VOL_SKIP_ENTRY: false,
  REGIME_TREND_SUPPRESS_EARLY_EXIT: true,
  CHOP_FLIP_WINDOW: 5,
  CHOP_FLIP_WEIGHT: 0.4,
  CHOP_MOM_WEIGHT: 0.35,
  CHOP_BB_WEIGHT: 0.25,
  CHOP_BB_COMPRESS_MAX: 0.015,
  CHOP_SCORE_THRESHOLD: 0.55,
  CHOP_BREAKOUT_SCORE_EDGE: 0.08,
  CHOP_BREAKOUT_VOL_MIN: 0.8,
  CHOP_BREAKOUT_IMBALANCE_THRESHOLD: 0.15,
  CHOP_COOLDOWN_STREAK_FACTOR: 0.5,
  CHOP_COOLDOWN_CHOP_FACTOR: 1.0,
  CHOP_COOLDOWN_MAX_MINS: 30,
  EXEC_MAX_SPREAD_BPS: 10,
  EXEC_SPREAD_OFFSET_MULT: 0.3,
  EXEC_DEPTH_LEVELS: 5,
  EXEC_DEPTH_THIN_THRESHOLD: 50000,
  EXEC_DEPTH_PENALTY: 0.5,
  EXEC_FILL_WINDOW: 20,
  EXEC_FILL_RATE_THRESHOLD: 0.6,
  EXEC_FILL_RATE_PENALTY: 1.0,
  EXEC_OFFSET_MIN: 0,
  EXEC_OFFSET_MAX: 5,
  MM_ENABLED: true,
  MM_PINGPONG_BIAS_STRENGTH: 0.08,
  MM_INVENTORY_SOFT_BIAS: 50,
  MM_INVENTORY_HARD_BLOCK: 150,
  MM_INVENTORY_BIAS_STRENGTH: 0.12,
  MM_SPREAD_MULT: 1.5,
  MM_MIN_FEE_MULT: 1.5,
  MM_TP_MAX_USD: 2.0,
};

describe('validateOverrides', () => {
  // 1. Valid patch returns empty errors array
  it('returns no errors for a valid patch', () => {
    const errors = validateOverrides({ ORDER_SIZE_MIN: 0.001, ORDER_SIZE_MAX: 0.004 }, baseEffective);
    expect(errors).toEqual([]);
  });

  it('returns no errors for an empty patch', () => {
    expect(validateOverrides({}, baseEffective)).toEqual([]);
  });

  // 2. ORDER_SIZE_MIN not positive → error
  it('errors when ORDER_SIZE_MIN is zero', () => {
    const errors = validateOverrides({ ORDER_SIZE_MIN: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MIN')).toBe(true);
  });

  it('errors when ORDER_SIZE_MIN is negative', () => {
    const errors = validateOverrides({ ORDER_SIZE_MIN: -1 }, baseEffective);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MIN')).toBe(true);
  });

  // 3. ORDER_SIZE_MAX not positive → error
  it('errors when ORDER_SIZE_MAX is zero', () => {
    const errors = validateOverrides({ ORDER_SIZE_MAX: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MAX')).toBe(true);
  });

  it('errors when ORDER_SIZE_MAX is negative', () => {
    const errors = validateOverrides({ ORDER_SIZE_MAX: -0.001 }, baseEffective);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MAX')).toBe(true);
  });

  // 4. ORDER_SIZE_MIN >= effective ORDER_SIZE_MAX → error
  it('errors when ORDER_SIZE_MIN equals effective ORDER_SIZE_MAX', () => {
    const errors = validateOverrides({ ORDER_SIZE_MIN: baseEffective.ORDER_SIZE_MAX }, baseEffective);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MIN')).toBe(true);
  });

  it('errors when ORDER_SIZE_MIN exceeds effective ORDER_SIZE_MAX', () => {
    const errors = validateOverrides({ ORDER_SIZE_MIN: 0.01 }, baseEffective);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MIN')).toBe(true);
  });

  // 5. ORDER_SIZE_MAX <= effective ORDER_SIZE_MIN → error
  it('errors when ORDER_SIZE_MAX equals effective ORDER_SIZE_MIN', () => {
    const errors = validateOverrides({ ORDER_SIZE_MAX: baseEffective.ORDER_SIZE_MIN }, baseEffective);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MAX')).toBe(true);
  });

  it('errors when ORDER_SIZE_MAX is less than effective ORDER_SIZE_MIN', () => {
    const errors = validateOverrides({ ORDER_SIZE_MAX: 0.001 }, baseEffective);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MAX')).toBe(true);
  });

  // 6. Percent fields out of range (0, 1] → error
  const percentFields = [
    'STOP_LOSS_PERCENT',
    'TAKE_PROFIT_PERCENT',
    'POSITION_SL_PERCENT',
    'FARM_SL_PERCENT',
    'TRADE_TP_PERCENT',
    'TRADE_SL_PERCENT',
  ] as const;

  for (const field of percentFields) {
    it(`errors when ${field} is zero`, () => {
      const errors = validateOverrides({ [field]: 0 }, baseEffective);
      expect(errors.some(e => e.field === field)).toBe(true);
    });

    it(`errors when ${field} is negative`, () => {
      const errors = validateOverrides({ [field]: -0.1 }, baseEffective);
      expect(errors.some(e => e.field === field)).toBe(true);
    });

    it(`errors when ${field} exceeds 1`, () => {
      const errors = validateOverrides({ [field]: 1.01 }, baseEffective);
      expect(errors.some(e => e.field === field)).toBe(true);
    });

    it(`accepts ${field} equal to 1 (upper bound inclusive)`, () => {
      const errors = validateOverrides({ [field]: 1 }, baseEffective);
      expect(errors.some(e => e.field === field)).toBe(false);
    });

    it(`accepts ${field} as a small positive value`, () => {
      const errors = validateOverrides({ [field]: 0.01 }, baseEffective);
      expect(errors.some(e => e.field === field)).toBe(false);
    });
  }

  // 7. FARM_MIN_HOLD_SECS >= effective FARM_MAX_HOLD_SECS → error
  it('errors when FARM_MIN_HOLD_SECS equals effective FARM_MAX_HOLD_SECS', () => {
    const errors = validateOverrides({ FARM_MIN_HOLD_SECS: baseEffective.FARM_MAX_HOLD_SECS }, baseEffective);
    expect(errors.some(e => e.field === 'FARM_MIN_HOLD_SECS')).toBe(true);
  });

  it('errors when FARM_MIN_HOLD_SECS exceeds effective FARM_MAX_HOLD_SECS', () => {
    const errors = validateOverrides({ FARM_MIN_HOLD_SECS: 700 }, baseEffective);
    expect(errors.some(e => e.field === 'FARM_MIN_HOLD_SECS')).toBe(true);
  });

  it('errors when FARM_MAX_HOLD_SECS is set below effective FARM_MIN_HOLD_SECS', () => {
    const errors = validateOverrides({ FARM_MAX_HOLD_SECS: 100 }, baseEffective);
    expect(errors.some(e => e.field === 'FARM_MAX_HOLD_SECS')).toBe(true);
  });

  // 8. FARM_TP_USD not positive → error
  it('errors when FARM_TP_USD is zero', () => {
    const errors = validateOverrides({ FARM_TP_USD: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'FARM_TP_USD')).toBe(true);
  });

  it('errors when FARM_TP_USD is negative', () => {
    const errors = validateOverrides({ FARM_TP_USD: -5 }, baseEffective);
    expect(errors.some(e => e.field === 'FARM_TP_USD')).toBe(true);
  });

  it('accepts a positive FARM_TP_USD', () => {
    const errors = validateOverrides({ FARM_TP_USD: 2.5 }, baseEffective);
    expect(errors.some(e => e.field === 'FARM_TP_USD')).toBe(false);
  });

  // 9. COOLDOWN_MIN_MINS >= effective COOLDOWN_MAX_MINS → error
  it('errors when COOLDOWN_MIN_MINS equals effective COOLDOWN_MAX_MINS', () => {
    const errors = validateOverrides({ COOLDOWN_MIN_MINS: baseEffective.COOLDOWN_MAX_MINS }, baseEffective);
    expect(errors.some(e => e.field === 'COOLDOWN_MIN_MINS')).toBe(true);
  });

  it('errors when COOLDOWN_MIN_MINS exceeds effective COOLDOWN_MAX_MINS', () => {
    const errors = validateOverrides({ COOLDOWN_MIN_MINS: 15 }, baseEffective);
    expect(errors.some(e => e.field === 'COOLDOWN_MIN_MINS')).toBe(true);
  });

  it('errors when COOLDOWN_MAX_MINS is set at or below effective COOLDOWN_MIN_MINS', () => {
    const errors = validateOverrides({ COOLDOWN_MAX_MINS: 1 }, baseEffective);
    expect(errors.some(e => e.field === 'COOLDOWN_MAX_MINS')).toBe(true);
  });

  // 10. COOLDOWN_MIN_MINS not a non-negative integer → error
  it('errors when COOLDOWN_MIN_MINS is a float', () => {
    const errors = validateOverrides({ COOLDOWN_MIN_MINS: 1.5 }, baseEffective);
    expect(errors.some(e => e.field === 'COOLDOWN_MIN_MINS')).toBe(true);
  });

  it('errors when COOLDOWN_MIN_MINS is negative', () => {
    const errors = validateOverrides({ COOLDOWN_MIN_MINS: -1 }, baseEffective);
    expect(errors.some(e => e.field === 'COOLDOWN_MIN_MINS')).toBe(true);
  });

  it('accepts COOLDOWN_MIN_MINS of zero', () => {
    // 0 is a valid non-negative integer; cross-field check: 0 < 10 (baseEffective.COOLDOWN_MAX_MINS)
    const errors = validateOverrides({ COOLDOWN_MIN_MINS: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'COOLDOWN_MIN_MINS')).toBe(false);
  });

  // 11. COOLDOWN_MAX_MINS not a non-negative integer → error
  it('errors when COOLDOWN_MAX_MINS is a float', () => {
    const errors = validateOverrides({ COOLDOWN_MAX_MINS: 5.5 }, baseEffective);
    expect(errors.some(e => e.field === 'COOLDOWN_MAX_MINS')).toBe(true);
  });

  it('errors when COOLDOWN_MAX_MINS is negative', () => {
    const errors = validateOverrides({ COOLDOWN_MAX_MINS: -2 }, baseEffective);
    expect(errors.some(e => e.field === 'COOLDOWN_MAX_MINS')).toBe(true);
  });

  // 12. Multiple errors returned for multiple invalid fields
  it('returns multiple errors when multiple fields are invalid', () => {
    const errors = validateOverrides(
      {
        ORDER_SIZE_MIN: -1,
        ORDER_SIZE_MAX: -1,
        STOP_LOSS_PERCENT: 0,
        COOLDOWN_MIN_MINS: -1,
      },
      baseEffective
    );
    expect(errors.length).toBeGreaterThanOrEqual(4);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MIN')).toBe(true);
    expect(errors.some(e => e.field === 'ORDER_SIZE_MAX')).toBe(true);
    expect(errors.some(e => e.field === 'STOP_LOSS_PERCENT')).toBe(true);
    expect(errors.some(e => e.field === 'COOLDOWN_MIN_MINS')).toBe(true);
  });

  // 13. SIZING_CONF_WEIGHT and SIZING_PERF_WEIGHT — weight sum must equal 1.0
  it('rejects SIZING_CONF_WEIGHT + SIZING_PERF_WEIGHT that do not sum to 1.0', () => {
    const errors = validateOverrides({ SIZING_CONF_WEIGHT: 0.7, SIZING_PERF_WEIGHT: 0.5 }, baseEffective);
    expect(errors.some(e => e.message.includes('must equal 1.0'))).toBe(true);
  });

  it('rejects SIZING_CONF_WEIGHT alone when effective sum would not equal 1.0', () => {
    // effective SIZING_PERF_WEIGHT is 0.4; setting CONF_WEIGHT to 0.7 → sum = 1.1
    const errors = validateOverrides({ SIZING_CONF_WEIGHT: 0.7 }, baseEffective);
    expect(errors.some(e => e.message.includes('must equal 1.0'))).toBe(true);
  });

  it('rejects SIZING_PERF_WEIGHT alone when effective sum would not equal 1.0', () => {
    // effective SIZING_CONF_WEIGHT is 0.6; setting PERF_WEIGHT to 0.5 → sum = 1.1
    const errors = validateOverrides({ SIZING_PERF_WEIGHT: 0.5 }, baseEffective);
    expect(errors.some(e => e.message.includes('must equal 1.0'))).toBe(true);
  });

  it('accepts SIZING_CONF_WEIGHT + SIZING_PERF_WEIGHT that sum to 1.0', () => {
    const errors = validateOverrides({ SIZING_CONF_WEIGHT: 0.7, SIZING_PERF_WEIGHT: 0.3 }, baseEffective);
    expect(errors.some(e => e.message.includes('must equal 1.0'))).toBe(false);
  });

  it('accepts SIZING_CONF_WEIGHT alone when effective sum equals 1.0', () => {
    // effective SIZING_PERF_WEIGHT is 0.4; setting CONF_WEIGHT to 0.6 → sum = 1.0
    const errors = validateOverrides({ SIZING_CONF_WEIGHT: 0.6 }, baseEffective);
    expect(errors.some(e => e.message.includes('must equal 1.0'))).toBe(false);
  });

  it('rejects SIZING_CONF_WEIGHT of zero', () => {
    const errors = validateOverrides({ SIZING_CONF_WEIGHT: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_CONF_WEIGHT')).toBe(true);
  });

  it('rejects SIZING_CONF_WEIGHT of 1 (exclusive upper bound)', () => {
    const errors = validateOverrides({ SIZING_CONF_WEIGHT: 1 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_CONF_WEIGHT')).toBe(true);
  });

  it('rejects SIZING_PERF_WEIGHT of zero', () => {
    const errors = validateOverrides({ SIZING_PERF_WEIGHT: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_PERF_WEIGHT')).toBe(true);
  });

  // 14. SIZING_MAX_BTC — must be positive and >= ORDER_SIZE_MIN
  it('rejects SIZING_MAX_BTC less than ORDER_SIZE_MIN', () => {
    const errors = validateOverrides({ SIZING_MAX_BTC: 0.001 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_BTC' && e.message.includes('ORDER_SIZE_MIN'))).toBe(true);
  });

  it('rejects SIZING_MAX_BTC of zero', () => {
    const errors = validateOverrides({ SIZING_MAX_BTC: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_BTC')).toBe(true);
  });

  it('rejects SIZING_MAX_BTC of negative value', () => {
    const errors = validateOverrides({ SIZING_MAX_BTC: -0.005 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_BTC')).toBe(true);
  });

  it('accepts SIZING_MAX_BTC equal to ORDER_SIZE_MIN', () => {
    const errors = validateOverrides({ SIZING_MAX_BTC: baseEffective.ORDER_SIZE_MIN }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_BTC')).toBe(false);
  });

  it('accepts SIZING_MAX_BTC greater than ORDER_SIZE_MIN', () => {
    const errors = validateOverrides({ SIZING_MAX_BTC: 0.01 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_BTC')).toBe(false);
  });

  // 15. SIZING_MIN_MULTIPLIER and SIZING_MAX_MULTIPLIER — inversion rejection
  it('rejects SIZING_MIN_MULTIPLIER >= effective SIZING_MAX_MULTIPLIER', () => {
    const errors = validateOverrides({ SIZING_MIN_MULTIPLIER: 2.0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MIN_MULTIPLIER')).toBe(true);
  });

  it('rejects SIZING_MIN_MULTIPLIER equal to effective SIZING_MAX_MULTIPLIER', () => {
    const errors = validateOverrides({ SIZING_MIN_MULTIPLIER: baseEffective.SIZING_MAX_MULTIPLIER }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MIN_MULTIPLIER')).toBe(true);
  });

  it('rejects SIZING_MAX_MULTIPLIER <= effective SIZING_MIN_MULTIPLIER', () => {
    const errors = validateOverrides({ SIZING_MAX_MULTIPLIER: 0.5 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_MULTIPLIER')).toBe(true);
  });

  it('rejects SIZING_MIN_MULTIPLIER of zero', () => {
    const errors = validateOverrides({ SIZING_MIN_MULTIPLIER: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MIN_MULTIPLIER')).toBe(true);
  });

  it('rejects SIZING_MAX_MULTIPLIER of zero', () => {
    const errors = validateOverrides({ SIZING_MAX_MULTIPLIER: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_MULTIPLIER')).toBe(true);
  });

  it('accepts valid SIZING_MIN_MULTIPLIER and SIZING_MAX_MULTIPLIER pair', () => {
    const errors = validateOverrides({ SIZING_MIN_MULTIPLIER: 0.3, SIZING_MAX_MULTIPLIER: 1.5 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MIN_MULTIPLIER' || e.field === 'SIZING_MAX_MULTIPLIER')).toBe(false);
  });

  // 16. SIZING_DRAWDOWN_THRESHOLD must be a finite negative number
  it('rejects SIZING_DRAWDOWN_THRESHOLD of zero', () => {
    const errors = validateOverrides({ SIZING_DRAWDOWN_THRESHOLD: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_DRAWDOWN_THRESHOLD')).toBe(true);
  });

  it('rejects SIZING_DRAWDOWN_THRESHOLD of a positive number', () => {
    const errors = validateOverrides({ SIZING_DRAWDOWN_THRESHOLD: 1.0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_DRAWDOWN_THRESHOLD')).toBe(true);
  });

  it('rejects SIZING_DRAWDOWN_THRESHOLD of -Infinity', () => {
    const errors = validateOverrides({ SIZING_DRAWDOWN_THRESHOLD: -Infinity }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_DRAWDOWN_THRESHOLD')).toBe(true);
  });

  it('accepts SIZING_DRAWDOWN_THRESHOLD as a finite negative number', () => {
    const errors = validateOverrides({ SIZING_DRAWDOWN_THRESHOLD: -5.0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_DRAWDOWN_THRESHOLD')).toBe(false);
  });

  // 17. SIZING_DRAWDOWN_FLOOR must be in (0, 1)
  it('rejects SIZING_DRAWDOWN_FLOOR of zero', () => {
    const errors = validateOverrides({ SIZING_DRAWDOWN_FLOOR: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_DRAWDOWN_FLOOR')).toBe(true);
  });

  it('rejects SIZING_DRAWDOWN_FLOOR of 1 (exclusive upper bound)', () => {
    const errors = validateOverrides({ SIZING_DRAWDOWN_FLOOR: 1 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_DRAWDOWN_FLOOR')).toBe(true);
  });

  it('rejects SIZING_DRAWDOWN_FLOOR greater than 1', () => {
    const errors = validateOverrides({ SIZING_DRAWDOWN_FLOOR: 1.5 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_DRAWDOWN_FLOOR')).toBe(true);
  });

  it('accepts SIZING_DRAWDOWN_FLOOR in (0, 1)', () => {
    const errors = validateOverrides({ SIZING_DRAWDOWN_FLOOR: 0.3 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_DRAWDOWN_FLOOR')).toBe(false);
  });

  // 18. SIZING_MAX_BALANCE_PCT must be in (0, 1)
  it('rejects SIZING_MAX_BALANCE_PCT of zero', () => {
    const errors = validateOverrides({ SIZING_MAX_BALANCE_PCT: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_BALANCE_PCT')).toBe(true);
  });

  it('rejects SIZING_MAX_BALANCE_PCT of 1 (exclusive upper bound)', () => {
    const errors = validateOverrides({ SIZING_MAX_BALANCE_PCT: 1 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_BALANCE_PCT')).toBe(true);
  });

  it('rejects SIZING_MAX_BALANCE_PCT greater than 1', () => {
    const errors = validateOverrides({ SIZING_MAX_BALANCE_PCT: 1.1 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_BALANCE_PCT')).toBe(true);
  });

  it('accepts SIZING_MAX_BALANCE_PCT in (0, 1)', () => {
    const errors = validateOverrides({ SIZING_MAX_BALANCE_PCT: 0.05 }, baseEffective);
    expect(errors.some(e => e.field === 'SIZING_MAX_BALANCE_PCT')).toBe(false);
  });

  // 19. Valid SIZING_* patch is accepted
  it('accepts a fully valid SIZING_* patch', () => {
    const errors = validateOverrides(
      {
        SIZING_CONF_WEIGHT: 0.7,
        SIZING_PERF_WEIGHT: 0.3,
        SIZING_MAX_BTC: 0.01,
        SIZING_MIN_MULTIPLIER: 0.4,
        SIZING_MAX_MULTIPLIER: 1.8,
        SIZING_DRAWDOWN_THRESHOLD: -5.0,
        SIZING_DRAWDOWN_FLOOR: 0.4,
        SIZING_MAX_BALANCE_PCT: 0.03,
      },
      baseEffective
    );
    expect(errors).toEqual([]);
  });

  // 20. REGIME_HIGH_VOL_SIZE_FACTOR must be in (0, 1]
  it('rejects REGIME_HIGH_VOL_SIZE_FACTOR of zero', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_SIZE_FACTOR: 0 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_SIZE_FACTOR')).toBe(true);
  });

  it('rejects REGIME_HIGH_VOL_SIZE_FACTOR of negative value', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_SIZE_FACTOR: -0.5 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_SIZE_FACTOR')).toBe(true);
  });

  it('rejects REGIME_HIGH_VOL_SIZE_FACTOR greater than 1', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_SIZE_FACTOR: 1.1 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_SIZE_FACTOR')).toBe(true);
  });

  it('accepts REGIME_HIGH_VOL_SIZE_FACTOR of 1 (inclusive upper bound)', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_SIZE_FACTOR: 1 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_SIZE_FACTOR')).toBe(false);
  });

  it('accepts REGIME_HIGH_VOL_SIZE_FACTOR of 0.5', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_SIZE_FACTOR: 0.5 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_SIZE_FACTOR')).toBe(false);
  });

  // 21. REGIME_SIDEWAY_SIZE_FACTOR must be in (0, 1]
  it('rejects REGIME_SIDEWAY_SIZE_FACTOR of zero', () => {
    expect(validateOverrides({ REGIME_SIDEWAY_SIZE_FACTOR: 0 }, baseEffective).some(e => e.field === 'REGIME_SIDEWAY_SIZE_FACTOR')).toBe(true);
  });

  it('rejects REGIME_SIDEWAY_SIZE_FACTOR greater than 1', () => {
    expect(validateOverrides({ REGIME_SIDEWAY_SIZE_FACTOR: 1.01 }, baseEffective).some(e => e.field === 'REGIME_SIDEWAY_SIZE_FACTOR')).toBe(true);
  });

  it('accepts REGIME_SIDEWAY_SIZE_FACTOR of 1 (inclusive upper bound)', () => {
    expect(validateOverrides({ REGIME_SIDEWAY_SIZE_FACTOR: 1 }, baseEffective).some(e => e.field === 'REGIME_SIDEWAY_SIZE_FACTOR')).toBe(false);
  });

  // 22. REGIME_HIGH_VOL_SL_MULT must be >= 1.0
  it('rejects REGIME_HIGH_VOL_SL_MULT less than 1', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_SL_MULT: 0.9 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_SL_MULT')).toBe(true);
  });

  it('rejects REGIME_HIGH_VOL_SL_MULT of zero', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_SL_MULT: 0 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_SL_MULT')).toBe(true);
  });

  it('accepts REGIME_HIGH_VOL_SL_MULT of exactly 1.0', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_SL_MULT: 1.0 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_SL_MULT')).toBe(false);
  });

  it('accepts REGIME_HIGH_VOL_SL_MULT greater than 1', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_SL_MULT: 2.0 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_SL_MULT')).toBe(false);
  });

  // 23. REGIME_HIGH_VOL_THRESHOLD must be > 0
  it('rejects REGIME_HIGH_VOL_THRESHOLD of zero', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_THRESHOLD: 0 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_THRESHOLD')).toBe(true);
  });

  it('rejects REGIME_HIGH_VOL_THRESHOLD of negative value', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_THRESHOLD: -0.01 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_THRESHOLD')).toBe(true);
  });

  it('accepts REGIME_HIGH_VOL_THRESHOLD as a positive number', () => {
    expect(validateOverrides({ REGIME_HIGH_VOL_THRESHOLD: 0.05 }, baseEffective).some(e => e.field === 'REGIME_HIGH_VOL_THRESHOLD')).toBe(false);
  });

  // 24. Hold multipliers must be > 0
  for (const field of ['REGIME_TREND_HOLD_MULT', 'REGIME_SIDEWAY_HOLD_MULT', 'REGIME_HIGH_VOL_HOLD_MULT'] as const) {
    it(`rejects ${field} of zero`, () => {
      expect(validateOverrides({ [field]: 0 }, baseEffective).some(e => e.field === field)).toBe(true);
    });

    it(`rejects ${field} of negative value`, () => {
      expect(validateOverrides({ [field]: -1 }, baseEffective).some(e => e.field === field)).toBe(true);
    });

    it(`accepts ${field} as a positive number`, () => {
      expect(validateOverrides({ [field]: 1.5 }, baseEffective).some(e => e.field === field)).toBe(false);
    });
  }

  // 25. Period/lookback fields must be positive integers (>= 1)
  for (const field of ['REGIME_ATR_PERIOD', 'REGIME_BB_PERIOD', 'REGIME_VOL_LOOKBACK'] as const) {
    it(`rejects ${field} of zero`, () => {
      expect(validateOverrides({ [field]: 0 }, baseEffective).some(e => e.field === field)).toBe(true);
    });

    it(`rejects ${field} of negative value`, () => {
      expect(validateOverrides({ [field]: -1 }, baseEffective).some(e => e.field === field)).toBe(true);
    });

    it(`rejects ${field} as a float`, () => {
      expect(validateOverrides({ [field]: 1.5 }, baseEffective).some(e => e.field === field)).toBe(true);
    });

    it(`accepts ${field} of 1 (minimum valid integer)`, () => {
      expect(validateOverrides({ [field]: 1 }, baseEffective).some(e => e.field === field)).toBe(false);
    });

    it(`accepts ${field} as a positive integer`, () => {
      expect(validateOverrides({ [field]: 14 }, baseEffective).some(e => e.field === field)).toBe(false);
    });
  }
});

describe('CHOP_* validation', () => {
  // Weight sum violation: CHOP_FLIP_WEIGHT: 0.5 without updating others
  // effective: CHOP_FLIP_WEIGHT=0.4, CHOP_MOM_WEIGHT=0.35, CHOP_BB_WEIGHT=0.25 → sum=1.0
  // patch: CHOP_FLIP_WEIGHT=0.5 → effective sum = 0.5 + 0.35 + 0.25 = 1.1 → rejected
  it('rejects CHOP_FLIP_WEIGHT: 0.5 alone (weight sum != 1.0)', () => {
    const errors = validateOverrides({ CHOP_FLIP_WEIGHT: 0.5 }, baseEffective);
    expect(errors.some(e => e.field === 'CHOP_FLIP_WEIGHT' && e.message.includes('must equal 1.0'))).toBe(true);
  });

  // CHOP_COOLDOWN_MAX_MINS < COOLDOWN_MAX_MINS → rejected
  // baseEffective.COOLDOWN_MAX_MINS = 10; setting CHOP_COOLDOWN_MAX_MINS = 5 → rejected
  it('rejects CHOP_COOLDOWN_MAX_MINS less than effective COOLDOWN_MAX_MINS', () => {
    const errors = validateOverrides({ CHOP_COOLDOWN_MAX_MINS: 5 }, baseEffective);
    expect(errors.some(e => e.field === 'CHOP_COOLDOWN_MAX_MINS')).toBe(true);
  });

  // CHOP_SCORE_THRESHOLD: 0 → rejected (must be in (0, 1) exclusive)
  it('rejects CHOP_SCORE_THRESHOLD of 0', () => {
    const errors = validateOverrides({ CHOP_SCORE_THRESHOLD: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'CHOP_SCORE_THRESHOLD')).toBe(true);
  });

  // CHOP_SCORE_THRESHOLD: 1 → rejected (must be in (0, 1) exclusive)
  it('rejects CHOP_SCORE_THRESHOLD of 1', () => {
    const errors = validateOverrides({ CHOP_SCORE_THRESHOLD: 1 }, baseEffective);
    expect(errors.some(e => e.field === 'CHOP_SCORE_THRESHOLD')).toBe(true);
  });

  // CHOP_FLIP_WINDOW: 0 → rejected (must be positive integer >= 1)
  it('rejects CHOP_FLIP_WINDOW of 0', () => {
    const errors = validateOverrides({ CHOP_FLIP_WINDOW: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'CHOP_FLIP_WINDOW')).toBe(true);
  });

  // Valid full CHOP_* patch → accepted
  it('accepts a fully valid CHOP_* patch', () => {
    const errors = validateOverrides(
      {
        CHOP_FLIP_WINDOW: 6,
        CHOP_FLIP_WEIGHT: 0.4,
        CHOP_MOM_WEIGHT: 0.35,
        CHOP_BB_WEIGHT: 0.25,
        CHOP_BB_COMPRESS_MAX: 0.012,
        CHOP_SCORE_THRESHOLD: 0.6,
        CHOP_BREAKOUT_SCORE_EDGE: 0.1,
        CHOP_BREAKOUT_VOL_MIN: 0.9,
        CHOP_BREAKOUT_IMBALANCE_THRESHOLD: 0.2,
        CHOP_COOLDOWN_STREAK_FACTOR: 0.5,
        CHOP_COOLDOWN_CHOP_FACTOR: 1.0,
        CHOP_COOLDOWN_MAX_MINS: 30,
      },
      baseEffective
    );
    expect(errors).toEqual([]);
  });
});

describe('EXEC_* validation', () => {
  // EXEC_OFFSET_MAX >= EXEC_OFFSET_MIN
  it('rejects EXEC_OFFSET_MAX < EXEC_OFFSET_MIN', () => {
    const errors = validateOverrides({ EXEC_OFFSET_MIN: 3, EXEC_OFFSET_MAX: 1 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_OFFSET_MAX' && e.message === 'EXEC_OFFSET_MAX must be >= EXEC_OFFSET_MIN')).toBe(true);
  });

  it('rejects EXEC_OFFSET_MAX alone when it would be less than effective EXEC_OFFSET_MIN', () => {
    // baseEffective.EXEC_OFFSET_MIN = 0; setting EXEC_OFFSET_MAX = -1 → rejected
    const errors = validateOverrides({ EXEC_OFFSET_MAX: -1 }, baseEffective);
    expect(errors.some(e => e.message === 'EXEC_OFFSET_MAX must be >= EXEC_OFFSET_MIN')).toBe(true);
  });

  it('rejects EXEC_OFFSET_MIN alone when it would exceed effective EXEC_OFFSET_MAX', () => {
    // baseEffective.EXEC_OFFSET_MAX = 5; setting EXEC_OFFSET_MIN = 10 → rejected
    const errors = validateOverrides({ EXEC_OFFSET_MIN: 10 }, baseEffective);
    expect(errors.some(e => e.message === 'EXEC_OFFSET_MAX must be >= EXEC_OFFSET_MIN')).toBe(true);
  });

  it('accepts EXEC_OFFSET_MAX equal to EXEC_OFFSET_MIN', () => {
    const errors = validateOverrides({ EXEC_OFFSET_MIN: 2, EXEC_OFFSET_MAX: 2 }, baseEffective);
    expect(errors.some(e => e.message === 'EXEC_OFFSET_MAX must be >= EXEC_OFFSET_MIN')).toBe(false);
  });

  it('accepts valid EXEC_OFFSET_MIN and EXEC_OFFSET_MAX pair', () => {
    const errors = validateOverrides({ EXEC_OFFSET_MIN: 0, EXEC_OFFSET_MAX: 5 }, baseEffective);
    expect(errors.some(e => e.message === 'EXEC_OFFSET_MAX must be >= EXEC_OFFSET_MIN')).toBe(false);
  });

  // EXEC_FILL_RATE_THRESHOLD must be in [0, 1]
  it('rejects EXEC_FILL_RATE_THRESHOLD below 0', () => {
    const errors = validateOverrides({ EXEC_FILL_RATE_THRESHOLD: -0.1 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_FILL_RATE_THRESHOLD')).toBe(true);
  });

  it('rejects EXEC_FILL_RATE_THRESHOLD above 1', () => {
    const errors = validateOverrides({ EXEC_FILL_RATE_THRESHOLD: 1.1 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_FILL_RATE_THRESHOLD')).toBe(true);
  });

  it('accepts EXEC_FILL_RATE_THRESHOLD of 0 (inclusive lower bound)', () => {
    const errors = validateOverrides({ EXEC_FILL_RATE_THRESHOLD: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_FILL_RATE_THRESHOLD')).toBe(false);
  });

  it('accepts EXEC_FILL_RATE_THRESHOLD of 1 (inclusive upper bound)', () => {
    const errors = validateOverrides({ EXEC_FILL_RATE_THRESHOLD: 1 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_FILL_RATE_THRESHOLD')).toBe(false);
  });

  it('accepts EXEC_FILL_RATE_THRESHOLD of 0.6', () => {
    const errors = validateOverrides({ EXEC_FILL_RATE_THRESHOLD: 0.6 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_FILL_RATE_THRESHOLD')).toBe(false);
  });

  // EXEC_DEPTH_LEVELS must be >= 1
  it('rejects EXEC_DEPTH_LEVELS of 0', () => {
    const errors = validateOverrides({ EXEC_DEPTH_LEVELS: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_DEPTH_LEVELS' && e.message === 'EXEC_DEPTH_LEVELS must be >= 1')).toBe(true);
  });

  it('rejects EXEC_DEPTH_LEVELS of negative value', () => {
    const errors = validateOverrides({ EXEC_DEPTH_LEVELS: -1 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_DEPTH_LEVELS')).toBe(true);
  });

  it('rejects EXEC_DEPTH_LEVELS as a float', () => {
    const errors = validateOverrides({ EXEC_DEPTH_LEVELS: 1.5 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_DEPTH_LEVELS')).toBe(true);
  });

  it('accepts EXEC_DEPTH_LEVELS of 1 (minimum valid)', () => {
    const errors = validateOverrides({ EXEC_DEPTH_LEVELS: 1 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_DEPTH_LEVELS')).toBe(false);
  });

  it('accepts EXEC_DEPTH_LEVELS of 5', () => {
    const errors = validateOverrides({ EXEC_DEPTH_LEVELS: 5 }, baseEffective);
    expect(errors.some(e => e.field === 'EXEC_DEPTH_LEVELS')).toBe(false);
  });
});

describe('MM_* validation', () => {
  // 10.3: MM_INVENTORY_HARD_BLOCK <= MM_INVENTORY_SOFT_BIAS → rejected
  it('rejects MM_INVENTORY_HARD_BLOCK equal to effective MM_INVENTORY_SOFT_BIAS (50 = 50)', () => {
    const errors = validateOverrides({ MM_INVENTORY_HARD_BLOCK: 50 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_INVENTORY_HARD_BLOCK')).toBe(true);
  });

  it('rejects MM_INVENTORY_HARD_BLOCK less than effective MM_INVENTORY_SOFT_BIAS (30 < 50)', () => {
    const errors = validateOverrides({ MM_INVENTORY_HARD_BLOCK: 30 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_INVENTORY_HARD_BLOCK')).toBe(true);
  });

  // 10.4: MM_SPREAD_MULT <= 0 → rejected
  it('rejects MM_SPREAD_MULT of 0', () => {
    const errors = validateOverrides({ MM_SPREAD_MULT: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_SPREAD_MULT')).toBe(true);
  });

  it('rejects MM_SPREAD_MULT of -1', () => {
    const errors = validateOverrides({ MM_SPREAD_MULT: -1 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_SPREAD_MULT')).toBe(true);
  });

  // 10.4: MM_MIN_FEE_MULT < 1.0 → rejected
  it('rejects MM_MIN_FEE_MULT of 0.9', () => {
    const errors = validateOverrides({ MM_MIN_FEE_MULT: 0.9 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_MIN_FEE_MULT')).toBe(true);
  });

  it('rejects MM_MIN_FEE_MULT of 0', () => {
    const errors = validateOverrides({ MM_MIN_FEE_MULT: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_MIN_FEE_MULT')).toBe(true);
  });

  // 10.4: MM_TP_MAX_USD <= 0 → rejected
  it('rejects MM_TP_MAX_USD of 0', () => {
    const errors = validateOverrides({ MM_TP_MAX_USD: 0 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_TP_MAX_USD')).toBe(true);
  });

  it('rejects MM_TP_MAX_USD of -1', () => {
    const errors = validateOverrides({ MM_TP_MAX_USD: -1 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_TP_MAX_USD')).toBe(true);
  });

  // 10.5: MM_PINGPONG_BIAS_STRENGTH < 0 → rejected
  it('rejects MM_PINGPONG_BIAS_STRENGTH of -0.1', () => {
    const errors = validateOverrides({ MM_PINGPONG_BIAS_STRENGTH: -0.1 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_PINGPONG_BIAS_STRENGTH')).toBe(true);
  });

  // 10.5: MM_INVENTORY_BIAS_STRENGTH < 0 → rejected
  it('rejects MM_INVENTORY_BIAS_STRENGTH of -0.1', () => {
    const errors = validateOverrides({ MM_INVENTORY_BIAS_STRENGTH: -0.1 }, baseEffective);
    expect(errors.some(e => e.field === 'MM_INVENTORY_BIAS_STRENGTH')).toBe(true);
  });

  // 10.6: fully valid MM config patch → accepted
  it('accepts a fully valid MM config patch', () => {
    const errors = validateOverrides(
      {
        MM_ENABLED: false,
        MM_PINGPONG_BIAS_STRENGTH: 0.1,
        MM_INVENTORY_SOFT_BIAS: 40,
        MM_INVENTORY_HARD_BLOCK: 200,
        MM_INVENTORY_BIAS_STRENGTH: 0.15,
        MM_SPREAD_MULT: 2.0,
        MM_MIN_FEE_MULT: 1.0,
        MM_TP_MAX_USD: 3.0,
      },
      baseEffective
    );
    expect(errors).toEqual([]);
  });
});
