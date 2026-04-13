import * as fs from 'fs';
import * as path from 'path';

// Signal snapshot captured at entry signal time
export interface SignalSnapshot {
  regime?: 'TREND_UP' | 'TREND_DOWN' | 'SIDEWAY' | 'HIGH_VOLATILITY';
  momentumScore?: number;
  ema9?: number;
  ema21?: number;
  rsi?: number;
  momentum3candles?: number;
  volSpike?: boolean;
  emaCrossUp?: boolean;
  emaCrossDown?: boolean;
  imbalance?: number;
  tradePressure?: number;
  lsRatio?: number;
  llmDirection?: 'long' | 'short' | 'skip';
  llmConfidence?: number;
  llmMatchesMomentum?: boolean;
  atrPct?: number;
  bbWidth?: number;
  volRatio?: number;
}

export interface TradeRecord extends SignalSnapshot {
  // ── Core fields (always present) ─────────────────────────────────
  id: string;
  timestamp: string;        // ISO 8601 — trade close time
  symbol: string;
  direction: 'long' | 'short';
  confidence: number;
  reasoning: string;
  fallback: boolean;
  entryPrice: number;
  exitPrice: number;
  pnl: number;              // net PnL after fees
  sessionPnl: number;

  // ── Trade metadata (new, optional for backward compat) ───────────
  mode?: 'farm' | 'trade';
  entryTime?: string;       // ISO 8601 — when entry was filled
  exitTime?: string;        // ISO 8601 — same as timestamp
  holdingTimeSecs?: number;
  exitTrigger?: 'FARM_TP' | 'FARM_TIME' | 'FARM_EARLY_PROFIT' | 'FARM_MM_TP' | 'SL' | 'TP' | 'FORCE' | 'EXTERNAL';

  // ── Fee analysis (new, optional) ─────────────────────────────────
  grossPnl?: number;        // PnL before fees
  feePaid?: number;         // total fee in USD (round-trip)
  wonBeforeFee?: boolean;   // grossPnl > 0 but pnl <= 0

  // ── Sizing metadata (optional) ────────────────────────────────────
  sizingConfMult?: number;
  sizingPerfMult?: number;
  sizingCombinedMult?: number;
  sizingCappedBy?: 'none' | 'btc_cap' | 'balance_pct';

  // ── Market Making metadata (optional) ─────────────────────────────
  mmPingPongBias?: number;
  mmInventoryBias?: number;
  mmDynamicTP?: number;
  mmNetExposure?: number;
}

export class TradeLogger {
  private backend: 'json' | 'sqlite';
  private logPath: string;
  private db: import('better-sqlite3').Database | null = null;

  /** Called after each successful trade log — use to invalidate analytics cache */
  onTradeLogged?: () => void;

  constructor(backend: 'json' | 'sqlite', logPath: string) {
    this.backend = backend;
    this.logPath = logPath;

    if (backend === 'sqlite') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const Database = require('better-sqlite3');
        this.db = new Database(logPath);
        this.db!.exec(`
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
        this._migrate();
      } catch (err) {
        console.error('[TradeLogger] Failed to initialize SQLite database:', err);
        this.db = null;
      }
    }
  }

  /** Idempotent migration — adds new columns, swallows duplicate column errors */
  private _migrate(): void {
    if (!this.db) return;
    const newCols: [string, string][] = [
      ['mode', 'TEXT'],
      ['entry_time', 'TEXT'],
      ['exit_time', 'TEXT'],
      ['holding_time_secs', 'REAL'],
      ['exit_trigger', 'TEXT'],
      ['gross_pnl', 'REAL'],
      ['fee_paid', 'REAL'],
      ['won_before_fee', 'INTEGER'],
      ['regime', 'TEXT'],
      ['momentum_score', 'REAL'],
      ['ema9', 'REAL'],
      ['ema21', 'REAL'],
      ['rsi', 'REAL'],
      ['momentum_3candles', 'REAL'],
      ['vol_spike', 'INTEGER'],
      ['ema_cross_up', 'INTEGER'],
      ['ema_cross_down', 'INTEGER'],
      ['imbalance', 'REAL'],
      ['trade_pressure', 'REAL'],
      ['ls_ratio', 'REAL'],
      ['llm_direction', 'TEXT'],
      ['llm_confidence', 'REAL'],
      ['llm_matches_momentum', 'INTEGER'],
      ['atr_pct', 'REAL'],
      ['bb_width', 'REAL'],
      ['vol_ratio', 'REAL'],
    ];
    for (const [col, type] of newCols) {
      try {
        this.db.exec(`ALTER TABLE trades ADD COLUMN ${col} ${type}`);
      } catch {
        // Column already exists — safe to ignore
      }
    }
  }

  log(record: TradeRecord): void {
    if (this.backend === 'json') {
      fs.promises.appendFile(this.logPath, JSON.stringify(record) + '\n').catch((err) => {
        console.error('[TradeLogger] Failed to write JSON record:', err);
      }).then(() => this.onTradeLogged?.());
    } else {
      try {
        if (!this.db) { console.error('[TradeLogger] SQLite database not initialized'); return; }
        const stmt = this.db.prepare(`
          INSERT INTO trades (
            id, timestamp, symbol, direction, confidence, reasoning, fallback,
            entry_price, exit_price, pnl, session_pnl,
            mode, entry_time, exit_time, holding_time_secs, exit_trigger,
            gross_pnl, fee_paid, won_before_fee,
            regime, momentum_score, ema9, ema21, rsi, momentum_3candles,
            vol_spike, ema_cross_up, ema_cross_down, imbalance, trade_pressure,
            ls_ratio, llm_direction, llm_confidence, llm_matches_momentum,
            atr_pct, bb_width, vol_ratio
          ) VALUES (
            ?,?,?,?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
            ?,?,?
          )
        `);
        stmt.run(
          record.id, record.timestamp, record.symbol, record.direction,
          record.confidence, record.reasoning, record.fallback ? 1 : 0,
          record.entryPrice, record.exitPrice, record.pnl, record.sessionPnl,
          record.mode ?? null, record.entryTime ?? null, record.exitTime ?? null,
          record.holdingTimeSecs ?? null, record.exitTrigger ?? null,
          record.grossPnl ?? null, record.feePaid ?? null,
          record.wonBeforeFee != null ? (record.wonBeforeFee ? 1 : 0) : null,
          record.regime ?? null, record.momentumScore ?? null,
          record.ema9 ?? null, record.ema21 ?? null, record.rsi ?? null,
          record.momentum3candles ?? null,
          record.volSpike != null ? (record.volSpike ? 1 : 0) : null,
          record.emaCrossUp != null ? (record.emaCrossUp ? 1 : 0) : null,
          record.emaCrossDown != null ? (record.emaCrossDown ? 1 : 0) : null,
          record.imbalance ?? null, record.tradePressure ?? null,
          record.lsRatio ?? null, record.llmDirection ?? null,
          record.llmConfidence ?? null,
          record.llmMatchesMomentum != null ? (record.llmMatchesMomentum ? 1 : 0) : null,
          record.atrPct ?? null, record.bbWidth ?? null, record.volRatio ?? null,
        );
        this.onTradeLogged?.();
      } catch (err) {
        console.error('[TradeLogger] Failed to insert SQLite record:', err);
      }
    }
  }

  async readAll(): Promise<TradeRecord[]> {
    try {
      return this.backend === 'json' ? await this._readAllJson() : this._readAllSqlite();
    } catch (err) {
      console.error('[TradeLogger] Failed to read records:', err);
      return [];
    }
  }

  private async _readAllJson(): Promise<TradeRecord[]> {
    let content: string;
    try { content = await fs.promises.readFile(this.logPath, 'utf-8'); }
    catch { return []; }
    const records: TradeRecord[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try { records.push(JSON.parse(trimmed) as TradeRecord); } catch { /* skip */ }
    }
    records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    return records;
  }

  private _readAllSqlite(): TradeRecord[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT * FROM trades ORDER BY timestamp DESC').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r['id'] as string,
      timestamp: r['timestamp'] as string,
      symbol: r['symbol'] as string,
      direction: r['direction'] as 'long' | 'short',
      confidence: r['confidence'] as number,
      reasoning: r['reasoning'] as string,
      fallback: (r['fallback'] as number) === 1,
      entryPrice: r['entry_price'] as number,
      exitPrice: r['exit_price'] as number,
      pnl: r['pnl'] as number,
      sessionPnl: r['session_pnl'] as number,
      mode: r['mode'] as 'farm' | 'trade' | undefined ?? undefined,
      entryTime: r['entry_time'] as string | undefined ?? undefined,
      exitTime: r['exit_time'] as string | undefined ?? undefined,
      holdingTimeSecs: r['holding_time_secs'] as number | undefined ?? undefined,
      exitTrigger: r['exit_trigger'] as TradeRecord['exitTrigger'] ?? undefined,
      grossPnl: r['gross_pnl'] as number | undefined ?? undefined,
      feePaid: r['fee_paid'] as number | undefined ?? undefined,
      wonBeforeFee: r['won_before_fee'] != null ? (r['won_before_fee'] as number) === 1 : undefined,
      regime: r['regime'] as TradeRecord['regime'] ?? undefined,
      momentumScore: r['momentum_score'] as number | undefined ?? undefined,
      ema9: r['ema9'] as number | undefined ?? undefined,
      ema21: r['ema21'] as number | undefined ?? undefined,
      rsi: r['rsi'] as number | undefined ?? undefined,
      momentum3candles: r['momentum_3candles'] as number | undefined ?? undefined,
      volSpike: r['vol_spike'] != null ? (r['vol_spike'] as number) === 1 : undefined,
      emaCrossUp: r['ema_cross_up'] != null ? (r['ema_cross_up'] as number) === 1 : undefined,
      emaCrossDown: r['ema_cross_down'] != null ? (r['ema_cross_down'] as number) === 1 : undefined,
      imbalance: r['imbalance'] as number | undefined ?? undefined,
      tradePressure: r['trade_pressure'] as number | undefined ?? undefined,
      lsRatio: r['ls_ratio'] as number | undefined ?? undefined,
      llmDirection: r['llm_direction'] as TradeRecord['llmDirection'] ?? undefined,
      llmConfidence: r['llm_confidence'] as number | undefined ?? undefined,
      llmMatchesMomentum: r['llm_matches_momentum'] != null ? (r['llm_matches_momentum'] as number) === 1 : undefined,
      atrPct: r['atr_pct'] as number | undefined ?? undefined,
      bbWidth: r['bb_width'] as number | undefined ?? undefined,
      volRatio: r['vol_ratio'] as number | undefined ?? undefined,
    }));
  }
}
