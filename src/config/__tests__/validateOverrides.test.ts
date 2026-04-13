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
  TRADE_TP_PERCENT: 0.10,
  TRADE_SL_PERCENT: 0.10,
  COOLDOWN_MIN_MINS: 2,
  COOLDOWN_MAX_MINS: 10,
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
});
