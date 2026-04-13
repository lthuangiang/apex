import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { TradeLogger, type TradeRecord } from './TradeLogger.js';

// Feature: ai-alpha-execution-engine, Property 5: TradeLogger round-trip fidelity
// Validates: Requirements 4.1, 4.2, 4.3, 4.4

const tradeRecordArb = fc.record<TradeRecord>({
  id: fc.uuid(),
  timestamp: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01'), noInvalidDate: true }).map((d) => d.toISOString()),
  symbol: fc.constantFrom('BTC-USD', 'ETH-USD', 'SOL-USD'),
  direction: fc.constantFrom('long' as const, 'short' as const),
  confidence: fc.float({ min: 0, max: 1, noNaN: true }),
  reasoning: fc.string({ minLength: 0, maxLength: 500 }),
  fallback: fc.boolean(),
  entryPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1_000_000), noNaN: true }),
  exitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1_000_000), noNaN: true }),
  pnl: fc.float({ min: Math.fround(-100_000), max: Math.fround(100_000), noNaN: true }),
  sessionPnl: fc.float({ min: Math.fround(-100_000), max: Math.fround(100_000), noNaN: true }),
});

function makeTempPath(ext: string): string {
  return path.join(os.tmpdir(), `trade-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

describe('TradeLogger — Property 5: round-trip fidelity (JSON backend)', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    tempFiles.length = 0;
  });

  it('logged record is returned by readAll() with identical fields', async () => {
    await fc.assert(
      fc.asyncProperty(tradeRecordArb, async (record) => {
        const logPath = makeTempPath('json');
        tempFiles.push(logPath);
        const logger = new TradeLogger('json', logPath);

        logger.log(record);

        // Give the fire-and-forget async write time to complete
        await new Promise((resolve) => setTimeout(resolve, 50));

        const all = await logger.readAll();
        const found = all.find((r) => r.id === record.id);

        expect(found).toBeDefined();
        expect(found!.id).toBe(record.id);
        expect(found!.timestamp).toBe(record.timestamp);
        expect(found!.symbol).toBe(record.symbol);
        expect(found!.direction).toBe(record.direction);
        expect(found!.confidence).toBeCloseTo(record.confidence, 10);
        expect(found!.reasoning).toBe(record.reasoning);
        expect(found!.fallback).toBe(record.fallback);
        expect(found!.entryPrice).toBeCloseTo(record.entryPrice, 5);
        expect(found!.exitPrice).toBeCloseTo(record.exitPrice, 5);
        expect(found!.pnl).toBeCloseTo(record.pnl, 5);
        expect(found!.sessionPnl).toBeCloseTo(record.sessionPnl, 5);
      }),
      { numRuns: 50 },
    );
  });
});

describe('TradeLogger — Property 5: round-trip fidelity (SQLite backend)', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    tempFiles.length = 0;
  });

  it('logged record is returned by readAll() with identical fields', async () => {
    await fc.assert(
      fc.asyncProperty(tradeRecordArb, async (record) => {
        const logPath = makeTempPath('db');
        tempFiles.push(logPath);
        const logger = new TradeLogger('sqlite', logPath);

        logger.log(record);

        // SQLite is synchronous — no delay needed, but readAll is async
        const all = await logger.readAll();
        const found = all.find((r) => r.id === record.id);

        expect(found).toBeDefined();
        expect(found!.id).toBe(record.id);
        expect(found!.timestamp).toBe(record.timestamp);
        expect(found!.symbol).toBe(record.symbol);
        expect(found!.direction).toBe(record.direction);
        expect(found!.confidence).toBeCloseTo(record.confidence, 10);
        expect(found!.reasoning).toBe(record.reasoning);
        expect(found!.fallback).toBe(record.fallback);
        expect(found!.entryPrice).toBeCloseTo(record.entryPrice, 5);
        expect(found!.exitPrice).toBeCloseTo(record.exitPrice, 5);
        expect(found!.pnl).toBeCloseTo(record.pnl, 5);
        expect(found!.sessionPnl).toBeCloseTo(record.sessionPnl, 5);
      }),
      { numRuns: 50 },
    );
  });
});

// Task 1.4: Migration idempotency tests
// Validates: design.md — TradeLogger.migrate() spec

const NEW_COLUMNS = [
  'mode', 'entry_time', 'exit_time', 'holding_time_secs', 'exit_trigger',
  'gross_pnl', 'fee_paid', 'won_before_fee', 'regime', 'momentum_score',
  'ema9', 'ema21', 'rsi', 'momentum_3candles', 'vol_spike',
  'ema_cross_up', 'ema_cross_down', 'imbalance', 'trade_pressure',
  'ls_ratio', 'llm_direction', 'llm_confidence', 'llm_matches_momentum',
];

describe('TradeLogger — migration idempotency', () => {
  it('constructing twice on the same DB does not throw', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');

    // First construction: create table + migrate
    expect(() => {
      const logger1 = new TradeLogger('sqlite', ':memory:');
      void logger1; // suppress unused warning
    }).not.toThrow();

    db.close();

    // Second construction on a fresh in-memory DB (same path ':memory:' opens a new DB each time)
    // To test true idempotency on the same DB, we use a temp file
    const tempPath = makeTempPath('db');
    try {
      expect(() => new TradeLogger('sqlite', tempPath)).not.toThrow();
      expect(() => new TradeLogger('sqlite', tempPath)).not.toThrow();
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  });

  it('all new columns are present after migration', () => {
    const tempPath = makeTempPath('db');
    try {
      // Construct once to trigger migration
      new TradeLogger('sqlite', tempPath);

      // Open the same DB and inspect schema
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = new Database(tempPath);
      const cols = (db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      db.close();

      for (const col of NEW_COLUMNS) {
        expect(cols, `expected column "${col}" to exist after migration`).toContain(col);
      }
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  });

  it('calling migration twice (two constructors on same file) does not throw and columns remain', () => {
    const tempPath = makeTempPath('db');
    try {
      // First constructor — creates table and migrates
      expect(() => new TradeLogger('sqlite', tempPath)).not.toThrow();
      // Second constructor — migration runs again; duplicate column errors must be swallowed
      expect(() => new TradeLogger('sqlite', tempPath)).not.toThrow();

      // Columns still present
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const Database = require('better-sqlite3');
      const db = new Database(tempPath);
      const cols = (db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>)
        .map((c) => c.name);
      db.close();

      for (const col of NEW_COLUMNS) {
        expect(cols, `expected column "${col}" to still exist after double migration`).toContain(col);
      }
    } finally {
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  });
});
