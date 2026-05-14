/**
 * Property-Based Tests for BacktestAdapter — Balance Conservation (Property 1)
 *
 * Uses fast-check to verify that the balance conservation invariant holds
 * across arbitrary sequences of order fills.
 *
 * **Validates: Requirements 1.12, 2.6, 5.1**
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { BacktestAdapter } from '../BacktestAdapter.js';
import type { BacktestAdapterConfig } from '../types.js';
import type { Kline } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid BacktestAdapterConfig. */
function makeConfig(overrides: Partial<BacktestAdapterConfig> = {}): BacktestAdapterConfig {
  return {
    makerFeeBps: 10,
    takerFeeBps: 15,
    slippageBps: 5,
    fillMode: 'optimistic', // use optimistic so fill price == order price (predictable)
    ...overrides,
  };
}

/**
 * Build a Kline candle that guarantees any limit order at `price` will fill.
 * Sets l = 0 (fills any buy) and h = Number.MAX_SAFE_INTEGER (fills any sell).
 */
function makeFillingCandle(index: number, closePrice: number = 100): Kline {
  return {
    t: index * 60_000, // 1-minute candles
    o: closePrice,
    h: Number.MAX_SAFE_INTEGER, // fills any sell limit order
    l: 0,                       // fills any buy limit order
    c: closePrice,
    v: 1000,
  };
}

const SYMBOL = 'BTC-USD';

/**
 * Create a BacktestAdapter with a single symbol loaded with `numCandles` candles.
 * All candles have extreme high/low ranges so any limit order will fill on the next candle.
 */
function makeAdapter(
  initialBalance: number,
  numCandles: number,
  config: BacktestAdapterConfig = makeConfig(),
): BacktestAdapter {
  const candles: Kline[] = Array.from({ length: numCandles }, (_, i) => makeFillingCandle(i));
  const klines = new Map<string, Kline[]>([[SYMBOL, candles]]);
  return new BacktestAdapter(klines, initialBalance, config);
}

// ---------------------------------------------------------------------------
// Property 1: Balance Conservation
//
// For any sequence of fill events:
//   finalBalance == initialBalance + Σ(trade.netPnl)
//
// **Validates: Requirements 1.12, 2.6, 5.1**
// ---------------------------------------------------------------------------

describe('Property 1 — Balance Conservation', () => {
  /**
   * Core property: after any sequence of buy/sell fills, the total account value
   * (cash balance + open position value at fill price) equals the initial balance
   * plus the sum of all trade netPnl values.
   *
   * The balance conservation invariant accounts for open positions:
   *   finalBalance + openPositionValue == initialBalance + Σ(trade.netPnl)
   *
   * where openPositionValue = entryPrice * size for long positions
   * (the cost locked in the position).
   *
   * Note: fc.float requires 32-bit float boundaries — use integers to avoid issues.
   * Note: get_balance() is async — must be awaited.
   */
  it('finalBalance == initialBalance + Σ(trade.netPnl) for any fill sequence', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Initial balance: positive, reasonable range
        fc.integer({ min: 100, max: 100_000 }),
        // Sequence of fill events: each is a (side, price, size) tuple
        fc.array(
          fc.record({
            side: fc.constantFrom<'buy' | 'sell'>('buy', 'sell'),
            // Integer prices to avoid 32-bit float constraint issues
            price: fc.integer({ min: 1, max: 500 }),
            // Integer sizes scaled to get fractional values
            size: fc.integer({ min: 1, max: 1000 }).map(n => n / 100),
          }),
          { minLength: 0, maxLength: 20 },
        ),
        async (initialBalance, fillEvents) => {
          // We need enough candles: 1 to advance before placing + 1 per fill event
          const numCandles = fillEvents.length + 2;
          const adapter = makeAdapter(initialBalance, numCandles);

          // Advance to candle 0 to initialise the clock
          const candles: Kline[] = Array.from({ length: numCandles }, (_, i) => makeFillingCandle(i));
          adapter.advanceTo(candles[0], SYMBOL);

          let candleIdx = 1;

          for (const event of fillEvents) {
            // Place the order on the current candle (candle index = candleIdx - 1 after advance)
            // The order will be eligible to fill on the NEXT candle (fill monotonicity)
            await adapter.place_limit_order(SYMBOL, event.side, event.price, event.size);

            // Advance to the next candle — this triggers _checkFills
            // The extreme candle (h=MAX, l=0) ensures the order fills
            try {
              adapter.advanceTo(candles[candleIdx], SYMBOL);
            } catch {
              // InsufficientBalanceError: order was rejected, no state change
              // The property still holds — we just skip this fill
            }
            candleIdx++;
          }

          const finalBalance = await adapter.get_balance();
          const trades = adapter.getTradeLog();
          const sumNetPnl = trades.reduce((acc, t) => acc + t.netPnl, 0);

          // Get open position value (signed cost locked in position):
          //   long:  +entryPrice * size  (we paid for the asset, it's locked)
          //   short: -entryPrice * size  (we received cash for the asset, we owe it back)
          const position = await adapter.get_position(SYMBOL);
          const openPositionCost = position
            ? (position.side === 'long' ? 1 : -1) * position.entryPrice * position.size
            : 0;

          // The full balance conservation invariant:
          //   finalBalance + openPositionCost == initialBalance + Σ(trade.netPnl)
          // This holds because:
          //   - buy fill:  balance -= (price*size + fee), netPnl = -fee, positionCost += price*size
          //   - sell fill: balance += (price*size - fee), netPnl = -fee, positionCost -= price*size
          expect(finalBalance + openPositionCost).toBeCloseTo(initialBalance + sumNetPnl, 6);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Concrete example: a single buy-then-sell round trip.
   *
   * Buy 1 unit @ 100 with 10 bps maker fee (optimistic mode):
   *   fee = 100 * 1 * 0.001 = 0.1
   *   balance delta on buy = -(100 * 1 + 0.1) = -100.1
   *   trade.netPnl at buy entry = -0.1 (only fee cost)
   *
   * Sell 1 unit @ 100 with 10 bps maker fee (optimistic mode):
   *   fee = 100 * 1 * 0.001 = 0.1
   *   balance delta on sell = +(100 * 1 - 0.1) = +99.9
   *   trade.netPnl at sell entry = -0.1 (only fee cost)
   *
   * finalBalance = 1000 - 100.1 + 99.9 = 999.8
   * Σ(netPnl) = -0.1 + -0.1 = -0.2
   * initialBalance + Σ(netPnl) = 1000 - 0.2 = 999.8 ✓
   */
  it('balance conservation holds for a complete buy-then-sell round trip', async () => {
    const initialBalance = 1000;
    const price = 100;
    const size = 1;
    const makerFeeBps = 10; // 0.1%
    const fee = price * size * (makerFeeBps / 10_000); // 0.1

    const numCandles = 5;
    const adapter = makeAdapter(initialBalance, numCandles, makeConfig({ makerFeeBps }));
    const candles: Kline[] = Array.from({ length: numCandles }, (_, i) => makeFillingCandle(i));

    // Candle 0: advance to initialise
    adapter.advanceTo(candles[0], SYMBOL);

    // Candle 0 → place buy order
    await adapter.place_limit_order(SYMBOL, 'buy', price, size);

    // Candle 1: buy fills
    adapter.advanceTo(candles[1], SYMBOL);

    // Candle 1 → place sell order at same price
    await adapter.place_limit_order(SYMBOL, 'sell', price, size);

    // Candle 2: sell fills
    adapter.advanceTo(candles[2], SYMBOL);

    const finalBalance = await adapter.get_balance();
    const trades = adapter.getTradeLog();
    const sumNetPnl = trades.reduce((acc, t) => acc + t.netPnl, 0);

    // After buy+sell at same price: balance = initialBalance - 2*fee
    expect(finalBalance).toBeCloseTo(initialBalance - 2 * fee, 8);

    // Σ(netPnl) = -fee (buy) + -fee (sell) = -2*fee
    expect(sumNetPnl).toBeCloseTo(-2 * fee, 8);

    // The invariant: finalBalance == initialBalance + Σ(netPnl)
    expect(finalBalance).toBeCloseTo(initialBalance + sumNetPnl, 8);
  });

  /**
   * Property: balance conservation holds for arbitrary round-trip sequences
   * (buy followed by sell at the same price, so position cost cancels out).
   *
   * For each round trip at price P with size S and fee F:
   *   balance delta = -(P*S + F) + (P*S - F) = -2F
   *   Σ(netPnl) = -F + -F = -2F
   *   → finalBalance = initialBalance + Σ(netPnl) ✓
   */
  it('balance conservation holds for arbitrary round-trip sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 100_000 }),
        fc.array(
          fc.record({
            // Integer prices to avoid 32-bit float constraint issues
            price: fc.integer({ min: 10, max: 200 }),
            // Integer sizes scaled to get fractional values
            size: fc.integer({ min: 1, max: 100 }).map(n => n / 100),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (initialBalance, roundTrips) => {
          // Each round trip needs 2 fill candles + 1 setup candle
          const numCandles = roundTrips.length * 2 + 2;
          const config = makeConfig({ makerFeeBps: 10 });
          const candles: Kline[] = Array.from({ length: numCandles }, (_, i) => makeFillingCandle(i));
          const klines = new Map<string, Kline[]>([[SYMBOL, candles]]);
          const adapter = new BacktestAdapter(klines, initialBalance, config);

          // Advance to candle 0
          adapter.advanceTo(candles[0], SYMBOL);
          let candleIdx = 1;

          for (const rt of roundTrips) {
            // Place buy
            await adapter.place_limit_order(SYMBOL, 'buy', rt.price, rt.size);
            try {
              adapter.advanceTo(candles[candleIdx++], SYMBOL);
            } catch {
              // InsufficientBalance — skip this round trip
              candleIdx++; // skip the sell candle too
              continue;
            }

            // Place sell at same price
            await adapter.place_limit_order(SYMBOL, 'sell', rt.price, rt.size);
            try {
              adapter.advanceTo(candles[candleIdx++], SYMBOL);
            } catch {
              // Should not happen for a sell, but handle gracefully
            }
          }

          const finalBalance = await adapter.get_balance();
          const trades = adapter.getTradeLog();
          const sumNetPnl = trades.reduce((acc, t) => acc + t.netPnl, 0);

          expect(finalBalance).toBeCloseTo(initialBalance + sumNetPnl, 6);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property: balance conservation holds even with zero fills (no orders placed).
   * finalBalance == initialBalance, Σ(netPnl) == 0.
   */
  it('balance is unchanged and trade log is empty when no orders are placed', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 50 }),
        async (initialBalance, numCandles) => {
          const adapter = makeAdapter(initialBalance, numCandles);
          const candles: Kline[] = Array.from({ length: numCandles }, (_, i) => makeFillingCandle(i));

          for (let i = 0; i < numCandles; i++) {
            adapter.advanceTo(candles[i], SYMBOL);
          }

          const finalBalance = await adapter.get_balance();
          const trades = adapter.getTradeLog();
          const sumNetPnl = trades.reduce((acc, t) => acc + t.netPnl, 0);

          expect(finalBalance).toBeCloseTo(initialBalance + sumNetPnl, 10);
          expect(finalBalance).toBeCloseTo(initialBalance, 10);
          expect(sumNetPnl).toBe(0);
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Fill Monotonicity
//
// An order placed during `advanceTo(candle[i])` is NEVER filled in that same
// call. It may only fill when `advanceTo` is called for a subsequent candle
// j where j > i.
//
// **Validates: Requirements 2.12, 4.2**
// ---------------------------------------------------------------------------

describe('Property 2 — Fill Monotonicity', () => {
  /**
   * Core property: for any candle and any order placed AFTER that candle has
   * been advanced to, `get_open_orders` still contains the order — it was NOT
   * filled by the same-tick `advanceTo`.
   *
   * Strategy:
   *  1. Advance to candle[i] (sets currentCandleIndex = i).
   *  2. Place a limit order whose fill condition is guaranteed to be met by
   *     candle[i] (buy with price >= candle.low, sell with price <= candle.high).
   *  3. Verify the order is still open — it must NOT have been filled yet.
   *  4. Advance to candle[i+1] (same extreme candle) — now the order SHOULD fill.
   *  5. Verify the order is gone from open orders after the next tick.
   */
  it('order placed after advanceTo(candle[i]) is not filled until candle[i+1]', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Candle close price: positive integer
        fc.integer({ min: 1, max: 10_000 }),
        // Order side
        fc.constantFrom<'buy' | 'sell'>('buy', 'sell'),
        // Order price: for buy, use a price >= candle.low (0) → any positive price fills
        //              for sell, use a price <= candle.high (MAX_SAFE_INTEGER) → any positive price fills
        fc.integer({ min: 1, max: 500 }),
        // Order size
        fc.integer({ min: 1, max: 100 }).map(n => n / 10),
        // Initial balance: large enough to cover any buy
        fc.integer({ min: 100_000, max: 1_000_000 }),
        async (closePrice, side, price, size, initialBalance) => {
          // Build 3 candles: candle[0] for initial advance, candle[1] for the
          // same-tick test, candle[2] for the next-tick fill verification.
          // All candles have extreme h/l so any limit order fills.
          const candles: Kline[] = [
            { t: 0,       o: closePrice, h: Number.MAX_SAFE_INTEGER, l: 0, c: closePrice, v: 1000 },
            { t: 60_000,  o: closePrice, h: Number.MAX_SAFE_INTEGER, l: 0, c: closePrice, v: 1000 },
            { t: 120_000, o: closePrice, h: Number.MAX_SAFE_INTEGER, l: 0, c: closePrice, v: 1000 },
          ];
          const klines = new Map<string, Kline[]>([[SYMBOL, candles]]);
          const adapter = new BacktestAdapter(klines, initialBalance, makeConfig());

          // Step 1: advance to candle[0] (currentCandleIndex becomes 0)
          adapter.advanceTo(candles[0], SYMBOL);

          // Step 2: advance to candle[1] (currentCandleIndex becomes 1)
          // Then place an order — it is stamped with placedAtCandleIndex = 1
          adapter.advanceTo(candles[1], SYMBOL);
          await adapter.place_limit_order(SYMBOL, side, price, size);

          // Step 3: verify the order is still open (not filled by candle[1])
          const openAfterSameTick = await adapter.get_open_orders(SYMBOL);
          expect(openAfterSameTick).toHaveLength(1);

          // Step 4: advance to candle[2] — the order should now fill
          // (candle[2] has l=0 and h=MAX_SAFE_INTEGER, so any limit fills)
          try {
            adapter.advanceTo(candles[2], SYMBOL);
          } catch {
            // InsufficientBalanceError is possible for large buy orders;
            // the monotonicity property still holds — the order was NOT filled
            // on the same tick (step 3 already verified that).
            return;
          }

          // Step 5: order should be gone after the next tick
          const openAfterNextTick = await adapter.get_open_orders(SYMBOL);
          expect(openAfterNextTick).toHaveLength(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Variant: multiple orders placed on the same tick are all deferred.
   *
   * Place N orders after advancing to candle[i]; all N orders must still be
   * open immediately after — none should have been filled by candle[i].
   */
  it('all orders placed after advanceTo(candle[i]) are deferred until candle[i+1]', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Number of orders to place on the same tick
        fc.integer({ min: 1, max: 10 }),
        // Initial balance: large enough to cover all buys
        fc.integer({ min: 500_000, max: 1_000_000 }),
        async (numOrders, initialBalance) => {
          const closePrice = 100;
          const candles: Kline[] = [
            { t: 0,      o: closePrice, h: Number.MAX_SAFE_INTEGER, l: 0, c: closePrice, v: 1000 },
            { t: 60_000, o: closePrice, h: Number.MAX_SAFE_INTEGER, l: 0, c: closePrice, v: 1000 },
          ];
          const klines = new Map<string, Kline[]>([[SYMBOL, candles]]);
          const adapter = new BacktestAdapter(klines, initialBalance, makeConfig());

          // Advance to candle[0]
          adapter.advanceTo(candles[0], SYMBOL);

          // Place numOrders orders — all stamped with placedAtCandleIndex = 0
          for (let i = 0; i < numOrders; i++) {
            await adapter.place_limit_order(SYMBOL, 'buy', 50, 0.1);
          }

          // All orders must still be open — candle[0] cannot fill them
          const openOrders = await adapter.get_open_orders(SYMBOL);
          expect(openOrders).toHaveLength(numOrders);
        },
      ),
      { numRuns: 100 },
    );
  });

  /**
   * Concrete example: verify the exact candle-index boundary.
   *
   * - Advance to candle[0]: place a buy order → still open after candle[0]
   * - Advance to candle[1]: order fills → open orders is empty
   */
  it('concrete example: order placed at candle[0] fills at candle[1], not candle[0]', async () => {
    const initialBalance = 10_000;
    const price = 100;
    const size = 1;

    const candles: Kline[] = [
      { t: 0,      o: price, h: Number.MAX_SAFE_INTEGER, l: 0, c: price, v: 1000 },
      { t: 60_000, o: price, h: Number.MAX_SAFE_INTEGER, l: 0, c: price, v: 1000 },
    ];
    const klines = new Map<string, Kline[]>([[SYMBOL, candles]]);
    const adapter = new BacktestAdapter(klines, initialBalance, makeConfig());

    // Advance to candle[0] and place a buy order
    adapter.advanceTo(candles[0], SYMBOL);
    await adapter.place_limit_order(SYMBOL, 'buy', price, size);

    // Order must NOT be filled by candle[0]
    const openAfterCandle0 = await adapter.get_open_orders(SYMBOL);
    expect(openAfterCandle0).toHaveLength(1);
    expect(adapter.getTradeLog()).toHaveLength(0);

    // Advance to candle[1] — order should fill now
    adapter.advanceTo(candles[1], SYMBOL);

    // Order must be gone from open orders
    const openAfterCandle1 = await adapter.get_open_orders(SYMBOL);
    expect(openAfterCandle1).toHaveLength(0);

    // Trade log should have one entry
    expect(adapter.getTradeLog()).toHaveLength(1);
  });

  /**
   * Edge case: order placed before any advanceTo call (placedAtCandleIndex = -1)
   * should fill on the very first advanceTo (candle index 0).
   *
   * This verifies that the monotonicity guard only blocks same-tick fills,
   * not pre-clock orders.
   */
  it('order placed before any advanceTo fills on the first advanceTo', async () => {
    const initialBalance = 10_000;
    const price = 100;
    const size = 1;

    const candles: Kline[] = [
      { t: 0, o: price, h: Number.MAX_SAFE_INTEGER, l: 0, c: price, v: 1000 },
    ];
    const klines = new Map<string, Kline[]>([[SYMBOL, candles]]);
    const adapter = new BacktestAdapter(klines, initialBalance, makeConfig());

    // Place order BEFORE any advanceTo — placedAtCandleIndex = -1
    await adapter.place_limit_order(SYMBOL, 'buy', price, size);

    // Advance to candle[0] (index = 0) — since -1 !== 0, the order should fill
    adapter.advanceTo(candles[0], SYMBOL);

    const openOrders = await adapter.get_open_orders(SYMBOL);
    expect(openOrders).toHaveLength(0);
    expect(adapter.getTradeLog()).toHaveLength(1);
  });
});
