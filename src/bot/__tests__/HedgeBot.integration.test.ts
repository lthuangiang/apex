/**
 * HedgeBot Integration Tests
 *
 * Tests end-to-end state machine flows using mock adapters.
 * The tick loop is driven manually by calling private tick methods directly
 * (e.g. `(bot as any)._tickIdle()`) rather than starting the full tick loop.
 *
 * Tasks: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HedgeBot } from '../HedgeBot.js';
import { BotManager } from '../BotManager.js';
import { BotInstance } from '../BotInstance.js';
import type { HedgeBotConfig, BotConfig } from '../types.js';
import type { ExchangeAdapter, Position } from '../../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeHedgeBotConfig(overrides: Partial<HedgeBotConfig> = {}): HedgeBotConfig {
  return {
    id: 'hedge-integration-1',
    name: 'Integration Hedge Bot',
    botType: 'hedge',
    exchange: 'sodex',
    tags: ['integration'],
    autoStart: false,
    credentialKey: 'SODEX',
    tradeLogBackend: 'json',
    tradeLogPath: '/tmp/hedge-integration-trades.json',
    symbolA: 'BTC-USD',
    symbolB: 'ETH-USD',
    legValueUsd: 1000,
    holdingPeriodSecs: 300,
    profitTargetUsd: 50,
    maxLossUsd: 30,
    volumeSpikeMultiplier: 2.0,
    volumeRollingWindow: 3,
    fundingRateWeight: 0,
    cooldownSecs: 30,
    ...overrides,
  };
}

function makeBotConfig(id: string): BotConfig {
  return {
    id,
    name: `Bot ${id}`,
    exchange: 'sodex',
    symbol: 'BTC-USD',
    tags: ['test'],
    autoStart: false,
    mode: 'farm',
    orderSizeMin: 0.003,
    orderSizeMax: 0.005,
    credentialKey: 'TEST',
    tradeLogBackend: 'json',
    tradeLogPath: `/tmp/trades-${id}.json`,
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
 * Mock the VolumeMonitor so that shouldEnter() returns true and sample() is a no-op.
 * This lets us test the state machine entry logic without worrying about volume data.
 */
function mockVolumeMonitorShouldEnter(bot: HedgeBot): void {
  const vm = bot.getVolumeMonitor();
  vi.spyOn(vm, 'sample').mockResolvedValue(undefined);
  vi.spyOn(vm, 'shouldEnter').mockReturnValue(true);
}

/**
 * Mock signal engines to return different scores so assignDirections() returns non-null.
 * scoreA > scoreB → symbolA (BTC-USD) is long, symbolB (ETH-USD) is short.
 */
function mockSignalEngines(bot: HedgeBot, scoreA = 0.8, scoreB = 0.3): void {
  vi.spyOn(bot.getSignalEngineA(), 'getSignal').mockResolvedValue({
    score: scoreA,
    direction: 'long',
    confidence: 0.9,
    reasoning: 'mock',
  } as any);
  vi.spyOn(bot.getSignalEngineB(), 'getSignal').mockResolvedValue({
    score: scoreB,
    direction: 'short',
    confidence: 0.9,
    reasoning: 'mock',
  } as any);
}

/**
 * Build a filled position response for a given symbol and side.
 */
function makePosition(
  symbol: string,
  side: 'long' | 'short',
  size: number,
  entryPrice: number,
  unrealizedPnl: number,
): Position {
  return { symbol, side, size, entryPrice, unrealizedPnl };
}

// ---------------------------------------------------------------------------
// Task 12.1 — Full entry → fill → PROFIT_TARGET exit cycle
// Requirements: 6.3, 7.5, 9.2
// ---------------------------------------------------------------------------

describe('12.1 — Full entry → fill → PROFIT_TARGET exit cycle', () => {
  let adapter: ExchangeAdapter;
  let bot: HedgeBot;
  let appendFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = makeAdapter();
    bot = new HedgeBot(makeHedgeBotConfig(), adapter, makeTelegram());
    appendFileSpy = vi.spyOn(fs.promises, 'appendFile').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a HedgeTradeRecord with exitReason PROFIT_TARGET after full cycle', async () => {
    // --- Step 1: IDLE → OPENING ---
    mockVolumeMonitorShouldEnter(bot);
    mockSignalEngines(bot, 0.8, 0.3); // BTC long, ETH short

    await (bot as any)._tickIdle();
    expect(bot.state.hedgeBotState).toBe('OPENING');

    // --- Step 2: OPENING → IN_PAIR ---
    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)  // BTC
      .mockResolvedValueOnce(2000);  // ETH

    vi.mocked(adapter.place_limit_order)
      .mockResolvedValueOnce('order-btc-1')
      .mockResolvedValueOnce('order-eth-1');

    vi.mocked(adapter.get_position)
      .mockResolvedValueOnce(makePosition('BTC-USD', 'long', 0.02, 50000, 0))
      .mockResolvedValueOnce(makePosition('ETH-USD', 'short', 0.5, 2000, 0));

    await (bot as any)._tickOpening();
    expect(bot.state.hedgeBotState).toBe('IN_PAIR');
    expect(bot.state.hedgePosition).not.toBeNull();

    // --- Step 3: IN_PAIR → CLOSING (profit target hit: combinedPnl = 55 >= 50) ---
    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.get_position)
      .mockResolvedValueOnce(makePosition('BTC-USD', 'long', 0.02, 50000, 30))
      .mockResolvedValueOnce(makePosition('ETH-USD', 'short', 0.5, 2000, 25));

    vi.mocked(adapter.get_balance).mockResolvedValue(10000);

    await (bot as any)._tickInPair();
    expect(bot.state.hedgeBotState).toBe('CLOSING');

    // --- Step 4: CLOSING → COOLDOWN ---
    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.place_limit_order)
      .mockResolvedValueOnce('close-btc-1')
      .mockResolvedValueOnce('close-eth-1');

    // get_position confirms flat (size=0)
    vi.mocked(adapter.get_position)
      .mockResolvedValue(makePosition('BTC-USD', 'long', 0, 50000, 0));

    await (bot as any)._tickClosing();
    expect(bot.state.hedgeBotState).toBe('COOLDOWN');
    expect(bot.state.hedgePosition).toBeNull();

    // --- Verify trade log was written with PROFIT_TARGET ---
    expect(appendFileSpy).toHaveBeenCalled();
    const writtenData = appendFileSpy.mock.calls[0][1] as string;
    const record = JSON.parse(writtenData.trim());

    expect(record.exitReason).toBe('PROFIT_TARGET');
    expect(record.botId).toBe(bot.id);
    expect(record.symbolA).toBe('BTC-USD');
    expect(record.symbolB).toBe('ETH-USD');
    expect(record).toHaveProperty('entryTimestamp');
    expect(record).toHaveProperty('exitTimestamp');
    expect(record).toHaveProperty('combinedPnl');
    expect(record).toHaveProperty('holdDurationSecs');
  });
});

// ---------------------------------------------------------------------------
// Task 12.2 — Full entry → fill → MAX_LOSS exit cycle
// Requirements: 6.4
// ---------------------------------------------------------------------------

describe('12.2 — Full entry → fill → MAX_LOSS exit cycle', () => {
  let adapter: ExchangeAdapter;
  let bot: HedgeBot;
  let appendFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = makeAdapter();
    bot = new HedgeBot(makeHedgeBotConfig(), adapter, makeTelegram());
    appendFileSpy = vi.spyOn(fs.promises, 'appendFile').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes a HedgeTradeRecord with exitReason MAX_LOSS and combinedPnl <= -maxLossUsd', async () => {
    // --- IDLE → OPENING ---
    mockVolumeMonitorShouldEnter(bot);
    mockSignalEngines(bot, 0.8, 0.3);

    await (bot as any)._tickIdle();
    expect(bot.state.hedgeBotState).toBe('OPENING');

    // --- OPENING → IN_PAIR ---
    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.place_limit_order)
      .mockResolvedValueOnce('order-btc-1')
      .mockResolvedValueOnce('order-eth-1');

    vi.mocked(adapter.get_position)
      .mockResolvedValueOnce(makePosition('BTC-USD', 'long', 0.02, 50000, 0))
      .mockResolvedValueOnce(makePosition('ETH-USD', 'short', 0.5, 2000, 0));

    await (bot as any)._tickOpening();
    expect(bot.state.hedgeBotState).toBe('IN_PAIR');

    // --- IN_PAIR → CLOSING (max loss hit: combinedPnl = -35 <= -30) ---
    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.get_position)
      .mockResolvedValueOnce(makePosition('BTC-USD', 'long', 0.02, 50000, -20))
      .mockResolvedValueOnce(makePosition('ETH-USD', 'short', 0.5, 2000, -15));

    vi.mocked(adapter.get_balance).mockResolvedValue(10000);

    await (bot as any)._tickInPair();
    expect(bot.state.hedgeBotState).toBe('CLOSING');

    // Verify combinedPnl is <= -maxLossUsd before closing
    const combinedPnl = bot.state.hedgePosition!.combinedPnl;
    expect(combinedPnl).toBeLessThanOrEqual(-30);

    // --- CLOSING → COOLDOWN ---
    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.place_limit_order)
      .mockResolvedValueOnce('close-btc-1')
      .mockResolvedValueOnce('close-eth-1');

    vi.mocked(adapter.get_position)
      .mockResolvedValue(makePosition('BTC-USD', 'long', 0, 50000, 0));

    await (bot as any)._tickClosing();
    expect(bot.state.hedgeBotState).toBe('COOLDOWN');

    // --- Verify trade log ---
    expect(appendFileSpy).toHaveBeenCalled();
    const writtenData = appendFileSpy.mock.calls[0][1] as string;
    const record = JSON.parse(writtenData.trim());

    expect(record.exitReason).toBe('MAX_LOSS');
    expect(record.combinedPnl).toBeLessThanOrEqual(-30);
  });
});

// ---------------------------------------------------------------------------
// Task 12.3 — One-leg failure during entry
// Requirements: 5.4
// ---------------------------------------------------------------------------

describe('12.3 — One-leg failure during entry', () => {
  let adapter: ExchangeAdapter;
  let bot: HedgeBot;

  beforeEach(() => {
    adapter = makeAdapter();
    bot = new HedgeBot(makeHedgeBotConfig(), adapter, makeTelegram());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('cancels the first order and returns to IDLE when second place_limit_order throws', async () => {
    // --- IDLE → OPENING ---
    mockVolumeMonitorShouldEnter(bot);
    mockSignalEngines(bot, 0.8, 0.3);

    await (bot as any)._tickIdle();
    expect(bot.state.hedgeBotState).toBe('OPENING');

    // --- OPENING: first order succeeds, second throws ---
    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.place_limit_order)
      .mockResolvedValueOnce('order-btc-1')                    // first leg succeeds
      .mockRejectedValueOnce(new Error('Exchange rejected'));  // second leg fails

    await (bot as any)._tickOpening();

    // State must return to IDLE
    expect(bot.state.hedgeBotState).toBe('IDLE');
    expect(bot.state.hedgePosition).toBeNull();

    // The first order must have been cancelled
    expect(adapter.cancel_order).toHaveBeenCalledWith('order-btc-1', 'BTC-USD');
  });

  it('returns to IDLE when both place_limit_order calls throw', async () => {
    mockVolumeMonitorShouldEnter(bot);
    mockSignalEngines(bot, 0.8, 0.3);

    await (bot as any)._tickIdle();
    expect(bot.state.hedgeBotState).toBe('OPENING');

    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    vi.mocked(adapter.place_limit_order)
      .mockRejectedValueOnce(new Error('Exchange rejected A'))
      .mockRejectedValueOnce(new Error('Exchange rejected B'));

    await (bot as any)._tickOpening();

    expect(bot.state.hedgeBotState).toBe('IDLE');
    expect(bot.state.hedgePosition).toBeNull();
    // No cancel calls since neither order succeeded
    expect(adapter.cancel_order).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Task 12.4 — Close retry with exponential backoff
// Requirements: 7.3
// ---------------------------------------------------------------------------

describe('12.4 — Close retry with exponential backoff', () => {
  let adapter: ExchangeAdapter;
  let bot: HedgeBot;
  let sleepSpy: ReturnType<typeof vi.spyOn>;
  let appendFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = makeAdapter();
    bot = new HedgeBot(makeHedgeBotConfig(), adapter, makeTelegram());
    sleepSpy = vi.spyOn(bot as any, '_sleep').mockResolvedValue(undefined);
    appendFileSpy = vi.spyOn(fs.promises, 'appendFile').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('retries close order 3 times total (2 failures then success) with correct backoff delays', async () => {
    // Set up bot in CLOSING state with an active hedge position
    const entryTimestamp = new Date(Date.now() - 10000).toISOString();
    bot.state.hedgePosition = {
      legA: {
        symbol: 'BTC-USD',
        side: 'long',
        size: 0.02,
        entryPrice: 50000,
        unrealizedPnl: 10,
      },
      legB: {
        symbol: 'ETH-USD',
        side: 'short',
        size: 0.5,
        entryPrice: 2000,
        unrealizedPnl: -5,
      },
      entryTimestamp,
      combinedPnl: 5,
    };
    bot.state.hedgeBotState = 'CLOSING';

    // Set opening context so trade record has signal scores
    (bot as any)._openingContext = {
      longSymbol: 'BTC-USD',
      shortSymbol: 'ETH-USD',
      scoreA: 0.8,
      scoreB: 0.3,
      entryTimestamp,
      orderIdA: null,
      orderIdB: null,
    };

    // Mark prices for close
    vi.mocked(adapter.get_mark_price)
      .mockResolvedValueOnce(50000)
      .mockResolvedValueOnce(2000);

    // Leg A close: fails twice, then succeeds on 3rd attempt
    // Leg B close: succeeds immediately
    let btcCallCount = 0;
    let ethCallCount = 0;

    vi.mocked(adapter.place_limit_order).mockImplementation(
      async (symbol: string) => {
        if (symbol === 'BTC-USD') {
          btcCallCount++;
          if (btcCallCount <= 2) {
            throw new Error(`BTC close failed attempt ${btcCallCount}`);
          }
          return 'close-btc-success';
        } else {
          ethCallCount++;
          return 'close-eth-success';
        }
      },
    );

    // get_position confirms flat after close
    vi.mocked(adapter.get_position)
      .mockResolvedValue(makePosition('BTC-USD', 'long', 0, 50000, 0));

    await (bot as any)._tickClosing();

    // BTC close should have been attempted 3 times (2 failures + 1 success)
    expect(btcCallCount).toBe(3);
    // ETH close should have been attempted once (immediate success)
    expect(ethCallCount).toBe(1);

    // Verify backoff delays: 1s after attempt 0, 2s after attempt 1
    const sleepCalls = sleepSpy.mock.calls.map((c) => c[0]);
    expect(sleepCalls).toContain(1000);
    expect(sleepCalls).toContain(2000);

    // Bot should have transitioned to COOLDOWN after successful close
    expect(bot.state.hedgeBotState).toBe('COOLDOWN');
  });
});

// ---------------------------------------------------------------------------
// Task 12.5 — Stop with open positions
// Requirements: 2.3
// ---------------------------------------------------------------------------

describe('12.5 — Stop with open positions', () => {
  let adapter: ExchangeAdapter;
  let bot: HedgeBot;

  beforeEach(() => {
    adapter = makeAdapter();
    bot = new HedgeBot(makeHedgeBotConfig(), adapter, makeTelegram());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a warning and does NOT place close orders when stopped while IN_PAIR', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Put bot in IN_PAIR state with an active hedge position
    bot.state.hedgeBotState = 'IN_PAIR';
    bot.state.hedgePosition = {
      legA: {
        symbol: 'BTC-USD',
        side: 'long',
        size: 0.02,
        entryPrice: 50000,
        unrealizedPnl: 5,
      },
      legB: {
        symbol: 'ETH-USD',
        side: 'short',
        size: 0.5,
        entryPrice: 2000,
        unrealizedPnl: -2,
      },
      entryTimestamp: new Date().toISOString(),
      combinedPnl: 3,
    };

    await bot.stop();

    // Must log a warning about open positions
    expect(warnSpy).toHaveBeenCalled();
    const warnMsg = warnSpy.mock.calls[0][0] as string;
    expect(warnMsg).toContain('WARNING');
    expect(warnMsg).toContain('Stopped with active LegPair');

    // Must NOT place any close orders
    expect(adapter.place_limit_order).not.toHaveBeenCalled();

    // Bot status must be STOPPED
    expect(bot.state.botStatus).toBe('STOPPED');

    warnSpy.mockRestore();
  });

  it('does NOT log a warning when stopped while IDLE (no open positions)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    bot.state.hedgeBotState = 'IDLE';
    bot.state.hedgePosition = null;

    await bot.stop();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(bot.state.botStatus).toBe('STOPPED');

    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Task 12.6 — BotManager aggregation with mixed bot types
// Requirements: 2.4
// ---------------------------------------------------------------------------

describe('12.6 — BotManager aggregation with mixed bot types', () => {
  let manager: BotManager;
  let adapter: ExchangeAdapter;
  let telegram: TelegramManager;

  beforeEach(() => {
    manager = new BotManager();
    adapter = makeAdapter();
    telegram = makeTelegram();
  });

  it('getAggregatedStats() sums sessionPnl from both BotInstance and HedgeBot', () => {
    // Register a standard BotInstance
    const botConfig = makeBotConfig('standard-bot-1');
    const botInstance = manager.createBot(botConfig, adapter, telegram);

    // Register a HedgeBot
    const hedgeConfig = makeHedgeBotConfig({ id: 'hedge-bot-agg-1' });
    const hedgeBot = manager.createHedgeBot(hedgeConfig, adapter, telegram);

    // Set session stats on both
    botInstance.state.sessionPnl = 100;
    botInstance.state.sessionVolume = 5000;
    botInstance.state.sessionFees = 10;
    botInstance.state.botStatus = 'RUNNING';

    hedgeBot.state.sessionPnl = 75;
    hedgeBot.state.sessionVolume = 3000;
    hedgeBot.state.sessionFees = 8;
    hedgeBot.state.botStatus = 'RUNNING';

    const stats = manager.getAggregatedStats();

    expect(stats.totalPnl).toBe(175);
    expect(stats.totalVolume).toBe(8000);
    expect(stats.totalFees).toBe(18);
    expect(stats.activeBotCount).toBe(2);
  });

  it('getAggregatedStats() counts only RUNNING bots as active', () => {
    const botConfig = makeBotConfig('standard-bot-2');
    const botInstance = manager.createBot(botConfig, adapter, telegram);

    const hedgeConfig = makeHedgeBotConfig({ id: 'hedge-bot-agg-2' });
    const hedgeBot = manager.createHedgeBot(hedgeConfig, adapter, telegram);

    botInstance.state.botStatus = 'STOPPED';
    hedgeBot.state.botStatus = 'RUNNING';

    const stats = manager.getAggregatedStats();
    expect(stats.activeBotCount).toBe(1);
  });

  it('getAggregatedStats() handles negative PnL from HedgeBot correctly', () => {
    const botConfig = makeBotConfig('standard-bot-3');
    const botInstance = manager.createBot(botConfig, adapter, telegram);

    const hedgeConfig = makeHedgeBotConfig({ id: 'hedge-bot-agg-3' });
    const hedgeBot = manager.createHedgeBot(hedgeConfig, adapter, telegram);

    botInstance.state.sessionPnl = 50;
    hedgeBot.state.sessionPnl = -30;

    const stats = manager.getAggregatedStats();
    expect(stats.totalPnl).toBe(20);
  });

  it('getAllBots() returns both BotInstance and HedgeBot', () => {
    const botConfig = makeBotConfig('standard-bot-4');
    const botInstance = manager.createBot(botConfig, adapter, telegram);

    const hedgeConfig = makeHedgeBotConfig({ id: 'hedge-bot-agg-4' });
    const hedgeBot = manager.createHedgeBot(hedgeConfig, adapter, telegram);

    const allBots = manager.getAllBots();
    expect(allBots).toHaveLength(2);
    expect(allBots).toContain(botInstance);
    expect(allBots).toContain(hedgeBot);
  });
});
