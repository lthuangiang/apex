/**
 * VolumeCounterRepository — Daily aggregated volume counters.
 *
 * Each trade increments the counter for its (date, exchange, botId, symbol) tuple.
 * Provides fast daily volume queries without scanning all trade_events rows.
 */

import { getDb } from './Database.js';

export interface VolumeCounter {
  date: string;           // YYYY-MM-DD (UTC)
  exchange: string;
  accountId?: string;
  botId: string;
  symbol: string;
  walletAddress?: string;
  volumeUsd: number;
  tradeCount: number;
  feesUsd: number;
  pnlUsd: number;
}

/**
 * Increment a volume counter (upsert pattern).
 * Called after every trade close.
 */
export function incrementVolume(entry: {
  date: string;
  exchange: string;
  accountId?: string;
  botId: string;
  symbol: string;
  walletAddress?: string;
  volumeUsd: number;
  feesUsd: number;
  pnlUsd: number;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO volume_counters (date, exchange, account_id, bot_id, symbol, wallet_address, volume_usd, trade_count, fees_usd, pnl_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(date, exchange, bot_id, symbol) DO UPDATE SET
      volume_usd = volume_usd + excluded.volume_usd,
      trade_count = trade_count + 1,
      fees_usd = fees_usd + excluded.fees_usd,
      pnl_usd = pnl_usd + excluded.pnl_usd,
      account_id = COALESCE(excluded.account_id, account_id),
      wallet_address = COALESCE(excluded.wallet_address, wallet_address)
  `).run(
    entry.date,
    entry.exchange,
    entry.accountId ?? null,
    entry.botId,
    entry.symbol,
    entry.walletAddress ?? null,
    entry.volumeUsd,
    entry.feesUsd,
    entry.pnlUsd,
  );
}

// ─── Query Functions ──────────────────────────────────────────────────────────

export interface VolumeFilter {
  date?: string;          // defaults to today UTC
  exchange?: string;
  botId?: string;
  walletAddress?: string;
  accountId?: string;
  symbol?: string;
}

export interface VolumeSummary {
  volumeUsd: number;
  tradeCount: number;
  feesUsd: number;
  pnlUsd: number;
}

/**
 * Get today's total volume with optional filters.
 */
export function getTodayVolume(filter?: VolumeFilter): VolumeSummary {
  const db = getDb();
  const date = filter?.date ?? new Date().toISOString().slice(0, 10);
  const { where, params } = _buildWhere(date, filter);

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(volume_usd), 0) as volume_usd,
      COALESCE(SUM(trade_count), 0) as trade_count,
      COALESCE(SUM(fees_usd), 0) as fees_usd,
      COALESCE(SUM(pnl_usd), 0) as pnl_usd
    FROM volume_counters
    WHERE ${where}
  `).get(...params) as Record<string, number>;

  return {
    volumeUsd: row['volume_usd'] ?? 0,
    tradeCount: row['trade_count'] ?? 0,
    feesUsd: row['fees_usd'] ?? 0,
    pnlUsd: row['pnl_usd'] ?? 0,
  };
}

/**
 * Get today's volume grouped by exchange.
 */
export function getTodayVolumeByExchange(filter?: VolumeFilter): Array<VolumeSummary & { exchange: string }> {
  const db = getDb();
  const date = filter?.date ?? new Date().toISOString().slice(0, 10);
  const { where, params } = _buildWhere(date, filter);

  const rows = db.prepare(`
    SELECT
      exchange,
      COALESCE(SUM(volume_usd), 0) as volume_usd,
      COALESCE(SUM(trade_count), 0) as trade_count,
      COALESCE(SUM(fees_usd), 0) as fees_usd,
      COALESCE(SUM(pnl_usd), 0) as pnl_usd
    FROM volume_counters
    WHERE ${where}
    GROUP BY exchange
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    exchange: r['exchange'] as string,
    volumeUsd: (r['volume_usd'] as number) ?? 0,
    tradeCount: (r['trade_count'] as number) ?? 0,
    feesUsd: (r['fees_usd'] as number) ?? 0,
    pnlUsd: (r['pnl_usd'] as number) ?? 0,
  }));
}

/**
 * Get today's volume grouped by bot.
 */
export function getTodayVolumeByBot(filter?: VolumeFilter): Array<VolumeSummary & { botId: string; exchange: string; symbol: string }> {
  const db = getDb();
  const date = filter?.date ?? new Date().toISOString().slice(0, 10);
  const { where, params } = _buildWhere(date, filter);

  const rows = db.prepare(`
    SELECT
      bot_id, exchange, symbol,
      COALESCE(SUM(volume_usd), 0) as volume_usd,
      COALESCE(SUM(trade_count), 0) as trade_count,
      COALESCE(SUM(fees_usd), 0) as fees_usd,
      COALESCE(SUM(pnl_usd), 0) as pnl_usd
    FROM volume_counters
    WHERE ${where}
    GROUP BY bot_id, exchange, symbol
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    botId: r['bot_id'] as string,
    exchange: r['exchange'] as string,
    symbol: r['symbol'] as string,
    volumeUsd: (r['volume_usd'] as number) ?? 0,
    tradeCount: (r['trade_count'] as number) ?? 0,
    feesUsd: (r['fees_usd'] as number) ?? 0,
    pnlUsd: (r['pnl_usd'] as number) ?? 0,
  }));
}

/**
 * Get volume history over a date range (for daily volume chart).
 */
export function getVolumeHistory(startDate: string, endDate: string, filter?: Omit<VolumeFilter, 'date'>): Array<VolumeSummary & { date: string }> {
  const db = getDb();
  const conditions: string[] = ["date BETWEEN ? AND ?"];
  const params: unknown[] = [startDate, endDate];

  if (filter?.exchange) { conditions.push("exchange = ?"); params.push(filter.exchange); }
  if (filter?.botId) { conditions.push("bot_id = ?"); params.push(filter.botId); }
  if (filter?.walletAddress) { conditions.push("wallet_address = ?"); params.push(filter.walletAddress); }
  if (filter?.accountId) { conditions.push("account_id = ?"); params.push(filter.accountId); }
  if (filter?.symbol) { conditions.push("symbol = ?"); params.push(filter.symbol); }

  const rows = db.prepare(`
    SELECT
      date,
      COALESCE(SUM(volume_usd), 0) as volume_usd,
      COALESCE(SUM(trade_count), 0) as trade_count,
      COALESCE(SUM(fees_usd), 0) as fees_usd,
      COALESCE(SUM(pnl_usd), 0) as pnl_usd
    FROM volume_counters
    WHERE ${conditions.join(' AND ')}
    GROUP BY date
    ORDER BY date ASC
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    date: r['date'] as string,
    volumeUsd: (r['volume_usd'] as number) ?? 0,
    tradeCount: (r['trade_count'] as number) ?? 0,
    feesUsd: (r['fees_usd'] as number) ?? 0,
    pnlUsd: (r['pnl_usd'] as number) ?? 0,
  }));
}

/**
 * Get all counters for today (raw breakdown).
 */
export function getTodayCounters(filter?: VolumeFilter): VolumeCounter[] {
  const db = getDb();
  const date = filter?.date ?? new Date().toISOString().slice(0, 10);
  const { where, params } = _buildWhere(date, filter);

  const rows = db.prepare(`
    SELECT * FROM volume_counters WHERE ${where} ORDER BY volume_usd DESC
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    date: r['date'] as string,
    exchange: r['exchange'] as string,
    accountId: r['account_id'] as string | undefined ?? undefined,
    botId: r['bot_id'] as string,
    symbol: r['symbol'] as string,
    walletAddress: r['wallet_address'] as string | undefined ?? undefined,
    volumeUsd: (r['volume_usd'] as number) ?? 0,
    tradeCount: (r['trade_count'] as number) ?? 0,
    feesUsd: (r['fees_usd'] as number) ?? 0,
    pnlUsd: (r['pnl_usd'] as number) ?? 0,
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _buildWhere(date: string, filter?: VolumeFilter): { where: string; params: unknown[] } {
  const conditions: string[] = ["date = ?"];
  const params: unknown[] = [date];

  if (filter?.exchange) { conditions.push("exchange = ?"); params.push(filter.exchange); }
  if (filter?.botId) { conditions.push("bot_id = ?"); params.push(filter.botId); }
  if (filter?.walletAddress) { conditions.push("wallet_address = ?"); params.push(filter.walletAddress); }
  if (filter?.accountId) { conditions.push("account_id = ?"); params.push(filter.accountId); }
  if (filter?.symbol) { conditions.push("symbol = ?"); params.push(filter.symbol); }

  return { where: conditions.join(' AND '), params };
}
