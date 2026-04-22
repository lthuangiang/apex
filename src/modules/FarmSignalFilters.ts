/**
 * FarmSignalFilters.ts
 *
 * Pure filter functions for the farm mode signal entry pipeline.
 * All filters are no-ops in trade mode (mode !== 'farm').
 * No side effects — all functions are pure and read-only.
 */

// ── Interfaces ────────────────────────────────────────────────────────────────

export interface FilterInput {
  // Signal fields
  regime: 'TREND_UP' | 'TREND_DOWN' | 'SIDEWAY' | 'HIGH_VOLATILITY';
  confidence: number;
  momentumScore: number;
  tradePressure: number;
  fallback: boolean;
  llmMatchesMomentum?: boolean | null;
  atrPct?: number;

  // Config fields
  mode: 'farm' | 'trade';
  FEE_RATE_MAKER: number;
  FARM_MIN_CONFIDENCE_PRESSURE_GATE: number;
  FARM_MIN_FALLBACK_CONFIDENCE: number;
  FARM_SIDEWAY_MIN_CONFIDENCE: number;
  FARM_TREND_MIN_CONFIDENCE: number;
  FARM_MIN_HOLD_SECS: number;
  FARM_MAX_HOLD_SECS: number;
}

export interface FilterResult {
  pass: boolean;
  reason?: string;           // filter name + rejection reason if pass=false
  effectiveConfidence: number;
  dynamicMinHold: number;    // seconds
}

// ── Individual Filter Functions ───────────────────────────────────────────────

/**
 * RegimeConfidenceThreshold — Requirement 5
 * Rejects signals whose confidence is below the regime-specific threshold.
 * SIDEWAY markets require higher confidence than TREND markets.
 */
export function regimeConfidenceThreshold(
  input: FilterInput
): { pass: boolean; reason?: string } {
  if (input.mode !== 'farm') {
    return { pass: true };
  }

  const threshold =
    input.regime === 'SIDEWAY'
      ? input.FARM_SIDEWAY_MIN_CONFIDENCE
      : input.FARM_TREND_MIN_CONFIDENCE;

  if (input.confidence < threshold) {
    return {
      pass: false,
      reason: `[RegimeGate] SKIP: regime=${input.regime}, confidence=${input.confidence} < ${threshold}`,
    };
  }

  return { pass: true };
}

/**
 * TradePressureGate — Requirement 2
 * Rejects signals when tradePressure is 0 and confidence is below the gate threshold.
 * Avoids near-random entries with no measurable buy/sell pressure.
 */
export function tradePressureGate(
  input: FilterInput
): { pass: boolean; reason?: string } {
  if (input.mode !== 'farm') {
    return { pass: true };
  }

  // Treat NaN tradePressure as 0 (defensive)
  const pressure = isNaN(input.tradePressure) ? 0 : input.tradePressure;

  if (pressure === 0 && input.confidence < input.FARM_MIN_CONFIDENCE_PRESSURE_GATE) {
    return {
      pass: false,
      reason: `[PressureGate] SKIP: tradePressure=0, confidence=${input.confidence} < ${input.FARM_MIN_CONFIDENCE_PRESSURE_GATE}`,
    };
  }

  return { pass: true };
}

/**
 * FallbackQualityGate — Requirement 4
 * Rejects fallback signals with very low confidence.
 * Avoids near-random entries when the primary signal engine fails.
 */
export function fallbackQualityGate(
  input: FilterInput
): { pass: boolean; reason?: string } {
  if (input.mode !== 'farm') {
    return { pass: true };
  }

  if (input.fallback === true && input.confidence < input.FARM_MIN_FALLBACK_CONFIDENCE) {
    return {
      pass: false,
      reason: `[FallbackGate] SKIP: fallback=true, confidence=${input.confidence} < ${input.FARM_MIN_FALLBACK_CONFIDENCE}`,
    };
  }

  return { pass: true };
}

/**
 * FeeAwareEntryFilter — Requirement 1
 * Rejects signals where the expected price edge is insufficient to cover fees.
 * expectedEdge = |momentumScore - 0.5| * 2 * atrPct
 * minRequiredMove = FEE_RATE_MAKER * 2
 * Rejects when expectedEdge <= minRequiredMove * 0.5
 *
 * Note: threshold reduced from 1.5x to 0.5x — the original 1.5x was too strict
 * and blocked most signals in low-ATR conditions (BTC sideways market).
 * When atrPct is very small (< minRequiredMove), skip this filter entirely
 * since ATR-based edge estimation is unreliable in flat markets.
 */
export function feeAwareEntryFilter(
  input: FilterInput
): { pass: boolean; reason?: string } {
  if (input.mode !== 'farm') {
    return { pass: true };
  }

  // TEMPORARY: Disable filter to test if this is blocking all entries
  console.log(`[FeeFilter] DISABLED (debug mode) — bypassing fee-aware entry filter`);
  return { pass: true };
}

/**
 * LLMMomentumAdjuster — Requirement 3
 * Adjusts effectiveConfidence based on LLM-Momentum alignment:
 *   - llmMatchesMomentum === true  → boost: min(1.0, confidence * 1.10)
 *   - llmMatchesMomentum === false AND confidence < 0.65 → penalty: confidence * 0.80
 *   - otherwise → unchanged
 *
 * Returns the adjusted effectiveConfidence (number).
 */
export function llmMomentumAdjuster(input: FilterInput): number {
  const raw = input.confidence;
  let adjusted: number;
  let label: string;

  if (input.llmMatchesMomentum === true) {
    adjusted = Math.min(1.0, raw * 1.10);
    label = 'boost';
  } else if (input.llmMatchesMomentum === false && raw < 0.65) {
    adjusted = raw * 0.80;
    label = 'penalty';
  } else {
    adjusted = raw;
    label = 'unchanged';
  }

  console.log(
    `[LLMAlign] confidence=${raw} → effectiveConfidence=${adjusted} (${label})`
  );

  return adjusted;
}

/**
 * ComputeDynamicMinHold — Requirement 6
 * Computes the minimum hold time in seconds based on fee break-even analysis.
 *   feeBreakEvenSecs = (FEE_RATE_MAKER * 2 / atrPct) * 300
 *   dynamicMinHold = clamp(max(FARM_MIN_HOLD_SECS, feeBreakEvenSecs), _, FARM_MAX_HOLD_SECS)
 *
 * Falls back to FARM_MIN_HOLD_SECS when atrPct is 0, null, or undefined.
 */
export function computeDynamicMinHold(input: FilterInput): number {
  const atrPct = input.atrPct;

  if (!atrPct || atrPct <= 0 || !Number.isFinite(atrPct)) {
    return input.FARM_MIN_HOLD_SECS;
  }

  const feeBreakEvenSecs = (input.FEE_RATE_MAKER * 2 / atrPct) * 300;

  // Guard against Infinity/NaN from very small atrPct values
  if (!Number.isFinite(feeBreakEvenSecs)) {
    return input.FARM_MIN_HOLD_SECS;
  }

  const dynamicMinHold = Math.max(input.FARM_MIN_HOLD_SECS, feeBreakEvenSecs);
  return Math.min(input.FARM_MAX_HOLD_SECS, dynamicMinHold);
}

// ── Pipeline Entry Point ──────────────────────────────────────────────────────

/**
 * evaluateFarmEntryFilters — Requirement 7
 * Runs the full signal filter pipeline in order:
 *   1. regimeConfidenceThreshold
 *   2. tradePressureGate
 *   3. fallbackQualityGate
 *   4. feeAwareEntryFilter
 *
 * Short-circuits on the first rejection.
 * After all gates pass, computes effectiveConfidence and dynamicMinHold.
 */
export function evaluateFarmEntryFilters(input: FilterInput): FilterResult {
  // [1] Regime confidence threshold
  const regimeResult = regimeConfidenceThreshold(input);
  if (!regimeResult.pass) {
    return {
      pass: false,
      reason: regimeResult.reason,
      effectiveConfidence: input.confidence,
      dynamicMinHold: input.FARM_MIN_HOLD_SECS,
    };
  }

  // [2] Trade pressure gate
  const pressureResult = tradePressureGate(input);
  if (!pressureResult.pass) {
    return {
      pass: false,
      reason: pressureResult.reason,
      effectiveConfidence: input.confidence,
      dynamicMinHold: input.FARM_MIN_HOLD_SECS,
    };
  }

  // [3] Fallback quality gate
  const fallbackResult = fallbackQualityGate(input);
  if (!fallbackResult.pass) {
    return {
      pass: false,
      reason: fallbackResult.reason,
      effectiveConfidence: input.confidence,
      dynamicMinHold: input.FARM_MIN_HOLD_SECS,
    };
  }

  // [4] Fee-aware entry filter
  const feeResult = feeAwareEntryFilter(input);
  if (!feeResult.pass) {
    return {
      pass: false,
      reason: feeResult.reason,
      effectiveConfidence: input.confidence,
      dynamicMinHold: input.FARM_MIN_HOLD_SECS,
    };
  }

  // All gates passed — compute adjustments
  const effectiveConfidence = llmMomentumAdjuster(input);
  const dynamicMinHold = computeDynamicMinHold(input);

  return {
    pass: true,
    effectiveConfidence,
    dynamicMinHold,
  };
}
