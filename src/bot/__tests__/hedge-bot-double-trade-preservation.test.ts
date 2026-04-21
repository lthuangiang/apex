/**
 * Preservation Property Tests — HedgeBot Double Trade Bug
 *
 * Property 2: Preservation — Normal OPENING Behavior Unchanged When Neither Leg Is Filled
 *
 * These tests MUST PASS on UNFIXED code (they capture existing correct behavior).
 * After the fix is applied, these tests MUST STILL PASS (no regressions).
 *
 * Observation-first methodology:
 * - Observed on unfixed code: when both get_position calls return null,
 *   _tickOpening() calls place_limit_order for both legs and transitions to WAITING_FILL.
 * - Observed: stale-order cancellation path is unchanged.
 * - Observed: mark price fetch failure → return to IDLE.
 * - Observed: one leg placement failure → cancel successful leg → return to IDLE.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { HedgeBot } from '../HedgeBot.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';
import type { HedgeBotConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeConfig(): HedgeBotConfig {
  return {
    id: 'hedge-preservation-test',
    name: 'Preservation Test Bot',
    botType: 'hedge',
    exchange: 'sodex',
    tags: ['test'],
    autoStart: false,
    credentialKey: 'SODEX',
    tradeLogBackend: 'json',
    tradeLogPath: '/tmp/hedge-preservation-test.json',
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

/**
 * Sets up a HedgeBot in OPENING state with a standard opening context.
 * longSymbol = BTC-USD, shortSymbol = ETH-USD.
 */
function setupBotInOpeningState(bot: HedgeBot): void {
  bot.state.hedgeBotState = 'OPENING';
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
// Property 2: Preservation — Normal OPENING Behavior Unchanged
// ---------------------------------------------------------------------------

describe('Property 2: Preservation — Normal OPENING Behavior Unchanged When Neither Leg Is Filled', () => {
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
  // Requirement 3.1: Normal path — both legs get fresh orders, state → WAITING_FILL
  // -------------------------------------------------------------------------
  it('places limit orders for both legs and transitions to WAITING_FILL when neither leg has a position', async () => {
    // No stale orders, no existing positions
    vi.mocked(adapter.get_open_orders).mockResolvedValue([]);
    vi.mocked(adapter.get_position).mockResolvedValue(null);

    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000) // BTC-USD
      .mockResolvedValueOnce(2000); // ETH-USD

    vi.mocked(adapter.place_limit_order)
      .mockResolvedValueOnce('order-btc-1')
      .mockResolvedValueOnce('order-eth-1');

    await (bot as any)._tickOpening();

    // Both legs must receive orders
    expect(adapter.place_limit_order).toHaveBeenCalledTimes(2);
    const calls = vi.mocked(adapter.place_limit_order).mock.calls;
    const btcCall = calls.find(([symbol]) => symbol === 'BTC-USD');
    const ethCall = calls.find(([symbol]) => symbol === 'ETH-USD');
    expect(btcCall).toBeDefined();
    expect(ethCall).toBeDefined();

    // State must transition to WAITING_FILL
    expect(bot.state.hedgeBotState).toBe('WAITING_FILL');
  });

  // -------------------------------------------------------------------------
  // Requirement 3.1: BTC is long (buy), ETH is short (sell) — sides are correct
  // -------------------------------------------------------------------------
  it('places BTC as buy (long) and ETH as sell (short) when BTC is the long symbol', async () => {
    vi.mocked(adapter.get_open_orders).mockResolvedValue([]);
    vi.mocked(adapter.get_position).mockResolvedValue(null);

    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.place_limit_order)
      .mockResolvedValueOnce('order-btc-1')
      .mockResolvedValueOnce('order-eth-1');

    await (bot as any)._tickOpening();

    const calls = vi.mocked(adapter.place_limit_order).mock.calls;
    const btcCall = calls.find(([symbol]) => symbol === 'BTC-USD');
    const ethCall = calls.find(([symbol]) => symbol === 'ETH-USD');

    expect(btcCall![1]).toBe('buy');  // BTC is long → buy
    expect(ethCall![1]).toBe('sell'); // ETH is short → sell
  });

  // -------------------------------------------------------------------------
  // Requirement 3.3: Stale open orders → cancel and return (no orders placed this tick)
  // -------------------------------------------------------------------------
  it('cancels stale open orders and returns without placing new orders (stale-order path unchanged)', async () => {
    // Stale orders exist for symbolA
    vi.mocked(adapter.get_open_orders)
      .mockResolvedValueOnce([{ id: 'stale-1', symbol: 'BTC-USD', side: 'buy', price: 50000, size: 0.02, status: 'open' }])
      .mockResolvedValueOnce([]);

    await (bot as any)._tickOpening();

    // Must cancel stale orders
    expect(adapter.cancel_all_orders).toHaveBeenCalledWith('BTC-USD');

    // Must NOT place any new orders this tick
    expect(adapter.place_limit_order).not.toHaveBeenCalled();

    // State must remain OPENING (will place orders next tick)
    expect(bot.state.hedgeBotState).toBe('OPENING');
  });

  // -------------------------------------------------------------------------
  // Requirement 3.5: One leg placement failure → cancel successful leg → return to IDLE
  // -------------------------------------------------------------------------
  it('cancels the successful leg and returns to IDLE when one leg placement fails', async () => {
    vi.mocked(adapter.get_open_orders).mockResolvedValue([]);
    vi.mocked(adapter.get_position).mockResolvedValue(null);

    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    // First leg succeeds, second fails
    vi.mocked(adapter.place_limit_order)
      .mockResolvedValueOnce('order-btc-1')
      .mockRejectedValueOnce(new Error('Exchange rejected ETH order'));

    await (bot as any)._tickOpening();

    // Must cancel the successful BTC order
    expect(adapter.cancel_order).toHaveBeenCalledWith('order-btc-1', 'BTC-USD');

    // Must return to IDLE
    expect(bot.state.hedgeBotState).toBe('IDLE');
    expect(bot.state.hedgePosition).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Requirement 3.5: Mark price fetch failure → return to IDLE
  // -------------------------------------------------------------------------
  it('returns to IDLE when get_mark_price throws', async () => {
    vi.mocked(adapter.get_open_orders).mockResolvedValue([]);
    vi.mocked(adapter.get_position).mockResolvedValue(null);
    vi.mocked(adapter.get_mark_price).mockRejectedValue(new Error('Price feed down'));

    await (bot as any)._tickOpening();

    expect(adapter.place_limit_order).not.toHaveBeenCalled();
    expect(bot.state.hedgeBotState).toBe('IDLE');
  });

  // -------------------------------------------------------------------------
  // Property-based: for any combination of mark prices where both positions are null,
  // place_limit_order is called exactly twice and state transitions to WAITING_FILL
  // -------------------------------------------------------------------------
  it('Property 2: Preservation — for any mark prices with no existing positions, both legs get orders and state → WAITING_FILL', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Any positive mark price for BTC
        fc.float({ min: Math.fround(100), max: Math.fround(200000), noNaN: true, noDefaultInfinity: true }),
        // Any positive mark price for ETH
        fc.float({ min: Math.fround(10), max: Math.fround(20000), noNaN: true, noDefaultInfinity: true }),
        async (btcPrice, ethPrice) => {
          const localAdapter = makeAdapter();
          const localBot = new HedgeBot(makeConfig(), localAdapter, makeTelegram());
          setupBotInOpeningState(localBot);

          vi.mocked(localAdapter.get_open_orders).mockResolvedValue([]);
          // Neither leg has a position
          vi.mocked(localAdapter.get_position).mockResolvedValue(null);

          vi.mocked(localAdapter.get_mark_price)
            .mockResolvedValueOnce(btcPrice)
            .mockResolvedValueOnce(ethPrice);

          vi.mocked(localAdapter.place_limit_order)
            .mockResolvedValueOnce('order-btc')
            .mockResolvedValueOnce('order-eth');

          await (localBot as any)._tickOpening();

          // Both legs must receive orders
          const callCount = vi.mocked(localAdapter.place_limit_order).mock.calls.length;
          expect(callCount).toBe(2);

          // State must be WAITING_FILL
          expect(localBot.state.hedgeBotState).toBe('WAITING_FILL');
        },
      ),
      { numRuns: 100 },
    );
  });

  // -------------------------------------------------------------------------
  // Property-based: when neither leg is filled, place_limit_order is called exactly twice
  // This is the preservation domain: NOT isBugCondition(X) → legAFilled=false AND legBFilled=false
  // -------------------------------------------------------------------------
  it('Property 2: Preservation — place_limit_order called exactly twice when neither leg has a position', async () => {
    await fc.assert(
      fc.asyncProperty(
        // mark prices — any positive values
        fc.float({ min: Math.fround(100), max: Math.fround(200000), noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: Math.fround(10), max: Math.fround(20000), noNaN: true, noDefaultInfinity: true }),
        async (btcPrice, ethPrice) => {
          const localAdapter = makeAdapter();
          const localBot = new HedgeBot(makeConfig(), localAdapter, makeTelegram());
          setupBotInOpeningState(localBot);

          vi.mocked(localAdapter.get_open_orders).mockResolvedValue([]);
          // Neither leg has a position — this is the preservation domain (NOT isBugCondition)
          vi.mocked(localAdapter.get_position).mockResolvedValue(null);

          vi.mocked(localAdapter.get_mark_price)
            .mockResolvedValueOnce(btcPrice)
            .mockResolvedValueOnce(ethPrice);

          vi.mocked(localAdapter.place_limit_order)
            .mockResolvedValue('order-id');

          await (localBot as any)._tickOpening();

          // Exactly 2 orders must be placed (one per leg)
          const actualOrderCount = vi.mocked(localAdapter.place_limit_order).mock.calls.length;
          expect(actualOrderCount).toBe(2);

          // State must be WAITING_FILL
          expect(localBot.state.hedgeBotState).toBe('WAITING_FILL');
        },
      ),
      { numRuns: 100 },
    );
  });
});
