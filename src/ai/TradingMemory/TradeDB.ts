import type { TradeRecord } from './types.js';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');

type BetterSQLite3Database = import('better-sqlite3').Database;

export class TradeDB {
  private db: BetterSQLite3Database;

  constructor(dbPath: string = './trading_memory.db') {
    this.db = new Database(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_trades (
        trade_id   TEXT PRIMARY KEY,
        signal     TEXT NOT NULL,
        decision   TEXT NOT NULL,
        pnl_percent REAL NOT NULL,
        outcome    TEXT NOT NULL,
        timestamp  TEXT NOT NULL
      );
    `);
  }

  insert(trade: TradeRecord): string {
    this.db.prepare(`
      INSERT OR REPLACE INTO memory_trades (trade_id, signal, decision, pnl_percent, outcome, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      trade.tradeId,
      JSON.stringify(trade.signal),
      trade.decision,
      trade.pnlPercent,
      trade.outcome,
      trade.timestamp,
    );
    return trade.tradeId;
  }

  getByIds(ids: string[]): TradeRecord[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT * FROM memory_trades WHERE trade_id IN (${placeholders})`
    ).all(...ids) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      tradeId: row['trade_id'] as string,
      signal: JSON.parse(row['signal'] as string),
      decision: row['decision'] as TradeRecord['decision'],
      pnlPercent: row['pnl_percent'] as number,
      outcome: row['outcome'] as 'WIN' | 'LOSS',
      timestamp: row['timestamp'] as string,
    }));
  }
}
