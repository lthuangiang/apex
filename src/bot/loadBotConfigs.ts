import fs from 'fs';
import type { BotConfig } from './types.js';

/**
 * Load bot configurations from file
 * 
 * @param configPath - Path to bot-configs.json (default: ./bot-configs.json)
 * @returns Array of valid BotConfig objects
 */
export function loadBotConfigs(configPath: string = './bot-configs.json'): BotConfig[] {
  // Check if file exists
  if (!fs.existsSync(configPath)) {
    console.warn(`[loadBotConfigs] Config file not found: ${configPath}`);
    console.log('[loadBotConfigs] Creating default bot-configs.json with 3 bots');
    
    const defaultConfigs: BotConfig[] = [
      {
        id: 'sodex-bot',
        name: 'SoDEX Bot',
        exchange: 'sodex',
        symbol: 'BTC-USD',
        credentialKey: 'SODEX',
        tradeLogBackend: 'json',
        tradeLogPath: './trades-sodex.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['TWAP', 'Farm'],
      },
      {
        id: 'decibel-bot',
        name: 'Decibel Bot',
        exchange: 'decibel',
        symbol: 'BTC/USD',
        credentialKey: 'DECIBELS',
        tradeLogBackend: 'json',
        tradeLogPath: './trades-decibel.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Market Making', 'Farm'],
      },
      {
        id: 'dango-bot',
        name: 'Dango Bot',
        exchange: 'dango',
        symbol: 'BTC-USD',
        credentialKey: 'DANGO',
        tradeLogBackend: 'json',
        tradeLogPath: './trades-dango.json',
        autoStart: false,
        mode: 'farm',
        orderSizeMin: 0.003,
        orderSizeMax: 0.005,
        tags: ['Scalping', 'Farm'],
      },
    ];
    
    // Write default configs to file
    const data = {
      version: 1,
      bots: defaultConfigs,
    };
    
    fs.writeFileSync(configPath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[loadBotConfigs] Created ${configPath} with ${defaultConfigs.length} default bots`);
    
    return defaultConfigs;
  }
  
  // Read existing file
  try {
    const fileContent = fs.readFileSync(configPath, 'utf-8');
    const data = JSON.parse(fileContent);
    
    if (!data.bots || !Array.isArray(data.bots)) {
      console.error('[loadBotConfigs] Invalid config file format: missing "bots" array');
      return [];
    }
    
    const validConfigs: BotConfig[] = [];
    
    for (const config of data.bots) {
      if (validateBotConfig(config)) {
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
function validateBotConfig(config: any): config is BotConfig {
  if (!config || typeof config !== 'object') return false;
  
  // Required fields
  if (typeof config.id !== 'string' || config.id.trim().length === 0) return false;
  if (typeof config.name !== 'string' || config.name.trim().length === 0) return false;
  if (!['sodex', 'dango', 'decibel'].includes(config.exchange)) return false;
  if (typeof config.symbol !== 'string' || config.symbol.trim().length === 0) return false;
  if (typeof config.credentialKey !== 'string' || config.credentialKey.trim().length === 0) return false;
  if (!['json', 'sqlite'].includes(config.tradeLogBackend)) return false;
  if (typeof config.tradeLogPath !== 'string' || config.tradeLogPath.trim().length === 0) return false;
  if (typeof config.autoStart !== 'boolean') return false;
  if (!['farm', 'trade'].includes(config.mode)) return false;
  if (typeof config.orderSizeMin !== 'number' || config.orderSizeMin <= 0) return false;
  if (typeof config.orderSizeMax !== 'number' || config.orderSizeMax <= 0) return false;
  if (!Array.isArray(config.tags)) return false;
  
  return true;
}
