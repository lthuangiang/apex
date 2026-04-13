import { describe, it, expect, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { MarketMaker, MMState } from '../MarketMaker';
import { config } from '../../config';

// Config defaults (mirrors src/config.ts)
const MM_PINGPONG_BIAS_STRENGTH = config.MM_PINGPONG_BIAS_STRENGTH; // 0.08
const MM_INVENTORY_SOFT_BIAS = config.MM_INVENTORY_SOFT_BIAS;       // 50
const MM_INVENTORY_HARD_BLOCK = config.MM_INVENTORY_HARD_BLOCK;     // 150
const MM_TP_MAX_USD = config.MM_TP_MAX_USD;                         // 2.0
const MM_MIN_FEE_MULT = config.MM_MIN_FEE_MULT;                     // 1.5
const ORDER_SIZE_MIN = config.ORDER_SIZE_MIN;                       // 0.003
const FEE_RATE_MAKER = config.FEE_RATE_MAKER;                       // 0.00012

// ─── Arbitraries ─────────────────────────────────────────────────────────────

// Positive float in (0, 200000]
const arbEntryPrice = fc.float({
  min: Math.fround(0.01),
  max: Math.fround(200000),
  noNaN: true,
}).filter((v) => v > 0);

// spreadBps in [0, 100]
const arbSpreadBpsNarrow = fc.float({
  min: Math.fround(0),
  max: Math.fround(100),
  noNaN: true,
}).filter((v) => v >= 0);

// spreadBps in [0, 1000]
const arbSpreadBpsWide = fc.float({
  min: Math.fround(0),
  max: Math.fround(1000),
  noNaN: true,
}).filter((v) => v >= 0);

// Positive volume in (0, 10000]
const arbVolume = fc.float({
  min: Math.fround(0.01),
  max: Math.fround(10000),
  noNaN: true,
}).filter((v) => v > 0);

// lastTradeContext: null or { side, exitPrice, pnl }
const arbLastTradeContext = fc.oneof(
  fc.constant(null),
  fc.record({
    side: fc.oneof(fc.constant('long' as const), fc.constant('short' as const)),
    exitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(200000), noNaN: true }).filter((v) => v > 0),
    pnl: fc.float({ min: Math.fround(-1000), max: Math.fround(1000), noNaN: true }),
  })
);

// Non-null lastTradeContext
const arbLastTradeContextNonNull = fc.record({
  side: fc.oneof(fc.constant('long' as const), fc.constant('short' as const)),
  exitPrice: fc.float({ min: Math.fround(0.01), max: Math.fround(200000), noNaN: true }).filter((v) => v > 0),
  pnl: fc.float({ min: Math.fround(-1000), max: Math.fround(1000), noNaN: true }),
});

// MMState where |cumLong - cumShort| > MM_INVENTORY_HARD_BLOCK (blocked)
const arbBlockedState: fc.Arbitrary<MMState> = fc.oneof(
  // cumLong > 150, cumShort = 0
  fc.record({
    cumLongUsd: fc.float({ min: Math.fround(MM_INVENTORY_HARD_BLOCK + 0.01), max: Math.fround(10000), noNaN: true }).filter((v) => v > MM_INVENTORY_HARD_BLOCK),
    cumShortUsd: fc.constant(0),
    lastExitSide: fc.oneof(fc.constant(null), fc.constant('long' as const), fc.constant('short' as const)),
    tradeCount: fc.integer({ min: 0, max: 100 }),
  }),
  // cumShort > 150, cumLong = 0
  fc.record({
    cumLongUsd: fc.constant(0),
    cumShortUsd: fc.float({ min: Math.fround(MM_INVENTORY_HARD_BLOCK + 0.01), max: Math.fround(10000), noNaN: true }).filter((v) => v > MM_INVENTORY_HARD_BLOCK),
    lastExitSide: fc.oneof(fc.constant(null), fc.constant('long' as const), fc.constant('short' as const)),
    tradeCount: fc.integer({ min: 0, max: 100 }),
  })
);

// MMState where |cumLong - cumShort| <= MM_INVENTORY_HARD_BLOCK (not blocked)
const arbNonBlockedState: fc.Arbitrary<MMState> = fc.record({
  cumLongUsd: fc.float({ min: Math.fround(0), max: Math.fround(MM_INVENTORY_HARD_BLOCK), noNaN: true }).filter((v) => v >= 0),
  cumShortUsd: fc.float({ min: Math.fround(0), max: Math.fround(MM_INVENTORY_HARD_BLOCK), noNaN: true }).filter((v) => v >= 0),
  lastExitSide: fc.oneof(fc.constant(null), fc.constant('long' as const), fc.constant('short' as const)),
  tradeCount: fc.integer({ min: 0, max: 100 }),
}).filter((s) => Math.abs(s.cumLongUsd - s.cumShortUsd) <= MM_INVENTORY_HARD_BLOCK);

// MMState where |cumLong - cumShort| <= MM_INVENTORY_SOFT_BIAS (balanced zone)
const arbBalancedState: fc.Arbitrary<MMState> = fc.record({
  cumLongUsd: fc.float({ min: Math.fround(0), max: Math.fround(MM_INVENTORY_SOFT_BIAS + 100), noNaN: true }).filter((v) => v >= 0),
  cumShortUsd: fc.float({ min: Math.fround(0), max: Math.fround(MM_INVENTORY_SOFT_BIAS + 100), noNaN: true }).filter((v) => v >= 0),
  lastExitSide: fc.oneof(fc.constant(null), fc.constant('long' as const), fc.constant('short' as const)),
  tradeCount: fc.integer({ min: 0, max: 100 }),
}).filter((s) => Math.abs(s.cumLongUsd - s.cumShortUsd) <= MM_INVENTORY_SOFT_BIAS);

// MMState where netExposure > MM_INVENTORY_SOFT_BIAS and not blocked (50 < net <= 150)
const arbLongBiasedState: fc.Arbitrary<MMState> = fc.record({
  cumLongUsd: fc.float({ min: Math.fround(MM_INVENTORY_SOFT_BIAS + 0.01), max: Math.fround(MM_INVENTORY_HARD_BLOCK), noNaN: true }).filter((v) => v > MM_INVENTORY_SOFT_BIAS),
  cumShortUsd: fc.constant(0),
  lastExitSide: fc.oneof(fc.constant(null), fc.constant('long' as const), fc.constant('short' as const)),
  tradeCount: fc.integer({ min: 0, max: 100 }),
}).filter((s) => {
  const net = s.cumLongUsd - s.cumShortUsd;
  return net > MM_INVENTORY_SOFT_BIAS && net <= MM_INVENTORY_HARD_BLOCK;
});

// MMState where netExposure < -MM_INVENTORY_SOFT_BIAS and not blocked (-150 <= net < -50)
const arbShortBiasedState: fc.Arbitrary<MMState> = fc.record({
  cumLongUsd: fc.constant(0),
  cumShortUsd: fc.float({ min: Math.fround(MM_INVENTORY_SOFT_BIAS + 0.01), max: Math.fround(MM_INVENTORY_HARD_BLOCK), noNaN: true }).filter((v) => v > MM_INVENTORY_SOFT_BIAS),
  lastExitSide: fc.oneof(fc.constant(null), fc.constant('long' as const), fc.constant('short' as const)),
  tradeCount: fc.integer({ min: 0, max: 100 }),
}).filter((s) => {
  const net = s.cumLongUsd - s.cumShortUsd;
  return net < -MM_INVENTORY_SOFT_BIAS && net >= -MM_INVENTORY_HARD_BLOCK;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('MarketMaker property-based tests', () => {
  let mm: MarketMaker;

  beforeEach(() => {
    mm = new MarketMaker();
  });

  // ── P1 (12.1): Hard block is symmetric ────────────────────────────────────
  // Validates: Requirements 2.1, 2.4
  describe('P1: Hard block — |cumLong - cumShort| > MM_INVENTORY_HARD_BLOCK → blocked = true', () => {
    it('returns blocked=true for any lastTradeContext when net exposure exceeds hard block', () => {
      fc.assert(
        fc.property(arbBlockedState, arbLastTradeContext, (state, lastTradeContext) => {
          const result = mm.computeEntryBias(lastTradeContext, state);
          expect(result.blocked).toBe(true);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ── P2 (12.2): Dynamic TP always covers fees ──────────────────────────────
  // Validates: Requirement 5.5
  describe('P2: computeDynamicTP >= feeRoundTrip × MM_MIN_FEE_MULT', () => {
    it('dynamic TP always covers the fee floor for any entryPrice and spreadBps', () => {
      fc.assert(
        fc.property(arbEntryPrice, arbSpreadBpsNarrow, (entryPrice, spreadBps) => {
          const feeRoundTrip = ORDER_SIZE_MIN * entryPrice * FEE_RATE_MAKER * 2;
          const feeFloor = feeRoundTrip * MM_MIN_FEE_MULT;
          const result = mm.computeDynamicTP(entryPrice, spreadBps);
          expect(result).toBeGreaterThanOrEqual(feeFloor - 1e-10);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ── P3 (12.3): Dynamic TP is bounded above ────────────────────────────────
  // Validates: Requirement 5.4
  describe('P3: computeDynamicTP <= MM_TP_MAX_USD', () => {
    it('dynamic TP never exceeds MM_TP_MAX_USD for any entryPrice and spreadBps', () => {
      fc.assert(
        fc.property(arbEntryPrice, arbSpreadBpsWide, (entryPrice, spreadBps) => {
          const result = mm.computeDynamicTP(entryPrice, spreadBps);
          expect(result).toBeLessThanOrEqual(MM_TP_MAX_USD + 1e-10);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ── P4 (12.4): Dynamic TP is monotone in spread ───────────────────────────
  // Validates: Requirement 5.6
  describe('P4: spreadBps_a >= spreadBps_b → computeDynamicTP(p, a) >= computeDynamicTP(p, b)', () => {
    it('higher spread always produces >= dynamic TP for the same entry price', () => {
      const arbSpreadPair = fc.tuple(
        fc.float({ min: Math.fround(0), max: Math.fround(50), noNaN: true }).filter((v) => v >= 0),
        fc.float({ min: Math.fround(0), max: Math.fround(50), noNaN: true }).filter((v) => v >= 0),
      ).map(([a, b]) => a <= b ? [a, b] as [number, number] : [b, a] as [number, number]);

      fc.assert(
        fc.property(arbEntryPrice, arbSpreadPair, (entryPrice, [spreadBpsB, spreadBpsA]) => {
          // spreadBpsA >= spreadBpsB
          const tpA = mm.computeDynamicTP(entryPrice, spreadBpsA);
          const tpB = mm.computeDynamicTP(entryPrice, spreadBpsB);
          expect(tpA).toBeGreaterThanOrEqual(tpB - 1e-10);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ── P5 (12.5): Ping-pong alternates sides ────────────────────────────────
  // Validates: Requirements 3.1, 3.2
  describe('P5: pingPongBias sign is opposite to lastTradeContext.side (non-blocked state)', () => {
    it('after long exit → pingPongBias < 0; after short exit → pingPongBias > 0', () => {
      fc.assert(
        fc.property(arbNonBlockedState, arbLastTradeContextNonNull, (state, lastTradeContext) => {
          const result = mm.computeEntryBias(lastTradeContext, state);
          if (result.blocked) return; // skip if state happened to be blocked (shouldn't with arbNonBlockedState)
          if (lastTradeContext.side === 'long') {
            expect(result.pingPongBias).toBeLessThan(0);
          } else {
            expect(result.pingPongBias).toBeGreaterThan(0);
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  // ── P6 (12.6): Inventory bias opposes net exposure ────────────────────────
  // Validates: Requirements 4.1, 4.2
  describe('P6: inventoryBias < 0 when netExposure > MM_INVENTORY_SOFT_BIAS; > 0 when < -MM_INVENTORY_SOFT_BIAS', () => {
    it('long-biased state (net > 50, not blocked) → inventoryBias < 0', () => {
      fc.assert(
        fc.property(arbLongBiasedState, arbLastTradeContext, (state, lastTradeContext) => {
          const result = mm.computeEntryBias(lastTradeContext, state);
          expect(result.blocked).toBe(false);
          expect(result.inventoryBias).toBeLessThan(0);
        }),
        { numRuns: 200 }
      );
    });

    it('short-biased state (net < -50, not blocked) → inventoryBias > 0', () => {
      fc.assert(
        fc.property(arbShortBiasedState, arbLastTradeContext, (state, lastTradeContext) => {
          const result = mm.computeEntryBias(lastTradeContext, state);
          expect(result.blocked).toBe(false);
          expect(result.inventoryBias).toBeGreaterThan(0);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ── P7 (12.7): recordTrade accumulates volume correctly ───────────────────
  // Validates: Requirements 6.1, 6.2, 6.5
  describe('P7: cumLongUsd = sum of long volumes, cumShortUsd = sum of short volumes', () => {
    it('cumulative volumes match sum of recorded trades and remain >= 0', () => {
      const arbTrades = fc.array(
        fc.record({
          side: fc.oneof(fc.constant('long' as const), fc.constant('short' as const)),
          volume: arbVolume,
        }),
        { minLength: 1, maxLength: 20 }
      );

      fc.assert(
        fc.property(arbTrades, (trades) => {
          mm.reset();
          let expectedLong = 0;
          let expectedShort = 0;

          for (const trade of trades) {
            mm.recordTrade(trade.side, trade.volume);
            if (trade.side === 'long') {
              expectedLong += trade.volume;
            } else {
              expectedShort += trade.volume;
            }
          }

          const state = mm.getState();
          expect(state.cumLongUsd).toBeCloseTo(expectedLong, 5);
          expect(state.cumShortUsd).toBeCloseTo(expectedShort, 5);
          expect(state.cumLongUsd).toBeGreaterThanOrEqual(0);
          expect(state.cumShortUsd).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: 200 }
      );
    });
  });

  // ── P8 (12.8): Balanced inventory → no inventory bias ────────────────────
  // Validates: Requirement 4.3
  describe('P8: |netExposure| <= MM_INVENTORY_SOFT_BIAS → inventoryBias === 0', () => {
    it('balanced state produces inventoryBias = 0', () => {
      fc.assert(
        fc.property(arbBalancedState, arbLastTradeContext, (state, lastTradeContext) => {
          const result = mm.computeEntryBias(lastTradeContext, state);
          expect(result.inventoryBias).toBe(0);
        }),
        { numRuns: 200 }
      );
    });
  });
});
