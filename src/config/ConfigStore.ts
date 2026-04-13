import * as fs from 'fs';
import * as path from 'path';
import { config } from '../config';
import { validateOverrides, type ValidationError } from './validateOverrides';

const PERSISTENCE_FILE = path.join(process.cwd(), 'config-overrides.json');

export type OverridableConfig = {
  ORDER_SIZE_MIN: number;
  ORDER_SIZE_MAX: number;
  STOP_LOSS_PERCENT: number;
  TAKE_PROFIT_PERCENT: number;
  POSITION_SL_PERCENT: number;
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
  TRADE_TP_PERCENT: number;
  TRADE_SL_PERCENT: number;
  COOLDOWN_MIN_MINS: number;
  COOLDOWN_MAX_MINS: number;
  MIN_POSITION_VALUE_USD: number;
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
  'STOP_LOSS_PERCENT',
  'TAKE_PROFIT_PERCENT',
  'POSITION_SL_PERCENT',
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
  'TRADE_TP_PERCENT',
  'TRADE_SL_PERCENT',
  'COOLDOWN_MIN_MINS',
  'COOLDOWN_MAX_MINS',
  'MIN_POSITION_VALUE_USD',
];

function extractBase(): OverridableConfig {
  return {
    ORDER_SIZE_MIN: config.ORDER_SIZE_MIN,
    ORDER_SIZE_MAX: config.ORDER_SIZE_MAX,
    STOP_LOSS_PERCENT: config.STOP_LOSS_PERCENT,
    TAKE_PROFIT_PERCENT: config.TAKE_PROFIT_PERCENT,
    POSITION_SL_PERCENT: config.POSITION_SL_PERCENT,
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
    TRADE_TP_PERCENT: config.TRADE_TP_PERCENT,
    TRADE_SL_PERCENT: config.TRADE_SL_PERCENT,
    COOLDOWN_MIN_MINS: config.COOLDOWN_MIN_MINS,
    COOLDOWN_MAX_MINS: config.COOLDOWN_MAX_MINS,
    MIN_POSITION_VALUE_USD: config.MIN_POSITION_VALUE_USD,
  };
}

class ConfigStore {
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
