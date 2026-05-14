/**
 * Property-Based Tests for BacktestMetricsCollector
 *
 * Uses fast-check to verify universal properties hold across arbitrary inputs.
 *
 * **Validates: Requirements 5.2, 5.3, 5.4**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { BacktestMetricsCollector } from '../BacktestMetricsCollector.js';
import type { BacktestRunConfig, BalanceSnapshot, SimulatedTrade } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid BacktestRunConfig for constructing a collector. */
function makeConfig(overrides: Partial<BacktestRunConfig> = {}): BacktestRunConfig {
  return {
    botId: 'test-bot',
    from: '2024-01-01',
    to: '2024-03-31',
    interval: '1h',
    initialBalance: 1000,
    makerFeeBps: 10,
    takerFeeBps: 15,
    slippageBps: 5,
    dataSource: 'local',
    ...overrides,
  };
}

/** Build a collector pre-loaded with the given equity curve snapshots. */
function collectorWithCurve(snapshots: Array<{ equity: number }>): BacktestMetricsCollector {
  const collector = new BacktestMetricsCollector('run-test', makeConfig());
  snapshots.forEach((s, i) => {
    const snapshot: BalanceSnapshot = {
      timestamp: new Date(Date.UTC(2024, 0, 1, i)).toISOString(),
      balance: s.equity, // balance == equity for simplicity (no open positions)
      equity: s.equity,
      drawdown: 0,       // drawdown field on snapshot is informational; collector recomputes
    };
    collector.recordTick(snapshot);
  });
  return collector;
}

// ---------------------------------------------------------------------------
// Property 4: Win Rate Bounds
// For any array of SimulatedTrade records (including empty), 0 ≤ winRate ≤ 1
// **Validates: Requirements 5.2, 5.3**
// ---------------------------------------------------------------------------

describe('Property 4 — Win Rate Bounds', () => {
  it('winRate is always in [0, 1] for any trade array', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            netPnl: fc.float({ noNaN: true }),
          }),
        ),
        (trades) => {
          const collector = new BacktestMetricsCollector('run-prop4', makeConfig());

          // Record a single tick so finalize() doesn't return the zero-value path
          collector.recordTick({
            timestamp: '2024-01-01T00:00:00.000Z',
            balance: 1000,
            equity: 1000,
            drawdown: 0,
          });

          // Record each generated trade (minimal required fields)
          trades.forEach((t, i) => {
            const trade: SimulatedTrade = {
              id: `trade-${i}`,
              symbol: 'BTC-USD',
              side: 'long',
              entryPrice: 100,
              exitPrice: 110,
              size: 1,
              entryTime: '2024-01-01T00:00:00.000Z',
              exitTime: '2024-01-01T01:00:00.000Z',
              holdingPeriodSecs: 3600,
              grossPnl: t.netPnl,
              netPnl: t.netPnl,
              feePaid: 0,
              exitReason: 'SIGNAL',
            };
            collector.recordTrade(trade);
          });

          const result = collector.finalize();
          expect(result.metrics.winRate).toBeGreaterThanOrEqual(0);
          expect(result.metrics.winRate).toBeLessThanOrEqual(1);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 5: Drawdown Non-Negative
// For any equity curve (array of BalanceSnapshot), maxDrawdown >= 0
// **Validates: Requirements 5.4**
// ---------------------------------------------------------------------------

describe('Property 5 — Drawdown Non-Negative', () => {
  it('maxDrawdown is always >= 0 for any equity curve', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            equity: fc.float({ min: 0, noNaN: true }),
          }),
          { minLength: 1 }, // at least one snapshot so finalize() uses the real path
        ),
        (snapshots) => {
          const collector = collectorWithCurve(snapshots);
          const result = collector.finalize();
          expect(result.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });

  it('maxDrawdown is 0 for a monotonically increasing equity curve', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0, max: 1e6, noNaN: true }), { minLength: 1 }),
        (values) => {
          // Sort ascending so equity never drops
          const sorted = [...values].sort((a, b) => a - b);
          const collector = collectorWithCurve(sorted.map((equity) => ({ equity })));
          const result = collector.finalize();
          // A strictly non-decreasing curve has zero drawdown
          expect(result.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
          // For a non-decreasing curve, drawdown should be 0 (or very close due to float precision)
          expect(result.metrics.maxDrawdown).toBeLessThanOrEqual(1e-6 * (sorted[sorted.length - 1] || 1) + 1e-9);
        },
      ),
    );
  });

  it('maxDrawdown equals peak minus trough for a single-peak curve', () => {
    // Concrete example: equity goes 100 → 200 → 50
    // Peak = 200, trough = 50, drawdown = 150
    const collector = collectorWithCurve([
      { equity: 100 },
      { equity: 200 },
      { equity: 50 },
    ]);
    const result = collector.finalize();
    expect(result.metrics.maxDrawdown).toBeCloseTo(150, 5);
    expect(result.metrics.maxDrawdown).toBeGreaterThanOrEqual(0);
  });

  it('maxDrawdown is 0 when equity curve has a single snapshot', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1e6, noNaN: true }),
        (equity) => {
          const collector = collectorWithCurve([{ equity }]);
          const result = collector.finalize();
          // Single point: peak == current, drawdown == 0
          expect(result.metrics.maxDrawdown).toBe(0);
        },
      ),
    );
  });
});
