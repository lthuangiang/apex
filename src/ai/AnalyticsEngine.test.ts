/**
 * AnalyticsEngine Tests — Unit + Property-Based
 *
 * Validates: design.md — Testing Strategy, P1, P2, P3, P4, P9, P10
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { isDeepStrictEqual } from 'node:util';
import { AnalyticsEngine } from './AnalyticsEngine.js';
import type { TradeRecord } from './TradeLogger.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let _idCounter = 0;
function makeTradeRecord(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: `trade-${++_idCounter}`,
    timestamp: new Date().toISOString(),
    symbol: 'BTC-USD',
    direction: 'long',
    confidence: 0.7,
    reasoning: 'test',
    fallback: false,
    entryPrice: 100,
    exitPrice: 101,
    pnl: 1,
    sessionPnl: 1,
    ...overrides,
  };
}

/** Build a trade with a specific UTC hour in its timestamp */
function makeTradeAtHour(hour: number, pnl = 1): TradeRecord {
  const d = new Date('2024-01-01T00:00:00.000Z');
  d.setUTCHours(hour);
  return makeTradeRecord({ timestamp: d.toISOString(), pnl });
}

// ─── fast-check arbitrary ────────────────────────────────────────────────────

function tradeRecordArbitrary(): fc.Arbitrary<TradeRecord> {
  return fc.record({
    id: fc.uuid(),
    // Use a fixed base + integer offset to avoid invalid date edge cases
    timestamp: fc.integer({ min: 0, max: 315360000 })
      .map(offset => new Date(1577836800000 + offset * 1000).toISOString()),
    symbol: fc.constantFrom('BTC-USD', 'ETH-USD', 'SOL-USD'),
    direction: fc.constantFrom('long' as const, 'short' as const),
    // confidence must be in [0,1] — use integer 0..100 scaled to float
    confidence: fc.integer({ min: 0, max: 100 }).map(n => n / 100),
    reasoning: fc.string(),
    fallback: fc.boolean(),
    entryPrice: fc.integer({ min: 1, max: 100000 }).map(n => n * 0.01),
    exitPrice: fc.integer({ min: 1, max: 100000 }).map(n => n * 0.01),
    pnl: fc.integer({ min: -100000, max: 100000 }).map(n => n * 0.01),
    sessionPnl: fc.integer({ min: -100000, max: 100000 }).map(n => n * 0.01),
  });
}

const engine = new AnalyticsEngine();

// ─── Property Tests ───────────────────────────────────────────────────────────

describe('P1: winRate is always in [0, 1]', () => {
  /**
   * **Validates: Requirements design.md P1**
   */
  it('overall.winRate is always between 0 and 1 for any array of trades', () => {
    fc.assert(
      fc.property(fc.array(tradeRecordArbitrary()), (trades) => {
        const s = engine.compute(trades);
        return s.overall.winRate >= 0 && s.overall.winRate <= 1;
      }),
    );
  });
});

describe('P2: wins + losses = total for every breakdown', () => {
  /**
   * **Validates: Requirements design.md P2**
   */
  it('overall.wins + overall.losses === overall.total for any array of trades', () => {
    fc.assert(
      fc.property(fc.array(tradeRecordArbitrary()), (trades) => {
        const s = engine.compute(trades);
        return s.overall.wins + s.overall.losses === s.overall.total;
      }),
    );
  });
});

describe('P9: compute is pure', () => {
  /**
   * **Validates: Requirements design.md P9**
   */
  it('same input always produces same output (shallow copy of array)', () => {
    fc.assert(
      fc.property(fc.array(tradeRecordArbitrary()), (trades) => {
        const result1 = engine.compute(trades);
        const result2 = engine.compute([...trades]);
        return isDeepStrictEqual(result1, result2);
      }),
    );
  });
});

describe('P10: empty input returns zero totals', () => {
  /**
   * **Validates: Requirements design.md P10**
   */
  it('compute([]).overall.total === 0 and compute([]).overall.winRate === 0', () => {
    const s = engine.compute([]);
    expect(s.overall.total).toBe(0);
    expect(s.overall.winRate).toBe(0);
  });
});

// ─── Unit Tests ───────────────────────────────────────────────────────────────

describe('AnalyticsEngine — unit tests', () => {
  describe('single trade cases', () => {
    it('single win: total=1, wins=1, losses=0, winRate=1', () => {
      const s = engine.compute([makeTradeRecord({ pnl: 5 })]);
      expect(s.overall.total).toBe(1);
      expect(s.overall.wins).toBe(1);
      expect(s.overall.losses).toBe(0);
      expect(s.overall.winRate).toBe(1);
    });

    it('single loss: total=1, wins=0, losses=1, winRate=0', () => {
      const s = engine.compute([makeTradeRecord({ pnl: -5 })]);
      expect(s.overall.total).toBe(1);
      expect(s.overall.wins).toBe(0);
      expect(s.overall.losses).toBe(1);
      expect(s.overall.winRate).toBe(0);
    });
  });

  describe('mixed win/loss', () => {
    it('3 wins and 1 loss → winRate = 0.75', () => {
      const trades = [
        makeTradeRecord({ pnl: 1 }),
        makeTradeRecord({ pnl: 2 }),
        makeTradeRecord({ pnl: 3 }),
        makeTradeRecord({ pnl: -1 }),
      ];
      const s = engine.compute(trades);
      expect(s.overall.wins).toBe(3);
      expect(s.overall.losses).toBe(1);
      expect(s.overall.winRate).toBeCloseTo(0.75);
    });
  });

  describe('streak detection', () => {
    it('3 wins then 2 losses → maxConsecWins=3, current={type:loss, count:2}', () => {
      // Timestamps must be ordered for streak sorting
      const base = new Date('2024-01-01T00:00:00.000Z').getTime();
      const trades = [
        makeTradeRecord({ pnl: 1, timestamp: new Date(base + 0).toISOString() }),
        makeTradeRecord({ pnl: 2, timestamp: new Date(base + 1000).toISOString() }),
        makeTradeRecord({ pnl: 3, timestamp: new Date(base + 2000).toISOString() }),
        makeTradeRecord({ pnl: -1, timestamp: new Date(base + 3000).toISOString() }),
        makeTradeRecord({ pnl: -2, timestamp: new Date(base + 4000).toISOString() }),
      ];
      const s = engine.compute(trades);
      expect(s.maxConsecWins).toBe(3);
      expect(s.currentStreak).toEqual({ type: 'loss', count: 2 });
    });
  });

  describe('fee impact', () => {
    it('grossPnl=0.01, pnl=-0.005 → wonBeforeFee=true is reflected in feeImpact', () => {
      const trade = makeTradeRecord({
        pnl: -0.005,
        grossPnl: 0.01,
        feePaid: 0.015,
        wonBeforeFee: true,
      });
      const s = engine.compute([trade]);
      expect(s.feeImpact.tradesWonBeforeFee).toBe(1);
      expect(s.feeImpact.feeLoserRate).toBe(1);
    });
  });

  describe('confidence bucket assignment', () => {
    it('trades at 0.55, 0.65, 0.75, 0.85 land in correct buckets', () => {
      const trades = [
        makeTradeRecord({ confidence: 0.55, pnl: 1 }),
        makeTradeRecord({ confidence: 0.65, pnl: 1 }),
        makeTradeRecord({ confidence: 0.75, pnl: 1 }),
        makeTradeRecord({ confidence: 0.85, pnl: 1 }),
      ];
      const s = engine.compute(trades);
      const bucket = (label: string) => s.byConfidence.find(b => b.label === label);

      expect(bucket('0.5–0.6')?.total).toBe(1);
      expect(bucket('0.6–0.7')?.total).toBe(1);
      expect(bucket('0.7–0.8')?.total).toBe(1);
      expect(bucket('0.8–1.0')?.total).toBe(1);
    });
  });

  describe('hour bucketing', () => {
    it('trades at 00:00, 12:00, 23:00 UTC appear in correct hour buckets', () => {
      const trades = [
        makeTradeAtHour(0),
        makeTradeAtHour(12),
        makeTradeAtHour(23),
      ];
      const s = engine.compute(trades);
      const hours = s.byHour.map(h => h.hour);
      expect(hours).toContain(0);
      expect(hours).toContain(12);
      expect(hours).toContain(23);

      const h0 = s.byHour.find(h => h.hour === 0);
      const h12 = s.byHour.find(h => h.hour === 12);
      const h23 = s.byHour.find(h => h.hour === 23);
      expect(h0?.total).toBe(1);
      expect(h12?.total).toBe(1);
      expect(h23?.total).toBe(1);
    });
  });

  describe('P3: bestTrade.pnl >= worstTrade.pnl', () => {
    it('bestTrade.pnl is always >= worstTrade.pnl', () => {
      const trades = [
        makeTradeRecord({ pnl: 10 }),
        makeTradeRecord({ pnl: -5 }),
        makeTradeRecord({ pnl: 3 }),
      ];
      const s = engine.compute(trades);
      expect(s.bestTrade).not.toBeNull();
      expect(s.worstTrade).not.toBeNull();
      expect(s.bestTrade!.pnl).toBeGreaterThanOrEqual(s.worstTrade!.pnl);
    });
  });

  describe('P4: streak invariant — maxConsecWins >= currentStreak.count when type is win', () => {
    it('maxConsecWins >= currentStreak.count when currentStreak.type is win', () => {
      const base = new Date('2024-01-01T00:00:00.000Z').getTime();
      const trades = [
        makeTradeRecord({ pnl: 1, timestamp: new Date(base + 0).toISOString() }),
        makeTradeRecord({ pnl: 2, timestamp: new Date(base + 1000).toISOString() }),
        makeTradeRecord({ pnl: 3, timestamp: new Date(base + 2000).toISOString() }),
      ];
      const s = engine.compute(trades);
      if (s.currentStreak.type === 'win') {
        expect(s.maxConsecWins).toBeGreaterThanOrEqual(s.currentStreak.count);
      }
    });

    it('maxConsecWins >= currentStreak.count holds across varied sequences', () => {
      // 2 wins, 1 loss, 4 wins → maxConsecWins=4, current={win,4}
      const base = new Date('2024-01-01T00:00:00.000Z').getTime();
      const trades = [
        makeTradeRecord({ pnl: 1, timestamp: new Date(base + 0).toISOString() }),
        makeTradeRecord({ pnl: 1, timestamp: new Date(base + 1000).toISOString() }),
        makeTradeRecord({ pnl: -1, timestamp: new Date(base + 2000).toISOString() }),
        makeTradeRecord({ pnl: 1, timestamp: new Date(base + 3000).toISOString() }),
        makeTradeRecord({ pnl: 1, timestamp: new Date(base + 4000).toISOString() }),
        makeTradeRecord({ pnl: 1, timestamp: new Date(base + 5000).toISOString() }),
        makeTradeRecord({ pnl: 1, timestamp: new Date(base + 6000).toISOString() }),
      ];
      const s = engine.compute(trades);
      expect(s.maxConsecWins).toBe(4);
      expect(s.currentStreak).toEqual({ type: 'win', count: 4 });
      expect(s.maxConsecWins).toBeGreaterThanOrEqual(s.currentStreak.count);
    });
  });
});
