"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TradeLogger = void 0;
const fs = __importStar(require("fs"));
class TradeLogger {
    backend;
    logPath;
    db = null;
    constructor(backend, logPath) {
        this.backend = backend;
        this.logPath = logPath;
        if (backend === 'sqlite') {
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                const Database = require('better-sqlite3');
                this.db = new Database(logPath);
                this.db.exec(`
          CREATE TABLE IF NOT EXISTS trades (
            id TEXT PRIMARY KEY,
            timestamp TEXT NOT NULL,
            symbol TEXT NOT NULL,
            direction TEXT NOT NULL,
            confidence REAL NOT NULL,
            reasoning TEXT NOT NULL,
            fallback INTEGER NOT NULL,
            entry_price REAL NOT NULL,
            exit_price REAL NOT NULL,
            pnl REAL NOT NULL,
            session_pnl REAL NOT NULL
          );
        `);
            }
            catch (err) {
                console.error('[TradeLogger] Failed to initialize SQLite database:', err);
                this.db = null;
            }
        }
    }
    log(record) {
        if (this.backend === 'json') {
            // Fire-and-forget async write
            fs.promises.appendFile(this.logPath, JSON.stringify(record) + '\n').catch((err) => {
                console.error('[TradeLogger] Failed to write JSON record:', err);
            });
        }
        else {
            // SQLite synchronous insert — fire-and-forget (wrap in try/catch)
            try {
                if (!this.db) {
                    console.error('[TradeLogger] SQLite database not initialized');
                    return;
                }
                const stmt = this.db.prepare(`
          INSERT INTO trades (id, timestamp, symbol, direction, confidence, reasoning, fallback, entry_price, exit_price, pnl, session_pnl)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
                stmt.run(record.id, record.timestamp, record.symbol, record.direction, record.confidence, record.reasoning, record.fallback ? 1 : 0, record.entryPrice, record.exitPrice, record.pnl, record.sessionPnl);
            }
            catch (err) {
                console.error('[TradeLogger] Failed to insert SQLite record:', err);
            }
        }
    }
    async readAll() {
        try {
            if (this.backend === 'json') {
                return await this._readAllJson();
            }
            else {
                return this._readAllSqlite();
            }
        }
        catch (err) {
            console.error('[TradeLogger] Failed to read records:', err);
            return [];
        }
    }
    async _readAllJson() {
        let content;
        try {
            content = await fs.promises.readFile(this.logPath, 'utf-8');
        }
        catch {
            // File doesn't exist yet — return empty
            return [];
        }
        const records = [];
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            try {
                records.push(JSON.parse(trimmed));
            }
            catch {
                // Skip malformed lines
            }
        }
        // Sort by timestamp descending
        records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return records;
    }
    _readAllSqlite() {
        if (!this.db)
            return [];
        const rows = this.db
            .prepare('SELECT * FROM trades ORDER BY timestamp DESC')
            .all();
        return rows.map((row) => ({
            id: row['id'],
            timestamp: row['timestamp'],
            symbol: row['symbol'],
            direction: row['direction'],
            confidence: row['confidence'],
            reasoning: row['reasoning'],
            fallback: row['fallback'] === 1,
            entryPrice: row['entry_price'],
            exitPrice: row['exit_price'],
            pnl: row['pnl'],
            sessionPnl: row['session_pnl'],
        }));
    }
}
exports.TradeLogger = TradeLogger;
