import type { OverridableConfig, PartialOverride } from './ConfigStore';

export interface ValidationError {
  field: string;
  message: string;
}

const PERCENT_FIELDS: (keyof OverridableConfig)[] = [
  'FARM_SL_PERCENT',
  'TRADE_TP_PERCENT',
  'TRADE_SL_PERCENT',
];

function isPositive(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v > 0;
}

function isNonNegativeInteger(v: unknown): v is number {
  return typeof v === 'number' && isFinite(v) && v >= 0 && Number.isInteger(v);
}

/**
 * Pure validation function. Returns an array of ValidationError objects.
 * An empty array means the patch is valid.
 *
 * @param patch   - The partial override submitted by the operator.
 * @param effective - The current effective config (used for cross-field checks).
 */
export function validateOverrides(
  patch: PartialOverride,
  effective: OverridableConfig
): ValidationError[] {
  const errors: ValidationError[] = [];

  // Rule 1: ORDER_SIZE_MIN and ORDER_SIZE_MAX must be positive numbers
  if ('ORDER_SIZE_MIN' in patch) {
    if (!isPositive(patch.ORDER_SIZE_MIN)) {
      errors.push({ field: 'ORDER_SIZE_MIN', message: 'Must be a positive number' });
    }
  }
  if ('ORDER_SIZE_MAX' in patch) {
    if (!isPositive(patch.ORDER_SIZE_MAX)) {
      errors.push({ field: 'ORDER_SIZE_MAX', message: 'Must be a positive number' });
    }
  }

  // Rule 2: ORDER_SIZE_MIN must be less than effective ORDER_SIZE_MAX (cross-field)
  const effectiveMin =
    'ORDER_SIZE_MIN' in patch && isPositive(patch.ORDER_SIZE_MIN)
      ? patch.ORDER_SIZE_MIN!
      : effective.ORDER_SIZE_MIN;
  const effectiveMax =
    'ORDER_SIZE_MAX' in patch && isPositive(patch.ORDER_SIZE_MAX)
      ? patch.ORDER_SIZE_MAX!
      : effective.ORDER_SIZE_MAX;

  if ('ORDER_SIZE_MIN' in patch && isPositive(patch.ORDER_SIZE_MIN)) {
    if (patch.ORDER_SIZE_MIN! >= effectiveMax) {
      errors.push({
        field: 'ORDER_SIZE_MIN',
        message: `Must be less than ORDER_SIZE_MAX (${effectiveMax})`,
      });
    }
  }
  if ('ORDER_SIZE_MAX' in patch && isPositive(patch.ORDER_SIZE_MAX)) {
    if (effectiveMin >= patch.ORDER_SIZE_MAX!) {
      errors.push({
        field: 'ORDER_SIZE_MAX',
        message: `Must be greater than ORDER_SIZE_MIN (${effectiveMin})`,
      });
    }
  }

  // Rule 3: Percent-based params must be in range (0, 1]
  for (const field of PERCENT_FIELDS) {
    if (field in patch) {
      const v = patch[field];
      if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v > 1) {
        errors.push({ field, message: 'Must be a number in the range (0, 1]' });
      }
    }
  }

  // Rule 4: FARM_MIN_HOLD_SECS must be less than effective FARM_MAX_HOLD_SECS
  if ('FARM_MIN_HOLD_SECS' in patch || 'FARM_MAX_HOLD_SECS' in patch) {
    const farmMin =
      'FARM_MIN_HOLD_SECS' in patch ? patch.FARM_MIN_HOLD_SECS! : effective.FARM_MIN_HOLD_SECS;
    const farmMax =
      'FARM_MAX_HOLD_SECS' in patch ? patch.FARM_MAX_HOLD_SECS! : effective.FARM_MAX_HOLD_SECS;

    if (typeof farmMin === 'number' && typeof farmMax === 'number' && farmMin >= farmMax) {
      const errorField = 'FARM_MIN_HOLD_SECS' in patch ? 'FARM_MIN_HOLD_SECS' : 'FARM_MAX_HOLD_SECS';
      errors.push({
        field: errorField,
        message: `FARM_MIN_HOLD_SECS must be less than FARM_MAX_HOLD_SECS (effective: min=${farmMin}, max=${farmMax})`,
      });
    }
  }

  // Rule 5: FARM_TP_USD must be a positive number
  if ('FARM_TP_USD' in patch) {
    if (!isPositive(patch.FARM_TP_USD)) {
      errors.push({ field: 'FARM_TP_USD', message: 'Must be a positive number' });
    }
  }

  // Rule 5a: FARM_COOLDOWN_SECS must be a positive integer
  if ('FARM_COOLDOWN_SECS' in patch) {
    const v = patch.FARM_COOLDOWN_SECS;
    if (typeof v !== 'number' || !isFinite(v) || v < 0) {
      errors.push({ field: 'FARM_COOLDOWN_SECS', message: 'Must be a non-negative number (seconds)' });
    }
  }

  // Rule 5b: MIN_POSITION_VALUE_USD must be a positive number
  if ('MIN_POSITION_VALUE_USD' in patch) {
    if (!isPositive(patch.MIN_POSITION_VALUE_USD)) {
      errors.push({ field: 'MIN_POSITION_VALUE_USD', message: 'Must be a positive number' });
    }
  }

  // Rule 5c: FARM_SCORE_EDGE must be in (0, 0.5)
  if ('FARM_SCORE_EDGE' in patch) {
    const v = patch.FARM_SCORE_EDGE;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= 0.5) {
      errors.push({ field: 'FARM_SCORE_EDGE', message: 'Must be a number in the range (0, 0.5)' });
    }
  }

  // Rule 5d: FARM_MIN_CONFIDENCE must be in (0, 1]
  if ('FARM_MIN_CONFIDENCE' in patch) {
    const v = patch.FARM_MIN_CONFIDENCE;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v > 1) {
      errors.push({ field: 'FARM_MIN_CONFIDENCE', message: 'Must be a number in the range (0, 1]' });
    }
  }

  // Rule 5e: FARM_EARLY_EXIT_SECS must be positive integer
  if ('FARM_EARLY_EXIT_SECS' in patch) {
    if (!isPositive(patch.FARM_EARLY_EXIT_SECS)) {
      errors.push({ field: 'FARM_EARLY_EXIT_SECS', message: 'Must be a positive number' });
    }
  }

  // Rule 5f: FARM_EARLY_EXIT_PNL must be positive
  if ('FARM_EARLY_EXIT_PNL' in patch) {
    if (!isPositive(patch.FARM_EARLY_EXIT_PNL)) {
      errors.push({ field: 'FARM_EARLY_EXIT_PNL', message: 'Must be a positive number' });
    }
  }

  // Rule 5g: FARM_EXTRA_WAIT_SECS must be non-negative
  if ('FARM_EXTRA_WAIT_SECS' in patch) {
    const v = patch.FARM_EXTRA_WAIT_SECS;
    if (typeof v !== 'number' || !isFinite(v) || v < 0) {
      errors.push({ field: 'FARM_EXTRA_WAIT_SECS', message: 'Must be a non-negative number' });
    }
  }

  // Rule 5h: FARM_BLOCKED_HOURS must be array of integers in [0, 23]
  if ('FARM_BLOCKED_HOURS' in patch) {
    const v = patch.FARM_BLOCKED_HOURS;
    if (!Array.isArray(v)) {
      errors.push({ field: 'FARM_BLOCKED_HOURS', message: 'Must be an array of UTC hours [0–23]' });
    } else {
      const invalid = v.filter(h => typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 23);
      if (invalid.length > 0) {
        errors.push({ field: 'FARM_BLOCKED_HOURS', message: `Invalid hours: ${invalid.join(', ')}. Must be integers in [0, 23]` });
      }
    }
  }

  // Rule 6: COOLDOWN_MIN_MINS must be less than effective COOLDOWN_MAX_MINS
  // Rule 7: COOLDOWN_MIN_MINS and COOLDOWN_MAX_MINS must be non-negative integers
  if ('COOLDOWN_MIN_MINS' in patch) {
    if (!isNonNegativeInteger(patch.COOLDOWN_MIN_MINS)) {
      errors.push({ field: 'COOLDOWN_MIN_MINS', message: 'Must be a non-negative integer' });
    }
  }
  if ('COOLDOWN_MAX_MINS' in patch) {
    if (!isNonNegativeInteger(patch.COOLDOWN_MAX_MINS)) {
      errors.push({ field: 'COOLDOWN_MAX_MINS', message: 'Must be a non-negative integer' });
    }
  }

  if ('COOLDOWN_MIN_MINS' in patch || 'COOLDOWN_MAX_MINS' in patch) {
    const coolMin =
      'COOLDOWN_MIN_MINS' in patch ? patch.COOLDOWN_MIN_MINS! : effective.COOLDOWN_MIN_MINS;
    const coolMax =
      'COOLDOWN_MAX_MINS' in patch ? patch.COOLDOWN_MAX_MINS! : effective.COOLDOWN_MAX_MINS;

    // Only do cross-field check if both values are valid integers
    if (isNonNegativeInteger(coolMin) && isNonNegativeInteger(coolMax) && coolMin >= coolMax) {
      const errorField = 'COOLDOWN_MIN_MINS' in patch ? 'COOLDOWN_MIN_MINS' : 'COOLDOWN_MAX_MINS';
      errors.push({
        field: errorField,
        message: `COOLDOWN_MIN_MINS must be less than COOLDOWN_MAX_MINS (effective: min=${coolMin}, max=${coolMax})`,
      });
    }
  }

  // Rule 8: SIZING_CONF_WEIGHT must be in (0, 1)
  if ('SIZING_CONF_WEIGHT' in patch) {
    const v = patch.SIZING_CONF_WEIGHT;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= 1) {
      errors.push({ field: 'SIZING_CONF_WEIGHT', message: 'Must be a number in the range (0, 1)' });
    }
  }

  // Rule 9: SIZING_PERF_WEIGHT must be in (0, 1)
  if ('SIZING_PERF_WEIGHT' in patch) {
    const v = patch.SIZING_PERF_WEIGHT;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= 1) {
      errors.push({ field: 'SIZING_PERF_WEIGHT', message: 'Must be a number in the range (0, 1)' });
    }
  }

  // Rule 10: SIZING_CONF_WEIGHT + SIZING_PERF_WEIGHT must equal 1.0 (cross-field, using effective values)
  if ('SIZING_CONF_WEIGHT' in patch || 'SIZING_PERF_WEIGHT' in patch) {
    const confWeight =
      'SIZING_CONF_WEIGHT' in patch &&
      typeof patch.SIZING_CONF_WEIGHT === 'number' &&
      isFinite(patch.SIZING_CONF_WEIGHT) &&
      patch.SIZING_CONF_WEIGHT > 0 &&
      patch.SIZING_CONF_WEIGHT < 1
        ? patch.SIZING_CONF_WEIGHT!
        : effective.SIZING_CONF_WEIGHT;
    const perfWeight =
      'SIZING_PERF_WEIGHT' in patch &&
      typeof patch.SIZING_PERF_WEIGHT === 'number' &&
      isFinite(patch.SIZING_PERF_WEIGHT) &&
      patch.SIZING_PERF_WEIGHT > 0 &&
      patch.SIZING_PERF_WEIGHT < 1
        ? patch.SIZING_PERF_WEIGHT!
        : effective.SIZING_PERF_WEIGHT;

    if (Math.abs(confWeight + perfWeight - 1.0) > 1e-9) {
      const errorField = 'SIZING_CONF_WEIGHT' in patch ? 'SIZING_CONF_WEIGHT' : 'SIZING_PERF_WEIGHT';
      errors.push({
        field: errorField,
        message: 'SIZING_CONF_WEIGHT + SIZING_PERF_WEIGHT must equal 1.0',
      });
    }
  }

  // Rule 11: SIZING_MAX_BTC must be a positive number and >= ORDER_SIZE_MIN (cross-field)
  if ('SIZING_MAX_BTC' in patch) {
    if (!isPositive(patch.SIZING_MAX_BTC)) {
      errors.push({ field: 'SIZING_MAX_BTC', message: 'Must be a positive number' });
    } else {
      const effectiveOrderSizeMin =
        'ORDER_SIZE_MIN' in patch && isPositive(patch.ORDER_SIZE_MIN)
          ? patch.ORDER_SIZE_MIN!
          : effective.ORDER_SIZE_MIN;
      if (patch.SIZING_MAX_BTC! < effectiveOrderSizeMin) {
        errors.push({
          field: 'SIZING_MAX_BTC',
          message: `SIZING_MAX_BTC must be >= ORDER_SIZE_MIN (${effectiveOrderSizeMin})`,
        });
      }
    }
  }

  // Rule 12: SIZING_MIN_MULTIPLIER must be positive and less than effective SIZING_MAX_MULTIPLIER
  if ('SIZING_MIN_MULTIPLIER' in patch) {
    if (!isPositive(patch.SIZING_MIN_MULTIPLIER)) {
      errors.push({ field: 'SIZING_MIN_MULTIPLIER', message: 'Must be a positive number' });
    } else {
      const effectiveMaxMult =
        'SIZING_MAX_MULTIPLIER' in patch && isPositive(patch.SIZING_MAX_MULTIPLIER)
          ? patch.SIZING_MAX_MULTIPLIER!
          : effective.SIZING_MAX_MULTIPLIER;
      if (patch.SIZING_MIN_MULTIPLIER! >= effectiveMaxMult) {
        errors.push({
          field: 'SIZING_MIN_MULTIPLIER',
          message: `Must be less than SIZING_MAX_MULTIPLIER (${effectiveMaxMult})`,
        });
      }
    }
  }

  // Rule 13: SIZING_MAX_MULTIPLIER must be positive and greater than effective SIZING_MIN_MULTIPLIER
  if ('SIZING_MAX_MULTIPLIER' in patch) {
    if (!isPositive(patch.SIZING_MAX_MULTIPLIER)) {
      errors.push({ field: 'SIZING_MAX_MULTIPLIER', message: 'Must be a positive number' });
    } else {
      const effectiveMinMult =
        'SIZING_MIN_MULTIPLIER' in patch && isPositive(patch.SIZING_MIN_MULTIPLIER)
          ? patch.SIZING_MIN_MULTIPLIER!
          : effective.SIZING_MIN_MULTIPLIER;
      if (effectiveMinMult >= patch.SIZING_MAX_MULTIPLIER!) {
        errors.push({
          field: 'SIZING_MAX_MULTIPLIER',
          message: `Must be greater than SIZING_MIN_MULTIPLIER (${effectiveMinMult})`,
        });
      }
    }
  }

  // Rule 14: SIZING_DRAWDOWN_THRESHOLD must be a finite negative number
  if ('SIZING_DRAWDOWN_THRESHOLD' in patch) {
    const v = patch.SIZING_DRAWDOWN_THRESHOLD;
    if (typeof v !== 'number' || !isFinite(v) || v >= 0) {
      errors.push({ field: 'SIZING_DRAWDOWN_THRESHOLD', message: 'Must be a finite negative number' });
    }
  }

  // Rule 15: SIZING_DRAWDOWN_FLOOR must be in (0, 1)
  if ('SIZING_DRAWDOWN_FLOOR' in patch) {
    const v = patch.SIZING_DRAWDOWN_FLOOR;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= 1) {
      errors.push({ field: 'SIZING_DRAWDOWN_FLOOR', message: 'Must be a number in the range (0, 1)' });
    }
  }

  // Rule 16: SIZING_MAX_BALANCE_PCT must be in (0, 1)
  if ('SIZING_MAX_BALANCE_PCT' in patch) {
    const v = patch.SIZING_MAX_BALANCE_PCT;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= 1) {
      errors.push({ field: 'SIZING_MAX_BALANCE_PCT', message: 'Must be a number in the range (0, 1)' });
    }
  }

  // Rule 17: REGIME_HIGH_VOL_SIZE_FACTOR must be in (0, 1]
  if ('REGIME_HIGH_VOL_SIZE_FACTOR' in patch) {
    const v = patch.REGIME_HIGH_VOL_SIZE_FACTOR;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v > 1) {
      errors.push({ field: 'REGIME_HIGH_VOL_SIZE_FACTOR', message: 'Must be a number in the range (0, 1]' });
    }
  }

  // Rule 18: REGIME_SIDEWAY_SIZE_FACTOR must be in (0, 1]
  if ('REGIME_SIDEWAY_SIZE_FACTOR' in patch) {
    const v = patch.REGIME_SIDEWAY_SIZE_FACTOR;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v > 1) {
      errors.push({ field: 'REGIME_SIDEWAY_SIZE_FACTOR', message: 'Must be a number in the range (0, 1]' });
    }
  }

  // Rule 19: REGIME_HIGH_VOL_SL_MULT must be >= 1.0
  if ('REGIME_HIGH_VOL_SL_MULT' in patch) {
    const v = patch.REGIME_HIGH_VOL_SL_MULT;
    if (typeof v !== 'number' || !isFinite(v) || v < 1) {
      errors.push({ field: 'REGIME_HIGH_VOL_SL_MULT', message: 'Must be >= 1.0' });
    }
  }

  // Rule 20: REGIME_HIGH_VOL_THRESHOLD must be > 0
  if ('REGIME_HIGH_VOL_THRESHOLD' in patch) {
    if (!isPositive(patch.REGIME_HIGH_VOL_THRESHOLD)) {
      errors.push({ field: 'REGIME_HIGH_VOL_THRESHOLD', message: 'Must be a positive number' });
    }
  }

  // Rule 21: Hold multipliers must be > 0
  for (const field of ['REGIME_TREND_HOLD_MULT', 'REGIME_SIDEWAY_HOLD_MULT', 'REGIME_HIGH_VOL_HOLD_MULT'] as const) {
    if (field in patch) {
      if (!isPositive(patch[field])) {
        errors.push({ field, message: 'Must be a positive number' });
      }
    }
  }

  // Rule 22: Period/lookback fields must be positive integers (>= 1)
  for (const field of ['REGIME_ATR_PERIOD', 'REGIME_BB_PERIOD', 'REGIME_VOL_LOOKBACK'] as const) {
    if (field in patch) {
      const v = patch[field];
      if (typeof v !== 'number' || !isFinite(v) || !Number.isInteger(v) || v < 1) {
        errors.push({ field, message: 'Must be a positive integer (>= 1)' });
      }
    }
  }

  // Rule 23: CHOP_FLIP_WINDOW must be a positive integer (>= 1)
  if ('CHOP_FLIP_WINDOW' in patch) {
    const v = patch.CHOP_FLIP_WINDOW;
    if (typeof v !== 'number' || !isFinite(v) || !Number.isInteger(v) || v < 1) {
      errors.push({ field: 'CHOP_FLIP_WINDOW', message: 'Must be a positive integer (>= 1)' });
    }
  }

  // Rule 24: CHOP_FLIP_WEIGHT, CHOP_MOM_WEIGHT, CHOP_BB_WEIGHT must each be in (0, 1)
  for (const field of ['CHOP_FLIP_WEIGHT', 'CHOP_MOM_WEIGHT', 'CHOP_BB_WEIGHT'] as const) {
    if (field in patch) {
      const v = patch[field];
      if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= 1) {
        errors.push({ field, message: 'Must be a number in the range (0, 1)' });
      }
    }
  }

  // Rule 25: CHOP_FLIP_WEIGHT + CHOP_MOM_WEIGHT + CHOP_BB_WEIGHT must equal 1.0 (cross-field, using effective values)
  if ('CHOP_FLIP_WEIGHT' in patch || 'CHOP_MOM_WEIGHT' in patch || 'CHOP_BB_WEIGHT' in patch) {
    const flipWeight =
      'CHOP_FLIP_WEIGHT' in patch &&
      typeof patch.CHOP_FLIP_WEIGHT === 'number' &&
      isFinite(patch.CHOP_FLIP_WEIGHT) &&
      patch.CHOP_FLIP_WEIGHT > 0 &&
      patch.CHOP_FLIP_WEIGHT < 1
        ? patch.CHOP_FLIP_WEIGHT!
        : effective.CHOP_FLIP_WEIGHT;
    const momWeight =
      'CHOP_MOM_WEIGHT' in patch &&
      typeof patch.CHOP_MOM_WEIGHT === 'number' &&
      isFinite(patch.CHOP_MOM_WEIGHT) &&
      patch.CHOP_MOM_WEIGHT > 0 &&
      patch.CHOP_MOM_WEIGHT < 1
        ? patch.CHOP_MOM_WEIGHT!
        : effective.CHOP_MOM_WEIGHT;
    const bbWeight =
      'CHOP_BB_WEIGHT' in patch &&
      typeof patch.CHOP_BB_WEIGHT === 'number' &&
      isFinite(patch.CHOP_BB_WEIGHT) &&
      patch.CHOP_BB_WEIGHT > 0 &&
      patch.CHOP_BB_WEIGHT < 1
        ? patch.CHOP_BB_WEIGHT!
        : effective.CHOP_BB_WEIGHT;

    if (Math.abs(flipWeight + momWeight + bbWeight - 1.0) > 1e-9) {
      const errorField =
        'CHOP_FLIP_WEIGHT' in patch
          ? 'CHOP_FLIP_WEIGHT'
          : 'CHOP_MOM_WEIGHT' in patch
          ? 'CHOP_MOM_WEIGHT'
          : 'CHOP_BB_WEIGHT';
      errors.push({
        field: errorField,
        message: 'CHOP_FLIP_WEIGHT + CHOP_MOM_WEIGHT + CHOP_BB_WEIGHT must equal 1.0',
      });
    }
  }

  // Rule 26: CHOP_BB_COMPRESS_MAX must be a positive number
  if ('CHOP_BB_COMPRESS_MAX' in patch) {
    if (!isPositive(patch.CHOP_BB_COMPRESS_MAX)) {
      errors.push({ field: 'CHOP_BB_COMPRESS_MAX', message: 'Must be a positive number' });
    }
  }

  // Rule 27: CHOP_SCORE_THRESHOLD must be in (0, 1) exclusive
  if ('CHOP_SCORE_THRESHOLD' in patch) {
    const v = patch.CHOP_SCORE_THRESHOLD;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= 1) {
      errors.push({ field: 'CHOP_SCORE_THRESHOLD', message: 'Must be a number in the range (0, 1)' });
    }
  }

  // Rule 28: CHOP_BREAKOUT_SCORE_EDGE must be in (0, 0.5) exclusive
  if ('CHOP_BREAKOUT_SCORE_EDGE' in patch) {
    const v = patch.CHOP_BREAKOUT_SCORE_EDGE;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= 0.5) {
      errors.push({ field: 'CHOP_BREAKOUT_SCORE_EDGE', message: 'Must be a number in the range (0, 0.5)' });
    }
  }

  // Rule 29: CHOP_BREAKOUT_VOL_MIN must be in (0, 1] (exclusive 0, inclusive 1)
  if ('CHOP_BREAKOUT_VOL_MIN' in patch) {
    const v = patch.CHOP_BREAKOUT_VOL_MIN;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v > 1) {
      errors.push({ field: 'CHOP_BREAKOUT_VOL_MIN', message: 'Must be a number in the range (0, 1]' });
    }
  }

  // Rule 30: CHOP_BREAKOUT_IMBALANCE_THRESHOLD must be in (0, 1) exclusive
  if ('CHOP_BREAKOUT_IMBALANCE_THRESHOLD' in patch) {
    const v = patch.CHOP_BREAKOUT_IMBALANCE_THRESHOLD;
    if (typeof v !== 'number' || !isFinite(v) || v <= 0 || v >= 1) {
      errors.push({ field: 'CHOP_BREAKOUT_IMBALANCE_THRESHOLD', message: 'Must be a number in the range (0, 1)' });
    }
  }

  // Rule 31: CHOP_COOLDOWN_STREAK_FACTOR and CHOP_COOLDOWN_CHOP_FACTOR must be positive numbers (> 0)
  for (const field of ['CHOP_COOLDOWN_STREAK_FACTOR', 'CHOP_COOLDOWN_CHOP_FACTOR'] as const) {
    if (field in patch) {
      if (!isPositive(patch[field])) {
        errors.push({ field, message: 'Must be a positive number' });
      }
    }
  }

  // Rule 32: CHOP_COOLDOWN_MAX_MINS must be a positive integer and >= effective COOLDOWN_MAX_MINS
  if ('CHOP_COOLDOWN_MAX_MINS' in patch) {
    const v = patch.CHOP_COOLDOWN_MAX_MINS;
    if (typeof v !== 'number' || !isFinite(v) || !Number.isInteger(v) || v < 1) {
      errors.push({ field: 'CHOP_COOLDOWN_MAX_MINS', message: 'Must be a positive integer (>= 1)' });
    } else {
      const effectiveCooldownMax =
        'COOLDOWN_MAX_MINS' in patch && isNonNegativeInteger(patch.COOLDOWN_MAX_MINS)
          ? patch.COOLDOWN_MAX_MINS!
          : effective.COOLDOWN_MAX_MINS;
      if (v < effectiveCooldownMax) {
        errors.push({
          field: 'CHOP_COOLDOWN_MAX_MINS',
          message: `Must be >= effective COOLDOWN_MAX_MINS (${effectiveCooldownMax})`,
        });
      }
    }
  }

  // Rule 33: EXEC_OFFSET_MAX >= EXEC_OFFSET_MIN (cross-field)
  if ('EXEC_OFFSET_MIN' in patch || 'EXEC_OFFSET_MAX' in patch) {
    const offsetMin =
      'EXEC_OFFSET_MIN' in patch && typeof patch.EXEC_OFFSET_MIN === 'number'
        ? patch.EXEC_OFFSET_MIN!
        : (effective.EXEC_OFFSET_MIN ?? 0);
    const offsetMax =
      'EXEC_OFFSET_MAX' in patch && typeof patch.EXEC_OFFSET_MAX === 'number'
        ? patch.EXEC_OFFSET_MAX!
        : (effective.EXEC_OFFSET_MAX ?? 0);

    if (offsetMax < offsetMin) {
      const errorField = 'EXEC_OFFSET_MAX' in patch ? 'EXEC_OFFSET_MAX' : 'EXEC_OFFSET_MIN';
      errors.push({
        field: errorField,
        message: 'EXEC_OFFSET_MAX must be >= EXEC_OFFSET_MIN',
      });
    }
  }

  // Rule 34: EXEC_FILL_RATE_THRESHOLD must be in [0, 1]
  if ('EXEC_FILL_RATE_THRESHOLD' in patch) {
    const v = patch.EXEC_FILL_RATE_THRESHOLD;
    if (typeof v !== 'number' || !isFinite(v) || v < 0 || v > 1) {
      errors.push({ field: 'EXEC_FILL_RATE_THRESHOLD', message: 'EXEC_FILL_RATE_THRESHOLD must be between 0 and 1' });
    }
  }

  // Rule 35: EXEC_DEPTH_LEVELS must be a positive integer (>= 1)
  if ('EXEC_DEPTH_LEVELS' in patch) {
    const v = patch.EXEC_DEPTH_LEVELS;
    if (typeof v !== 'number' || !isFinite(v) || !Number.isInteger(v) || v < 1) {
      errors.push({ field: 'EXEC_DEPTH_LEVELS', message: 'EXEC_DEPTH_LEVELS must be >= 1' });
    }
  }

  // Rule 36: MM_SPREAD_MULT must be > 0
  if ('MM_SPREAD_MULT' in patch) {
    if (!isPositive(patch.MM_SPREAD_MULT)) {
      errors.push({ field: 'MM_SPREAD_MULT', message: 'Must be a positive number' });
    }
  }

  // Rule 37: MM_MIN_FEE_MULT must be >= 1.0
  if ('MM_MIN_FEE_MULT' in patch) {
    const v = patch.MM_MIN_FEE_MULT;
    if (typeof v !== 'number' || !isFinite(v) || v < 1) {
      errors.push({ field: 'MM_MIN_FEE_MULT', message: 'Must be >= 1.0' });
    }
  }

  // Rule 38: MM_TP_MAX_USD must be > 0
  if ('MM_TP_MAX_USD' in patch) {
    if (!isPositive(patch.MM_TP_MAX_USD)) {
      errors.push({ field: 'MM_TP_MAX_USD', message: 'Must be a positive number' });
    }
  }

  // Rule 39: MM_PINGPONG_BIAS_STRENGTH must be >= 0
  if ('MM_PINGPONG_BIAS_STRENGTH' in patch) {
    const v = patch.MM_PINGPONG_BIAS_STRENGTH;
    if (typeof v !== 'number' || !isFinite(v) || v < 0) {
      errors.push({ field: 'MM_PINGPONG_BIAS_STRENGTH', message: 'Must be >= 0' });
    }
  }

  // Rule 40: MM_INVENTORY_BIAS_STRENGTH must be >= 0
  if ('MM_INVENTORY_BIAS_STRENGTH' in patch) {
    const v = patch.MM_INVENTORY_BIAS_STRENGTH;
    if (typeof v !== 'number' || !isFinite(v) || v < 0) {
      errors.push({ field: 'MM_INVENTORY_BIAS_STRENGTH', message: 'Must be >= 0' });
    }
  }

  // Rule 41: MM_INVENTORY_HARD_BLOCK must be > MM_INVENTORY_SOFT_BIAS (cross-field)
  if ('MM_INVENTORY_HARD_BLOCK' in patch || 'MM_INVENTORY_SOFT_BIAS' in patch) {
    const hardBlock =
      'MM_INVENTORY_HARD_BLOCK' in patch && typeof patch.MM_INVENTORY_HARD_BLOCK === 'number'
        ? patch.MM_INVENTORY_HARD_BLOCK!
        : effective.MM_INVENTORY_HARD_BLOCK;
    const softBias =
      'MM_INVENTORY_SOFT_BIAS' in patch && typeof patch.MM_INVENTORY_SOFT_BIAS === 'number'
        ? patch.MM_INVENTORY_SOFT_BIAS!
        : effective.MM_INVENTORY_SOFT_BIAS;

    if (typeof hardBlock === 'number' && typeof softBias === 'number' && hardBlock <= softBias) {
      const errorField = 'MM_INVENTORY_HARD_BLOCK' in patch ? 'MM_INVENTORY_HARD_BLOCK' : 'MM_INVENTORY_SOFT_BIAS';
      errors.push({
        field: errorField,
        message: `MM_INVENTORY_HARD_BLOCK must be > MM_INVENTORY_SOFT_BIAS (effective: hard=${hardBlock}, soft=${softBias})`,
      });
    }
  }

  return errors;
}
