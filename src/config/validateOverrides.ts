import type { OverridableConfig, PartialOverride } from './ConfigStore';

export interface ValidationError {
  field: string;
  message: string;
}

const PERCENT_FIELDS: (keyof OverridableConfig)[] = [
  'STOP_LOSS_PERCENT',
  'TAKE_PROFIT_PERCENT',
  'POSITION_SL_PERCENT',
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

  return errors;
}
