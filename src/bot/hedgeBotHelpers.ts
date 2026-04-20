import type { HedgeTradeRecord } from './HedgeBotSharedState.js';

// ---------------------------------------------------------------------------
// Exit condition types
// ---------------------------------------------------------------------------

export type ExitReason = 'PROFIT_TARGET' | 'MAX_LOSS' | 'MEAN_REVERSION' | 'TIME_EXPIRY';

export interface ExitConditionInput {
  combinedPnl: number;
  profitTargetUsd: number;
  maxLossUsd: number;
  elapsedSecs: number;
  holdingPeriodSecs: number;
  currentRatio: number;
  equilibriumSpread: number;
}

// ---------------------------------------------------------------------------
// CompletedTrade — input to buildHedgeTradeRecord
// ---------------------------------------------------------------------------

export interface CompletedTrade {
  id: string;
  botId: string;
  exchange: string;
  symbolA: string;
  symbolB: string;
  legValueUsd: number;
  entryPriceA: number;
  entryPriceB: number;
  exitPriceA: number;
  exitPriceB: number;
  sizeA: number;
  sizeB: number;
  pnlA: number;
  pnlB: number;
  exitReason: ExitReason;
  entryTimestamp: string;
  exitTimestamp: string;
  signalScoreA: number;
  signalScoreB: number;
  longSymbol: string;
  shortSymbol: string;
}

// ---------------------------------------------------------------------------
// Task 5.1 — assignDirections
// Requirements: 4.2, 4.3, 4.4
// ---------------------------------------------------------------------------

/**
 * Determines which symbol should be the long leg and which the short leg,
 * based on AI signal scores optionally adjusted by funding rates.
 *
 * Returns `{ longSymbol, shortSymbol }` where the higher adjusted score gets
 * the long leg, or `null` when:
 *   - both scores are equal within 0.001 tolerance, or
 *   - both symbols are "skip" (score === 0 and treated as skip sentinel)
 */
export function assignDirections(
  symbolA: string,
  scoreA: number,
  symbolB: string,
  scoreB: number,
  fundingRateA?: number,
  fundingRateB?: number,
  fundingRateWeight?: number,
): { longSymbol: string; shortSymbol: string } | null {
  // Apply funding rate adjustment when weight is provided and > 0
  const weight = fundingRateWeight ?? 0;
  const adjustedA = scoreA + (fundingRateA ?? 0) * weight;
  const adjustedB = scoreB + (fundingRateB ?? 0) * weight;

  // Requirement 4.4: skip when both signals are "skip" (score === 0 sentinel)
  // The caller passes score=0 for "skip" direction signals; we treat both-zero as skip.
  // More precisely: if both raw scores are exactly 0 we treat it as both-skip.
  if (scoreA === 0 && scoreB === 0) {
    return null;
  }

  // Requirement 4.4: skip when scores are equal within 0.001
  if (Math.abs(adjustedA - adjustedB) <= 0.001) {
    return null;
  }

  // Requirement 4.2 / 4.3: higher adjusted score → LongLeg
  if (adjustedA > adjustedB) {
    return { longSymbol: symbolA, shortSymbol: symbolB };
  } else {
    return { longSymbol: symbolB, shortSymbol: symbolA };
  }
}

// ---------------------------------------------------------------------------
// Task 5.2 — evaluateExitConditions
// Requirements: 6.2, 6.3, 6.4, 6.5, 6.6
// ---------------------------------------------------------------------------

/**
 * Evaluates all exit conditions in priority order and returns the first
 * matching condition.
 *
 * Priority: MAX_LOSS → PROFIT_TARGET → MEAN_REVERSION → TIME_EXPIRY
 *
 * Mean reversion fires when:
 *   |currentRatio - equilibriumSpread| / equilibriumSpread < 0.005
 */
export function evaluateExitConditions(
  input: ExitConditionInput,
): { shouldExit: boolean; reason: ExitReason | null } {
  const {
    combinedPnl,
    profitTargetUsd,
    maxLossUsd,
    elapsedSecs,
    holdingPeriodSecs,
    currentRatio,
    equilibriumSpread,
  } = input;

  // Priority 1 — MAX_LOSS (Requirement 6.4)
  if (combinedPnl <= -maxLossUsd) {
    return { shouldExit: true, reason: 'MAX_LOSS' };
  }

  // Priority 2 — PROFIT_TARGET (Requirement 6.3)
  if (combinedPnl >= profitTargetUsd) {
    return { shouldExit: true, reason: 'PROFIT_TARGET' };
  }

  // Priority 3 — MEAN_REVERSION (Requirement 6.5)
  // Guard against division by zero
  if (equilibriumSpread !== 0) {
    const deviation = Math.abs(currentRatio - equilibriumSpread) / equilibriumSpread;
    if (deviation < 0.005) {
      return { shouldExit: true, reason: 'MEAN_REVERSION' };
    }
  }

  // Priority 4 — TIME_EXPIRY (Requirement 6.2)
  if (elapsedSecs >= holdingPeriodSecs) {
    return { shouldExit: true, reason: 'TIME_EXPIRY' };
  }

  return { shouldExit: false, reason: null };
}

// ---------------------------------------------------------------------------
// Task 5.3 — computeCombinedPnl
// Requirements: 8.3, 8.4
// ---------------------------------------------------------------------------

/**
 * Returns the arithmetic sum of two leg PnL values.
 * Requirement 8.3: CombinedPnL = pnlA + pnlB
 */
export function computeCombinedPnl(pnlA: number, pnlB: number): number {
  return pnlA + pnlB;
}

// ---------------------------------------------------------------------------
// Task 5.3 — buildHedgeTradeRecord
// Requirements: 9.2
// ---------------------------------------------------------------------------

/**
 * Constructs a complete `HedgeTradeRecord` from a completed trade.
 * Computes `combinedPnl` and `holdDurationSecs` from the provided data.
 */
export function buildHedgeTradeRecord(trade: CompletedTrade): HedgeTradeRecord {
  const combinedPnl = computeCombinedPnl(trade.pnlA, trade.pnlB);

  const entryMs = new Date(trade.entryTimestamp).getTime();
  const exitMs = new Date(trade.exitTimestamp).getTime();
  const holdDurationSecs = Math.round((exitMs - entryMs) / 1000);

  return {
    id: trade.id,
    botId: trade.botId,
    timestamp: trade.exitTimestamp,
    exchange: trade.exchange,
    symbolA: trade.symbolA,
    symbolB: trade.symbolB,
    legValueUsd: trade.legValueUsd,
    entryPriceA: trade.entryPriceA,
    entryPriceB: trade.entryPriceB,
    exitPriceA: trade.exitPriceA,
    exitPriceB: trade.exitPriceB,
    sizeA: trade.sizeA,
    sizeB: trade.sizeB,
    pnlA: trade.pnlA,
    pnlB: trade.pnlB,
    combinedPnl,
    holdDurationSecs,
    exitReason: trade.exitReason,
    entryTimestamp: trade.entryTimestamp,
    exitTimestamp: trade.exitTimestamp,
    signalScoreA: trade.signalScoreA,
    signalScoreB: trade.signalScoreB,
    longSymbol: trade.longSymbol,
    shortSymbol: trade.shortSymbol,
  };
}

// ---------------------------------------------------------------------------
// Stubs for tasks 6.1 and 6.2 (filled in later)
// ---------------------------------------------------------------------------

/**
 * Computes the size of a single leg given its USD notional value and mark price.
 * Requirement 5.1: size = legValueUsd / markPrice
 */
export function computeLegSize(legValueUsd: number, markPrice: number): number {
  return legValueUsd / markPrice;
}

/**
 * Checks whether the two filled leg values are within the 1% imbalance tolerance.
 * Returns the deviation ratio. Logs a warning if deviation exceeds 0.01 (1%).
 * Requirements: 8.1, 8.2
 */
export function checkLegImbalance(
  legValueA: number,
  legValueB: number,
  legValueUsd: number,
): number {
  const deviation = Math.abs(legValueA - legValueB) / legValueUsd;
  if (deviation > 0.01) {
    console.warn(
      `[HedgeBot] Leg imbalance detected: legValueA=${legValueA}, legValueB=${legValueB}, ` +
        `deviation=${(deviation * 100).toFixed(4)}% (threshold: 1%). ` +
        `legValueUsd=${legValueUsd}`,
    );
  }
  return deviation;
}
