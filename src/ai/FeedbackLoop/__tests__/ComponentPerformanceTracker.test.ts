import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeComponentStats, ComponentPerformanceTracker } from '../ComponentPerformanceTracker';
import type { TradeRecord } from '../../TradeLogger';

// Minimal helper to build a TradeRecord with only required fields + overrides
function makeTrade(overrides: Partial<TradeRecord>): TradeRecord {
  return {
    id: 'test-id',
    timestamp: new Date().toISOString(),
    symbol: 'BTC',
    direction: 'long',
    confidence: 0.8,
    reasoning: '',
    fallback: false,
    entryPrice: 100,
    exitPrice: 110,
    pnl: 10,
    sessionPnl: 10,
    ...overrides,
  };
}

// ─── computeComponentStats tests ─────────────────────────────────────────────

describe('computeComponentStats – EMA attribution', () => {
  it('counts a win when ema9 > ema21, direction=long, pnl>0', () => {
    const trade = makeTrade({ ema9: 200, ema21: 100, direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.ema.total).toBe(1);
    expect(stats.ema.wins).toBe(1);
    expect(stats.ema.winRate).toBe(1);
  });

  it('does NOT count a win when ema9 > ema21 but direction=short', () => {
    const trade = makeTrade({ ema9: 200, ema21: 100, direction: 'short', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.ema.total).toBe(1);
    expect(stats.ema.wins).toBe(0);
  });

  it('does NOT count a win when ema9 > ema21, direction=long, but pnl<=0', () => {
    const trade = makeTrade({ ema9: 200, ema21: 100, direction: 'long', pnl: -5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.ema.total).toBe(1);
    expect(stats.ema.wins).toBe(0);
  });

  it('predicts short when ema9 < ema21 and counts win for short+profit', () => {
    const trade = makeTrade({ ema9: 50, ema21: 100, direction: 'short', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.ema.wins).toBe(1);
  });

  it('skips trade when ema fields are missing', () => {
    const trade = makeTrade({ direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.ema.total).toBe(0);
  });
});

describe('computeComponentStats – RSI extreme-zone filtering', () => {
  it('excludes trades with rsi in [35, 65] (rsi=50)', () => {
    const trade = makeTrade({ rsi: 50, direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.rsi.total).toBe(0);
  });

  it('excludes trades with rsi exactly at boundary 35', () => {
    const trade = makeTrade({ rsi: 35, direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.rsi.total).toBe(0);
  });

  it('excludes trades with rsi exactly at boundary 65', () => {
    const trade = makeTrade({ rsi: 65, direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.rsi.total).toBe(0);
  });

  it('predicts long when rsi < 35 and counts win for long+profit', () => {
    const trade = makeTrade({ rsi: 20, direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.rsi.total).toBe(1);
    expect(stats.rsi.wins).toBe(1);
  });

  it('predicts short when rsi > 65 and counts win for short+profit', () => {
    const trade = makeTrade({ rsi: 80, direction: 'short', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.rsi.total).toBe(1);
    expect(stats.rsi.wins).toBe(1);
  });

  it('does NOT count win when rsi < 35 but direction=short', () => {
    const trade = makeTrade({ rsi: 20, direction: 'short', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.rsi.total).toBe(1);
    expect(stats.rsi.wins).toBe(0);
  });
});

describe('computeComponentStats – Momentum attribution', () => {
  it('predicts long when momentum3candles > 0 and counts win for long+profit', () => {
    const trade = makeTrade({ momentum3candles: 0.5, direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.momentum.total).toBe(1);
    expect(stats.momentum.wins).toBe(1);
  });

  it('predicts short when momentum3candles < 0 and counts win for short+profit', () => {
    const trade = makeTrade({ momentum3candles: -0.5, direction: 'short', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.momentum.total).toBe(1);
    expect(stats.momentum.wins).toBe(1);
  });

  it('does NOT count win when momentum > 0 but direction=short', () => {
    const trade = makeTrade({ momentum3candles: 0.5, direction: 'short', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.momentum.wins).toBe(0);
  });

  it('skips trade when momentum3candles is missing', () => {
    const trade = makeTrade({ direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.momentum.total).toBe(0);
  });
});

describe('computeComponentStats – Imbalance attribution', () => {
  it('predicts long when imbalance > 1 and counts win for long+profit', () => {
    const trade = makeTrade({ imbalance: 1.5, direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.imbalance.total).toBe(1);
    expect(stats.imbalance.wins).toBe(1);
  });

  it('predicts short when imbalance <= 1 and counts win for short+profit', () => {
    const trade = makeTrade({ imbalance: 0.8, direction: 'short', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.imbalance.total).toBe(1);
    expect(stats.imbalance.wins).toBe(1);
  });

  it('predicts short when imbalance exactly equals 1', () => {
    const trade = makeTrade({ imbalance: 1, direction: 'short', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.imbalance.wins).toBe(1);
  });

  it('does NOT count win when imbalance > 1 but direction=short', () => {
    const trade = makeTrade({ imbalance: 2, direction: 'short', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.imbalance.wins).toBe(0);
  });

  it('skips trade when imbalance is missing', () => {
    const trade = makeTrade({ direction: 'long', pnl: 5 });
    const stats = computeComponentStats([trade], 10);
    expect(stats.imbalance.total).toBe(0);
  });
});

describe('computeComponentStats – Lookback window slicing', () => {
  it('only analyses the first lookbackN trades (sorted desc by timestamp)', () => {
    // 5 trades, lookbackN=3 → only first 3 should be analysed
    const trades = [
      makeTrade({ ema9: 200, ema21: 100, direction: 'long', pnl: 5 }),   // included
      makeTrade({ ema9: 200, ema21: 100, direction: 'long', pnl: 5 }),   // included
      makeTrade({ ema9: 200, ema21: 100, direction: 'long', pnl: 5 }),   // included
      makeTrade({ ema9: 200, ema21: 100, direction: 'long', pnl: 5 }),   // excluded
      makeTrade({ ema9: 200, ema21: 100, direction: 'long', pnl: 5 }),   // excluded
    ];
    const stats = computeComponentStats(trades, 3);
    expect(stats.ema.total).toBe(3);
    expect(stats.lookbackN).toBe(3);
  });

  it('analyses all trades when lookbackN >= trades.length', () => {
    const trades = [
      makeTrade({ ema9: 200, ema21: 100, direction: 'long', pnl: 5 }),
      makeTrade({ ema9: 200, ema21: 100, direction: 'long', pnl: 5 }),
    ];
    const stats = computeComponentStats(trades, 100);
    expect(stats.ema.total).toBe(2);
    expect(stats.lookbackN).toBe(2);
  });

  it('returns zero stats for empty trade list', () => {
    const stats = computeComponentStats([], 10);
    expect(stats.ema.total).toBe(0);
    expect(stats.lookbackN).toBe(0);
  });
});

// ─── ComponentPerformanceTracker class tests ──────────────────────────────────

describe('ComponentPerformanceTracker – recalc trigger at N trades', () => {
  it('does NOT call readAll after 9 calls to onTradeLogged()', async () => {
    const mockReadAll = vi.fn().mockResolvedValue([]);
    const mockTradeLogger = { readAll: mockReadAll } as any;
    const mockWeightStore = {
      getWeights: vi.fn().mockReturnValue({}),
      setWeights: vi.fn(),
    } as any;

    const tracker = new ComponentPerformanceTracker(mockTradeLogger, mockWeightStore);

    for (let i = 0; i < 9; i++) {
      tracker.onTradeLogged();
    }

    expect(mockReadAll).not.toHaveBeenCalled();
  });

  it('calls readAll on the 10th call to onTradeLogged()', async () => {
    const mockReadAll = vi.fn().mockResolvedValue([]);
    const mockTradeLogger = { readAll: mockReadAll } as any;
    const mockWeightStore = {
      getWeights: vi.fn().mockReturnValue({}),
      setWeights: vi.fn(),
    } as any;

    const tracker = new ComponentPerformanceTracker(mockTradeLogger, mockWeightStore);

    for (let i = 0; i < 10; i++) {
      tracker.onTradeLogged();
    }

    // readAll is async — flush microtask queue
    await Promise.resolve();

    expect(mockReadAll).toHaveBeenCalledTimes(1);
  });
});
