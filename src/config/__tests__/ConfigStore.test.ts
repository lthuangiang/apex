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
  REGIME_BB_STD_DEV: 2,
  REGIME_VOL_LOOKBACK: 10,
  REGIME_HIGH_VOL_THRESHOLD: 0.005,
  REGIME_TREND_EMA_BAND: 0.002,
  REGIME_BB_TREND_MIN: 0.01,
  REGIME_TREND_HOLD_MULT: 1.5,
  REGIME_SIDEWAY_HOLD_MULT: 0.8,
  REGIME_HIGH_VOL_HOLD_MULT: 0.7,
  REGIME_HIGH_VOL_SIZE_FACTOR: 0.5,
  REGIME_SIDEWAY_SIZE_FACTOR: 0.85,
  REGIME_HIGH_VOL_SL_MULT: 1.5,
  REGIME_HIGH_VOL_SKIP_ENTRY: false,
  REGIME_TREND_SUPPRESS_EARLY_EXIT: true,
  // Anti-chop filter defaults
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

  it('SIZING_* overrides: all values restored correctly from config-overrides.json', async () => {
    // Note: SIZING_CONF_WEIGHT and SIZING_PERF_WEIGHT must sum to 1.0.
    // loadFromDisk() validates each field individually against the current effective state,
    // so we keep them at their base values (0.6 + 0.4 = 1.0) and override the other SIZING fields.
    const sizingOverrides = {
      SIZING_MIN_MULTIPLIER: 0.3,
      SIZING_MAX_MULTIPLIER: 1.8,
      SIZING_CONF_WEIGHT: 0.6,
      SIZING_PERF_WEIGHT: 0.4,
      SIZING_DRAWDOWN_THRESHOLD: -5.0,
      SIZING_DRAWDOWN_FLOOR: 0.4,
      SIZING_MAX_BTC: 0.01,
      SIZING_MAX_BALANCE_PCT: 0.03,
    };

    const store = await freshStore({
      existsSync: () => true,
      readFileSync: () => JSON.stringify(sizingOverrides),
    });

    store.loadFromDisk();
    const effective = store.getEffective();

    expect(effective.SIZING_MIN_MULTIPLIER).toBe(0.3);
    expect(effective.SIZING_MAX_MULTIPLIER).toBe(1.8);
    expect(effective.SIZING_CONF_WEIGHT).toBe(0.6);
    expect(effective.SIZING_PERF_WEIGHT).toBe(0.4);
    expect(effective.SIZING_DRAWDOWN_THRESHOLD).toBe(-5.0);
    expect(effective.SIZING_DRAWDOWN_FLOOR).toBe(0.4);
    expect(effective.SIZING_MAX_BTC).toBe(0.01);
    expect(effective.SIZING_MAX_BALANCE_PCT).toBe(0.03);

    // Non-SIZING keys should remain at base values
    expect(effective.ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
    expect(effective.FARM_TP_USD).toBe(BASE_CONFIG.FARM_TP_USD);
  });
});

describe('ConfigStore.loadFromDisk() — REGIME_* overrides', () => {
  it('REGIME_* overrides: all values restored correctly from config-overrides.json', async () => {
    const regimeOverrides = {
      REGIME_HIGH_VOL_THRESHOLD: 0.01,
      REGIME_HIGH_VOL_SIZE_FACTOR: 0.3,
      REGIME_HIGH_VOL_SL_MULT: 2.0,
    };

    const store = await freshStore({
      existsSync: () => true,
      readFileSync: () => JSON.stringify(regimeOverrides),
    });

    store.loadFromDisk();
    const effective = store.getEffective();

    expect(effective.REGIME_HIGH_VOL_THRESHOLD).toBe(0.01);
    expect(effective.REGIME_HIGH_VOL_SIZE_FACTOR).toBe(0.3);
    expect(effective.REGIME_HIGH_VOL_SL_MULT).toBe(2.0);

    // Non-REGIME keys should remain at base values
    expect(effective.ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
    expect(effective.FARM_TP_USD).toBe(BASE_CONFIG.FARM_TP_USD);
  });

  it('REGIME_* overrides via applyOverrides() are persisted and restored on fresh instance', async () => {
    let diskContents = '';

    // First store: apply overrides (auto-saves to disk via saveToDisk)
    const store1 = await freshStore({
      existsSync: () => false,
      readFileSync: () => diskContents,
    });

    // Capture what gets written to disk
    mockWriteFileSync.mockImplementation((_path: string, data: string) => {
      diskContents = data;
    });

    store1.applyOverrides({
      REGIME_HIGH_VOL_THRESHOLD: 0.01,
      REGIME_HIGH_VOL_SIZE_FACTOR: 0.3,
      REGIME_HIGH_VOL_SL_MULT: 2.0,
    });

    expect(diskContents).toBeTruthy();

    // Second store: fresh instance pointing to the same "file"
    const store2 = await freshStore({
      existsSync: () => true,
      readFileSync: () => diskContents,
    });

    store2.loadFromDisk();
    const effective = store2.getEffective();

    expect(effective.REGIME_HIGH_VOL_THRESHOLD).toBe(0.01);
    expect(effective.REGIME_HIGH_VOL_SIZE_FACTOR).toBe(0.3);
    expect(effective.REGIME_HIGH_VOL_SL_MULT).toBe(2.0);

    // Unrelated keys stay at base
    expect(effective.ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
  });

  it('invalid REGIME_* values in persisted file are discarded, valid ones applied', async () => {
    // REGIME_HIGH_VOL_SIZE_FACTOR: 1.5 is invalid (must be in (0, 1])
    // REGIME_HIGH_VOL_SL_MULT: 2.0 is valid (>= 1.0)
    const store = await freshStore({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({
        REGIME_HIGH_VOL_SIZE_FACTOR: 1.5,
        REGIME_HIGH_VOL_SL_MULT: 2.0,
      }),
    });

    store.loadFromDisk();
    const effective = store.getEffective();

    // Invalid value discarded — stays at base
    expect(effective.REGIME_HIGH_VOL_SIZE_FACTOR).toBe(BASE_CONFIG.REGIME_HIGH_VOL_SIZE_FACTOR);
    // Valid value applied
    expect(effective.REGIME_HIGH_VOL_SL_MULT).toBe(2.0);
  });
});

describe('ConfigStore.loadFromDisk() — CHOP_* overrides', () => {
  it('CHOP_* overrides: all values restored correctly from config-overrides.json', async () => {
    // Keep weight fields at base values (0.4 + 0.35 + 0.25 = 1.0) to satisfy cross-field sum rule.
    // Override the non-weight CHOP_* fields to distinct non-default values.
    const chopOverrides = {
      CHOP_FLIP_WINDOW: 8,
      CHOP_BB_COMPRESS_MAX: 0.02,
      CHOP_SCORE_THRESHOLD: 0.65,
      CHOP_BREAKOUT_SCORE_EDGE: 0.1,
      CHOP_BREAKOUT_VOL_MIN: 0.9,
      CHOP_BREAKOUT_IMBALANCE_THRESHOLD: 0.2,
      CHOP_COOLDOWN_STREAK_FACTOR: 0.75,
      CHOP_COOLDOWN_CHOP_FACTOR: 1.5,
      CHOP_COOLDOWN_MAX_MINS: 45,
    };

    const store = await freshStore({
      existsSync: () => true,
      readFileSync: () => JSON.stringify(chopOverrides),
    });

    store.loadFromDisk();
    const effective = store.getEffective();

    expect(effective.CHOP_FLIP_WINDOW).toBe(8);
    expect(effective.CHOP_BB_COMPRESS_MAX).toBe(0.02);
    expect(effective.CHOP_SCORE_THRESHOLD).toBe(0.65);
    expect(effective.CHOP_BREAKOUT_SCORE_EDGE).toBe(0.1);
    expect(effective.CHOP_BREAKOUT_VOL_MIN).toBe(0.9);
    expect(effective.CHOP_BREAKOUT_IMBALANCE_THRESHOLD).toBe(0.2);
    expect(effective.CHOP_COOLDOWN_STREAK_FACTOR).toBe(0.75);
    expect(effective.CHOP_COOLDOWN_CHOP_FACTOR).toBe(1.5);
    expect(effective.CHOP_COOLDOWN_MAX_MINS).toBe(45);

    // Non-CHOP keys should remain at base values
    expect(effective.ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
    expect(effective.FARM_TP_USD).toBe(BASE_CONFIG.FARM_TP_USD);
  });

  it('CHOP_* overrides via applyOverrides() are persisted and restored on fresh instance', async () => {
    let diskContents = '';

    // First store: apply overrides (auto-saves to disk via saveToDisk)
    const store1 = await freshStore({
      existsSync: () => false,
      readFileSync: () => diskContents,
    });

    // Capture what gets written to disk
    mockWriteFileSync.mockImplementation((_path: string, data: string) => {
      diskContents = data;
    });

    store1.applyOverrides({
      CHOP_FLIP_WINDOW: 8,
      CHOP_SCORE_THRESHOLD: 0.65,
      CHOP_COOLDOWN_MAX_MINS: 45,
    });

    expect(diskContents).toBeTruthy();

    // Second store: fresh instance pointing to the same "file"
    const store2 = await freshStore({
      existsSync: () => true,
      readFileSync: () => diskContents,
    });

    store2.loadFromDisk();
    const effective = store2.getEffective();

    expect(effective.CHOP_FLIP_WINDOW).toBe(8);
    expect(effective.CHOP_SCORE_THRESHOLD).toBe(0.65);
    expect(effective.CHOP_COOLDOWN_MAX_MINS).toBe(45);

    // Unrelated keys stay at base
    expect(effective.ORDER_SIZE_MIN).toBe(BASE_CONFIG.ORDER_SIZE_MIN);
    expect(effective.REGIME_HIGH_VOL_THRESHOLD).toBe(BASE_CONFIG.REGIME_HIGH_VOL_THRESHOLD);
  });

  it('invalid CHOP_* values in persisted file are discarded, valid ones applied', async () => {
    // CHOP_FLIP_WINDOW: 0 is invalid (must be >= 1)
    // CHOP_SCORE_THRESHOLD: 0 is invalid (must be in (0, 1))
    // CHOP_COOLDOWN_MAX_MINS: 45 is valid (>= COOLDOWN_MAX_MINS=10)
    const store = await freshStore({
      existsSync: () => true,
      readFileSync: () => JSON.stringify({
        CHOP_FLIP_WINDOW: 0,
        CHOP_SCORE_THRESHOLD: 0,
        CHOP_COOLDOWN_MAX_MINS: 45,
      }),
    });

    store.loadFromDisk();
    const effective = store.getEffective();

    // Invalid values discarded — stay at base
    expect(effective.CHOP_FLIP_WINDOW).toBe(BASE_CONFIG.CHOP_FLIP_WINDOW);
    expect(effective.CHOP_SCORE_THRESHOLD).toBe(BASE_CONFIG.CHOP_SCORE_THRESHOLD);
    // Valid value applied
    expect(effective.CHOP_COOLDOWN_MAX_MINS).toBe(45);
  });
});
