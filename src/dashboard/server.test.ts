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

// ── Task 7.2: GET /api/feedback-loop/stats route tests ───────────────────────

import { vi } from 'vitest';
import * as ComponentPerformanceTrackerModule from '../ai/FeedbackLoop/ComponentPerformanceTracker.js';
import * as WeightStoreModule from '../ai/FeedbackLoop/WeightStore.js';
import * as ConfidenceCalibratorModule from '../ai/FeedbackLoop/ConfidenceCalibrator.js';

describe('DashboardServer — GET /api/feedback-loop/stats', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 with valid JSON shape when no trades exist (defaults)', async () => {
    const logPath = makeTempPath('json');
    const logger = new TradeLogger('json', logPath);
    const server = new DashboardServer(logger, 0);

    const res = await request(server.app).get('/api/feedback-loop/stats');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);

    const body = res.body as {
      weights: Record<string, unknown>;
      componentStats: Record<string, unknown>;
      confidenceBuckets: unknown[];
    };

    // Top-level shape
    expect(body).toHaveProperty('weights');
    expect(body).toHaveProperty('componentStats');
    expect(body).toHaveProperty('confidenceBuckets');

    // weights shape: ema, rsi, momentum, imbalance
    expect(typeof body.weights.ema).toBe('number');
    expect(typeof body.weights.rsi).toBe('number');
    expect(typeof body.weights.momentum).toBe('number');
    expect(typeof body.weights.imbalance).toBe('number');

    // componentStats shape
    const cs = body.componentStats as Record<string, unknown>;
    expect(cs).toHaveProperty('ema');
    expect(cs).toHaveProperty('rsi');
    expect(cs).toHaveProperty('momentum');
    expect(cs).toHaveProperty('imbalance');

    // confidenceBuckets is an array
    expect(Array.isArray(body.confidenceBuckets)).toBe(true);

    // Cleanup
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
  });

  it('returns populated componentStats when getStats() returns non-zero data', async () => {
    const logPath = makeTempPath('json');
    const logger = new TradeLogger('json', logPath);
    const server = new DashboardServer(logger, 0);

    // Mock componentPerformanceTracker.getStats() to return non-zero stats
    const mockStats: ComponentPerformanceTrackerModule.ComponentStats = {
      ema: { total: 20, wins: 14, winRate: 0.7 },
      rsi: { total: 10, wins: 6, winRate: 0.6, lossStreak: 1 },
      momentum: { total: 18, wins: 11, winRate: 0.611 },
      imbalance: { total: 15, wins: 8, winRate: 0.533 },
      computedAt: new Date().toISOString(),
      lookbackN: 50,
    };

    vi.spyOn(ComponentPerformanceTrackerModule.componentPerformanceTracker, 'getStats')
      .mockReturnValue(mockStats);

    const res = await request(server.app).get('/api/feedback-loop/stats');

    expect(res.status).toBe(200);

    const body = res.body as {
      weights: Record<string, unknown>;
      componentStats: typeof mockStats;
      confidenceBuckets: unknown[];
    };

    // componentStats reflects the mocked non-zero values
    expect(body.componentStats.ema.total).toBe(20);
    expect(body.componentStats.ema.wins).toBe(14);
    expect(body.componentStats.ema.winRate).toBeCloseTo(0.7);

    expect(body.componentStats.rsi.total).toBe(10);
    expect(body.componentStats.rsi.lossStreak).toBe(1);

    expect(body.componentStats.momentum.total).toBe(18);
    expect(body.componentStats.imbalance.total).toBe(15);

    // weights still has the expected shape
    expect(typeof body.weights.ema).toBe('number');
    expect(typeof body.weights.rsi).toBe('number');
    expect(typeof body.weights.momentum).toBe('number');
    expect(typeof body.weights.imbalance).toBe('number');

    // confidenceBuckets is still an array
    expect(Array.isArray(body.confidenceBuckets)).toBe(true);

    // Cleanup
    try { fs.unlinkSync(logPath); } catch { /* ignore */ }
  });
});
