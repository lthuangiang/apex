/**
 * ReportingCollector — Central service that captures trade events,
 * balance snapshots, and volume counter increments.
 *
 * Called by Watcher/PairBot/DeltaNeutralBot after every position close.
 * Also provides balance snapshot capture for pre_open/post_close/daily triggers.
 *
 * Usage:
 *   import { reportingCollector } from '../db/ReportingCollector.js';
 *   reportingCollector.recordTrade({ ... });
 *   reportingCollector.captureBalance({ ... });
 */

import { randomUUID } from 'crypto';
import { insertTradeEvent, type TradeEvent } from './TradeEventRepository.js';
import { insertSnapshot, type BalanceSnapshot, type SnapshotTrigger } from './BalanceSnapshotRepository.js';
import { incrementVolume } from './VolumeCounterRepository.js';

// ─── Trade Event Recording ────────────────────────────────────────────────────

export interface TradeEventInput {
  botId: string;
  botType?: 'standard' | 'pair' | 'delta-neutral' | 'oi-farmer';
  exchange: string;
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  size: number;
  pnl: number;
  grossPnl?: number;
  fees: number;
  holdDurationSecs?: number;
  exitReason?: string;
  signalSource?: string;
  regime?: string;
  confidence?: number;
  // DN-specific
  exchangeB?: string;
  pnlA?: number;
  pnlB?: number;
  fundingNet?: number;
  oiHours?: number;
  // Context
  walletAddress?: string;
  accountId?: string;
}

/**
 * Record a completed trade. Inserts into trade_events and increments volume_counters.
 */
export function recordTrade(input: TradeEventInput): void {
  const now = new Date();
  const timestamp = now.toISOString();
  const date = timestamp.slice(0, 10);
  const notionalUsd = Math.abs(input.size) * ((input.entryPrice + input.exitPrice) / 2);
  const volumeUsd = Math.abs(input.size) * input.entryPrice + Math.abs(input.size) * input.exitPrice;

  const event: TradeEvent = {
    id: randomUUID(),
    timestamp,
    botId: input.botId,
    botType: input.botType ?? 'standard',
    exchange: input.exchange,
    symbol: input.symbol,
    direction: input.direction,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    size: Math.abs(input.size),
    notionalUsd,
    pnl: input.pnl,
    grossPnl: input.grossPnl,
    fees: input.fees,
    volumeUsd,
    holdDurationSecs: input.holdDurationSecs,
    exitReason: input.exitReason,
    signalSource: input.signalSource,
    regime: input.regime,
    confidence: input.confidence,
    exchangeB: input.exchangeB,
    pnlA: input.pnlA,
    pnlB: input.pnlB,
    fundingNet: input.fundingNet,
    oiHours: input.oiHours,
    walletAddress: input.walletAddress,
    accountId: input.accountId,
  };

  try {
    insertTradeEvent(event);
  } catch (err) {
    console.error('[ReportingCollector] Failed to insert trade event:', err);
  }

  // Increment daily volume counter
  try {
    incrementVolume({
      date,
      exchange: input.exchange,
      accountId: input.accountId,
      botId: input.botId,
      symbol: input.symbol,
      walletAddress: input.walletAddress,
      volumeUsd,
      feesUsd: input.fees,
      pnlUsd: input.pnl,
    });
  } catch (err) {
    console.error('[ReportingCollector] Failed to increment volume counter:', err);
  }
}

// ─── Balance Snapshot Recording ───────────────────────────────────────────────

export interface BalanceSnapshotInput {
  exchange: string;
  equity: number;
  availableMargin?: number;
  usedMargin?: number;
  openPositionCount?: number;
  trigger: SnapshotTrigger;
  walletAddress?: string;
  accountId?: string;
}

/**
 * Capture a balance snapshot.
 */
export function captureBalance(input: BalanceSnapshotInput): void {
  const snapshot: BalanceSnapshot = {
    timestamp: new Date().toISOString(),
    exchange: input.exchange,
    accountId: input.accountId,
    walletAddress: input.walletAddress,
    equity: input.equity,
    availableMargin: input.availableMargin,
    usedMargin: input.usedMargin,
    openPositionCount: input.openPositionCount,
    trigger: input.trigger,
  };

  try {
    insertSnapshot(snapshot);
  } catch (err) {
    console.error('[ReportingCollector] Failed to insert balance snapshot:', err);
  }
}
