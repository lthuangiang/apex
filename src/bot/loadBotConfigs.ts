import fs from 'fs';
import type { BotConfig, PairBotConfig } from './types.js';
import type { DeltaNeutralConfig } from './DeltaNeutralTypes.js';

/**
 * Load bot configurations from file
 * 
 * @param configPath - Path to bot-configs.json (default: ./bot-configs.json)
 * @returns Array of valid BotConfig or PairBotConfig objects
 */
export function loadBotConfigs(configPath: string = './bot-configs.json'): (BotConfig | PairBotConfig | DeltaNeutralConfig)[] {
  // Check if file exists
  if (!fs.existsSync(configPath)) {
    console.log(`[loadBotConfigs] No root bot-configs.json found — SaaS mode (tenant-only)`);
    return [];
  }
  
  // Read existing file
  try {
    const fileContent = fs.readFileSync(configPath, 'utf-8');
    const data = JSON.parse(fileContent);
    
    if (!data.bots || !Array.isArray(data.bots)) {
      console.error('[loadBotConfigs] Invalid config file format: missing "bots" array');
      return [];
    }
    
    const validConfigs: (BotConfig | PairBotConfig | DeltaNeutralConfig)[] = [];
    
    for (const config of data.bots) {
      if (config.botType === 'hedge' || config.botType === 'pair') {
        // Hedge/Pair bots now route through DeltaNeutralBot (same-exchange DN mode)
        try {
          // Map pair config → DN config if needed
          if (!config.exchangeA) {
            config.exchangeA = config.exchange;
            config.exchangeB = config.exchange;
            config.symbolA = config.symbolA || config.symbol;
            config.symbolB = config.symbolB || config.symbol;
            config.credentialKeyA = config.credentialKey || config.credentialKeyA || '';
            config.credentialKeyB = config.credentialKey || config.credentialKeyB || '';
            config.orderSizeMinUsd = config.orderSizeMinUsd || config.legValueUsd || 100;
            config.orderSizeMaxUsd = config.orderSizeMaxUsd || config.legValueUsd || 200;
            config.maxHoldSecs = config.maxHoldSecs || config.holdPeriodSecs || 1800;
            config.minHoldSecs = config.minHoldSecs || 60;
            config.maxLossUsd = config.maxLossUsd || 15;
            config.direction = config.direction || 'long';
            config.tickIntervalSecs = config.tickIntervalSecs || 60;
            config.cooldownSecs = config.cooldownSecs || 30;
            config.entryMode = config.entryMode || 'taker';
            config.botType = 'delta-neutral'; // reclassify
          }
          validateDeltaNeutralConfig(config);
          validConfigs.push(config as DeltaNeutralConfig);
        } catch (err) {
          console.warn(`[loadBotConfigs] Invalid hedge bot config skipped: ${config.id || 'unknown'} — ${err}`);
        }
      } else if (config.botType === 'oi-farmer' || config.botType === 'delta-neutral') {
        try {
          validateDeltaNeutralConfig(config);
          validConfigs.push(config as DeltaNeutralConfig);
        } catch (err) {
          console.warn(`[loadBotConfigs] Invalid delta-neutral config skipped: ${config.id || 'unknown'} — ${err}`);
        }
      } else if (validateBotConfig(config)) {
        validConfigs.push(config);
      } else {
        console.warn(`[loadBotConfigs] Invalid config skipped: ${config.id || 'unknown'}`);
      }
    }
    
    if (validConfigs.length === 0) {
      console.error('[loadBotConfigs] No valid bot configs found in file');
    } else {
      console.log(`[loadBotConfigs] Loaded ${validConfigs.length} bot config(s) from ${configPath}`);
    }
    
    return validConfigs;
  } catch (err) {
    console.error(`[loadBotConfigs] Failed to read config file: ${err}`);
    return [];
  }
}

/**
 * Validate a bot config object
 * @param config - Config object to validate
 * @returns true if valid, false otherwise
 */
export function validateBotConfig(config: any): config is BotConfig {
  if (!config || typeof config !== 'object') return false;
  
  // Required fields
  if (typeof config.id !== 'string' || config.id.trim().length === 0) return false;
  if (typeof config.name !== 'string' || config.name.trim().length === 0) return false;
  if (!['sodex', 'dango', 'decibel', 'hibachi', 'ondoperps', 'perpl'].includes(config.exchange)) return false;
  if (typeof config.symbol !== 'string' || config.symbol.trim().length === 0) return false;
  if (typeof config.credentialKey !== 'string' || config.credentialKey.trim().length === 0) return false;
  if (!['json', 'sqlite'].includes(config.tradeLogBackend)) return false;
  if (typeof config.tradeLogPath !== 'string' || config.tradeLogPath.trim().length === 0) return false;
  if (typeof config.autoStart !== 'boolean') return false;
  if (!['farm', 'trade'].includes(config.mode)) return false;
  if (typeof config.orderSizeMin !== 'number' || config.orderSizeMin <= 0) return false;
  if (typeof config.orderSizeMax !== 'number' || config.orderSizeMax <= 0) return false;
  if (!Array.isArray(config.tags)) return false;

  // Wave 3: Intelligence mode validation (optional, defaults to manual)
  if (config.intelligenceMode !== undefined && !['auto', 'manual'].includes(config.intelligenceMode)) {
    return false;
  }

  return true;
}

/**
 * Validate a pair bot config object, throwing a descriptive error for any missing required field.
 * @param config - Config object to validate
 * @throws Error naming the missing or invalid field
 */
export function validatePairBotConfig(config: any): asserts config is PairBotConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('PairBotConfig must be a non-null object');
  }

  // Base identity fields
  if (typeof config.id !== 'string' || config.id.trim().length === 0) {
    throw new Error('PairBotConfig missing required field: id');
  }
  if (typeof config.name !== 'string' || config.name.trim().length === 0) {
    throw new Error('PairBotConfig missing required field: name');
  }
  if (typeof config.credentialKey !== 'string' || config.credentialKey.trim().length === 0) {
    throw new Error('PairBotConfig missing required field: credentialKey');
  }
  if (!['json', 'sqlite'].includes(config.tradeLogBackend)) {
    throw new Error('PairBotConfig missing required field: tradeLogBackend');
  }
  if (typeof config.tradeLogPath !== 'string' || config.tradeLogPath.trim().length === 0) {
    throw new Error('PairBotConfig missing required field: tradeLogPath');
  }
  if (!Array.isArray(config.tags)) {
    throw new Error('PairBotConfig missing required field: tags');
  }
  if (typeof config.autoStart !== 'boolean') {
    throw new Error('PairBotConfig missing required field: autoStart');
  }

  // Pair-trading-specific required fields (accept both 'pair' and 'hedge' for backward compatibility)
  if (config.botType !== 'pair' && config.botType !== 'hedge') {
    throw new Error('PairBotConfig missing required field: botType (must be "pair" or "hedge")');
  }
  if (typeof config.symbolA !== 'string' || config.symbolA.trim().length === 0) {
    throw new Error('PairBotConfig missing required field: symbolA');
  }
  if (typeof config.symbolB !== 'string' || config.symbolB.trim().length === 0) {
    throw new Error('PairBotConfig missing required field: symbolB');
  }
  if (!['sodex', 'dango', 'decibel', 'hibachi', 'ondoperps', 'perpl'].includes(config.exchange)) {
    throw new Error('PairBotConfig missing required field: exchange');
  }
  if (typeof config.legValueUsd !== 'number') {
    throw new Error('PairBotConfig missing required field: legValueUsd');
  }
  if (typeof config.holdingPeriodSecs !== 'number') {
    throw new Error('PairBotConfig missing required field: holdingPeriodSecs');
  }
  if (typeof config.profitTargetUsd !== 'number') {
    throw new Error('PairBotConfig missing required field: profitTargetUsd');
  }
  if (typeof config.maxLossUsd !== 'number') {
    throw new Error('PairBotConfig missing required field: maxLossUsd');
  }
  if (typeof config.volumeSpikeMultiplier !== 'number') {
    throw new Error('PairBotConfig missing required field: volumeSpikeMultiplier');
  }
  if (typeof config.volumeRollingWindow !== 'number') {
    throw new Error('PairBotConfig missing required field: volumeRollingWindow');
  }
  if (typeof config.fundingRateWeight !== 'number') {
    throw new Error('PairBotConfig missing required field: fundingRateWeight');
  }
}

/**
 * Validate a Delta-Neutral config object, throwing a descriptive error for any missing required field.
 * @param config - Config object to validate
 * @throws Error naming the missing or invalid field
 */
export function validateDeltaNeutralConfig(config: any): asserts config is DeltaNeutralConfig {
  if (!config || typeof config !== 'object') {
    throw new Error('DeltaNeutralConfig must be a non-null object');
  }

  // Base identity fields
  if (typeof config.id !== 'string' || config.id.trim().length === 0) {
    throw new Error('DeltaNeutralConfig missing required field: id');
  }
  if (typeof config.name !== 'string' || config.name.trim().length === 0) {
    throw new Error('DeltaNeutralConfig missing required field: name');
  }
  if (config.botType !== 'oi-farmer' && config.botType !== 'delta-neutral' && config.botType !== 'hedge' && config.botType !== 'pair') {
    throw new Error('DeltaNeutralConfig missing required field: botType (must be "delta-neutral", "oi-farmer", "hedge" or "pair")');
  }
  if (!Array.isArray(config.tags)) {
    throw new Error('DeltaNeutralConfig missing required field: tags');
  }
  if (typeof config.autoStart !== 'boolean') {
    throw new Error('DeltaNeutralConfig missing required field: autoStart');
  }
  if (!['json', 'sqlite'].includes(config.tradeLogBackend)) {
    throw new Error('DeltaNeutralConfig missing required field: tradeLogBackend');
  }
  if (typeof config.tradeLogPath !== 'string' || config.tradeLogPath.trim().length === 0) {
    throw new Error('DeltaNeutralConfig missing required field: tradeLogPath');
  }

  // Cross-exchange fields
  const validExchanges = ['sodex', 'dango', 'decibel', 'hibachi', 'ondoperps', 'perpl'];
  if (!validExchanges.includes(config.exchangeA)) {
    throw new Error(`DeltaNeutralConfig invalid exchangeA: "${config.exchangeA}"`);
  }
  if (!validExchanges.includes(config.exchangeB)) {
    throw new Error(`DeltaNeutralConfig invalid exchangeB: "${config.exchangeB}"`);
  }
  // Allow same-exchange DN (hedge mode): exchangeA === exchangeB is valid
  // when the exchange supports hedge/dual-position mode (Long + Short same symbol)
  if (typeof config.credentialKeyA !== 'string' || config.credentialKeyA.trim().length === 0) {
    throw new Error('DeltaNeutralConfig missing required field: credentialKeyA');
  }
  if (typeof config.credentialKeyB !== 'string' || config.credentialKeyB.trim().length === 0) {
    throw new Error('DeltaNeutralConfig missing required field: credentialKeyB');
  }

  // Position parameters
  if (typeof config.symbol !== 'string' || config.symbol.trim().length === 0) {
    throw new Error('DeltaNeutralConfig missing required field: symbol');
  }
  if (typeof config.legValueUsd !== 'number' || config.legValueUsd <= 0) {
    throw new Error('DeltaNeutralConfig missing required field: legValueUsd (must be > 0)');
  }
  if (!['long', 'short', 'auto'].includes(config.primaryDirection)) {
    throw new Error('DeltaNeutralConfig missing required field: primaryDirection (must be "long", "short", or "auto")');
  }

  // Hold & exit rules
  if (typeof config.minHoldSecs !== 'number' || config.minHoldSecs < 0) {
    throw new Error('DeltaNeutralConfig missing required field: minHoldSecs');
  }
  if (typeof config.maxHoldSecs !== 'number' || config.maxHoldSecs <= 0) {
    throw new Error('DeltaNeutralConfig missing required field: maxHoldSecs');
  }
  if (typeof config.maxLossUsd !== 'number' || config.maxLossUsd <= 0) {
    throw new Error('DeltaNeutralConfig missing required field: maxLossUsd');
  }
  if (typeof config.maxDeltaDivergenceUsd !== 'number' || config.maxDeltaDivergenceUsd <= 0) {
    throw new Error('DeltaNeutralConfig missing required field: maxDeltaDivergenceUsd');
  }

  // Funding rate
  if (typeof config.maxFundingRateThreshold !== 'number') {
    throw new Error('DeltaNeutralConfig missing required field: maxFundingRateThreshold');
  }
  if (typeof config.autoFlipOnFunding !== 'boolean') {
    throw new Error('DeltaNeutralConfig missing required field: autoFlipOnFunding');
  }

  // Timing
  if (typeof config.tickIntervalSecs !== 'number' || config.tickIntervalSecs <= 0) {
    throw new Error('DeltaNeutralConfig missing required field: tickIntervalSecs');
  }
  if (typeof config.cooldownSecs !== 'number' || config.cooldownSecs < 0) {
    throw new Error('DeltaNeutralConfig missing required field: cooldownSecs');
  }
}
