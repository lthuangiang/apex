/**
 * ConfigStore unit tests.
 *
 * Strategy: vi.doMock (not hoisted) + vi.resetModules() + dynamic import
 * gives us a truly fresh singleton per test, with per-test fs/config control.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Base config (mirrors src/config.ts defaults) ----
const BASE_CONFIG = {
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

// ---- Per-test fs state (read by the mock factory) ----
let mockExistsSync = vi.fn(() => false);
let mockReadFileSync = vi.fn(() => '');
let mockWriteFileSync = vi.fn();

/**
 * Returns a fresh ConfigStore singleton by resetting the module registry
 * and re-registering mocks with vi.doMock (not hoisted).
 *
 * @param fsSetup - optional overrides for fs mock functions
 */
async function freshStore(fsSetup?: {
  existsSync?: () => boolean;
  readFileSync?: () => string;
}) {
  // Reset mock functions to defaults
  mockExistsSync = vi.fn(fsSetup?.existsSync ?? (() => false));
  mockReadFileSync = vi.fn(fsSetup?.readFileSync ?? (() => ''));
  mockWriteFileSync = vi.fn();

  vi.resetModules();

  // vi.doMock is NOT hoisted — runs in place, so closures work correctly.
  vi.doMock('fs', () => ({
    existsSync: mockExistsSync,
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
  }));

  // Provide a fresh config object each time so mutations don't bleed between tests.
  vi.doMock('../../config', () => ({
    config: { ...BASE_CONFIG },
  }));

  const mod = await import('../ConfigStore');
  return mod.configStore;
}

// ---- Tests ----

describe('ConfigStore.getEffective()', () => {
  it('returns base config values when no overrides are set', async () => {
    const store = await freshStore();
    const effective = store.getEffective();

    expect(effective.ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
    expect(effective.ORDER_SIZE_MAX).toBe(BASE_CONFIG.ORDER_SIZE_MAX);
    expect(effective.STOP_LOSS_PERCENT).toBe(BASE_CONFIG.STOP_LOSS_PERCENT);
    expect(effective.COOLDOWN_MIN_MINS).toBe(BASE_CONFIG.COOLDOWN_MIN_MINS);
    expect(effective.COOLDOWN_MAX_MINS).toBe(BASE_CONFIG.COOLDOWN_MAX_MINS);
  });
});

describe('ConfigStore.applyOverrides()', () => {
  it('partial patch — only patched keys change, others stay at base', async () => {
    const store = await freshStore();

    store.applyOverrides({ ORDER_SIZE_MIN: 0.001 });
    const effective = store.getEffective();

    expect(effective.ORDER_SIZE_MIN).toBe(0.001);
    expect(effective.ORDER_SIZE_MAX).toBe(BASE_CONFIG.ORDER_SIZE_MAX);
    expect(effective.STOP_LOSS_PERCENT).toBe(BASE_CONFIG.STOP_LOSS_PERCENT);
    expect(effective.FARM_TP_USD).toBe(BASE_CONFIG.FARM_TP_USD);
  });

  it('throws when validation fails (ORDER_SIZE_MIN = -1)', async () => {
    const store = await freshStore();

    expect(() => store.applyOverrides({ ORDER_SIZE_MIN: -1 })).toThrow('Config validation failed');
  });

  it('does NOT mutate config when validation fails', async () => {
    const store = await freshStore();
    const before = store.getEffective().ORDER_SIZE_MIN;

    try {
      store.applyOverrides({ ORDER_SIZE_MIN: -1 });
    } catch {
      // expected
    }

    expect(store.getEffective().ORDER_SIZE_MIN).toBe(before);
  });
});

describe('ConfigStore.resetToDefaults()', () => {
  it('clears all overrides and restores base values', async () => {
    const store = await freshStore();

    store.applyOverrides({ ORDER_SIZE_MIN: 0.001, FARM_TP_USD: 2.0 });
    expect(store.getEffective().ORDER_SIZE_MIN).toBe(0.001);

    store.resetToDefaults();
    const effective = store.getEffective();

    expect(effective.ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
    expect(effective.FARM_TP_USD).toBe(BASE_CONFIG.FARM_TP_USD);
  });
});

describe('ConfigStore.loadFromDisk()', () => {
  it('missing file: no overrides applied, no error thrown', async () => {
    const store = await freshStore({ existsSync: () => false });

    expect(() => store.loadFromDisk()).not.toThrow();
    expect(store.getEffective().ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
  });

  it('invalid JSON: no overrides applied, no error thrown', async () => {
    const store = await freshStore({
      existsSync: () => true,
      readFileSync: () => 'not valid json {{',
    });

    expect(() => store.loadFromDisk()).not.toThrow();
    expect(store.getEffective().ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
  });

  it('valid JSON with all valid values: overrides applied', async () => {
    const store = await freshStore({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ ORDER_SIZE_MIN: 0.001, FARM_TP_USD: 3.0 }),
    });

    store.loadFromDisk();
    const effective = store.getEffective();

    expect(effective.ORDER_SIZE_MIN).toBe(0.001);
    expect(effective.FARM_TP_USD).toBe(3.0);
    expect(effective.ORDER_SIZE_MAX).toBe(BASE_CONFIG.ORDER_SIZE_MAX);
  });

  it('mixed valid/invalid: only valid values applied, invalid discarded', async () => {
    // ORDER_SIZE_MIN: -1 is invalid; FARM_TP_USD: 5.0 is valid
    const store = await freshStore({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({ ORDER_SIZE_MIN: -1, FARM_TP_USD: 5.0 }),
    });

    store.loadFromDisk();
    const effective = store.getEffective();

    expect(effective.ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
    expect(effective.FARM_TP_USD).toBe(5.0);
  });
});
