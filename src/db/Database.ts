/**
 * Database.ts — Singleton SQLite database for DRIFT runtime state.
 *
 * Stores bot state, signal weights, and agent layer state in a single
 * WAL-mode SQLite file at DATA_DIR/drift.db.
 *
 * Usage:
 *   import { getDb } from '../db/Database.js';
 *   const db = getDb();
 *   db.prepare('SELECT ...').all();
 */

import Database from 'better-sqlite3';
import { dataPath } from '../utils/dataDir.js';

const DB_PATH = dataPath('drift.db');

let _instance: Database.Database | null = null;

/**
 * Get the singleton database instance. Creates and initializes on first call.
 */
export function getDb(): Database.Database {
  if (_instance) return _instance;

  _instance = new Database(DB_PATH);

  // WAL mode for better concurrency (reads don't block writes)
  _instance.pragma('journal_mode = WAL');
  // Synchronous NORMAL balances safety and performance
  _instance.pragma('synchronous = NORMAL');
  // Increase cache for fewer disk reads
  _instance.pragma('cache_size = -8000'); // ~8MB

  _initSchema(_instance);

  return _instance;
}

/**
 * Close the database (call on shutdown).
 */
export function closeDb(): void {
  if (_instance) {
    _instance.close();
    _instance = null;
  }
}

/**
 * Get the database file path (for logging/diagnostics).
 */
export function getDbPath(): string {
  return DB_PATH;
}

// ─── Schema Initialization ──────────────────────────────────────────────────

function _initSchema(db: Database.Database): void {
  db.exec(`
    -- Schema version tracking
    CREATE TABLE IF NOT EXISTS schema_version (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- Bot session state (replaces bot_state*.json)
    CREATE TABLE IF NOT EXISTS bot_state (
      bot_id TEXT PRIMARY KEY,
      session_pnl REAL NOT NULL DEFAULT 0,
      session_volume REAL NOT NULL DEFAULT 0,
      session_fees REAL NOT NULL DEFAULT 0,
      session_gross_pnl REAL NOT NULL DEFAULT 0,
      session_start_balance REAL,
      current_balance REAL,
      today_volume REAL NOT NULL DEFAULT 0,
      today_volume_date TEXT,
      pnl_history TEXT NOT NULL DEFAULT '[]',
      volume_history TEXT NOT NULL DEFAULT '[]',
      event_log TEXT NOT NULL DEFAULT '[]',
      saved_at TEXT NOT NULL
    );

    -- Signal weights (replaces signal-weights.json)
    CREATE TABLE IF NOT EXISTS signal_weights (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ema REAL NOT NULL DEFAULT 0.40,
      rsi REAL NOT NULL DEFAULT 0.25,
      momentum REAL NOT NULL DEFAULT 0.20,
      imbalance REAL NOT NULL DEFAULT 0.15,
      updated_at TEXT,
      trade_count INTEGER DEFAULT 0
    );

    -- Agent layer state (replaces agent-state.json)
    CREATE TABLE IF NOT EXISTS agent_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      decision_history TEXT NOT NULL DEFAULT '[]',
      cycle_count INTEGER NOT NULL DEFAULT 0,
      cycle_latencies TEXT NOT NULL DEFAULT '[]',
      strategy_performance TEXT NOT NULL DEFAULT '{}',
      total_cycle_time_ms REAL NOT NULL DEFAULT 0,
      lifecycle_state TEXT NOT NULL DEFAULT 'STOPPED',
      saved_at TEXT NOT NULL
    );
  `);

  // Ensure schema_version row exists
  const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number } | undefined;
  if (!row) {
    db.prepare('INSERT INTO schema_version (id, version, updated_at) VALUES (1, 1, ?)').run(
      new Date().toISOString()
    );
  }

  // Run migrations if needed
  _migrate(db);
}

/**
 * Idempotent schema migrations. Bumps version after each migration block.
 */
function _migrate(db: Database.Database): void {
  const row = db.prepare('SELECT version FROM schema_version WHERE id = 1').get() as { version: number };
  let version = row.version;

  // ── Migration 2: Reporting & Analytics tables ────────────────────────────────
  if (version < 2) {
    db.exec(`
      -- Trade events: full record of every closed position
      CREATE TABLE IF NOT EXISTS trade_events (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        bot_type TEXT NOT NULL DEFAULT 'standard',
        exchange TEXT NOT NULL,
        symbol TEXT NOT NULL,
        direction TEXT NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL NOT NULL,
        size REAL NOT NULL,
        notional_usd REAL NOT NULL,
        pnl REAL NOT NULL,
        gross_pnl REAL,
        fees REAL NOT NULL DEFAULT 0,
        volume_usd REAL NOT NULL,
        hold_duration_secs REAL,
        exit_reason TEXT,
        signal_source TEXT,
        regime TEXT,
        confidence REAL,
        -- DN-specific fields
        exchange_b TEXT,
        pnl_a REAL,
        pnl_b REAL,
        funding_net REAL,
        oi_hours REAL,
        -- Context
        wallet_address TEXT,
        account_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Indexes for common report queries
      CREATE INDEX IF NOT EXISTS idx_trade_events_timestamp ON trade_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_trade_events_bot_id ON trade_events(bot_id);
      CREATE INDEX IF NOT EXISTS idx_trade_events_exchange ON trade_events(exchange);
      CREATE INDEX IF NOT EXISTS idx_trade_events_date ON trade_events(date(timestamp));
      CREATE INDEX IF NOT EXISTS idx_trade_events_wallet ON trade_events(wallet_address);

      -- Balance snapshots: equity captures at specific moments
      CREATE TABLE IF NOT EXISTS balance_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        exchange TEXT NOT NULL,
        account_id TEXT,
        wallet_address TEXT,
        equity REAL NOT NULL,
        available_margin REAL,
        used_margin REAL,
        open_position_count INTEGER DEFAULT 0,
        trigger TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_balance_snapshots_timestamp ON balance_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_balance_snapshots_account ON balance_snapshots(account_id);
      CREATE INDEX IF NOT EXISTS idx_balance_snapshots_exchange ON balance_snapshots(exchange);
      CREATE INDEX IF NOT EXISTS idx_balance_snapshots_date ON balance_snapshots(date(timestamp));
      CREATE INDEX IF NOT EXISTS idx_balance_snapshots_wallet ON balance_snapshots(wallet_address);

      -- Volume counters: daily aggregated volume (upsert pattern)
      CREATE TABLE IF NOT EXISTS volume_counters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        exchange TEXT NOT NULL,
        account_id TEXT,
        bot_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        wallet_address TEXT,
        volume_usd REAL NOT NULL DEFAULT 0,
        trade_count INTEGER NOT NULL DEFAULT 0,
        fees_usd REAL NOT NULL DEFAULT 0,
        pnl_usd REAL NOT NULL DEFAULT 0,
        UNIQUE(date, exchange, bot_id, symbol)
      );

      CREATE INDEX IF NOT EXISTS idx_volume_counters_date ON volume_counters(date);
      CREATE INDEX IF NOT EXISTS idx_volume_counters_exchange ON volume_counters(exchange);
      CREATE INDEX IF NOT EXISTS idx_volume_counters_bot ON volume_counters(bot_id);
      CREATE INDEX IF NOT EXISTS idx_volume_counters_wallet ON volume_counters(wallet_address);
    `);
    version = 2;
  }

  // Update version if changed
  if (version !== row.version) {
    db.prepare('UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1').run(
      version,
      new Date().toISOString()
    );
  }
}
