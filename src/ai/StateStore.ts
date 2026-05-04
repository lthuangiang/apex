/**
 * StateStore — persists sharedState to disk so PnL, logs, and history
 * survive bot restarts (stop/start or Docker restart).
 *
 * Saves to STATE_STORE_PATH (default: ./bot_state.json).
 * For multi-bot mode, saves to ./bot_state_${botId}.json.
 * Writes are debounced to avoid hammering disk on every tick.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { sharedState, EventLogEntry, PnlDataPoint } from './sharedState.js';
import type { BotSharedState } from '../bot/BotSharedState.js';

const STATE_PATH = process.env.STATE_STORE_PATH ?? './bot_state.json';
const DEBOUNCE_MS = 3000;

interface PersistedState {
  sessionPnl: number;
  sessionVolume: number;
  sessionFees?: number;
  sessionGrossPnl?: number;
  sessionStartBalance?: number | null;
  currentBalance?: number | null;
  todayVolume?: number;
  todayVolumeDate?: string;
  pnlHistory: PnlDataPoint[];
  volumeHistory: PnlDataPoint[];
  eventLog: EventLogEntry[];
  savedAt: string;
}

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Get the state file path for a given botId.
 * For single-bot mode (no botId), uses STATE_PATH.
 * For multi-bot mode, uses ./bot_state_${botId}.json.
 */
function getStatePath(botId?: string): string {
  if (!botId) return STATE_PATH;
  return `./bot_state_${botId}.json`;
}

/** Load persisted state into sharedState or BotSharedState. Call once at startup. */
export function loadState(botState?: BotSharedState): void {
  const statePath = getStatePath(botState?.botId);
  if (!existsSync(statePath)) return;
  try {
    const raw = readFileSync(statePath, 'utf-8');
    const saved: PersistedState = JSON.parse(raw);
    
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
    console.log(`[StateStore] Loaded state from ${statePath} (saved at ${saved.savedAt})`);
  } catch (e) {
    console.warn('[StateStore] Failed to load state:', e);
  }
}

/** Persist current sharedState or BotSharedState to disk (debounced). */
export function saveState(botState?: BotSharedState): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    try {
      const targetState = botState ?? sharedState;
      const statePath = getStatePath(botState?.botId);
      
      const payload: PersistedState = {
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
        savedAt: new Date().toISOString(),
      };
      writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[StateStore] Failed to save state:', e);
    }
  }, DEBOUNCE_MS);
}

/** Save immediately (use on shutdown). */
export function saveStateSync(botState?: BotSharedState): void {
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  try {
    const targetState = botState ?? sharedState;
    const statePath = getStatePath(botState?.botId);
    
    const payload: PersistedState = {
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
      savedAt: new Date().toISOString(),
    };
    writeFileSync(statePath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`[StateStore] State saved on shutdown to ${statePath}.`);
  } catch (e) {
    console.warn('[StateStore] Failed to save state on shutdown:', e);
  }
}
