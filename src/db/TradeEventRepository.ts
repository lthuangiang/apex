/**
 * TradeEventRepository — Insert and query closed trade events for reporting.
 *
 * Every position close (farm, trade, DN, pair) writes a record here.
 * Supports aggregation queries for reports: today volume, PnL, fees, etc.
 */

import { getDb } from './Database.js';

export interface TradeEvent {
  id: string;
  timestamp: string;          // ISO 8601
  botId: string;
  botType: 'standard' | 'pair' | 'delta-neutral' | 'oi-farmer';
  exchange: string;
  symbol: string;
  direction: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  size: number;
  notionalUsd: number;
  pnl: number;                // net PnL after fees
  grossPnl?: number;
  fees: number;
  volumeUsd: number;          // notional volume (entry + exit)
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
 * Insert a trade event record.
 */
export function insertTradeEvent(event: TradeEvent): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO trade_events (
      id, timestamp, bot_id, bot_type, exchange, symbol, direction,
      entry_price, exit_price, size, notional_usd,
      pnl, gross_pnl, fees, volume_usd,
      hold_duration_secs, exit_reason, signal_source, regime, confidence,
      exchange_b, pnl_a, pnl_b, funding_net, oi_hours,
      wallet_address, account_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id,
    event.timestamp,
    event.botId,
    event.botType,
    event.exchange,
    event.symbol,
    event.direction,
    event.entryPrice,
    event.exitPrice,
    event.size,
    event.notionalUsd,
    event.pnl,
    event.grossPnl ?? null,
    event.fees,
    event.volumeUsd,
    event.holdDurationSecs ?? null,
    event.exitReason ?? null,
    event.signalSource ?? null,
    event.regime ?? null,
    event.confidence ?? null,
    event.exchangeB ?? null,
    event.pnlA ?? null,
    event.pnlB ?? null,
    event.fundingNet ?? null,
    event.oiHours ?? null,
    event.walletAddress ?? null,
    event.accountId ?? null,
  );
}

// ─── Query Interfaces ─────────────────────────────────────────────────────────

export interface ReportFilter {
  date?: string;          // YYYY-MM-DD (defaults to today UTC)
  botId?: string;
  exchange?: string;
  walletAddress?: string;
  accountId?: string;
  symbol?: string;
}

export interface TodaySummary {
  volumeUsd: number;
  pnl: number;
  grossPnl: number;
  fees: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number;
}

export interface DailyAggregate {
  date: string;
  volumeUsd: number;
  pnl: number;
  fees: number;
  tradeCount: number;
  wins: number;
  losses: number;
}

/**
 * Get today's summary with optional filters.
 */
export function getTodaySummary(filter?: ReportFilter): TodaySummary {
  const db = getDb();
  const date = filter?.date ?? new Date().toISOString().slice(0, 10);
  const { where, params } = _buildWhereClause(date, filter);

  const row = db.prepare(`
    SELECT
      COALESCE(SUM(volume_usd), 0) as volume_usd,
      COALESCE(SUM(pnl), 0) as pnl,
      COALESCE(SUM(gross_pnl), 0) as gross_pnl,
      COALESCE(SUM(fees), 0) as fees,
      COUNT(*) as trade_count,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses
    FROM trade_events
    WHERE ${where}
  `).get(...params) as Record<string, number>;

  const tradeCount = row['trade_count'] ?? 0;
  return {
    volumeUsd: row['volume_usd'] ?? 0,
    pnl: row['pnl'] ?? 0,
    grossPnl: row['gross_pnl'] ?? 0,
    fees: row['fees'] ?? 0,
    tradeCount,
    wins: row['wins'] ?? 0,
    losses: row['losses'] ?? 0,
    winRate: tradeCount > 0 ? (row['wins'] ?? 0) / tradeCount : 0,
  };
}

/**
 * Get today's summary grouped by exchange.
 */
export function getTodayByExchange(filter?: ReportFilter): Array<TodaySummary & { exchange: string }> {
  const db = getDb();
  const date = filter?.date ?? new Date().toISOString().slice(0, 10);
  const { where, params } = _buildWhereClause(date, filter);

  const rows = db.prepare(`
    SELECT
      exchange,
      COALESCE(SUM(volume_usd), 0) as volume_usd,
      COALESCE(SUM(pnl), 0) as pnl,
      COALESCE(SUM(gross_pnl), 0) as gross_pnl,
      COALESCE(SUM(fees), 0) as fees,
      COUNT(*) as trade_count,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses
    FROM trade_events
    WHERE ${where}
    GROUP BY exchange
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(r => {
    const tc = (r['trade_count'] as number) ?? 0;
    return {
      exchange: r['exchange'] as string,
      volumeUsd: (r['volume_usd'] as number) ?? 0,
      pnl: (r['pnl'] as number) ?? 0,
      grossPnl: (r['gross_pnl'] as number) ?? 0,
      fees: (r['fees'] as number) ?? 0,
      tradeCount: tc,
      wins: (r['wins'] as number) ?? 0,
      losses: (r['losses'] as number) ?? 0,
      winRate: tc > 0 ? ((r['wins'] as number) ?? 0) / tc : 0,
    };
  });
}

/**
 * Get today's summary grouped by bot.
 */
export function getTodayByBot(filter?: ReportFilter): Array<TodaySummary & { botId: string }> {
  const db = getDb();
  const date = filter?.date ?? new Date().toISOString().slice(0, 10);
  const { where, params } = _buildWhereClause(date, filter);

  const rows = db.prepare(`
    SELECT
      bot_id,
      COALESCE(SUM(volume_usd), 0) as volume_usd,
      COALESCE(SUM(pnl), 0) as pnl,
      COALESCE(SUM(gross_pnl), 0) as gross_pnl,
      COALESCE(SUM(fees), 0) as fees,
      COUNT(*) as trade_count,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses
    FROM trade_events
    WHERE ${where}
    GROUP BY bot_id
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(r => {
    const tc = (r['trade_count'] as number) ?? 0;
    return {
      botId: r['bot_id'] as string,
      volumeUsd: (r['volume_usd'] as number) ?? 0,
      pnl: (r['pnl'] as number) ?? 0,
      grossPnl: (r['gross_pnl'] as number) ?? 0,
      fees: (r['fees'] as number) ?? 0,
      tradeCount: tc,
      wins: (r['wins'] as number) ?? 0,
      losses: (r['losses'] as number) ?? 0,
      winRate: tc > 0 ? ((r['wins'] as number) ?? 0) / tc : 0,
    };
  });
}

/**
 * Get daily aggregates for a date range (for charts).
 */
export function getDailyAggregates(startDate: string, endDate: string, filter?: Omit<ReportFilter, 'date'>): DailyAggregate[] {
  const db = getDb();
  const conditions: string[] = ["date(timestamp) BETWEEN ? AND ?"];
  const params: unknown[] = [startDate, endDate];

  if (filter?.botId) { conditions.push("bot_id = ?"); params.push(filter.botId); }
  if (filter?.exchange) { conditions.push("exchange = ?"); params.push(filter.exchange); }
  if (filter?.walletAddress) { conditions.push("wallet_address = ?"); params.push(filter.walletAddress); }
  if (filter?.accountId) { conditions.push("account_id = ?"); params.push(filter.accountId); }
  if (filter?.symbol) { conditions.push("symbol = ?"); params.push(filter.symbol); }

  const rows = db.prepare(`
    SELECT
      date(timestamp) as date,
      COALESCE(SUM(volume_usd), 0) as volume_usd,
      COALESCE(SUM(pnl), 0) as pnl,
      COALESCE(SUM(fees), 0) as fees,
      COUNT(*) as trade_count,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      SUM(CASE WHEN pnl <= 0 THEN 1 ELSE 0 END) as losses
    FROM trade_events
    WHERE ${conditions.join(' AND ')}
    GROUP BY date(timestamp)
    ORDER BY date(timestamp)
  `).all(...params) as Array<Record<string, unknown>>;

  return rows.map(r => ({
    date: r['date'] as string,
    volumeUsd: (r['volume_usd'] as number) ?? 0,
    pnl: (r['pnl'] as number) ?? 0,
    fees: (r['fees'] as number) ?? 0,
    tradeCount: (r['trade_count'] as number) ?? 0,
    wins: (r['wins'] as number) ?? 0,
    losses: (r['losses'] as number) ?? 0,
  }));
}

/**
 * Get recent trade events (paginated).
 */
export function getRecentTrades(limit = 50, offset = 0, filter?: ReportFilter): TradeEvent[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.date) { conditions.push("date(timestamp) = ?"); params.push(filter.date); }
  if (filter?.botId) { conditions.push("bot_id = ?"); params.push(filter.botId); }
  if (filter?.exchange) { conditions.push("exchange = ?"); params.push(filter.exchange); }
  if (filter?.walletAddress) { conditions.push("wallet_address = ?"); params.push(filter.walletAddress); }
  if (filter?.symbol) { conditions.push("symbol = ?"); params.push(filter.symbol); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT * FROM trade_events ${where}
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<Record<string, unknown>>;

  return rows.map(_rowToTradeEvent);
}

/**
 * Get analytics: win rate, avg PnL, hold duration by bot/regime.
 */
export function getAnalytics(filter?: ReportFilter): {
  winRate: number;
  avgPnl: number;
  avgWin: number;
  avgLoss: number;
  avgHoldSecs: number;
  totalTrades: number;
  expectancy: number;
  profitFactor: number;
  byRegime: Array<{ regime: string; winRate: number; avgPnl: number; tradeCount: number }>;
} {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter?.date) { conditions.push("date(timestamp) = ?"); params.push(filter.date); }
  if (filter?.botId) { conditions.push("bot_id = ?"); params.push(filter.botId); }
  if (filter?.exchange) { conditions.push("exchange = ?"); params.push(filter.exchange); }
  if (filter?.walletAddress) { conditions.push("wallet_address = ?"); params.push(filter.walletAddress); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const summary = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      AVG(pnl) as avg_pnl,
      AVG(CASE WHEN pnl > 0 THEN pnl END) as avg_win,
      AVG(CASE WHEN pnl <= 0 THEN pnl END) as avg_loss,
      AVG(hold_duration_secs) as avg_hold,
      SUM(CASE WHEN pnl > 0 THEN pnl ELSE 0 END) as total_wins_pnl,
      ABS(SUM(CASE WHEN pnl < 0 THEN pnl ELSE 0 END)) as total_losses_pnl
    FROM trade_events ${where}
  `).get(...params) as Record<string, number | null>;

  const total = summary['total'] ?? 0;
  const wins = summary['wins'] ?? 0;
  const avgWin = summary['avg_win'] ?? 0;
  const avgLoss = summary['avg_loss'] ?? 0;
  const totalWinsPnl = summary['total_wins_pnl'] ?? 0;
  const totalLossesPnl = summary['total_losses_pnl'] ?? 0;

  // By regime
  const regimeRows = db.prepare(`
    SELECT
      COALESCE(regime, 'unknown') as regime,
      COUNT(*) as trade_count,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) as wins,
      AVG(pnl) as avg_pnl
    FROM trade_events ${where}
    GROUP BY regime
  `).all(...params) as Array<Record<string, unknown>>;

  return {
    winRate: total > 0 ? wins / total : 0,
    avgPnl: summary['avg_pnl'] ?? 0,
    avgWin,
    avgLoss,
    avgHoldSecs: summary['avg_hold'] ?? 0,
    totalTrades: total,
    expectancy: total > 0 ? ((wins / total) * avgWin) + (((total - wins) / total) * avgLoss) : 0,
    profitFactor: totalLossesPnl > 0 ? totalWinsPnl / totalLossesPnl : totalWinsPnl > 0 ? Infinity : 0,
    byRegime: regimeRows.map(r => {
      const tc = (r['trade_count'] as number) ?? 0;
      return {
        regime: r['regime'] as string,
        winRate: tc > 0 ? ((r['wins'] as number) ?? 0) / tc : 0,
        avgPnl: (r['avg_pnl'] as number) ?? 0,
        tradeCount: tc,
      };
    }),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _buildWhereClause(date: string, filter?: ReportFilter): { where: string; params: unknown[] } {
  const conditions: string[] = ["date(timestamp) = ?"];
  const params: unknown[] = [date];

  if (filter?.botId) { conditions.push("bot_id = ?"); params.push(filter.botId); }
  if (filter?.exchange) { conditions.push("exchange = ?"); params.push(filter.exchange); }
  if (filter?.walletAddress) { conditions.push("wallet_address = ?"); params.push(filter.walletAddress); }
  if (filter?.accountId) { conditions.push("account_id = ?"); params.push(filter.accountId); }
  if (filter?.symbol) { conditions.push("symbol = ?"); params.push(filter.symbol); }

  return { where: conditions.join(' AND '), params };
}

function _rowToTradeEvent(r: Record<string, unknown>): TradeEvent {
  return {
    id: r['id'] as string,
    timestamp: r['timestamp'] as string,
    botId: r['bot_id'] as string,
    botType: r['bot_type'] as TradeEvent['botType'],
    exchange: r['exchange'] as string,
    symbol: r['symbol'] as string,
    direction: r['direction'] as 'long' | 'short',
    entryPrice: r['entry_price'] as number,
    exitPrice: r['exit_price'] as number,
    size: r['size'] as number,
    notionalUsd: r['notional_usd'] as number,
    pnl: r['pnl'] as number,
    grossPnl: r['gross_pnl'] as number | undefined ?? undefined,
    fees: r['fees'] as number,
    volumeUsd: r['volume_usd'] as number,
    holdDurationSecs: r['hold_duration_secs'] as number | undefined ?? undefined,
    exitReason: r['exit_reason'] as string | undefined ?? undefined,
    signalSource: r['signal_source'] as string | undefined ?? undefined,
    regime: r['regime'] as string | undefined ?? undefined,
    confidence: r['confidence'] as number | undefined ?? undefined,
    exchangeB: r['exchange_b'] as string | undefined ?? undefined,
    pnlA: r['pnl_a'] as number | undefined ?? undefined,
    pnlB: r['pnl_b'] as number | undefined ?? undefined,
    fundingNet: r['funding_net'] as number | undefined ?? undefined,
    oiHours: r['oi_hours'] as number | undefined ?? undefined,
    walletAddress: r['wallet_address'] as string | undefined ?? undefined,
    accountId: r['account_id'] as string | undefined ?? undefined,
  };
}
