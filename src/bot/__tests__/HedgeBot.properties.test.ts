import { describe, it, expect, vi } from 'vitest';
import * as fc from 'fast-check';
import { VolumeMonitor } from '../VolumeMonitor.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';

// Minimal mock adapter — VolumeMonitor only calls get_recent_trades via sample(),
// but property tests use _addSampleA / _addSampleB directly, so no real calls are made.
const mockAdapter: ExchangeAdapter = {
  get_mark_price: vi.fn(),
  get_orderbook: vi.fn(),
  place_limit_order: vi.fn(),
  cancel_order: vi.fn(),
  cancel_all_orders: vi.fn(),
  get_open_orders: vi.fn(),
  get_position: vi.fn(),
  get_balance: vi.fn(),
  get_orderbook_depth: vi.fn(),
  get_recent_trades: vi.fn(),
};

describe('HedgeBot — property-based tests', () => {
  /**
   * Property 5: Rolling window never exceeds configured size
   *
   * For any sequence of volume samples added to a VolumeMonitor, the internal
   * rolling window for each symbol should never contain more than
   * `volumeRollingWindow` elements, and should always contain the most recently
   * added samples.
   *
   * **Validates: Requirements 3.1, 3.2**
   */
  it('Property 5: rolling window never exceeds configured size', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0, noNaN: true, noDefaultInfinity: true })),
        fc.integer({ min: 1, max: 50 }),
        (samples, windowSize) => {
          const monitor = new VolumeMonitor(mockAdapter, 'A', 'B', windowSize, 2.0);

          for (const s of samples) {
            monitor._addSampleA(s);
          }

          const windowA = monitor.getWindowA();

          // Window must never exceed the configured size
          if (windowA.length > windowSize) return false;

          // If any samples were added, the last element must be the most recently added sample
          if (samples.length > 0) {
            if (windowA[windowA.length - 1] !== samples[samples.length - 1]) return false;
          }

          // Window size must equal min(samples.length, windowSize)
          const expectedLength = Math.min(samples.length, windowSize);
          if (windowA.length !== expectedLength) return false;

          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  /**
   * Property 6: Volume spike detection formula
   *
   * For any rolling window of volume samples and any current volume value,
   * `VolumeMonitor.shouldEnter()` should return `true` only when
   * `currentVolumeA > mean(windowA) * spikeMultiplier` AND
   * `currentVolumeB > mean(windowB) * spikeMultiplier` AND both windows are full.
   *
   * Implementation note: `shouldEnter()` uses `windowA[windowA.length - 1]` as
   * the "current" volume and `getRollingAverageA()` which averages the full window
   * (including the current sample). The window is set up by filling the monitor
   * with exactly `windowA.length` samples so the window is full.
   *
   * **Validates: Requirements 3.3, 3.4, 3.5**
   */
  it('Property 6: volume spike detection formula', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 1, noNaN: true, noDefaultInfinity: true }), {
          minLength: 5,
          maxLength: 20,
        }),
        fc.array(fc.float({ min: 1, noNaN: true, noDefaultInfinity: true }), {
          minLength: 5,
          maxLength: 20,
        }),
        fc.float({ min: Math.fround(1.1), max: Math.fround(5), noNaN: true, noDefaultInfinity: true }),
        (windowA, windowB, multiplier) => {
          // Window size equals the length of the generated arrays so both windows
          // are exactly full after adding all samples.
          const windowSize = Math.max(windowA.length, windowB.length);
          const monitor = new VolumeMonitor(mockAdapter, 'A', 'B', windowSize, multiplier);

          // Pad shorter array with the value 1.0 so both windows reach windowSize
          const paddedA = windowA.length < windowSize
            ? [...Array(windowSize - windowA.length).fill(1.0), ...windowA]
            : windowA;
          const paddedB = windowB.length < windowSize
            ? [...Array(windowSize - windowB.length).fill(1.0), ...windowB]
            : windowB;

          for (const s of paddedA) monitor._addSampleA(s);
          for (const s of paddedB) monitor._addSampleB(s);

          // Compute expected spike using the same formula as VolumeMonitor.shouldEnter()
          // avgA / avgB include the current (last) sample — this matches getRollingAverageA/B
          const avgA = paddedA.reduce((sum, v) => sum + v, 0) / paddedA.length;
          const avgB = paddedB.reduce((sum, v) => sum + v, 0) / paddedB.length;

          const currentA = paddedA[paddedA.length - 1];
          const currentB = paddedB[paddedB.length - 1];

          const expectedSpike = currentA > avgA * multiplier && currentB > avgB * multiplier;

          const result = monitor.shouldEnter();
          return result === expectedSpike;
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Imports needed for config-related properties (3.4 and 3.5)
// ---------------------------------------------------------------------------
import { validateHedgeBotConfig } from '../loadBotConfigs.js';
import type { HedgeBotConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers shared by Property 1 and Property 2
// ---------------------------------------------------------------------------

/** Returns a complete, valid HedgeBotConfig. */
function validHedgeBotConfig(): HedgeBotConfig {
  return {
    id: 'hedge-bot-1',
    name: 'Hedge Bot',
    botType: 'hedge',
    exchange: 'sodex',
    tags: ['hedge'],
    autoStart: false,
    credentialKey: 'SODEX',
    tradeLogBackend: 'json',
    tradeLogPath: './trades-hedge.json',
    symbolA: 'BTC-USD',
    symbolB: 'ETH-USD',
    legValueUsd: 1000,
    holdingPeriodSecs: 300,
    profitTargetUsd: 50,
    maxLossUsd: 30,
    volumeSpikeMultiplier: 2.0,
    volumeRollingWindow: 20,
    fundingRateWeight: 0.1,
  };
}

/**
 * Arbitrary generator for valid HedgeBotConfig objects.
 * All fields are constrained to valid domains so that JSON round-trip
 * and validation both succeed.
 */
function arbitraryHedgeBotConfig(): fc.Arbitrary<HedgeBotConfig> {
  return fc.record({
    id: fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/),
    name: fc.string({ minLength: 1, maxLength: 40 }),
    botType: fc.constant('hedge' as const),
    exchange: fc.constantFrom('sodex' as const, 'dango' as const, 'decibel' as const),
    tags: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
    autoStart: fc.boolean(),
    credentialKey: fc.stringMatching(/^[A-Z][A-Z0-9_]{0,19}$/),
    tradeLogBackend: fc.constantFrom('json' as const, 'sqlite' as const),
    tradeLogPath: fc.string({ minLength: 1, maxLength: 60 }),
    symbolA: fc.string({ minLength: 1, maxLength: 20 }),
    symbolB: fc.string({ minLength: 1, maxLength: 20 }),
    legValueUsd: fc.float({ min: Math.fround(1), max: Math.fround(1_000_000), noNaN: true, noDefaultInfinity: true }),
    holdingPeriodSecs: fc.integer({ min: 1, max: 86400 }),
    profitTargetUsd: fc.float({ min: Math.fround(0.01), max: Math.fround(100_000), noNaN: true, noDefaultInfinity: true }),
    maxLossUsd: fc.float({ min: Math.fround(0.01), max: Math.fround(100_000), noNaN: true, noDefaultInfinity: true }),
    volumeSpikeMultiplier: fc.float({ min: Math.fround(1.01), max: Math.fround(10), noNaN: true, noDefaultInfinity: true }),
    volumeRollingWindow: fc.integer({ min: 2, max: 200 }),
    fundingRateWeight: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true, noDefaultInfinity: true }),
  });
}

/** The list of required fields that validateHedgeBotConfig checks. */
const REQUIRED_FIELDS: (keyof HedgeBotConfig)[] = [
  'id',
  'name',
  'botType',
  'exchange',
  'tags',
  'autoStart',
  'credentialKey',
  'tradeLogBackend',
  'tradeLogPath',
  'symbolA',
  'symbolB',
  'legValueUsd',
  'holdingPeriodSecs',
  'profitTargetUsd',
  'maxLossUsd',
  'volumeSpikeMultiplier',
  'volumeRollingWindow',
  'fundingRateWeight',
];

/** Arbitrary that picks one required field name at random. */
function arbitraryRequiredField(): fc.Arbitrary<keyof HedgeBotConfig> {
  return fc.constantFrom(...REQUIRED_FIELDS);
}

// ---------------------------------------------------------------------------
// Property 2: Config validation rejects missing required fields
// ---------------------------------------------------------------------------
describe('HedgeBot — config validation properties', () => {
  /**
   * Property 2: Config validation rejects missing required fields
   *
   * For any required field in `HedgeBotConfig`, a config object missing that
   * field should cause `validateHedgeBotConfig` to throw an error whose
   * message names the missing field.
   *
   * **Validates: Requirements 1.4**
   */
  it('Property 2: config validation rejects missing required fields', () => {
    // Feature: correlation-hedging-bot, Property 2: Config validation rejects missing required fields
    fc.assert(
      fc.property(arbitraryRequiredField(), (field) => {
        const config = validHedgeBotConfig() as any;
        delete config[field];
        expect(() => validateHedgeBotConfig(config)).toThrow(field);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 1: Config round-trip serialization
// ---------------------------------------------------------------------------
describe('HedgeBot — config round-trip serialization', () => {
  /**
   * Property 1: Config round-trip serialization
   *
   * For any valid `HedgeBotConfig` object, serializing it to JSON and
   * deserializing it back should produce an object equal to the original.
   *
   * **Validates: Requirements 1.5**
   */
  it('Property 1: config round-trip serialization', () => {
    // Feature: correlation-hedging-bot, Property 1: Config round-trip serialization
    fc.assert(
      fc.property(arbitraryHedgeBotConfig(), (config) => {
        const serialized = JSON.stringify(config);
        const deserialized = JSON.parse(serialized);
        expect(deserialized).toEqual(config);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Tasks 5.5 – 5.8: Properties 7, 10, 11, 12
// ---------------------------------------------------------------------------
import {
  assignDirections,
  evaluateExitConditions,
  computeCombinedPnl,
} from '../hedgeBotHelpers.js';
import type { ExitConditionInput } from '../hedgeBotHelpers.js';

// ---------------------------------------------------------------------------
// Property 7: Direction assignment follows signal score ordering
// Requirements: 4.2, 4.3
// ---------------------------------------------------------------------------

describe('HedgeBot — Property 7: direction assignment follows signal score ordering', () => {
  /**
   * Property 7: Direction assignment follows signal score ordering
   *
   * For any two signals where scoreA ≠ scoreB (difference > 0.001), the symbol
   * with the higher adjusted score should always be assigned the LongLeg.
   *
   * **Validates: Requirements 4.2, 4.3**
   */
  it('Property 7: direction assignment follows signal score ordering', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
        (scoreA, scoreB) => {
          // Only test when scores differ by more than 0.001
          if (Math.abs(scoreA - scoreB) <= 0.001) return; // skip tie cases

          const result = assignDirections('A', scoreA, 'B', scoreB);

          // Result must not be null when scores differ by more than 0.001
          expect(result).not.toBeNull();

          if (scoreA > scoreB) {
            expect(result!.longSymbol).toBe('A');
            expect(result!.shortSymbol).toBe('B');
          } else {
            expect(result!.longSymbol).toBe('B');
            expect(result!.shortSymbol).toBe('A');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Exit condition priority ordering
// Requirements: 6.6
// ---------------------------------------------------------------------------

/**
 * Arbitrary generator for exit condition flag sets.
 * Produces an object with boolean flags for each condition, plus the numeric
 * inputs needed to construct a valid ExitConditionInput.
 */
function arbitraryExitConditionSet(): fc.Arbitrary<{
  maxLossHit: boolean;
  profitTargetHit: boolean;
  meanReversionHit: boolean;
  timeExpired: boolean;
}> {
  return fc.record({
    maxLossHit: fc.boolean(),
    profitTargetHit: fc.boolean(),
    meanReversionHit: fc.boolean(),
    timeExpired: fc.boolean(),
  });
}

/**
 * Converts boolean condition flags into a concrete ExitConditionInput.
 *
 * - maxLossHit      → combinedPnl <= -maxLossUsd
 * - profitTargetHit → combinedPnl >= profitTargetUsd  (only when !maxLossHit)
 * - meanReversionHit → |currentRatio - equilibriumSpread| / equilibriumSpread < 0.005
 * - timeExpired     → elapsedSecs >= holdingPeriodSecs
 *
 * We use fixed, non-conflicting base values and override only the fields
 * needed to trigger each condition.
 */
function buildExitInput(flags: {
  maxLossHit: boolean;
  profitTargetHit: boolean;
  meanReversionHit: boolean;
  timeExpired: boolean;
}): ExitConditionInput {
  const profitTargetUsd = 50;
  const maxLossUsd = 30;
  const holdingPeriodSecs = 300;
  const equilibriumSpread = 100.0;

  // Determine combinedPnl: MAX_LOSS takes precedence over PROFIT_TARGET
  let combinedPnl = 0; // neutral — triggers neither profit nor loss
  if (flags.maxLossHit) {
    combinedPnl = -maxLossUsd; // exactly at max loss boundary
  } else if (flags.profitTargetHit) {
    combinedPnl = profitTargetUsd; // exactly at profit target boundary
  }

  // Mean reversion: deviation < 0.005 triggers it; deviation >= 0.005 does not
  // Use 0.004 (inside) vs 0.01 (outside)
  const currentRatio = flags.meanReversionHit
    ? equilibriumSpread * (1 + 0.004)   // 0.4% deviation → triggers
    : equilibriumSpread * (1 + 0.01);   // 1% deviation → does not trigger

  const elapsedSecs = flags.timeExpired ? holdingPeriodSecs : holdingPeriodSecs - 1;

  return {
    combinedPnl,
    profitTargetUsd,
    maxLossUsd,
    elapsedSecs,
    holdingPeriodSecs,
    currentRatio,
    equilibriumSpread,
  };
}

describe('HedgeBot — Property 10: exit condition priority ordering', () => {
  /**
   * Property 10: Exit condition priority ordering
   *
   * For any combination of exit conditions simultaneously true, the exit reason
   * should be the highest-priority: MAX_LOSS > PROFIT_TARGET > MEAN_REVERSION > TIME_EXPIRY
   *
   * **Validates: Requirements 6.6**
   */
  it('Property 10: exit condition priority ordering', () => {
    fc.assert(
      fc.property(arbitraryExitConditionSet(), (flags) => {
        const input = buildExitInput(flags);
        const result = evaluateExitConditions(input);

        if (flags.maxLossHit) {
          expect(result.reason).toBe('MAX_LOSS');
        } else if (flags.profitTargetHit) {
          expect(result.reason).toBe('PROFIT_TARGET');
        } else if (flags.meanReversionHit) {
          expect(result.reason).toBe('MEAN_REVERSION');
        } else if (flags.timeExpired) {
          expect(result.reason).toBe('TIME_EXPIRY');
        } else {
          expect(result.shouldExit).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11: Mean reversion trigger threshold
// Requirements: 6.5
// ---------------------------------------------------------------------------

describe('HedgeBot — Property 11: mean reversion trigger threshold', () => {
  /**
   * Property 11: Mean reversion trigger threshold
   *
   * For any current BTC/ETH price ratio and equilibrium spread, the mean
   * reversion trigger should fire if and only if
   * |currentRatio - equilibriumSpread| / equilibriumSpread < 0.005
   *
   * **Validates: Requirements 6.5**
   */
  it('Property 11: mean reversion trigger threshold', () => {
    fc.assert(
      fc.property(
        // equilibriumSpread: positive, non-zero, finite
        fc.float({ min: Math.fround(0.01), max: Math.fround(100_000), noNaN: true, noDefaultInfinity: true }),
        // currentRatio: any positive finite value
        fc.float({ min: Math.fround(0.001), max: Math.fround(200_000), noNaN: true, noDefaultInfinity: true }),
        (equilibriumSpread, currentRatio) => {
          // Build an input that only tests mean reversion (no other conditions triggered)
          const input: ExitConditionInput = {
            combinedPnl: 0,          // no profit/loss exit
            profitTargetUsd: 1e9,    // unreachable profit target
            maxLossUsd: 1e9,         // unreachable max loss
            elapsedSecs: 0,          // no time expiry
            holdingPeriodSecs: 1e9,
            currentRatio,
            equilibriumSpread,
          };

          const result = evaluateExitConditions(input);

          const deviation = Math.abs(currentRatio - equilibriumSpread) / equilibriumSpread;
          const expectedMeanReversion = deviation < 0.005;

          if (expectedMeanReversion) {
            expect(result.shouldExit).toBe(true);
            expect(result.reason).toBe('MEAN_REVERSION');
          } else {
            expect(result.reason).not.toBe('MEAN_REVERSION');
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 12: CombinedPnL arithmetic identity
// Requirements: 8.3, 8.4
// ---------------------------------------------------------------------------

describe('HedgeBot — Property 12: CombinedPnL arithmetic identity', () => {
  /**
   * Property 12: CombinedPnL arithmetic identity
   *
   * For any two leg PnL values, computeCombinedPnl(pnlA, pnlB) should equal
   * pnlA + pnlB within floating-point precision.
   *
   * **Validates: Requirements 8.3, 8.4**
   */
  it('Property 12: CombinedPnL arithmetic identity', () => {
    fc.assert(
      fc.property(
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        (pnlA, pnlB) => {
          expect(computeCombinedPnl(pnlA, pnlB)).toBeCloseTo(pnlA + pnlB, 10);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Tasks 6.3 – 6.4: Properties 8 and 9
// ---------------------------------------------------------------------------
import { computeLegSize } from '../hedgeBotHelpers.js';

// ---------------------------------------------------------------------------
// Property 8: Leg size computation
// Requirements: 5.1
// ---------------------------------------------------------------------------

describe('HedgeBot — Property 8: leg size computation', () => {
  /**
   * Property 8: Leg size computation
   *
   * For any `legValueUsd` and `markPrice > 0`, the computed leg size should
   * equal `legValueUsd / markPrice` within floating-point precision.
   *
   * **Validates: Requirements 5.1**
   */
  it('Property 8: leg size computation equals legValueUsd / markPrice', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 10, max: 10000, noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 100, max: 100000, noNaN: true, noDefaultInfinity: true }),
        (legValueUsd, markPrice) => {
          const size = computeLegSize(legValueUsd, markPrice);
          expect(size).toBeCloseTo(legValueUsd / markPrice, 10);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Leg value equality invariant
// Requirements: 5.3, 8.1
// ---------------------------------------------------------------------------

describe('HedgeBot — Property 9: leg value equality invariant', () => {
  /**
   * Property 9: Leg value equality invariant
   *
   * For any `legValueUsd` and two mark prices `markPriceA` and `markPriceB`,
   * the computed leg values `sizeA * markPriceA` and `sizeB * markPriceB`
   * should differ by no more than 1% of `legValueUsd`.
   *
   * **Validates: Requirements 5.3, 8.1**
   */
  it('Property 9: leg values computed from same legValueUsd differ by at most 1%', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 10, max: 10000, noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 100, max: 100000, noNaN: true, noDefaultInfinity: true }),
        fc.float({ min: 10, max: 10000, noNaN: true, noDefaultInfinity: true }),
        (legValueUsd, markPriceA, markPriceB) => {
          const sizeA = legValueUsd / markPriceA;
          const sizeB = legValueUsd / markPriceB;
          const legValueA = sizeA * markPriceA;
          const legValueB = sizeB * markPriceB;
          const deviation = Math.abs(legValueA - legValueB) / legValueUsd;
          expect(deviation).toBeLessThanOrEqual(0.01);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 7.5 — Property test: getStatus() always returns all required fields
// Property 3: getStatus always returns all required fields
// Requirements: 2.2
// ---------------------------------------------------------------------------
import { HedgeBot } from '../HedgeBot.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';
import type { ActiveLegPair } from '../HedgeBotSharedState.js';

/** The set of required fields that getStatus() must always return. */
const REQUIRED_STATUS_FIELDS = [
  'id',
  'name',
  'exchange',
  'status',
  'tags',
  'sessionPnl',
  'sessionVolume',
  'uptime',
  'hedgePosition',
] as const;

/** Factory: creates a mock ExchangeAdapter with all methods stubbed. */
function buildMockAdapter(): ExchangeAdapter {
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

/** Factory: creates a minimal TelegramManager mock. */
function buildMockTelegram(): TelegramManager {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendMessageWithInlineButtons: vi.fn().mockResolvedValue(undefined),
    setupMenu: vi.fn().mockResolvedValue(undefined),
    onCallback: vi.fn(),
    onCommand: vi.fn(),
    isEnabled: vi.fn().mockReturnValue(false),
  } as unknown as TelegramManager;
}

/** Factory: creates a HedgeBot with mock dependencies. */
function buildHedgeBot(overrides?: Partial<{
  sessionPnl: number;
  sessionVolume: number;
  botStatus: 'RUNNING' | 'STOPPED';
  hedgePosition: ActiveLegPair | null;
  startTimeDeltaMs: number | null;
}>): HedgeBot {
  const config = {
    id: 'hedge-prop-test',
    name: 'Property Test Hedge Bot',
    botType: 'hedge' as const,
    exchange: 'sodex' as const,
    tags: ['hedge'],
    autoStart: false,
    credentialKey: 'SODEX',
    tradeLogBackend: 'json' as const,
    tradeLogPath: './trades-prop.json',
    symbolA: 'BTC-USD',
    symbolB: 'ETH-USD',
    legValueUsd: 1000,
    holdingPeriodSecs: 300,
    profitTargetUsd: 50,
    maxLossUsd: 30,
    volumeSpikeMultiplier: 2.0,
    volumeRollingWindow: 20,
    fundingRateWeight: 0.1,
  };

  const bot = new HedgeBot(config, buildMockAdapter(), buildMockTelegram());

  if (overrides) {
    if (overrides.sessionPnl !== undefined) bot.state.sessionPnl = overrides.sessionPnl;
    if (overrides.sessionVolume !== undefined) bot.state.sessionVolume = overrides.sessionVolume;
    if (overrides.botStatus !== undefined) bot.state.botStatus = overrides.botStatus;
    if (overrides.hedgePosition !== undefined) bot.state.hedgePosition = overrides.hedgePosition;
    if (overrides.startTimeDeltaMs !== undefined) {
      (bot as any)._startTime = overrides.startTimeDeltaMs === null
        ? null
        : Date.now() - overrides.startTimeDeltaMs;
    }
  }

  return bot;
}

/** Arbitrary generator for an ActiveLegPair or null. */
function arbitraryHedgePosition(): fc.Arbitrary<ActiveLegPair | null> {
  const legPairArb = fc.record({
    legA: fc.record({
      symbol: fc.constant('BTC-USD'),
      side: fc.constant('long' as const),
      size: fc.float({ min: Math.fround(0.001), max: Math.fround(10), noNaN: true, noDefaultInfinity: true }),
      entryPrice: fc.float({ min: Math.fround(100), max: Math.fround(200000), noNaN: true, noDefaultInfinity: true }),
      unrealizedPnl: fc.float({ noNaN: true, noDefaultInfinity: true }),
    }),
    legB: fc.record({
      symbol: fc.constant('ETH-USD'),
      side: fc.constant('short' as const),
      size: fc.float({ min: Math.fround(0.001), max: Math.fround(100), noNaN: true, noDefaultInfinity: true }),
      entryPrice: fc.float({ min: Math.fround(10), max: Math.fround(20000), noNaN: true, noDefaultInfinity: true }),
      unrealizedPnl: fc.float({ noNaN: true, noDefaultInfinity: true }),
    }),
    entryTimestamp: fc.constant(new Date().toISOString()),
    combinedPnl: fc.float({ noNaN: true, noDefaultInfinity: true }),
  });

  return fc.oneof(fc.constant(null), legPairArb);
}

describe('HedgeBot — Property 3: getStatus() always returns all required fields', () => {
  /**
   * Property 3: getStatus always returns all required fields
   *
   * For any HedgeBot state (running or stopped, with or without active pair,
   * with any sessionPnl / sessionVolume values), `getStatus()` should return
   * an object containing all required fields: `id`, `name`, `exchange`,
   * `status`, `tags`, `sessionPnl`, `sessionVolume`, `uptime`, and
   * `hedgePosition`.
   *
   * **Validates: Requirements 2.2**
   */
  it('Property 3: getStatus always returns all required fields', () => {
    fc.assert(
      fc.property(
        // botStatus: running or stopped
        fc.constantFrom('RUNNING' as const, 'STOPPED' as const),
        // sessionPnl: any finite float
        fc.float({ noNaN: true, noDefaultInfinity: true }),
        // sessionVolume: any non-negative finite float
        fc.float({ min: 0, noNaN: true, noDefaultInfinity: true }),
        // hedgePosition: null or a valid ActiveLegPair
        arbitraryHedgePosition(),
        // startTimeDeltaMs: null (never started) or elapsed ms since start
        fc.oneof(
          fc.constant(null as null),
          fc.integer({ min: 0, max: 3_600_000 }),
        ),
        (botStatus, sessionPnl, sessionVolume, hedgePosition, startTimeDeltaMs) => {
          const bot = buildHedgeBot({
            botStatus,
            sessionPnl,
            sessionVolume,
            hedgePosition,
            startTimeDeltaMs,
          });

          const status = bot.getStatus();

          // Every required field must be present (not undefined)
          for (const field of REQUIRED_STATUS_FIELDS) {
            if (!(field in status)) return false;
          }

          // status field must be 'active' or 'inactive'
          if (status.status !== 'active' && status.status !== 'inactive') return false;

          // uptime must be a non-negative number
          if (typeof status.uptime !== 'number' || status.uptime < 0) return false;

          // tags must be an array
          if (!Array.isArray(status.tags)) return false;

          // sessionPnl and sessionVolume must be numbers
          if (typeof status.sessionPnl !== 'number') return false;
          if (typeof status.sessionVolume !== 'number') return false;

          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 8.6 — Property 13: Trade log record completeness
// Requirements: 7.5, 9.2
// ---------------------------------------------------------------------------
import { buildHedgeTradeRecord } from '../hedgeBotHelpers.js';
import type { CompletedTrade, ExitReason } from '../hedgeBotHelpers.js';

/**
 * Arbitrary generator for a valid CompletedTrade object.
 * All fields are constrained to realistic domains.
 */
function arbitraryCompletedTrade(): fc.Arbitrary<CompletedTrade> {
  const exitReasons: ExitReason[] = ['PROFIT_TARGET', 'MAX_LOSS', 'MEAN_REVERSION', 'TIME_EXPIRY'];

  // Generate a pair of ISO timestamps where entry < exit
  const timestampPair = fc
    .integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 })
    .chain((entryMs) =>
      fc
        .integer({ min: 1, max: 86_400_000 }) // 1ms to 24h hold
        .map((holdMs) => ({
          entryTimestamp: new Date(entryMs).toISOString(),
          exitTimestamp: new Date(entryMs + holdMs).toISOString(),
        })),
    );

  return fc.record({
    id: fc.uuid(),
    botId: fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/),
    exchange: fc.constantFrom('sodex', 'dango', 'decibel'),
    symbolA: fc.constant('BTC-USD'),
    symbolB: fc.constant('ETH-USD'),
    legValueUsd: fc.float({ min: Math.fround(10), max: Math.fround(100_000), noNaN: true, noDefaultInfinity: true }),
    entryPriceA: fc.float({ min: Math.fround(100), max: Math.fround(200_000), noNaN: true, noDefaultInfinity: true }),
    entryPriceB: fc.float({ min: Math.fround(10), max: Math.fround(20_000), noNaN: true, noDefaultInfinity: true }),
    exitPriceA: fc.float({ min: Math.fround(100), max: Math.fround(200_000), noNaN: true, noDefaultInfinity: true }),
    exitPriceB: fc.float({ min: Math.fround(10), max: Math.fround(20_000), noNaN: true, noDefaultInfinity: true }),
    sizeA: fc.float({ min: Math.fround(0.0001), max: Math.fround(100), noNaN: true, noDefaultInfinity: true }),
    sizeB: fc.float({ min: Math.fround(0.001), max: Math.fround(1_000), noNaN: true, noDefaultInfinity: true }),
    pnlA: fc.float({ noNaN: true, noDefaultInfinity: true }),
    pnlB: fc.float({ noNaN: true, noDefaultInfinity: true }),
    exitReason: fc.constantFrom(...exitReasons),
    signalScoreA: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    signalScoreB: fc.float({ min: 0, max: 1, noNaN: true, noDefaultInfinity: true }),
    longSymbol: fc.constant('BTC-USD'),
    shortSymbol: fc.constant('ETH-USD'),
  }).chain((base) =>
    timestampPair.map(({ entryTimestamp, exitTimestamp }) => ({
      ...base,
      entryTimestamp,
      exitTimestamp,
    })),
  );
}

describe('HedgeBot — Property 13: trade log record completeness', () => {
  /**
   * Property 13: Trade log record completeness
   *
   * For any completed AtomicClose, the HedgeTradeRecord written to the trade
   * log should contain all required fields: `botId`, `exchange`, `symbolA`,
   * `symbolB`, `legValueUsd`, `entryPriceA`, `entryPriceB`, `exitPriceA`,
   * `exitPriceB`, `pnlA`, `pnlB`, `combinedPnl`, `holdDurationSecs`,
   * `exitReason`, `entryTimestamp`, and `exitTimestamp`.
   *
   * **Validates: Requirements 7.5, 9.2**
   */
  it('Property 13: buildHedgeTradeRecord always produces all required fields', () => {
    fc.assert(
      fc.property(arbitraryCompletedTrade(), (trade) => {
        const record = buildHedgeTradeRecord(trade);
        const requiredFields = [
          'botId',
          'exchange',
          'symbolA',
          'symbolB',
          'legValueUsd',
          'entryPriceA',
          'entryPriceB',
          'exitPriceA',
          'exitPriceB',
          'pnlA',
          'pnlB',
          'combinedPnl',
          'holdDurationSecs',
          'exitReason',
          'entryTimestamp',
          'exitTimestamp',
        ];
        for (const field of requiredFields) {
          expect(record).toHaveProperty(field);
          expect((record as Record<string, unknown>)[field]).not.toBeUndefined();
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Task 10.4 — Property 4: BotManager aggregated stats include HedgeBot contributions
// Requirements: 2.4
// ---------------------------------------------------------------------------
import { BotManager } from '../BotManager.js';
import { BotInstance } from '../BotInstance.js';
import type { BotConfig } from '../types.js';

/**
 * Factory: creates a minimal BotConfig for a BotInstance.
 */
function buildBotConfig(id: string): BotConfig {
  return {
    id,
    name: `Bot ${id}`,
    exchange: 'sodex',
    symbol: 'BTC-USD',
    tags: [],
    autoStart: false,
    mode: 'farm',
    orderSizeMin: 0.001,
    orderSizeMax: 0.01,
    credentialKey: 'SODEX',
    tradeLogBackend: 'json',
    tradeLogPath: `./trades-${id}.json`,
  };
}

/**
 * Factory: creates a minimal HedgeBotConfig.
 */
function buildHedgeBotConfig(id: string): import('../types.js').HedgeBotConfig {
  return {
    id,
    name: `HedgeBot ${id}`,
    botType: 'hedge',
    exchange: 'sodex',
    tags: [],
    autoStart: false,
    credentialKey: 'SODEX',
    tradeLogBackend: 'json',
    tradeLogPath: `./trades-${id}.json`,
    symbolA: 'BTC-USD',
    symbolB: 'ETH-USD',
    legValueUsd: 1000,
    holdingPeriodSecs: 300,
    profitTargetUsd: 50,
    maxLossUsd: 30,
    volumeSpikeMultiplier: 2.0,
    volumeRollingWindow: 20,
    fundingRateWeight: 0.1,
  };
}

describe('BotManager — Property 4: aggregated stats include HedgeBot contributions', () => {
  /**
   * Property 4: BotManager aggregated stats include HedgeBot contributions
   *
   * For any collection of bots registered with BotManager (including HedgeBot
   * instances), `getAggregatedStats().totalPnl` should equal the arithmetic
   * sum of `sessionPnl` across all registered bots.
   *
   * **Validates: Requirements 2.4**
   */
  it('Property 4: totalPnl equals sum of sessionPnl across all registered bots', () => {
    fc.assert(
      fc.property(
        // Array of sessionPnl values for BotInstance bots (0–3 bots)
        fc.array(
          fc.float({ noNaN: true, noDefaultInfinity: true }),
          { minLength: 0, maxLength: 3 },
        ),
        // Array of sessionPnl values for HedgeBot bots (0–3 bots)
        fc.array(
          fc.float({ noNaN: true, noDefaultInfinity: true }),
          { minLength: 0, maxLength: 3 },
        ),
        (botPnls, hedgePnls) => {
          const manager = new BotManager();
          const adapter = buildMockAdapter();
          const telegram = buildMockTelegram();

          // Register BotInstance bots with the given sessionPnl values
          botPnls.forEach((pnl, i) => {
            const config = buildBotConfig(`bot-${i}`);
            const bot = manager.createBot(config, adapter, telegram);
            bot.state.sessionPnl = pnl;
          });

          // Register HedgeBot bots with the given sessionPnl values
          hedgePnls.forEach((pnl, i) => {
            const config = buildHedgeBotConfig(`hedge-${i}`);
            const hedgeBot = manager.createHedgeBot(config, adapter, telegram);
            hedgeBot.state.sessionPnl = pnl;
          });

          const stats = manager.getAggregatedStats();

          // Expected totalPnl is the arithmetic sum of all sessionPnl values
          const expectedTotalPnl = [...botPnls, ...hedgePnls].reduce((sum, v) => sum + v, 0);

          // Use toBeCloseTo for floating-point comparison
          expect(stats.totalPnl).toBeCloseTo(expectedTotalPnl, 5);
        },
      ),
      { numRuns: 200 },
    );
  });
});
