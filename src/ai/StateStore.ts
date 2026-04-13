/**
 * StateStore — persists sharedState to disk so PnL, logs, and history
 * survive bot restarts (stop/start or Docker restart).
 *
 * Saves to STATE_STORE_PATH (default: ./bot_state.json).
 * Writes are debounced to avoid hammering disk on every tick.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { sharedState, EventLogEntry, PnlDataPoint } from './sharedState.js';

const STATE_PATH = process.env.STATE_STORE_PATH ?? './bot_state.json';
const DEBOUNCE_MS = 3000;

interface PersistedState {
  sessionPnl: number;
  sessionVolume: number;
  pnlHistory: PnlDataPoint[];
  volumeHistory: PnlDataPoint[];
  eventLog: EventLogEntry[];
  savedAt: string;
}

let _debounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Load persisted state into sharedState. Call once at startup. */
export function loadState(): void {
  if (!existsSync(STATE_PATH)) return;
  try {
    const raw = readFileSync(STATE_PATH, 'utf-8');
    const saved: PersistedState = JSON.parse(raw);
    if (typeof saved.sessionPnl === 'number') sharedState.sessionPnl = saved.sessionPnl;
    if (typeof saved.sessionVolume === 'number') sharedState.sessionVolume = saved.sessionVolume;
    if (Array.isArray(saved.pnlHistory)) sharedState.pnlHistory = saved.pnlHistory;
    if (Array.isArray(saved.volumeHistory)) sharedState.volumeHistory = saved.volumeHistory;
    if (Array.isArray(saved.eventLog)) sharedState.eventLog = saved.eventLog;
    console.log(`[StateStore] Loaded state from ${STATE_PATH} (saved at ${saved.savedAt})`);
  } catch (e) {
    console.warn('[StateStore] Failed to load state:', e);
  }
}

/** Persist current sharedState to disk (debounced). */
export function saveState(): void {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    try {
      const payload: PersistedState = {
        sessionPnl: sharedState.sessionPnl,
        sessionVolume: sharedState.sessionVolume,
        pnlHistory: sharedState.pnlHistory,
        volumeHistory: sharedState.volumeHistory,
        eventLog: sharedState.eventLog,
        savedAt: new Date().toISOString(),
      };
      writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    } catch (e) {
      console.warn('[StateStore] Failed to save state:', e);
    }
  }, DEBOUNCE_MS);
}

/** Save immediately (use on shutdown). */
export function saveStateSync(): void {
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  try {
    const payload: PersistedState = {
      sessionPnl: sharedState.sessionPnl,
      sessionVolume: sharedState.sessionVolume,
      pnlHistory: sharedState.pnlHistory,
      volumeHistory: sharedState.volumeHistory,
      eventLog: sharedState.eventLog,
      savedAt: new Date().toISOString(),
    };
    writeFileSync(STATE_PATH, JSON.stringify(payload, null, 2), 'utf-8');
    console.log('[StateStore] State saved on shutdown.');
  } catch (e) {
    console.warn('[StateStore] Failed to save state on shutdown:', e);
  }
}
