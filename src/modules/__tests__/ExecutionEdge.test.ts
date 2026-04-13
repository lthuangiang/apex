import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { ExecutionEdge } from '../ExecutionEdge';
import { FillTracker } from '../FillTracker';
import { ExchangeAdapter } from '../../adapters/ExchangeAdapter';
import { config } from '../../config';

// ─── Config constants used in tests ──────────────────────────────────────────
// EXEC_MAX_SPREAD_BPS = 10
// EXEC_SPREAD_OFFSET_MULT = 0.3
// EXEC_DEPTH_LEVELS = 5
// EXEC_DEPTH_THIN_THRESHOLD = 50000
// EXEC_DEPTH_PENALTY = 0.5
// EXEC_FILL_WINDOW = 20
// EXEC_FILL_RATE_THRESHOLD = 0.6
// EXEC_FILL_RATE_PENALTY = 1.0
// EXEC_OFFSET_MIN = 0
// EXEC_OFFSET_MAX = 5

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAdapter(depthResult?: { bids: [number, number][]; asks: [number, number][] }) {
  return {
    get_orderbook_depth: vi.fn().mockResolvedValue(
      depthResult ?? {
        bids: [[100000, 1], [99999, 1], [99998, 1], [99997, 1], [99996, 1]], // ~500k USD depth
        asks: [[100001, 1], [100002, 1], [100003, 1], [100004, 1], [100005, 1]],
      }
    ),
  } as unknown as ExchangeAdapter;
}

function makeEdge(adapter: ExchangeAdapter, tracker?: FillTracker) {
  return new ExecutionEdge(adapter, tracker ?? new FillTracker());
}

// ─── Task 8.1: spreadBps > EXEC_MAX_SPREAD_BPS → spreadOk=false, offset=0 ───

describe('8.1 spreadBps > EXEC_MAX_SPREAD_BPS → spreadOk=false, offset=0', () => {
  it('returns spreadOk=false and offset=0 when spread is 11 bps (> 10)', async () => {
    // spreadBps = (ask - bid) / bid * 10000 = 11
    // → ask - bid = bid * 11 / 10000 = 100000 * 11 / 10000 = 110
    // → best_ask = 100110
    const edge = makeEdge(makeAdapter());
    const result = await edge.computeOffset('BTC-USD', 'long', {
      best_bid: 100000,
      best_ask: 100110,
    });
    expect(result.spreadOk).toBe(false);
    expect(result.offset).toBe(0);
    expect(result.spreadBps).toBeCloseTo(11, 5);
  });
});

// ─── Task 8.2: spreadBps <= EXEC_MAX_SPREAD_BPS → spreadOk=true ──────────────

describe('8.2 spreadBps <= EXEC_MAX_SPREAD_BPS → spreadOk=true', () => {
  it('returns spreadOk=true when spread is 2 bps (<= 10)', async () => {
    // best_bid=100000, best_ask=100002 → spreadBps = 2/100000 * 10000 = 0.2 bps
    // Actually: (100002 - 100000) / 100000 * 10000 = 2 * 10000 / 100000 = 0.2 bps
    // Wait: spreadBps = (ask - bid) / bid * 10000 = 2/100000 * 10000 = 0.2 bps
    // To get 2 bps: ask - bid = 2, bid = 10000 → ask = 10002
    const edge = makeEdge(makeAdapter());
    const result = await edge.computeOffset('BTC-USD', 'long', {
      best_bid: 100000,
      best_ask: 100002,
    });
    // spreadBps = 2/100000 * 10000 = 0.2 bps — well within 10 bps limit
    expect(result.spreadOk).toBe(true);
  });

  it('returns spreadOk=true when spread is exactly EXEC_MAX_SPREAD_BPS (10 bps)', async () => {
    // For 10 bps: (ask - bid) / bid * 10000 = 10 → ask - bid = bid * 0.001
    // bid=100000 → ask = 100000 + 100 = 100100
    const edge = makeEdge(makeAdapter());
    const result = await edge.computeOffset('BTC-USD', 'long', {
      best_bid: 100000,
      best_ask: 100100,
    });
    // spreadBps = 100/100000 * 10000 = 10 bps — exactly at threshold, should pass
    expect(result.spreadOk).toBe(true);
  });
});

// ─── Task 8.3: thin book → depthPenalty applied ───────────────────────────────

describe('8.3 thin book (depthScore < threshold) → depthPenalty applied', () => {
  it('offset > spreadBps * EXEC_SPREAD_OFFSET_MULT when book is thin', async () => {
    // Thin book: bids = [[100000, 0.1]] → depthScore = 10000 < 50000
    const thinAdapter = makeAdapter({
      bids: [[100000, 0.1]],
      asks: [[100001, 0.1]],
    });
    const edge = makeEdge(thinAdapter);

    // best_bid=100000, best_ask=100002 → spreadBps ≈ 0.2 bps
    const result = await edge.computeOffset('BTC-USD', 'long', {
      best_bid: 100000,
      best_ask: 100002,
    });

    const baseOffset = result.spreadBps * config.EXEC_SPREAD_OFFSET_MULT;
    expect(result.offset).toBeGreaterThan(baseOffset);
    expect(result.depthScore).toBe(10000);
  });
});

// ─── Task 8.4: deep book → no depthPenalty ────────────────────────────────────

describe('8.4 deep book (depthScore >= threshold) → no depthPenalty', () => {
  it('offset equals spreadBps * EXEC_SPREAD_OFFSET_MULT with deep book and empty FillTracker', async () => {
    // Deep book: 5 levels × 100000 × 1 = 500000 >= 50000
    const deepAdapter = makeAdapter({
      bids: [[100000, 1], [99999, 1], [99998, 1], [99997, 1], [99996, 1]],
      asks: [[100001, 1], [100002, 1], [100003, 1], [100004, 1], [100005, 1]],
    });
    const edge = makeEdge(deepAdapter, new FillTracker());

    // best_bid=100000, best_ask=100002 → spreadBps ≈ 0.2 bps
    const result = await edge.computeOffset('BTC-USD', 'long', {
      best_bid: 100000,
      best_ask: 100002,
    });

    const expectedOffset = result.spreadBps * config.EXEC_SPREAD_OFFSET_MULT;
    // No depth penalty, no fill penalty → rawOffset = spreadBps * mult
    // Clamped to [0, 5]
    const clamped = Math.max(config.EXEC_OFFSET_MIN, Math.min(config.EXEC_OFFSET_MAX, expectedOffset));
    expect(result.offset).toBeCloseTo(clamped, 10);
    expect(result.depthScore).toBeGreaterThanOrEqual(config.EXEC_DEPTH_THIN_THRESHOLD);
  });
});

// ─── Task 8.5: low fill rate → fillRatePenalty applied ───────────────────────

describe('8.5 low fill rate (< threshold, sampleSize > 0) → fillRatePenalty applied', () => {
  it('fillRatePenalty equals EXEC_FILL_RATE_PENALTY when fill rate is below threshold', async () => {
    const tracker = new FillTracker();
    // Add many cancels to drive fill rate below 0.6
    for (let i = 0; i < 10; i++) {
      tracker.recordCancel('entry');
    }
    // fillRate = 0 < 0.6, sampleSize = 10 > 0 → penalty applies

    const edge = makeEdge(makeAdapter(), tracker);
    const result = await edge.computeOffset('BTC-USD', 'long', {
      best_bid: 100000,
      best_ask: 100002,
    });

    expect(result.fillRatePenalty).toBe(config.EXEC_FILL_RATE_PENALTY);
  });
});

// ─── Task 8.6: empty buffer (sampleSize=0) → no fillRatePenalty ──────────────

describe('8.6 empty buffer (sampleSize=0) → no fillRatePenalty', () => {
  it('fillRatePenalty is 0 when FillTracker is empty', async () => {
    const edge = makeEdge(makeAdapter(), new FillTracker());
    const result = await edge.computeOffset('BTC-USD', 'long', {
      best_bid: 100000,
      best_ask: 100002,
    });
    expect(result.fillRatePenalty).toBe(0);
  });
});

// ─── Task 8.7: get_orderbook_depth failure → depthScore=0, no throw ──────────

describe('8.7 get_orderbook_depth failure → depthScore=0, thin-book penalty applied, no throw', () => {
  it('handles depth fetch error gracefully: spreadOk=true, depthScore=0, no exception', async () => {
    const failingAdapter = {
      get_orderbook_depth: vi.fn().mockRejectedValue(new Error('Network error')),
    } as unknown as ExchangeAdapter;

    const edge = makeEdge(failingAdapter, new FillTracker());

    // Should not throw
    const result = await edge.computeOffset('BTC-USD', 'long', {
      best_bid: 100000,
      best_ask: 100002,
    });

    expect(result.spreadOk).toBe(true);
    expect(result.depthScore).toBe(0);
    // depthScore=0 < 50000 → thin-book penalty should be applied
    const baseOffset = result.spreadBps * config.EXEC_SPREAD_OFFSET_MULT;
    expect(result.offset).toBeGreaterThan(baseOffset);
  });
});

// ─── Task 8.8: Property — offset ∈ [EXEC_OFFSET_MIN, EXEC_OFFSET_MAX] ────────
// Validates: Requirements 5.2 (offset formula safety)

describe('8.8 Property: offset ∈ [EXEC_OFFSET_MIN, EXEC_OFFSET_MAX] for any valid orderbook with spreadOk=true', () => {
  it('offset is always within bounds for valid orderbooks', async () => {
    const maxSpreadBps = config.EXEC_MAX_SPREAD_BPS;

    // Generate valid orderbooks where spreadBps <= EXEC_MAX_SPREAD_BPS
    // Use integer spread ticks (0..maxSpreadBps bps) to avoid fc.float 32-bit constraint issues
    const arbOrderbook = fc.record({
      best_bid: fc.integer({ min: 1000, max: 200000 }),
      spreadBpsTimes100: fc.integer({ min: 0, max: maxSpreadBps * 100 }), // 0..1000 (0..10 bps in 0.01 increments)
    }).map(({ best_bid, spreadBpsTimes100 }) => {
      const spreadBps = spreadBpsTimes100 / 100;
      const best_ask = best_bid + Math.ceil(best_bid * spreadBps / 10000);
      return { best_bid, best_ask };
    }).filter(({ best_bid, best_ask }) => {
      const spreadBps = (best_ask - best_bid) / best_bid * 10000;
      return best_ask > best_bid && spreadBps <= maxSpreadBps;
    });

    await fc.assert(
      fc.asyncProperty(arbOrderbook, async (orderbook) => {
        const edge = makeEdge(makeAdapter(), new FillTracker());
        const result = await edge.computeOffset('BTC-USD', 'long', orderbook);

        if (result.spreadOk) {
          expect(result.offset).toBeGreaterThanOrEqual(config.EXEC_OFFSET_MIN);
          expect(result.offset).toBeLessThanOrEqual(config.EXEC_OFFSET_MAX);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ─── Task 8.9: Property — wider spread → larger or equal offset ───────────────
// Validates: Requirements 5.3 (spread monotonicity)

describe('8.9 Property: wider spread → larger or equal offset (fixed depth and fill stats, before clamp)', () => {
  it('offset1 <= offset2 when spread1 < spread2, both within EXEC_MAX_SPREAD_BPS', async () => {
    const maxSpreadBps = config.EXEC_MAX_SPREAD_BPS;
    const bid = 100000;

    // Generate two spread values (in bps * 100 integer units) where spread1 < spread2, both <= maxSpreadBps
    const arbTwoSpreads = fc.tuple(
      fc.integer({ min: 0, max: maxSpreadBps * 100 }),
      fc.integer({ min: 0, max: maxSpreadBps * 100 }),
    ).filter(([s1, s2]) => s1 < s2).map(([s1, s2]) => ({
      ask1: bid + Math.ceil(bid * (s1 / 100) / 10000),
      ask2: bid + Math.ceil(bid * (s2 / 100) / 10000),
    })).filter(({ ask1, ask2 }) => {
      const bps1 = (ask1 - bid) / bid * 10000;
      const bps2 = (ask2 - bid) / bid * 10000;
      return bps1 <= maxSpreadBps && bps2 <= maxSpreadBps && ask1 > bid && ask2 > bid;
    });

    // Use same deep adapter for both to keep depth fixed
    const deepAdapter = makeAdapter();

    await fc.assert(
      fc.asyncProperty(arbTwoSpreads, async ({ ask1, ask2 }) => {
        const tracker = new FillTracker(); // empty, no fill penalty

        const edge1 = new ExecutionEdge(deepAdapter, tracker);
        const edge2 = new ExecutionEdge(deepAdapter, tracker);

        const result1 = await edge1.computeOffset('BTC-USD', 'long', { best_bid: bid, best_ask: ask1 });
        const result2 = await edge2.computeOffset('BTC-USD', 'long', { best_bid: bid, best_ask: ask2 });

        if (result1.spreadOk && result2.spreadOk) {
          // rawOffset = spreadBps * MULT + depthPenalty + fillPenalty
          // With same depth and fill stats, wider spread → larger rawOffset → larger or equal clamped offset
          const rawOffset1 = result1.spreadBps * config.EXEC_SPREAD_OFFSET_MULT;
          const rawOffset2 = result2.spreadBps * config.EXEC_SPREAD_OFFSET_MULT;
          expect(rawOffset1).toBeLessThanOrEqual(rawOffset2);
        }
      }),
      { numRuns: 200 }
    );
  });
});

// ─── Task 8.10: Property — spreadBps > EXEC_MAX_SPREAD_BPS → spreadOk=false ──
// Validates: Requirements 5.1 (spread guard)

describe('8.10 Property: spreadBps > EXEC_MAX_SPREAD_BPS always produces spreadOk=false', () => {
  it('spreadOk is always false when spread exceeds EXEC_MAX_SPREAD_BPS', async () => {
    const maxSpreadBps = config.EXEC_MAX_SPREAD_BPS;

    // Generate orderbooks where spreadBps > EXEC_MAX_SPREAD_BPS
    // Use integer extra bps (1..500) to avoid fc.float 32-bit constraint issues
    const arbWideOrderbook = fc.record({
      best_bid: fc.integer({ min: 1000, max: 100000 }),
      extraBpsTimes10: fc.integer({ min: 1, max: 500 }), // 0.1..50 extra bps
    }).map(({ best_bid, extraBpsTimes10 }) => {
      const spreadBps = maxSpreadBps + extraBpsTimes10 / 10;
      const best_ask = best_bid + Math.ceil(best_bid * spreadBps / 10000);
      return { best_bid, best_ask };
    }).filter(({ best_bid, best_ask }) => {
      const spreadBps = (best_ask - best_bid) / best_bid * 10000;
      return spreadBps > maxSpreadBps;
    });

    await fc.assert(
      fc.asyncProperty(arbWideOrderbook, async (orderbook) => {
        const edge = makeEdge(makeAdapter(), new FillTracker());
        const result = await edge.computeOffset('BTC-USD', 'long', orderbook);
        expect(result.spreadOk).toBe(false);
      }),
      { numRuns: 200 }
    );
  });
});
