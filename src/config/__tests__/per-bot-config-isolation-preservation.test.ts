/**
 * PRESERVATION TESTS — Must PASS on both unfixed and fixed code
 *
 * These tests document baseline single-bot behavior that must be preserved
 * after the per-bot config isolation fix is applied.
 *
 * Property 2: Preservation - Single-Bot and Existing Behavior Unchanged
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ConfigStore } from '../../config/ConfigStore.js';
import { config } from '../../config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Snapshot of config keys we mutate in tests, restored in afterEach */
let savedFarmMinHoldSecs: number;
let savedFarmTpUsd: number;

beforeEach(() => {
  savedFarmMinHoldSecs = config.FARM_MIN_HOLD_SECS;
  savedFarmTpUsd = config.FARM_TP_USD;
});

afterEach(() => {
  config.FARM_MIN_HOLD_SECS = savedFarmMinHoldSecs;
  config.FARM_TP_USD = savedFarmTpUsd;
});

// ── Test 1: Single-store getEffective() correctness ───────────────────────────

describe('Preservation: single-store getEffective() correctness', () => {
  it('returns the overridden value after applyOverrides({ FARM_MIN_HOLD_SECS: 120 })', () => {
    const store = new ConfigStore();
    store.applyOverrides({ FARM_MIN_HOLD_SECS: 120 });
    expect(store.getEffective().FARM_MIN_HOLD_SECS).toBe(120);
  });
});

// ── Test 2: resetToDefaults() restores base values ────────────────────────────

describe('Preservation: resetToDefaults() restores base values', () => {
  it('restores FARM_MIN_HOLD_SECS to the original base value (120) after reset', () => {
    const store = new ConfigStore();
    // The base value captured at construction time comes from config.ts default: 120
    const baseValue = store.getEffective().FARM_MIN_HOLD_SECS;

    store.applyOverrides({ FARM_MIN_HOLD_SECS: 300 });
    expect(store.getEffective().FARM_MIN_HOLD_SECS).toBe(300);

    store.resetToDefaults();
    expect(store.getEffective().FARM_MIN_HOLD_SECS).toBe(baseValue);
    // Also assert against the known default from config.ts
    expect(store.getEffective().FARM_MIN_HOLD_SECS).toBe(120);
  });
});

// ── Test 3: getEffective() merges base + overrides correctly ──────────────────

describe('Preservation: getEffective() merges base + multiple overrides correctly', () => {
  it('reflects all applied overrides simultaneously', () => {
    const store = new ConfigStore();
    store.applyOverrides({ FARM_MIN_HOLD_SECS: 200, FARM_TP_USD: 1.5 });

    const effective = store.getEffective();
    expect(effective.FARM_MIN_HOLD_SECS).toBe(200);
    expect(effective.FARM_TP_USD).toBe(1.5);
  });
});

// ── Test 4: Unoverridden keys retain base values ──────────────────────────────

describe('Preservation: unoverridden keys retain base values', () => {
  it('FARM_TP_USD stays at base when only FARM_MIN_HOLD_SECS is overridden', () => {
    const store = new ConfigStore();
    const baseFarmTpUsd = store.getEffective().FARM_TP_USD;

    store.applyOverrides({ FARM_MIN_HOLD_SECS: 300 });

    expect(store.getEffective().FARM_MIN_HOLD_SECS).toBe(300);
    expect(store.getEffective().FARM_TP_USD).toBe(baseFarmTpUsd);
  });
});

// ── Test 5: Representative values — overrides always reflected in getEffective() ─

describe('Preservation: representative override values always reflected in getEffective()', () => {
  /**
   * Tests a set of representative FARM_MIN_HOLD_SECS values to confirm
   * getEffective() always returns the applied override.
   *
   * Validates: Requirements 3.1
   */
  const representativeValues = [60, 90, 180, 300];

  for (const value of representativeValues) {
    it(`FARM_MIN_HOLD_SECS=${value} is correctly returned by getEffective()`, () => {
      const store = new ConfigStore();
      store.applyOverrides({ FARM_MIN_HOLD_SECS: value });
      expect(store.getEffective().FARM_MIN_HOLD_SECS).toBe(value);
    });
  }

  it('sequential overrides: last value wins', () => {
    const store = new ConfigStore();
    for (const value of representativeValues) {
      store.applyOverrides({ FARM_MIN_HOLD_SECS: value });
    }
    // Last applied value should be the effective one
    expect(store.getEffective().FARM_MIN_HOLD_SECS).toBe(representativeValues[representativeValues.length - 1]);
  });
});
