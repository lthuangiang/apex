import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { validateOverrides, type ValidationError } from './validateOverrides';

const PERSISTENCE_FILE = path.join(process.cwd(), 'config-overrides.json');

export type OverridableConfig = {
  ORDER_SIZE_MIN: number;
  ORDER_SIZE_MAX: number;
  // ── Farm mode ──────────────────────────────────────────────────────────────
  FARM_MIN_HOLD_SECS: number;
  FARM_MAX_HOLD_SECS: number;
  FARM_TP_USD: number;
  FARM_SL_PERCENT: number;
  FARM_SCORE_EDGE: number;
  FARM_MIN_CONFIDENCE: number;
  FARM_EARLY_EXIT_SECS: number;
  FARM_EARLY_EXIT_PNL: number;
  FARM_EXTRA_WAIT_SECS: number;
  FARM_BLOCKED_HOURS: number[];
  FARM_COOLDOWN_SECS: number;   // Fixed cooldown after each farm trade (seconds)
  // ── Trade mode ─────────────────────────────────────────────────────────────
  TRADE_TP_PERCENT: number;
  TRADE_SL_PERCENT: number;
  COOLDOWN_MIN_MINS: number;    // Trade mode adaptive cooldown min
  COOLDOWN_MAX_MINS: number;    // Trade mode adaptive cooldown max
  // ── Shared ─────────────────────────────────────────────────────────────────
  MIN_POSITION_VALUE_USD: number;
  // ── Dynamic sizing ─────────────────────────────────────────────────────────
  SIZING_MIN_MULTIPLIER: number;
  SIZING_MAX_MULTIPLIER: number;
  SIZING_CONF_WEIGHT: number;
  SIZING_PERF_WEIGHT: number;
  SIZING_DRAWDOWN_THRESHOLD: number;
  SIZING_DRAWDOWN_FLOOR: number;
  SIZING_MAX_BTC: number;
  SIZING_MAX_BALANCE_PCT: number;
  // ── Regime detection ───────────────────────────────────────────────────────
  REGIME_ATR_PERIOD: number;
  REGIME_BB_PERIOD: number;
  REGIME_BB_STD_DEV: number;
  REGIME_VOL_LOOKBACK: number;
  REGIME_HIGH_VOL_THRESHOLD: number;
  REGIME_TREND_EMA_BAND: number;
  REGIME_BB_TREND_MIN: number;
  REGIME_TREND_HOLD_MULT: number;
  REGIME_SIDEWAY_HOLD_MULT: number;
  REGIME_HIGH_VOL_HOLD_MULT: number;
  REGIME_HIGH_VOL_SIZE_FACTOR: number;
  REGIME_SIDEWAY_SIZE_FACTOR: number;
  REGIME_HIGH_VOL_SL_MULT: number;
  REGIME_HIGH_VOL_SKIP_ENTRY: boolean;
  REGIME_TREND_SUPPRESS_EARLY_EXIT: boolean;
  // ── Anti-chop (trade mode) ─────────────────────────────────────────────────
  CHOP_FLIP_WINDOW: number;
  CHOP_FLIP_WEIGHT: number;
  CHOP_MOM_WEIGHT: number;
  CHOP_BB_WEIGHT: number;
  CHOP_BB_COMPRESS_MAX: number;
  CHOP_SCORE_THRESHOLD: number;
  CHOP_BREAKOUT_SCORE_EDGE: number;
  CHOP_BREAKOUT_VOL_MIN: number;
  CHOP_BREAKOUT_IMBALANCE_THRESHOLD: number;
  CHOP_COOLDOWN_STREAK_FACTOR: number;
  CHOP_COOLDOWN_CHOP_FACTOR: number;
  CHOP_COOLDOWN_MAX_MINS: number;
  // ── Execution edge ─────────────────────────────────────────────────────────
  EXEC_MAX_SPREAD_BPS?: number;
  EXEC_SPREAD_OFFSET_MULT?: number;
  EXEC_DEPTH_LEVELS?: number;
  EXEC_DEPTH_THIN_THRESHOLD?: number;
  EXEC_DEPTH_PENALTY?: number;
  EXEC_FILL_WINDOW?: number;
  EXEC_FILL_RATE_THRESHOLD?: number;
  EXEC_FILL_RATE_PENALTY?: number;
  EXEC_OFFSET_MIN?: number;
  EXEC_OFFSET_MAX?: number;
  // ── Market making ──────────────────────────────────────────────────────────
  MM_ENABLED: boolean;
  MM_PINGPONG_BIAS_STRENGTH: number;
  MM_INVENTORY_SOFT_BIAS: number;
  MM_INVENTORY_HARD_BLOCK: number;
  MM_INVENTORY_BIAS_STRENGTH: number;
  MM_SPREAD_MULT: number;
  MM_MIN_FEE_MULT: number;
  MM_TP_MAX_USD: number;
};

export type PartialOverride = Partial<OverridableConfig>;

export interface ConfigStoreInterface {
  /** Returns the current effective values (base merged with overrides). */
  getEffective(): OverridableConfig;
  /** Validates and applies a partial override. Throws ValidationError on failure. */
  applyOverrides(patch: PartialOverride): void;
  /** Clears all overrides, restoring base config values. */
  resetToDefaults(): void;
  /** Loads persisted overrides from disk (called at startup). */
  loadFromDisk(): void;
}

const OVERRIDABLE_KEYS: (keyof OverridableConfig)[] = [
  'ORDER_SIZE_MIN',
  'ORDER_SIZE_MAX',
  // Farm mode
  'FARM_MIN_HOLD_SECS',
  'FARM_MAX_HOLD_SECS',
  'FARM_TP_USD',
  'FARM_SL_PERCENT',
  'FARM_SCORE_EDGE',
  'FARM_MIN_CONFIDENCE',
  'FARM_EARLY_EXIT_SECS',
  'FARM_EARLY_EXIT_PNL',
  'FARM_EXTRA_WAIT_SECS',
  'FARM_BLOCKED_HOURS',
  'FARM_COOLDOWN_SECS',
  // Trade mode
  'TRADE_TP_PERCENT',
  'TRADE_SL_PERCENT',
  'COOLDOWN_MIN_MINS',
  'COOLDOWN_MAX_MINS',
  // Shared
  'MIN_POSITION_VALUE_USD',
  // Sizing
  'SIZING_MIN_MULTIPLIER',
  'SIZING_MAX_MULTIPLIER',
  'SIZING_CONF_WEIGHT',
  'SIZING_PERF_WEIGHT',
  'SIZING_DRAWDOWN_THRESHOLD',
  'SIZING_DRAWDOWN_FLOOR',
  'SIZING_MAX_BTC',
  'SIZING_MAX_BALANCE_PCT',
  // Regime
  'REGIME_ATR_PERIOD',
  'REGIME_BB_PERIOD',
  'REGIME_BB_STD_DEV',
  'REGIME_VOL_LOOKBACK',
  'REGIME_HIGH_VOL_THRESHOLD',
  'REGIME_TREND_EMA_BAND',
  'REGIME_BB_TREND_MIN',
  'REGIME_TREND_HOLD_MULT',
  'REGIME_SIDEWAY_HOLD_MULT',
  'REGIME_HIGH_VOL_HOLD_MULT',
  'REGIME_HIGH_VOL_SIZE_FACTOR',
  'REGIME_SIDEWAY_SIZE_FACTOR',
  'REGIME_HIGH_VOL_SL_MULT',
  'REGIME_HIGH_VOL_SKIP_ENTRY',
  'REGIME_TREND_SUPPRESS_EARLY_EXIT',
  // Anti-chop (trade mode)
  'CHOP_FLIP_WINDOW',
  'CHOP_FLIP_WEIGHT',
  'CHOP_MOM_WEIGHT',
  'CHOP_BB_WEIGHT',
  'CHOP_BB_COMPRESS_MAX',
  'CHOP_SCORE_THRESHOLD',
  'CHOP_BREAKOUT_SCORE_EDGE',
  'CHOP_BREAKOUT_VOL_MIN',
  'CHOP_BREAKOUT_IMBALANCE_THRESHOLD',
  'CHOP_COOLDOWN_STREAK_FACTOR',
  'CHOP_COOLDOWN_CHOP_FACTOR',
  'CHOP_COOLDOWN_MAX_MINS',
  // Execution edge
  'EXEC_MAX_SPREAD_BPS',
  'EXEC_SPREAD_OFFSET_MULT',
  'EXEC_DEPTH_LEVELS',
  'EXEC_DEPTH_THIN_THRESHOLD',
  'EXEC_DEPTH_PENALTY',
  'EXEC_FILL_WINDOW',
  'EXEC_FILL_RATE_THRESHOLD',
  'EXEC_FILL_RATE_PENALTY',
  'EXEC_OFFSET_MIN',
  'EXEC_OFFSET_MAX',
  // Market making
  'MM_ENABLED',
  'MM_PINGPONG_BIAS_STRENGTH',
  'MM_INVENTORY_SOFT_BIAS',
  'MM_INVENTORY_HARD_BLOCK',
  'MM_INVENTORY_BIAS_STRENGTH',
  'MM_SPREAD_MULT',
  'MM_MIN_FEE_MULT',
  'MM_TP_MAX_USD',
];

function extractBase(): OverridableConfig {
  return {
    ORDER_SIZE_MIN: config.ORDER_SIZE_MIN,
    ORDER_SIZE_MAX: config.ORDER_SIZE_MAX,
    FARM_MIN_HOLD_SECS: config.FARM_MIN_HOLD_SECS,
    FARM_MAX_HOLD_SECS: config.FARM_MAX_HOLD_SECS,
    FARM_TP_USD: config.FARM_TP_USD,
    FARM_SL_PERCENT: config.FARM_SL_PERCENT,
    FARM_SCORE_EDGE: config.FARM_SCORE_EDGE,
    FARM_MIN_CONFIDENCE: config.FARM_MIN_CONFIDENCE,
    FARM_EARLY_EXIT_SECS: config.FARM_EARLY_EXIT_SECS,
    FARM_EARLY_EXIT_PNL: config.FARM_EARLY_EXIT_PNL,
    FARM_EXTRA_WAIT_SECS: config.FARM_EXTRA_WAIT_SECS,
    FARM_BLOCKED_HOURS: config.FARM_BLOCKED_HOURS,
    FARM_COOLDOWN_SECS: config.FARM_COOLDOWN_SECS,
    TRADE_TP_PERCENT: config.TRADE_TP_PERCENT,
    TRADE_SL_PERCENT: config.TRADE_SL_PERCENT,
    COOLDOWN_MIN_MINS: config.COOLDOWN_MIN_MINS,
    COOLDOWN_MAX_MINS: config.COOLDOWN_MAX_MINS,
    MIN_POSITION_VALUE_USD: config.MIN_POSITION_VALUE_USD,
    SIZING_MIN_MULTIPLIER: config.SIZING_MIN_MULTIPLIER,
    SIZING_MAX_MULTIPLIER: config.SIZING_MAX_MULTIPLIER,
    SIZING_CONF_WEIGHT: config.SIZING_CONF_WEIGHT,
    SIZING_PERF_WEIGHT: config.SIZING_PERF_WEIGHT,
    SIZING_DRAWDOWN_THRESHOLD: config.SIZING_DRAWDOWN_THRESHOLD,
    SIZING_DRAWDOWN_FLOOR: config.SIZING_DRAWDOWN_FLOOR,
    SIZING_MAX_BTC: config.SIZING_MAX_BTC,
    SIZING_MAX_BALANCE_PCT: config.SIZING_MAX_BALANCE_PCT,
    REGIME_ATR_PERIOD: config.REGIME_ATR_PERIOD,
    REGIME_BB_PERIOD: config.REGIME_BB_PERIOD,
    REGIME_BB_STD_DEV: config.REGIME_BB_STD_DEV,
    REGIME_VOL_LOOKBACK: config.REGIME_VOL_LOOKBACK,
    REGIME_HIGH_VOL_THRESHOLD: config.REGIME_HIGH_VOL_THRESHOLD,
    REGIME_TREND_EMA_BAND: config.REGIME_TREND_EMA_BAND,
    REGIME_BB_TREND_MIN: config.REGIME_BB_TREND_MIN,
    REGIME_TREND_HOLD_MULT: config.REGIME_TREND_HOLD_MULT,
    REGIME_SIDEWAY_HOLD_MULT: config.REGIME_SIDEWAY_HOLD_MULT,
    REGIME_HIGH_VOL_HOLD_MULT: config.REGIME_HIGH_VOL_HOLD_MULT,
    REGIME_HIGH_VOL_SIZE_FACTOR: config.REGIME_HIGH_VOL_SIZE_FACTOR,
    REGIME_SIDEWAY_SIZE_FACTOR: config.REGIME_SIDEWAY_SIZE_FACTOR,
    REGIME_HIGH_VOL_SL_MULT: config.REGIME_HIGH_VOL_SL_MULT,
    REGIME_HIGH_VOL_SKIP_ENTRY: config.REGIME_HIGH_VOL_SKIP_ENTRY,
    REGIME_TREND_SUPPRESS_EARLY_EXIT: config.REGIME_TREND_SUPPRESS_EARLY_EXIT,
    CHOP_FLIP_WINDOW: config.CHOP_FLIP_WINDOW,
    CHOP_FLIP_WEIGHT: config.CHOP_FLIP_WEIGHT,
    CHOP_MOM_WEIGHT: config.CHOP_MOM_WEIGHT,
    CHOP_BB_WEIGHT: config.CHOP_BB_WEIGHT,
    CHOP_BB_COMPRESS_MAX: config.CHOP_BB_COMPRESS_MAX,
    CHOP_SCORE_THRESHOLD: config.CHOP_SCORE_THRESHOLD,
    CHOP_BREAKOUT_SCORE_EDGE: config.CHOP_BREAKOUT_SCORE_EDGE,
    CHOP_BREAKOUT_VOL_MIN: config.CHOP_BREAKOUT_VOL_MIN,
    CHOP_BREAKOUT_IMBALANCE_THRESHOLD: config.CHOP_BREAKOUT_IMBALANCE_THRESHOLD,
    CHOP_COOLDOWN_STREAK_FACTOR: config.CHOP_COOLDOWN_STREAK_FACTOR,
    CHOP_COOLDOWN_CHOP_FACTOR: config.CHOP_COOLDOWN_CHOP_FACTOR,
    CHOP_COOLDOWN_MAX_MINS: config.CHOP_COOLDOWN_MAX_MINS,
    EXEC_MAX_SPREAD_BPS: config.EXEC_MAX_SPREAD_BPS,
    EXEC_SPREAD_OFFSET_MULT: config.EXEC_SPREAD_OFFSET_MULT,
    EXEC_DEPTH_LEVELS: config.EXEC_DEPTH_LEVELS,
    EXEC_DEPTH_THIN_THRESHOLD: config.EXEC_DEPTH_THIN_THRESHOLD,
    EXEC_DEPTH_PENALTY: config.EXEC_DEPTH_PENALTY,
    EXEC_FILL_WINDOW: config.EXEC_FILL_WINDOW,
    EXEC_FILL_RATE_THRESHOLD: config.EXEC_FILL_RATE_THRESHOLD,
    EXEC_FILL_RATE_PENALTY: config.EXEC_FILL_RATE_PENALTY,
    EXEC_OFFSET_MIN: config.EXEC_OFFSET_MIN,
    EXEC_OFFSET_MAX: config.EXEC_OFFSET_MAX,
    MM_ENABLED: config.MM_ENABLED,
    MM_PINGPONG_BIAS_STRENGTH: config.MM_PINGPONG_BIAS_STRENGTH,
    MM_INVENTORY_SOFT_BIAS: config.MM_INVENTORY_SOFT_BIAS,
    MM_INVENTORY_HARD_BLOCK: config.MM_INVENTORY_HARD_BLOCK,
    MM_INVENTORY_BIAS_STRENGTH: config.MM_INVENTORY_BIAS_STRENGTH,
    MM_SPREAD_MULT: config.MM_SPREAD_MULT,
    MM_MIN_FEE_MULT: config.MM_MIN_FEE_MULT,
    MM_TP_MAX_USD: config.MM_TP_MAX_USD,
  };
}

export class ConfigStore {
  private overrides: PartialOverride = {};
  private readonly base: OverridableConfig;

  constructor() {
    this.base = extractBase();
  }

  /** Returns the current effective values (base merged with overrides). */
  getEffective(): OverridableConfig {
    return { ...this.base, ...this.overrides };
  }

  /** Validates and applies a partial override. Throws if validation fails. */
  applyOverrides(patch: PartialOverride): void {
    const errors = validateOverrides(patch, this.getEffective());
    if (errors.length > 0) {
      const err = new Error('Config validation failed') as Error & { errors: ValidationError[] };
      err.errors = errors;
      throw err;
    }

    // Merge patch into overrides
    for (const key of OVERRIDABLE_KEYS) {
      if (key in patch) {
        (this.overrides as Record<string, number>)[key] = patch[key] as number;
      }
    }

    // Mutate the live config object so Watcher picks up changes on next tick
    const effective = this.getEffective();
    for (const key of OVERRIDABLE_KEYS) {
      (config as Record<string, unknown>)[key] = effective[key];
    }

    this.saveToDisk();
  }

  /** Clears all overrides and restores base config values. */
  resetToDefaults(): void {
    this.overrides = {};

    // Restore base values on the live config object
    for (const key of OVERRIDABLE_KEYS) {
      (config as Record<string, unknown>)[key] = this.base[key];
    }

    this.saveToDisk();
  }

  /** Persists current overrides to disk. Logs error on failure but does not throw. */
  saveToDisk(): void {
    try {
      fs.writeFileSync(PERSISTENCE_FILE, JSON.stringify(this.overrides, null, 2), 'utf-8');
    } catch (err) {
      console.error('[ConfigStore] Failed to save overrides to disk:', err);
    }
  }

  /**
   * Loads overrides from disk on startup.
   * - Missing file: logs info, no overrides applied.
   * - Invalid JSON: logs warning, no overrides applied.
   * - Per-field validation failure: logs warning, skips that field, continues.
   */
  loadFromDisk(): void {
    if (!fs.existsSync(PERSISTENCE_FILE)) {
      console.info('[ConfigStore] No config-overrides.json found, starting with no overrides.');
      return;
    }

    let raw: string;
    try {
      raw = fs.readFileSync(PERSISTENCE_FILE, 'utf-8');
    } catch (err) {
      console.warn('[ConfigStore] Failed to read config-overrides.json, starting with no overrides:', err);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn('[ConfigStore] config-overrides.json contains invalid JSON, starting with no overrides.');
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.warn('[ConfigStore] config-overrides.json has unexpected format, starting with no overrides.');
      return;
    }

    const stored = parsed as Record<string, unknown>;

    for (const key of OVERRIDABLE_KEYS) {
      if (!(key in stored)) continue;

      const value = stored[key];
      const singleField = { [key]: value } as PartialOverride;
      const errors = validateOverrides(singleField, this.getEffective());

      if (errors.length > 0) {
        console.warn(`[ConfigStore] Discarding stored override for "${key}" (failed validation): ${errors.map(e => e.message).join(', ')}`);
        continue;
      }

      (this.overrides as Record<string, number>)[key] = value as number;
      (config as Record<string, unknown>)[key] = value;
    }
  }
}

// Singleton instance
export const configStore = new ConfigStore();
