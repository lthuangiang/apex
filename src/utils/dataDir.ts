/**
 * dataDir.ts — Central data directory resolver.
 *
 * All persistent files (state, trades, logs, configs) must write under DATA_DIR
 * so Docker volume mount (`./data:/app/data`) preserves them across restarts.
 *
 * Usage:
 *   import { dataPath } from '../utils/dataDir.js';
 *   const statePath = dataPath('bot_state.json');
 *   // → /app/data/bot_state.json (Docker) or ./data/bot_state.json (local dev)
 */

import { mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

/** Base data directory. Defaults to ./data; override with DATA_DIR env var. */
export const DATA_DIR = resolve(process.env.DATA_DIR ?? './data');

// Ensure data directory exists on import
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Resolve a filename or relative path under DATA_DIR.
 * @param filename - e.g. 'bot_state.json', 'trades-sodex-btc.json', 'logs/system.log'
 * @returns Absolute path under DATA_DIR
 */
export function dataPath(filename: string): string {
  return join(DATA_DIR, filename);
}
