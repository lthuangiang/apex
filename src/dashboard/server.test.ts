import { describe, it, expect, afterEach } from 'vitest';
import * as fc from 'fast-check';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import { TradeLogger, type TradeRecord } from '../ai/TradeLogger.js';
import { sharedState } from '../ai/sharedState.js';
import { DashboardServer } from './server.js';

// Feature: ai-alpha-execution-engine, Property 8: Dashboard trades endpoint returns records ordered by timestamp descending
// Validates: Requirements 6.2

// Feature: ai-alpha-execution-engine, Property 9: Dashboard PnL endpoint reflects current shared state
// Validates: Requirements 7.2

const tradeRecordArb = (timestamp: string) =>
  fc.record<TradeRecord>({
    id: fc.uuid(),
    timestamp: fc.constant(timestamp),
    symbol: fc.constantFrom('BTC-USD', 'ETH-USD', 'SOL-USD'),
    direction: fc.constantFrom('long' as const, 'short' as const),
    confidence: fc.float({ min: 0, max: 1, noNaN: true }),
    reasoning: fc.string({ minLength: 0, maxLength: 200 }),
    fallback: fc.boolean(),
    entryPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1_000_000), noNaN: true }),
    exitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(1_000_000), noNaN: true }),
    pnl: fc.float({ min: Math.fround(-100_000), max: Math.fround(100_000), noNaN: true }),
    sessionPnl: fc.float({ min: Math.fround(-100_000), max: Math.fround(100_000), noNaN: true }),
  });

function makeTempPath(ext: string): string {
  return path.join(os.tmpdir(), `dashboard-test-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

describe('DashboardServer — Property 8: trades endpoint returns records ordered by timestamp descending', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    tempFiles.length = 0;
  });

  it('GET /api/trades returns records sorted by timestamp descending', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.date({ min: new Date('2020-01-01'), max: new Date('2030-01-01') }).map((d) => d.toISOString()),
          { minLength: 2, maxLength: 10 },
        ),
        async (timestamps) => {
          const logPath = makeTempPath('json');
          tempFiles.push(logPath);
          const logger = new TradeLogger('json', logPath);
          const server = new DashboardServer(logger, 0);

          // Build and log one record per timestamp
          for (const ts of timestamps) {
            const [record] = fc.sample(tradeRecordArb(ts), 1);
            logger.log(record);
          }

          // Wait for fire-and-forget writes to complete
          await new Promise((resolve) => setTimeout(resolve, 30));

          const res = await request(server.app).get('/api/trades');
          expect(res.status).toBe(200);

          const body: TradeRecord[] = res.body;
          expect(Array.isArray(body)).toBe(true);

          // Assert descending order
          for (let i = 0; i < body.length - 1; i++) {
            expect(body[i].timestamp >= body[i + 1].timestamp).toBe(true);
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 30_000);
});

describe('DashboardServer — Property 9: PnL endpoint reflects current shared state', () => {
  it('GET /api/pnl returns the current sharedState.sessionPnl value', async () => {
    const logPath = makeTempPath('json');
    const logger = new TradeLogger('json', logPath);
    const server = new DashboardServer(logger, 0);

    await fc.assert(
      fc.asyncProperty(
        fc.float({ noNaN: true }),
        async (pnl) => {
          sharedState.sessionPnl = pnl;
          sharedState.updatedAt = new Date().toISOString();

          const res = await request(server.app).get('/api/pnl');
          expect(res.status).toBe(200);
          // JSON serialization normalizes -0 to 0, so use == comparison
          expect(res.body.sessionPnl == pnl).toBe(true);
        },
      ),
      { numRuns: 100 },
    );

    // Cleanup
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
  });
});
