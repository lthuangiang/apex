/**
 * WeightRepository — SQLite-backed signal weight persistence.
 *
 * Replaces signal-weights.json. Single-row table with the four signal weights.
 */

import { getDb } from './Database.js';

export interface WeightRow {
  ema: number;
  rsi: number;
  momentum: number;
  imbalance: number;
  updatedAt: string | null;
  tradeCount: number;
}

const DEFAULTS: WeightRow = {
  ema: 0.40,
  rsi: 0.25,
  momentum: 0.20,
  imbalance: 0.15,
  updatedAt: null,
  tradeCount: 0,
};

/**
 * Load signal weights from SQLite.
 * Returns defaults if no row exists yet.
 */
export function loadWeights(): WeightRow {
  const db = getDb();
  const row = db.prepare(
    'SELECT ema, rsi, momentum, imbalance, updated_at, trade_count FROM signal_weights WHERE id = 1'
  ).get() as Record<string, unknown> | undefined;

  if (!row) return { ...DEFAULTS };

  return {
    ema: row['ema'] as number,
    rsi: row['rsi'] as number,
    momentum: row['momentum'] as number,
    imbalance: row['imbalance'] as number,
    updatedAt: row['updated_at'] as string | null,
    tradeCount: (row['trade_count'] as number) ?? 0,
  };
}

/**
 * Upsert signal weights into SQLite.
 */
export function saveWeights(weights: WeightRow): void {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO signal_weights (id, ema, rsi, momentum, imbalance, updated_at, trade_count)
    VALUES (1, ?, ?, ?, ?, ?, ?)
  `).run(
    weights.ema,
    weights.rsi,
    weights.momentum,
    weights.imbalance,
    weights.updatedAt,
    weights.tradeCount,
  );
}
