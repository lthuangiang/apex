/**
 * Tests 10.1 & 10.2: MM_* config default values and presence in ConfigStore.
 */
import { describe, it, expect } from 'vitest';
import { config } from '../../config';

describe('MM_* keys in config.ts (10.1)', () => {
  it('MM_ENABLED defaults to true', () => {
    expect(config.MM_ENABLED).toBe(true);
  });

  it('MM_PINGPONG_BIAS_STRENGTH defaults to 0.08', () => {
    expect(config.MM_PINGPONG_BIAS_STRENGTH).toBe(0.08);
  });

  it('MM_INVENTORY_SOFT_BIAS defaults to 50', () => {
    expect(config.MM_INVENTORY_SOFT_BIAS).toBe(50);
  });

  it('MM_INVENTORY_HARD_BLOCK defaults to 150', () => {
    expect(config.MM_INVENTORY_HARD_BLOCK).toBe(150);
  });

  it('MM_INVENTORY_BIAS_STRENGTH defaults to 0.12', () => {
    expect(config.MM_INVENTORY_BIAS_STRENGTH).toBe(0.12);
  });

  it('MM_SPREAD_MULT defaults to 1.5', () => {
    expect(config.MM_SPREAD_MULT).toBe(1.5);
  });

  it('MM_MIN_FEE_MULT defaults to 1.5', () => {
    expect(config.MM_MIN_FEE_MULT).toBe(1.5);
  });

  it('MM_TP_MAX_USD defaults to 2.0', () => {
    expect(config.MM_TP_MAX_USD).toBe(2.0);
  });
});

describe('MM_* keys in OverridableConfig and OVERRIDABLE_KEYS via getEffective() (10.2)', () => {
  // We import the real configStore (no mocking needed — just checking key presence and defaults)
  it('getEffective() includes all 8 MM_* keys with correct default values', async () => {
    // Use a fresh dynamic import to avoid module-level side effects
    const { configStore } = await import('../ConfigStore');
    const effective = configStore.getEffective();

    expect(effective.MM_ENABLED).toBe(true);
    expect(effective.MM_PINGPONG_BIAS_STRENGTH).toBe(0.08);
    expect(effective.MM_INVENTORY_SOFT_BIAS).toBe(50);
    expect(effective.MM_INVENTORY_HARD_BLOCK).toBe(150);
    expect(effective.MM_INVENTORY_BIAS_STRENGTH).toBe(0.12);
    expect(effective.MM_SPREAD_MULT).toBe(1.5);
    expect(effective.MM_MIN_FEE_MULT).toBe(1.5);
    expect(effective.MM_TP_MAX_USD).toBe(2.0);
  });
});
