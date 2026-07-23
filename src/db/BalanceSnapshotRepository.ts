/**
 * BalanceSnapshotRepository — Capture and query account balance snapshots.
 *
 * Snapshots are taken:
 * - Daily at 0h UTC (trigger='daily')
 * - Before opening a position (trigger='pre_open')
 * - After closing a position (trigger='post_close')
 */

import { getDb } from './Database.js';

export type SnapshotTrigger = 'daily' | 'pre_open' | 'post_close';

export interface BalanceSnapshot {
  timestamp: string;          // ISO 8601
  exchange: string;
  accountId?: string;
  walletAddress?: string;
  equity: number;
  availableMargin?: number;
  usedMargin?: number;
  openPositionCount?: number;
  trigger: SnapshotTrigger;
}

export interface BalanceSnapshotRow extends BalanceSnapshot {
  id: number;
}

/**
 * Insert a balance snapshot.
 */
export function insertSnapshot(snapshot: BalanceSnapshot): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO balance_snapshots (
      timestamp, exchange, account_id, wallet_address,
      equity, available_margin, used_margin, open_position_count, trigger
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    snapshot.timestamp,
    snapshot.exchange,
    snapshot.accountId ?? null,
    snapshot.walletAddress ?? null,
    snapshot.equity,
    snapshot.availableMargin ?? null,
    snapshot.usedMargin ?? null,
    snapshot.openPositionCount ?? 0,
    snapshot.trigger,
  );
}

/**
 * Get daily snapshots (trigger='daily') for an account over a date range.
 */
export function getDailySnapshots(
  exchange: string,
  startDate: string,
  endDate: string,
  accountId?: string,
  walletAddress?: string,
): BalanceSnapshotRow[] {
  const db = getDb();
  const conditions: string[] = [
    "exchange = ?",
    "trigger = 'daily'",
    "date(timestamp) BETWEEN ? AND ?",
  ];
  const params: unknown[] = [exchange, startDate, endDate];

  if (accountId) { conditions.push("account_id = ?"); params.push(accountId); }
  if (walletAddress) { conditions.push("wallet_address = ?"); params.push(walletAddress); }

  const rows = db.prepare(`
    SELECT * FROM balance_snapshots
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp ASC
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(_rowToSnapshot);
}

/**
 * Get the latest snapshot for each exchange/account combination.
 */
export function getAllLatestSnapshots(walletAddress?: string): BalanceSnapshotRow[] {
  const db = getDb();
  const walletFilter = walletAddress ? "WHERE wallet_address = ?" : "";
  const params = walletAddress ? [walletAddress] : [];

  const rows = db.prepare(`
    SELECT bs.* FROM balance_snapshots bs
    INNER JOIN (
      SELECT exchange, account_id, MAX(timestamp) as max_ts
      FROM balance_snapshots
      ${walletFilter}
      GROUP BY exchange, account_id
    ) latest ON bs.exchange = latest.exchange
      AND COALESCE(bs.account_id, '') = COALESCE(latest.account_id, '')
      AND bs.timestamp = latest.max_ts
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(_rowToSnapshot);
}

/**
 * Get latest snapshot for a specific account.
 */
export function getLatestSnapshot(exchange: string, accountId?: string): BalanceSnapshotRow | null {
  const db = getDb();
  const conditions: string[] = ["exchange = ?"];
  const params: unknown[] = [exchange];

  if (accountId) { conditions.push("account_id = ?"); params.push(accountId); }

  const row = db.prepare(`
    SELECT * FROM balance_snapshots
    WHERE ${conditions.join(' AND ')}
    ORDER BY timestamp DESC
    LIMIT 1
  `).get(...params) as Record<string, unknown> | undefined;

  return row ? _rowToSnapshot(row) : null;
}

/**
 * Get equity history for charts (all snapshots in a date range).
 */
export function getEquityHistory(
  startDate: string,
  endDate: string,
  walletAddress?: string,
): Array<{ timestamp: string; totalEquity: number }> {
  const db = getDb();
  const conditions: string[] = [
    "trigger = 'daily'",
    "date(timestamp) BETWEEN ? AND ?",
  ];
  const params: unknown[] = [startDate, endDate];

  if (walletAddress) { conditions.push("wallet_address = ?"); params.push(walletAddress); }

  // Sum equity across all accounts per timestamp
  const rows = db.prepare(`
    SELECT timestamp, SUM(equity) as total_equity
    FROM balance_snapshots
    WHERE ${conditions.join(' AND ')}
    GROUP BY date(timestamp)
    ORDER BY timestamp ASC
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    timestamp: r['timestamp'] as string,
    totalEquity: (r['total_equity'] as number) ?? 0,
  }));
}

/**
 * Get total AUM (sum of latest snapshots across all accounts).
 */
export function getTotalAum(walletAddress?: string): number {
  const snapshots = getAllLatestSnapshots(walletAddress);
  return snapshots.reduce((sum, s) => sum + s.equity, 0);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _rowToSnapshot(r: Record<string, unknown>): BalanceSnapshotRow {
  return {
    id: r['id'] as number,
    timestamp: r['timestamp'] as string,
    exchange: r['exchange'] as string,
    accountId: r['account_id'] as string | undefined ?? undefined,
    walletAddress: r['wallet_address'] as string | undefined ?? undefined,
    equity: r['equity'] as number,
    availableMargin: r['available_margin'] as number | undefined ?? undefined,
    usedMargin: r['used_margin'] as number | undefined ?? undefined,
    openPositionCount: r['open_position_count'] as number | undefined ?? 0,
    trigger: r['trigger'] as SnapshotTrigger,
  };
}
