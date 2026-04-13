"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradeDB = void 0;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require('better-sqlite3');
class TradeDB {
    db;
    constructor(dbPath = './trading_memory.db') {
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
    insert(trade) {
        this.db.prepare(`
      INSERT OR REPLACE INTO memory_trades (trade_id, signal, decision, pnl_percent, outcome, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(trade.tradeId, JSON.stringify(trade.signal), trade.decision, trade.pnlPercent, trade.outcome, trade.timestamp);
        return trade.tradeId;
    }
    getByIds(ids) {
        if (ids.length === 0)
            return [];
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.db.prepare(`SELECT * FROM memory_trades WHERE trade_id IN (${placeholders})`).all(...ids);
        return rows.map(row => ({
            tradeId: row['trade_id'],
            signal: JSON.parse(row['signal']),
            decision: row['decision'],
            pnlPercent: row['pnl_percent'],
            outcome: row['outcome'],
            timestamp: row['timestamp'],
        }));
    }
}
exports.TradeDB = TradeDB;
