/**
 * Bug Condition Exploration Tests — HedgeBot Double Trade Bug
 *
 * Property 1: Bug Condition — Already-Filled Leg Receives Duplicate Order
 *
 * These tests MUST FAIL on unfixed code. Failure confirms the bug exists.
 * After the fix is applied, these tests MUST PASS.
 *
 * Bug: When _tickOpening() is called while one (or both) legs already have an
 * open position from a prior fill, the unfixed code places a new order for the
 * already-filled leg, doubling its intended size.
 *
 * Requirements: 2.1, 2.2, 2.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { HedgeBot } from '../HedgeBot.js';
import type { ExchangeAdapter, Position } from '../../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';
import type { HedgeBotConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeConfig(): HedgeBotConfig {
  return {
    id: 'hedge-double-trade-test',
    name: 'Double Trade Bug Test',
    botType: 'hedge',
    exchange: 'sodex',
    tags: ['test'],
    autoStart: false,
    credentialKey: 'SODEX',
    tradeLogBackend: 'json',
    tradeLogPath: '/tmp/hedge-double-trade-test.json',
    symbolA: 'BTC-USD',
    symbolB: 'ETH-USD',
    legValueUsd: 1000,
    holdingPeriodSecs: 300,
    profitTargetUsd: 50,
    maxLossUsd: 30,
    volumeSpikeMultiplier: 2.0,
    volumeRollingWindow: 20,
    fundingRateWeight: 0,
    cooldownSecs: 30,
  };
}

function makeAdapter(): ExchangeAdapter {
  return {
    get_mark_price: vi.fn().mockResolvedValue(50000),
    get_orderbook: vi.fn().mockResolvedValue({ best_bid: 49990, best_ask: 50010 }),
    place_limit_order: vi.fn().mockResolvedValue('order-id-1'),
    cancel_order: vi.fn().mockResolvedValue(true),
    cancel_all_orders: vi.fn().mockResolvedValue(true),
    get_open_orders: vi.fn().mockResolvedValue([]),
    get_position: vi.fn().mockResolvedValue(null),
    get_balance: vi.fn().mockResolvedValue(10000),
    get_orderbook_depth: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    get_recent_trades: vi.fn().mockResolvedValue([]),
  };
}

function makeTelegram(): TelegramManager {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendMessageWithInlineButtons: vi.fn().mockResolvedValue(undefined),
    setupMenu: vi.fn().mockResolvedValue(undefined),
    onCallback: vi.fn(),
    onCommand: vi.fn(),
    isEnabled: vi.fn().mockReturnValue(false),
  } as unknown as TelegramManager;
}

function makePosition(
  symbol: string,
  side: 'long' | 'short',
  size: number,
  entryPrice: number,
): Position {
  return { symbol, side, size, entryPrice, unrealizedPnl: 0 };
}

/**
 * Sets up a HedgeBot in OPENING state with the given _openingContext.
 * Simulates the scenario where the bot re-enters OPENING after a fill-timeout retry.
 */
function setupBotInOpeningState(bot: HedgeBot): void {
  bot.state.hedgeBotState = 'OPENING';
  // Inject opening context as if the bot had previously entered OPENING from IDLE
  (bot as any)._openingContext = {
    longSymbol: 'BTC-USD',
    shortSymbol: 'ETH-USD',
    scoreA: 0.8,
    scoreB: 0.3,
    entryTimestamp: new Date().toISOString(),
    orderIdA: null,
    orderIdB: null,
    waitingFillStartMs: null,
  };
}

// ---------------------------------------------------------------------------
// Property 1: Bug Condition — Already-Filled Leg Receives Duplicate Order
//
// isBugCondition(X): X.state = 'OPENING' AND (X.legAFilled OR X.legBFilled)
//
// For all inputs satisfying the bug condition, the fixed _tickOpening() SHALL
// NOT call place_limit_order for the already-filled leg.
//
// On UNFIXED code: these tests FAIL (place_limit_order IS called for the
// already-filled leg, confirming the bug).
// ---------------------------------------------------------------------------

describe('Property 1: Bug Condition — Already-Filled Leg Receives Duplicate Order', () => {
  let adapter: ExchangeAdapter;
  let bot: HedgeBot;

  beforeEach(() => {
    adapter = makeAdapter();
    bot = new HedgeBot(makeConfig(), adapter, makeTelegram());
    setupBotInOpeningState(bot);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Concrete case 1: ETH (symbolB) already filled, BTC (symbolA) not filled
  // Scenario: BTC order rejected, ETH order fills, timeout expires, re-enters OPENING
  // -------------------------------------------------------------------------
  it('does NOT call place_limit_order for ETH-USD when ETH already has a position (legB filled)', async () => {
    // No stale open orders (stale-order check passes)
    vi.mocked(adapter.get_open_orders).mockResolvedValue([]);

    // Mark prices for both symbols
    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000) // BTC-USD
      .mockResolvedValueOnce(2000); // ETH-USD

    // ETH already has a position (size > 0), BTC does not
    vi.mocked(adapter.get_position)
      .mockImplementation(async (symbol: string) => {
        if (symbol === 'ETH-USD') {
          return makePosition('ETH-USD', 'short', 0.5, 2000);
        }
        return null; // BTC-USD has no position
      });

    await (bot as any)._tickOpening();

    // FIXED behavior: place_limit_order must NOT be called for ETH-USD
    const calls = vi.mocked(adapter.place_limit_order).mock.calls;
    const ethCalls = calls.filter(([symbol]) => symbol === 'ETH-USD');
    expect(ethCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Concrete case 2: BTC (symbolA) already filled, ETH (symbolB) not filled
  // Scenario: ETH order rejected, BTC order fills, timeout expires, re-enters OPENING
  // -------------------------------------------------------------------------
  it('does NOT call place_limit_order for BTC-USD when BTC already has a position (legA filled)', async () => {
    vi.mocked(adapter.get_open_orders).mockResolvedValue([]);

    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000) // BTC-USD
      .mockResolvedValueOnce(2000); // ETH-USD

    // BTC already has a position (size > 0), ETH does not
    vi.mocked(adapter.get_position)
      .mockImplementation(async (symbol: string) => {
        if (symbol === 'BTC-USD') {
          return makePosition('BTC-USD', 'long', 0.02, 50000);
        }
        return null; // ETH-USD has no position
      });

    await (bot as any)._tickOpening();

    const calls = vi.mocked(adapter.place_limit_order).mock.calls;
    const btcCalls = calls.filter(([symbol]) => symbol === 'BTC-USD');
    expect(btcCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Concrete case 3: Both legs already filled
  // Scenario: crash-recovery or both legs filled before timeout
  // Expected: no orders placed, state transitions to WAITING_FILL
  // -------------------------------------------------------------------------
  it('does NOT call place_limit_order for either leg when both legs already have positions', async () => {
    vi.mocked(adapter.get_open_orders).mockResolvedValue([]);

    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000) // BTC-USD
      .mockResolvedValueOnce(2000); // ETH-USD

    // Both legs already have positions
    vi.mocked(adapter.get_position)
      .mockImplementation(async (symbol: string) => {
        if (symbol === 'BTC-USD') {
          return makePosition('BTC-USD', 'long', 0.02, 50000);
        }
        return makePosition('ETH-USD', 'short', 0.5, 2000);
      });

    await (bot as any)._tickOpening();

    // No orders should be placed for either leg
    expect(adapter.place_limit_order).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Concrete case 4: Both legs filled → state transitions to WAITING_FILL
  // -------------------------------------------------------------------------
  it('transitions to WAITING_FILL when both legs already have positions (no orders placed)', async () => {
    vi.mocked(adapter.get_open_orders).mockResolvedValue([]);

    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.get_position)
      .mockImplementation(async (symbol: string) => {
        if (symbol === 'BTC-USD') {
          return makePosition('BTC-USD', 'long', 0.02, 50000);
        }
        return makePosition('ETH-USD', 'short', 0.5, 2000);
      });

    await (bot as any)._tickOpening();

    expect(bot.state.hedgeBotState).toBe('WAITING_FILL');
  });

  // -------------------------------------------------------------------------
  // Concrete case 5: get_position throws → tick returns early, no orders placed
  // -------------------------------------------------------------------------
  it('returns early without placing orders when get_position throws', async () => {
    vi.mocked(adapter.get_open_orders).mockResolvedValue([]);

    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.get_position).mockRejectedValue(new Error('API error'));

    await (bot as any)._tickOpening();

    // No orders should be placed when position check fails
    expect(adapter.place_limit_order).not.toHaveBeenCalled();
    // State should remain OPENING (tick skipped)
    expect(bot.state.hedgeBotState).toBe('OPENING');
  });

  // -------------------------------------------------------------------------
  // Property-based: for any non-zero position size on legB, place_limit_order
  // is never called for ETH-USD
  // -------------------------------------------------------------------------
  it('Property 1: Bug Condition — for any non-zero ETH position, place_limit_order is never called for ETH-USD', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Any positive position size for ETH
        fc.float({ min: Math.fround(0.001), max: Math.fround(100), noNaN: true, noDefaultInfinity: true }),
        // Any positive mark price for BTC
        fc.float({ min: Math.fround(100), max: Math.fround(200000), noNaN: true, noDefaultInfinity: true }),
        // Any positive mark price for ETH
        fc.float({ min: Math.fround(10), max: Math.fround(20000), noNaN: true, noDefaultInfinity: true }),
        async (ethSize, btcPrice, ethPrice) => {
          const localAdapter = makeAdapter();
          const localBot = new HedgeBot(makeConfig(), localAdapter, makeTelegram());
          setupBotInOpeningState(localBot);

          vi.mocked(localAdapter.get_open_orders).mockResolvedValue([]);
          vi.mocked(localAdapter.get_mark_price)
            .mockResolvedValueOnce(btcPrice)
            .mockResolvedValueOnce(ethPrice);

          // ETH has a position, BTC does not
          vi.mocked(localAdapter.get_position)
            .mockImplementation(async (symbol: string) => {
              if (symbol === 'ETH-USD') {
                return makePosition('ETH-USD', 'short', ethSize, ethPrice);
              }
              return null;
            });

          await (localBot as any)._tickOpening();

          const calls = vi.mocked(localAdapter.place_limit_order).mock.calls;
          const ethCalls = calls.filter(([symbol]) => symbol === 'ETH-USD');
          expect(ethCalls).toHaveLength(0);
        },
      ),
      { numRuns: 50 },
    );
  });

  // -------------------------------------------------------------------------
  // Property-based: for any non-zero position size on legA, place_limit_order
  // is never called for BTC-USD
  // -------------------------------------------------------------------------
  it('Property 1: Bug Condition — for any non-zero BTC position, place_limit_order is never called for BTC-USD', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.float({ min: Math.fround(0.001), max: Math.fround(10), noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: Math.fround(100), max: Math.fround(200000), noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: Math.fround(10), max: Math.fround(20000), noNaN: true, noDefaultInfinity: true }),
        async (btcSize, btcPrice, ethPrice) => {
          const localAdapter = makeAdapter();
          const localBot = new HedgeBot(makeConfig(), localAdapter, makeTelegram());
          setupBotInOpeningState(localBot);

          vi.mocked(localAdapter.get_open_orders).mockResolvedValue([]);
          vi.mocked(localAdapter.get_mark_price)
            .mockResolvedValueOnce(btcPrice)
            .mockResolvedValueOnce(ethPrice);

          // BTC has a position, ETH does not
          vi.mocked(localAdapter.get_position)
            .mockImplementation(async (symbol: string) => {
              if (symbol === 'BTC-USD') {
                return makePosition('BTC-USD', 'long', btcSize, btcPrice);
              }
              return null;
            });

          await (localBot as any)._tickOpening();

          const calls = vi.mocked(localAdapter.place_limit_order).mock.calls;
          const btcCalls = calls.filter(([symbol]) => symbol === 'BTC-USD');
          expect(btcCalls).toHaveLength(0);
        },
      ),
      { numRuns: 50 },
    );
  });
});
