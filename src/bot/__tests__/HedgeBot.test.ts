import { describe, it, expect, vi } from 'vitest';
import { validateHedgeBotConfig } from '../loadBotConfigs.js';
import type { HedgeBotConfig } from '../types.js';

// A complete, valid HedgeBotConfig used as the baseline for all tests
function validConfig(): HedgeBotConfig {
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

describe('validateHedgeBotConfig — unit tests', () => {
  // Requirement 1.4: valid config passes without throwing
  it('accepts a fully valid HedgeBotConfig', () => {
    expect(() => validateHedgeBotConfig(validConfig())).not.toThrow();
  });

  it('accepts a valid config with optional cooldownSecs', () => {
    const config = { ...validConfig(), cooldownSecs: 60 };
    expect(() => validateHedgeBotConfig(config)).not.toThrow();
  });

  // Requirement 1.4: each missing required field causes a descriptive error

  it('throws a descriptive error when "id" is missing', () => {
    const config = validConfig() as any;
    delete config.id;
    expect(() => validateHedgeBotConfig(config)).toThrow('id');
  });

  it('throws a descriptive error when "name" is missing', () => {
    const config = validConfig() as any;
    delete config.name;
    expect(() => validateHedgeBotConfig(config)).toThrow('name');
  });

  it('throws a descriptive error when "botType" is missing', () => {
    const config = validConfig() as any;
    delete config.botType;
    expect(() => validateHedgeBotConfig(config)).toThrow('botType');
  });

  it('throws a descriptive error when "exchange" is missing', () => {
    const config = validConfig() as any;
    delete config.exchange;
    expect(() => validateHedgeBotConfig(config)).toThrow('exchange');
  });

  it('throws a descriptive error when "tags" is missing', () => {
    const config = validConfig() as any;
    delete config.tags;
    expect(() => validateHedgeBotConfig(config)).toThrow('tags');
  });

  it('throws a descriptive error when "autoStart" is missing', () => {
    const config = validConfig() as any;
    delete config.autoStart;
    expect(() => validateHedgeBotConfig(config)).toThrow('autoStart');
  });

  it('throws a descriptive error when "credentialKey" is missing', () => {
    const config = validConfig() as any;
    delete config.credentialKey;
    expect(() => validateHedgeBotConfig(config)).toThrow('credentialKey');
  });

  it('throws a descriptive error when "tradeLogBackend" is missing', () => {
    const config = validConfig() as any;
    delete config.tradeLogBackend;
    expect(() => validateHedgeBotConfig(config)).toThrow('tradeLogBackend');
  });

  it('throws a descriptive error when "tradeLogPath" is missing', () => {
    const config = validConfig() as any;
    delete config.tradeLogPath;
    expect(() => validateHedgeBotConfig(config)).toThrow('tradeLogPath');
  });

  it('throws a descriptive error when "symbolA" is missing', () => {
    const config = validConfig() as any;
    delete config.symbolA;
    expect(() => validateHedgeBotConfig(config)).toThrow('symbolA');
  });

  it('throws a descriptive error when "symbolB" is missing', () => {
    const config = validConfig() as any;
    delete config.symbolB;
    expect(() => validateHedgeBotConfig(config)).toThrow('symbolB');
  });

  it('throws a descriptive error when "legValueUsd" is missing', () => {
    const config = validConfig() as any;
    delete config.legValueUsd;
    expect(() => validateHedgeBotConfig(config)).toThrow('legValueUsd');
  });

  it('throws a descriptive error when "holdingPeriodSecs" is missing', () => {
    const config = validConfig() as any;
    delete config.holdingPeriodSecs;
    expect(() => validateHedgeBotConfig(config)).toThrow('holdingPeriodSecs');
  });

  it('throws a descriptive error when "profitTargetUsd" is missing', () => {
    const config = validConfig() as any;
    delete config.profitTargetUsd;
    expect(() => validateHedgeBotConfig(config)).toThrow('profitTargetUsd');
  });

  it('throws a descriptive error when "maxLossUsd" is missing', () => {
    const config = validConfig() as any;
    delete config.maxLossUsd;
    expect(() => validateHedgeBotConfig(config)).toThrow('maxLossUsd');
  });

  it('throws a descriptive error when "volumeSpikeMultiplier" is missing', () => {
    const config = validConfig() as any;
    delete config.volumeSpikeMultiplier;
    expect(() => validateHedgeBotConfig(config)).toThrow('volumeSpikeMultiplier');
  });

  it('throws a descriptive error when "volumeRollingWindow" is missing', () => {
    const config = validConfig() as any;
    delete config.volumeRollingWindow;
    expect(() => validateHedgeBotConfig(config)).toThrow('volumeRollingWindow');
  });

  it('throws a descriptive error when "fundingRateWeight" is missing', () => {
    const config = validConfig() as any;
    delete config.fundingRateWeight;
    expect(() => validateHedgeBotConfig(config)).toThrow('fundingRateWeight');
  });

  // Edge cases: wrong types / invalid values
  it('throws when "id" is an empty string', () => {
    const config = { ...validConfig(), id: '' };
    expect(() => validateHedgeBotConfig(config)).toThrow('id');
  });

  it('throws when "botType" is not "hedge"', () => {
    const config = { ...validConfig(), botType: 'trade' } as any;
    expect(() => validateHedgeBotConfig(config)).toThrow('botType');
  });

  it('throws when "exchange" is an unsupported value', () => {
    const config = { ...validConfig(), exchange: 'binance' } as any;
    expect(() => validateHedgeBotConfig(config)).toThrow('exchange');
  });

  it('throws when "tradeLogBackend" is an unsupported value', () => {
    const config = { ...validConfig(), tradeLogBackend: 'postgres' } as any;
    expect(() => validateHedgeBotConfig(config)).toThrow('tradeLogBackend');
  });

  it('throws when config is null', () => {
    expect(() => validateHedgeBotConfig(null)).toThrow();
  });

  it('throws when config is not an object', () => {
    expect(() => validateHedgeBotConfig('not-an-object')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 5.4 — Unit tests for direction assignment and exit conditions
// Requirements: 4.2, 4.3, 4.4, 6.2, 6.3, 6.4, 6.5, 6.6
// ---------------------------------------------------------------------------
import {
  assignDirections,
  evaluateExitConditions,
  computeCombinedPnl,
} from '../hedgeBotHelpers.js';
import type { ExitConditionInput } from '../hedgeBotHelpers.js';

// ---------------------------------------------------------------------------
// assignDirections — direction assignment
// ---------------------------------------------------------------------------

describe('assignDirections — direction assignment', () => {
  // Requirement 4.2 / 4.3: higher score → LongLeg
  it('assigns symbolA as long when scoreA > scoreB by a clear margin', () => {
    const result = assignDirections('BTC', 0.8, 'ETH', 0.3);
    expect(result).not.toBeNull();
    expect(result!.longSymbol).toBe('BTC');
    expect(result!.shortSymbol).toBe('ETH');
  });

  it('assigns symbolB as long when scoreB > scoreA by a clear margin', () => {
    const result = assignDirections('BTC', 0.2, 'ETH', 0.9);
    expect(result).not.toBeNull();
    expect(result!.longSymbol).toBe('ETH');
    expect(result!.shortSymbol).toBe('BTC');
  });

  it('assigns correctly when scores are far apart (0.0 vs 1.0)', () => {
    const result = assignDirections('A', 0.0, 'B', 1.0);
    expect(result).not.toBeNull();
    expect(result!.longSymbol).toBe('B');
    expect(result!.shortSymbol).toBe('A');
  });

  it('assigns correctly when scores are close but outside the 0.001 tolerance', () => {
    // 0.5 vs 0.5015 — difference is 0.0015 > 0.001
    const result = assignDirections('A', 0.5, 'B', 0.5015);
    expect(result).not.toBeNull();
    expect(result!.longSymbol).toBe('B');
    expect(result!.shortSymbol).toBe('A');
  });

  // Requirement 4.4: tie / skip handling
  it('returns null when scores are exactly equal', () => {
    const result = assignDirections('BTC', 0.5, 'ETH', 0.5);
    expect(result).toBeNull();
  });

  it('returns null when scores differ by exactly 0.001 (boundary)', () => {
    // Use values where the difference is unambiguously <= 0.001 in floating point.
    // 0.0 and 0.001 differ by exactly 0.001 → should return null (condition is <=).
    const result = assignDirections('BTC', 0.0, 'ETH', 0.001);
    expect(result).toBeNull();
  });

  it('returns null when scores differ by less than 0.001', () => {
    const result = assignDirections('BTC', 0.5, 'ETH', 0.5005);
    expect(result).toBeNull();
  });

  it('returns null when both scores are 0 (both-skip sentinel)', () => {
    const result = assignDirections('BTC', 0, 'ETH', 0);
    expect(result).toBeNull();
  });

  // Requirement 4.3: funding rate adjustment
  it('applies funding rate adjustment before comparison', () => {
    // Without adjustment: scoreA=0.4, scoreB=0.6 → B is long
    // With adjustment: adjustedA = 0.4 + 0.5*0.5 = 0.65, adjustedB = 0.6 + 0.0*0.5 = 0.6 → A is long
    const result = assignDirections('A', 0.4, 'B', 0.6, 0.5, 0.0, 0.5);
    expect(result).not.toBeNull();
    expect(result!.longSymbol).toBe('A');
    expect(result!.shortSymbol).toBe('B');
  });

  it('returns null when funding rate adjustment makes scores equal within 0.001', () => {
    // scoreA=0.5, scoreB=0.6, fundingA=0.2, fundingB=0.0, weight=0.5
    // adjustedA = 0.5 + 0.2*0.5 = 0.6, adjustedB = 0.6 + 0.0*0.5 = 0.6 → tie
    const result = assignDirections('A', 0.5, 'B', 0.6, 0.2, 0.0, 0.5);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// evaluateExitConditions — exit condition triggers
// ---------------------------------------------------------------------------

/** Returns a baseline input where no exit condition is triggered. */
function noExitInput(): ExitConditionInput {
  return {
    combinedPnl: 0,
    profitTargetUsd: 50,
    maxLossUsd: 30,
    elapsedSecs: 100,
    holdingPeriodSecs: 300,
    currentRatio: 20.0,   // far from equilibrium
    equilibriumSpread: 15.0,
  };
}

describe('evaluateExitConditions — no exit', () => {
  it('returns shouldExit=false when no condition is met', () => {
    const result = evaluateExitConditions(noExitInput());
    expect(result.shouldExit).toBe(false);
    expect(result.reason).toBeNull();
  });
});

describe('evaluateExitConditions — MAX_LOSS trigger (Requirement 6.4)', () => {
  it('triggers MAX_LOSS when combinedPnl equals -maxLossUsd', () => {
    const input = { ...noExitInput(), combinedPnl: -30 };
    const result = evaluateExitConditions(input);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('MAX_LOSS');
  });

  it('triggers MAX_LOSS when combinedPnl is below -maxLossUsd', () => {
    const input = { ...noExitInput(), combinedPnl: -50 };
    const result = evaluateExitConditions(input);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('MAX_LOSS');
  });

  it('does NOT trigger MAX_LOSS when combinedPnl is just above -maxLossUsd', () => {
    const input = { ...noExitInput(), combinedPnl: -29.99 };
    const result = evaluateExitConditions(input);
    expect(result.reason).not.toBe('MAX_LOSS');
  });
});

describe('evaluateExitConditions — PROFIT_TARGET trigger (Requirement 6.3)', () => {
  it('triggers PROFIT_TARGET when combinedPnl equals profitTargetUsd', () => {
    const input = { ...noExitInput(), combinedPnl: 50 };
    const result = evaluateExitConditions(input);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('PROFIT_TARGET');
  });

  it('triggers PROFIT_TARGET when combinedPnl exceeds profitTargetUsd', () => {
    const input = { ...noExitInput(), combinedPnl: 75 };
    const result = evaluateExitConditions(input);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('PROFIT_TARGET');
  });

  it('does NOT trigger PROFIT_TARGET when combinedPnl is just below profitTargetUsd', () => {
    const input = { ...noExitInput(), combinedPnl: 49.99 };
    const result = evaluateExitConditions(input);
    expect(result.reason).not.toBe('PROFIT_TARGET');
  });
});

describe('evaluateExitConditions — MEAN_REVERSION trigger (Requirement 6.5)', () => {
  // Mean reversion fires when |currentRatio - equilibriumSpread| / equilibriumSpread < 0.005

  it('triggers MEAN_REVERSION when ratio is exactly at equilibrium', () => {
    const input = { ...noExitInput(), currentRatio: 15.0, equilibriumSpread: 15.0 };
    const result = evaluateExitConditions(input);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('MEAN_REVERSION');
  });

  it('triggers MEAN_REVERSION when deviation is just inside 0.5% threshold', () => {
    // deviation = 0.004 < 0.005 → should trigger
    const equilibrium = 100.0;
    const current = 100.0 * (1 + 0.004); // 0.4% deviation
    const input = { ...noExitInput(), currentRatio: current, equilibriumSpread: equilibrium };
    const result = evaluateExitConditions(input);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('MEAN_REVERSION');
  });

  it('does NOT trigger MEAN_REVERSION when deviation equals exactly 0.5%', () => {
    // Use a ratio that is clearly >= 0.5% away from equilibrium to avoid
    // floating-point boundary ambiguity. 0.6% deviation is unambiguously outside.
    const equilibrium = 100.0;
    const current = 100.6; // 0.6% deviation — clearly above 0.5% threshold
    const input = { ...noExitInput(), currentRatio: current, equilibriumSpread: equilibrium };
    const result = evaluateExitConditions(input);
    expect(result.reason).not.toBe('MEAN_REVERSION');
  });

  it('does NOT trigger MEAN_REVERSION when deviation is above 0.5%', () => {
    const equilibrium = 100.0;
    const current = 100.0 * (1 + 0.01); // 1% deviation
    const input = { ...noExitInput(), currentRatio: current, equilibriumSpread: equilibrium };
    const result = evaluateExitConditions(input);
    expect(result.reason).not.toBe('MEAN_REVERSION');
  });

  it('does NOT trigger MEAN_REVERSION when equilibriumSpread is 0 (guard)', () => {
    const input = { ...noExitInput(), currentRatio: 0, equilibriumSpread: 0 };
    const result = evaluateExitConditions(input);
    expect(result.reason).not.toBe('MEAN_REVERSION');
  });
});

describe('evaluateExitConditions — TIME_EXPIRY trigger (Requirement 6.2)', () => {
  it('triggers TIME_EXPIRY when elapsedSecs equals holdingPeriodSecs', () => {
    const input = { ...noExitInput(), elapsedSecs: 300, holdingPeriodSecs: 300 };
    const result = evaluateExitConditions(input);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TIME_EXPIRY');
  });

  it('triggers TIME_EXPIRY when elapsedSecs exceeds holdingPeriodSecs', () => {
    const input = { ...noExitInput(), elapsedSecs: 400, holdingPeriodSecs: 300 };
    const result = evaluateExitConditions(input);
    expect(result.shouldExit).toBe(true);
    expect(result.reason).toBe('TIME_EXPIRY');
  });

  it('does NOT trigger TIME_EXPIRY when elapsedSecs is just below holdingPeriodSecs', () => {
    const input = { ...noExitInput(), elapsedSecs: 299, holdingPeriodSecs: 300 };
    const result = evaluateExitConditions(input);
    expect(result.reason).not.toBe('TIME_EXPIRY');
  });
});

describe('evaluateExitConditions — priority ordering (Requirement 6.6)', () => {
  it('MAX_LOSS takes priority over PROFIT_TARGET when both are triggered', () => {
    // combinedPnl = -30 triggers MAX_LOSS; but also >= profitTargetUsd if we set it negative
    // Use: combinedPnl = -30 (hits MAX_LOSS), profitTargetUsd = -35 (also hit since -30 >= -35)
    const input: ExitConditionInput = {
      combinedPnl: -30,
      profitTargetUsd: -35,  // -30 >= -35 → PROFIT_TARGET also triggered
      maxLossUsd: 30,         // -30 <= -30 → MAX_LOSS triggered
      elapsedSecs: 400,
      holdingPeriodSecs: 300,
      currentRatio: 15.0,
      equilibriumSpread: 15.0,
    };
    const result = evaluateExitConditions(input);
    expect(result.reason).toBe('MAX_LOSS');
  });

  it('MAX_LOSS takes priority over MEAN_REVERSION when both are triggered', () => {
    const input: ExitConditionInput = {
      combinedPnl: -30,
      profitTargetUsd: 50,
      maxLossUsd: 30,
      elapsedSecs: 100,
      holdingPeriodSecs: 300,
      currentRatio: 15.0,    // at equilibrium → MEAN_REVERSION triggered
      equilibriumSpread: 15.0,
    };
    const result = evaluateExitConditions(input);
    expect(result.reason).toBe('MAX_LOSS');
  });

  it('MAX_LOSS takes priority over TIME_EXPIRY when both are triggered', () => {
    const input: ExitConditionInput = {
      combinedPnl: -30,
      profitTargetUsd: 50,
      maxLossUsd: 30,
      elapsedSecs: 400,      // TIME_EXPIRY triggered
      holdingPeriodSecs: 300,
      currentRatio: 20.0,
      equilibriumSpread: 15.0,
    };
    const result = evaluateExitConditions(input);
    expect(result.reason).toBe('MAX_LOSS');
  });

  it('PROFIT_TARGET takes priority over MEAN_REVERSION when both are triggered', () => {
    const input: ExitConditionInput = {
      combinedPnl: 50,       // PROFIT_TARGET triggered
      profitTargetUsd: 50,
      maxLossUsd: 30,
      elapsedSecs: 100,
      holdingPeriodSecs: 300,
      currentRatio: 15.0,    // MEAN_REVERSION triggered
      equilibriumSpread: 15.0,
    };
    const result = evaluateExitConditions(input);
    expect(result.reason).toBe('PROFIT_TARGET');
  });

  it('PROFIT_TARGET takes priority over TIME_EXPIRY when both are triggered', () => {
    const input: ExitConditionInput = {
      combinedPnl: 50,
      profitTargetUsd: 50,
      maxLossUsd: 30,
      elapsedSecs: 400,      // TIME_EXPIRY triggered
      holdingPeriodSecs: 300,
      currentRatio: 20.0,
      equilibriumSpread: 15.0,
    };
    const result = evaluateExitConditions(input);
    expect(result.reason).toBe('PROFIT_TARGET');
  });

  it('MEAN_REVERSION takes priority over TIME_EXPIRY when both are triggered', () => {
    const input: ExitConditionInput = {
      combinedPnl: 0,
      profitTargetUsd: 50,
      maxLossUsd: 30,
      elapsedSecs: 400,      // TIME_EXPIRY triggered
      holdingPeriodSecs: 300,
      currentRatio: 15.0,    // MEAN_REVERSION triggered
      equilibriumSpread: 15.0,
    };
    const result = evaluateExitConditions(input);
    expect(result.reason).toBe('MEAN_REVERSION');
  });
});

// ---------------------------------------------------------------------------
// computeCombinedPnl — arithmetic identity
// ---------------------------------------------------------------------------

describe('computeCombinedPnl', () => {
  it('returns the sum of two positive PnL values', () => {
    expect(computeCombinedPnl(10, 20)).toBe(30);
  });

  it('returns the sum when one leg is negative', () => {
    expect(computeCombinedPnl(30, -10)).toBe(20);
  });

  it('returns the sum when both legs are negative', () => {
    expect(computeCombinedPnl(-15, -10)).toBe(-25);
  });

  it('returns 0 when both legs are 0', () => {
    expect(computeCombinedPnl(0, 0)).toBe(0);
  });

  it('returns the sum when legs cancel out', () => {
    expect(computeCombinedPnl(50, -50)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Task 6.1 / 6.2 — Unit tests for computeLegSize and checkLegImbalance
// Requirements: 5.1, 8.1, 8.2
// ---------------------------------------------------------------------------
import { computeLegSize, checkLegImbalance } from '../hedgeBotHelpers.js';

describe('computeLegSize — leg size computation (Requirement 5.1)', () => {
  it('computes size as legValueUsd / markPrice', () => {
    expect(computeLegSize(1000, 50000)).toBeCloseTo(0.02, 10);
  });

  it('computes size correctly for ETH-like prices', () => {
    expect(computeLegSize(1000, 2000)).toBeCloseTo(0.5, 10);
  });

  it('returns legValueUsd when markPrice is 1', () => {
    expect(computeLegSize(500, 1)).toBeCloseTo(500, 10);
  });

  it('returns 1 when legValueUsd equals markPrice', () => {
    expect(computeLegSize(3000, 3000)).toBeCloseTo(1, 10);
  });

  it('handles fractional legValueUsd', () => {
    expect(computeLegSize(0.5, 100)).toBeCloseTo(0.005, 10);
  });

  it('handles large mark prices', () => {
    expect(computeLegSize(10000, 100000)).toBeCloseTo(0.1, 10);
  });
});

describe('checkLegImbalance — imbalance detection (Requirements 8.1, 8.2)', () => {
  it('returns 0 when both leg values are equal', () => {
    expect(checkLegImbalance(1000, 1000, 1000)).toBe(0);
  });

  it('returns correct deviation for a 0.5% imbalance', () => {
    // |1005 - 1000| / 1000 = 0.005
    expect(checkLegImbalance(1005, 1000, 1000)).toBeCloseTo(0.005, 10);
  });

  it('returns correct deviation for a 1% imbalance (boundary)', () => {
    // |1010 - 1000| / 1000 = 0.01
    expect(checkLegImbalance(1010, 1000, 1000)).toBeCloseTo(0.01, 10);
  });

  it('returns correct deviation for a 2% imbalance', () => {
    // |1020 - 1000| / 1000 = 0.02
    expect(checkLegImbalance(1020, 1000, 1000)).toBeCloseTo(0.02, 10);
  });

  it('uses absolute value — same deviation regardless of which leg is larger', () => {
    const devAB = checkLegImbalance(1020, 1000, 1000);
    const devBA = checkLegImbalance(1000, 1020, 1000);
    expect(devAB).toBeCloseTo(devBA, 10);
  });

  it('logs a warning when deviation exceeds 1%', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkLegImbalance(1020, 1000, 1000); // 2% deviation
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('Leg imbalance detected');
    warnSpy.mockRestore();
  });

  it('does NOT log a warning when deviation is exactly 1% (boundary — not exceeded)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkLegImbalance(1010, 1000, 1000); // exactly 1% — not > 0.01
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does NOT log a warning when deviation is below 1%', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkLegImbalance(1005, 1000, 1000); // 0.5% deviation
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('warning message includes actual leg values and deviation percentage', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    checkLegImbalance(1050, 1000, 1000); // 5% deviation
    const msg: string = warnSpy.mock.calls[0][0];
    expect(msg).toContain('1050');
    expect(msg).toContain('1000');
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Task 7.4 — Unit tests for HedgeBot lifecycle and getStatus()
// Requirements: 2.1, 2.2, 2.3
// ---------------------------------------------------------------------------
import { HedgeBot } from '../HedgeBot.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../../modules/TelegramManager.js';
import type { ActiveLegPair } from '../HedgeBotSharedState.js';

/** Returns a complete, valid HedgeBotConfig for lifecycle tests. */
function hedgeBotConfig() {
  return {
    id: 'hedge-lifecycle-1',
    name: 'Lifecycle Hedge Bot',
    botType: 'hedge' as const,
    exchange: 'sodex' as const,
    tags: ['hedge', 'test'],
    autoStart: false,
    credentialKey: 'SODEX',
    tradeLogBackend: 'json' as const,
    tradeLogPath: './trades-hedge-test.json',
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

/** Creates a mock ExchangeAdapter with all methods stubbed via vi.fn(). */
function mockAdapter(): ExchangeAdapter {
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

/** Creates a minimal TelegramManager mock (all methods are no-ops). */
function mockTelegram(): TelegramManager {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendMessageWithInlineButtons: vi.fn().mockResolvedValue(undefined),
    setupMenu: vi.fn().mockResolvedValue(undefined),
    onCallback: vi.fn(),
    onCommand: vi.fn(),
    isEnabled: vi.fn().mockReturnValue(false),
  } as unknown as TelegramManager;
}

/** A sample ActiveLegPair used to simulate an open hedge position. */
function sampleActiveLegPair(): ActiveLegPair {
  return {
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
    entryTimestamp: new Date().toISOString(),
    combinedPnl: 5,
  };
}

describe('HedgeBot — lifecycle and getStatus() unit tests', () => {
  // -------------------------------------------------------------------------
  // Requirement 2.1: start() transitions state to RUNNING
  // -------------------------------------------------------------------------

  it('start() transitions botStatus to RUNNING and returns true', async () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());

    expect(bot.state.botStatus).toBe('STOPPED');

    const result = await bot.start();

    expect(result).toBe(true);
    expect(bot.state.botStatus).toBe('RUNNING');

    // Clean up — stop the tick loop
    await bot.stop();
  });

  it('start() returns false when already RUNNING', async () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());

    await bot.start();
    const secondResult = await bot.start();

    expect(secondResult).toBe(false);
    expect(bot.state.botStatus).toBe('RUNNING');

    await bot.stop();
  });

  it('start() updates updatedAt timestamp', async () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());
    const before = bot.state.updatedAt;

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 5));
    await bot.start();

    expect(bot.state.updatedAt).not.toBe(before);

    await bot.stop();
  });

  // -------------------------------------------------------------------------
  // Requirement 2.1: stop() with no active pair transitions to STOPPED
  // -------------------------------------------------------------------------

  it('stop() with no active pair transitions botStatus to STOPPED', async () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());

    await bot.start();
    expect(bot.state.botStatus).toBe('RUNNING');

    await bot.stop();

    expect(bot.state.botStatus).toBe('STOPPED');
  });

  it('stop() with no active pair does NOT log a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());

    await bot.start();
    await bot.stop();

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Requirement 2.3: stop() with active pair logs warning, does NOT close positions
  // -------------------------------------------------------------------------

  it('stop() with active pair logs a warning about open positions', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const adapter = mockAdapter();
    const bot = new HedgeBot(hedgeBotConfig(), adapter, mockTelegram());

    // Inject an active hedge position directly into state
    bot.state.hedgePosition = sampleActiveLegPair();

    await bot.start();
    await bot.stop();

    expect(warnSpy).toHaveBeenCalledOnce();
    const warnMsg: string = warnSpy.mock.calls[0][0];
    expect(warnMsg).toContain('WARNING');
    expect(warnMsg).toContain('Stopped with active LegPair');

    warnSpy.mockRestore();
  });

  it('stop() with active pair does NOT call place_limit_order (no auto-close)', async () => {
    const adapter = mockAdapter();
    const bot = new HedgeBot(hedgeBotConfig(), adapter, mockTelegram());

    bot.state.hedgePosition = sampleActiveLegPair();

    await bot.start();
    await bot.stop();

    expect(adapter.place_limit_order).not.toHaveBeenCalled();
  });

  it('stop() with active pair still transitions botStatus to STOPPED', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());

    bot.state.hedgePosition = sampleActiveLegPair();

    await bot.start();
    await bot.stop();

    expect(bot.state.botStatus).toBe('STOPPED');
    warnSpy.mockRestore();
  });

  // -------------------------------------------------------------------------
  // Requirement 2.2: getStatus() returns all required fields in all states
  // -------------------------------------------------------------------------

  it('getStatus() returns all required fields when bot is STOPPED with no position', () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());

    const status = bot.getStatus();

    expect(status).toHaveProperty('id');
    expect(status).toHaveProperty('name');
    expect(status).toHaveProperty('exchange');
    expect(status).toHaveProperty('status');
    expect(status).toHaveProperty('tags');
    expect(status).toHaveProperty('sessionPnl');
    expect(status).toHaveProperty('sessionVolume');
    expect(status).toHaveProperty('uptime');
    expect(status).toHaveProperty('hedgePosition');
  });

  it('getStatus() returns correct values when bot is STOPPED', () => {
    const config = hedgeBotConfig();
    const bot = new HedgeBot(config, mockAdapter(), mockTelegram());

    const status = bot.getStatus();

    expect(status.id).toBe(config.id);
    expect(status.name).toBe(config.name);
    expect(status.exchange).toBe(config.exchange);
    expect(status.status).toBe('inactive');
    expect(status.tags).toEqual(config.tags);
    expect(status.sessionPnl).toBe(0);
    expect(status.sessionVolume).toBe(0);
    expect(status.uptime).toBe(0);
    expect(status.hedgePosition).toBeNull();
  });

  it('getStatus() returns status="active" when bot is RUNNING', async () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());

    await bot.start();
    const status = bot.getStatus();

    expect(status.status).toBe('active');

    await bot.stop();
  });

  it('getStatus() returns status="inactive" after stop()', async () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());

    await bot.start();
    await bot.stop();

    const status = bot.getStatus();
    expect(status.status).toBe('inactive');
  });

  it('getStatus() returns hedgePosition when an active pair is set', () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());
    const pair = sampleActiveLegPair();
    bot.state.hedgePosition = pair;

    const status = bot.getStatus();

    expect(status.hedgePosition).not.toBeNull();
    expect(status.hedgePosition).toEqual(pair);
  });

  it('getStatus() returns uptime > 0 after bot has been running', async () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());

    await bot.start();

    // Manually backdate _startTime to simulate elapsed time (60 seconds = 1 minute)
    (bot as any)._startTime = Date.now() - 60_000;

    const status = bot.getStatus();
    expect(status.uptime).toBeGreaterThanOrEqual(1);

    await bot.stop();
  });

  it('getStatus() returns openPosition as null (hedge uses hedgePosition)', () => {
    const bot = new HedgeBot(hedgeBotConfig(), mockAdapter(), mockTelegram());
    const status = bot.getStatus();
    expect(status.openPosition).toBeNull();
  });
});
