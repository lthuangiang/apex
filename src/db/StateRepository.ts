/**
 * StateRepository — SQLite-backed bot state persistence.
 *
 * Replaces the JSON file-based StateStore for bot session state (PnL, volume,
 * event logs, history). Maintains the same debounce semantics.
 */

import { getDb } from './Database.js';
import type { EventLogEntry, PnlDataPoint } from '../ai/sharedState.js';

export interface BotStateRow {
  sessionPnl: number;
  sessionVolume: number;
  sessionFees: number;
  sessionGrossPnl: number;
  sessionStartBalance: number | null;
  currentBalance: number | null;
  todayVolume: number;
  todayVolumeDate: string | null;
  pnlHistory: PnlDataPoint[];
  volumeHistory: PnlDataPoint[];
  eventLog: EventLogEntry[];
  savedAt: string;
}

/**
 * Load bot state from SQLite.
 * Returns null if no state exists for this botId.
 */
export function loadBotState(botId: string): BotStateRow | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT session_pnl, session_volume, session_fees, session_gross_pnl,
           session_start_balance, current_balance, today_volume, today_volume_date,
           pnl_history, volume_history, event_log, saved_at
    FROM bot_state WHERE bot_id = ?
  `).get(botId) as Record<string, unknown> | undefined;

  if (!row) return null;

  return {
    sessionPnl: row['session_pnl'] as number,
    sessionVolume: row['session_volume'] as number,
    sessionFees: row['session_fees'] as number,
    sessionGrossPnl: row['session_gross_pnl'] as number,
    sessionStartBalance: row['session_start_balance'] as number | null,
    currentBalance: row['current_balance'] as number | null,
    todayVolume: row['today_volume'] as number,
    todayVolumeDate: row['today_volume_date'] as string | null,
    pnlHistory: JSON.parse(row['pnl_history'] as string),
    volumeHistory: JSON.parse(row['volume_history'] as string),
    eventLog: JSON.parse(row['event_log'] as string),
    savedAt: row['saved_at'] as string,
  };
}

/**
 * Upsert bot state into SQLite (INSERT OR REPLACE).
 */
export function saveBotState(botId: string, state: Omit<BotStateRow, 'savedAt'>): void {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT OR REPLACE INTO bot_state (
      bot_id, session_pnl, session_volume, session_fees, session_gross_pnl,
      session_start_balance, current_balance, today_volume, today_volume_date,
      pnl_history, volume_history, event_log, saved_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    botId,
    state.sessionPnl,
    state.sessionVolume,
    state.sessionFees,
    state.sessionGrossPnl,
    state.sessionStartBalance,
    state.currentBalance,
    state.todayVolume,
    state.todayVolumeDate,
    JSON.stringify(state.pnlHistory),
    JSON.stringify(state.volumeHistory),
    JSON.stringify(state.eventLog),
    now,
  );
}

/**
 * Delete bot state (e.g. on daily reset).
 */
export function deleteBotState(botId: string): void {
  const db = getDb();
  db.prepare('DELETE FROM bot_state WHERE bot_id = ?').run(botId);
}

/**
 * List all bot IDs that have persisted state.
 */
export function listBotStateIds(): string[] {
  const db = getDb();
  const rows = db.prepare('SELECT bot_id FROM bot_state').all() as Array<{ bot_id: string }>;
  return rows.map(r => r.bot_id);
}
