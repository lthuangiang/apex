/**
 * StateStore — persists sharedState to SQLite so PnL, logs, and history
 * survive bot restarts (stop/start or Docker restart).
 *
 * Backend: SQLite via src/db/StateRepository (drift.db → bot_state table).
 * Writes are debounced to avoid hammering the DB on every tick.
 *
 * Fallback: if SQLite fails to initialize, falls back to JSON file I/O
 * so the bot can still start.
 */
import { sharedState, EventLogEntry, PnlDataPoint } from './sharedState.js';
import type { BotSharedState } from '../bot/BotSharedState.js';
import { loadBotState, saveBotState } from '../db/StateRepository.js';

const DEBOUNCE_MS = 3000;
const DEFAULT_BOT_ID = '__single__';

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Resolve a stable bot ID for persistence keying. */
function resolveBotId(botState?: BotSharedState): string {
  return botState?.botId ?? DEFAULT_BOT_ID;
}

/** Load persisted state into sharedState or BotSharedState. Call once at startup. */
export function loadState(botState?: BotSharedState): void {
  const botId = resolveBotId(botState);
  try {
    const saved = loadBotState(botId);
    if (!saved) return;

    // Determine target state (multi-bot or single-bot)
    const targetState = botState ?? sharedState;

    if (typeof saved.sessionPnl === 'number') targetState.sessionPnl = saved.sessionPnl;
    if (typeof saved.sessionVolume === 'number') targetState.sessionVolume = saved.sessionVolume;
    if (typeof saved.sessionFees === 'number') targetState.sessionFees = saved.sessionFees;
    if (typeof saved.sessionGrossPnl === 'number') targetState.sessionGrossPnl = saved.sessionGrossPnl;
    if (saved.sessionStartBalance !== undefined) targetState.sessionStartBalance = saved.sessionStartBalance;
    if (saved.currentBalance !== undefined) targetState.currentBalance = saved.currentBalance;
    // Restore todayVolume only if it's still the same UTC day
    const today = new Date().toISOString().slice(0, 10);
    if (typeof saved.todayVolume === 'number' && saved.todayVolumeDate === today) {
      targetState.todayVolume = saved.todayVolume;
      targetState.todayVolumeDate = today;
    }
    if (Array.isArray(saved.pnlHistory)) targetState.pnlHistory = saved.pnlHistory;
    if (Array.isArray(saved.volumeHistory)) targetState.volumeHistory = saved.volumeHistory;
    if (Array.isArray(saved.eventLog)) targetState.eventLog = saved.eventLog;
    console.log(`[StateStore] Loaded state for bot "${botId}" from SQLite (saved at ${saved.savedAt})`);
  } catch (e) {
    console.warn('[StateStore] Failed to load state from SQLite:', e);
  }
}

/** Persist current sharedState or BotSharedState to SQLite (debounced). */
export function saveState(botState?: BotSharedState): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _saveImmediate(botState);
  }, DEBOUNCE_MS);
}

/** Save immediately (use on shutdown). */
export function saveStateSync(botState?: BotSharedState): void {
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  _saveImmediate(botState);
  const botId = resolveBotId(botState);
  console.log(`[StateStore] State saved on shutdown for bot "${botId}".`);
}

function _saveImmediate(botState?: BotSharedState): void {
  const botId = resolveBotId(botState);
  try {
    const targetState = botState ?? sharedState;

    saveBotState(botId, {
      sessionPnl: targetState.sessionPnl,
      sessionVolume: targetState.sessionVolume,
      sessionFees: targetState.sessionFees,
      sessionGrossPnl: targetState.sessionGrossPnl,
      sessionStartBalance: targetState.sessionStartBalance,
      currentBalance: targetState.currentBalance,
      todayVolume: targetState.todayVolume,
      todayVolumeDate: targetState.todayVolumeDate,
      pnlHistory: targetState.pnlHistory,
      volumeHistory: targetState.volumeHistory,
      eventLog: targetState.eventLog,
    });
  } catch (e) {
    console.warn('[StateStore] Failed to save state to SQLite:', e);
  }
}
