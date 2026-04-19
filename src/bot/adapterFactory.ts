import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import { SodexAdapter } from '../adapters/sodex_adapter.js';
import { DangoAdapter } from '../adapters/dango_adapter.js';
import { DecibelAdapter } from '../adapters/decibel_adapter.js';

/**
 * Create an exchange adapter from bot config
 * 
 * @param exchange - Exchange name ('sodex', 'dango', 'decibel')
 * @param credentialKey - Env var prefix for credentials (e.g., 'SODEX' → SODEX_API_KEY, SODEX_API_SECRET)
 * @returns Initialized ExchangeAdapter instance
 * @throws Error if credentials are missing or exchange is unsupported
 */
export function createAdapter(exchange: string, credentialKey: string): ExchangeAdapter {
  const exchangeLower = exchange.toLowerCase();
  
  switch (exchangeLower) {
    case 'sodex': {
      const apiKey = process.env[`${credentialKey}_API_KEY`];
      const apiSecret = process.env[`${credentialKey}_API_SECRET`];
      const subaccount = process.env[`${credentialKey}_SUBACCOUNT`];
      
      if (!apiKey || !apiSecret || !subaccount) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env vars: ` +
          `${credentialKey}_API_KEY, ${credentialKey}_API_SECRET, ${credentialKey}_SUBACCOUNT`
        );
      }
      
      console.log(`[adapterFactory] Creating SodexAdapter with credentialKey: ${credentialKey}`);
      return new SodexAdapter(apiKey, apiSecret, subaccount);
    }
    
    case 'dango': {
      const privateKey = process.env[`${credentialKey}_PRIVATE_KEY`];
      const userAddress = process.env[`${credentialKey}_USER_ADDRESS`];
      const network = (process.env[`${credentialKey}_NETWORK`] ?? 'mainnet') as 'mainnet' | 'testnet';
      
      if (!privateKey || !userAddress) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env vars: ` +
          `${credentialKey}_PRIVATE_KEY, ${credentialKey}_USER_ADDRESS`
        );
      }
      
      console.log(`[adapterFactory] Creating DangoAdapter with credentialKey: ${credentialKey}, network: ${network}`);
      return new DangoAdapter(privateKey, userAddress, network);
    }
    
    case 'decibel': {
      const privateKey = process.env[`${credentialKey}_PRIVATE_KEY`];
      const nodeApiKey = process.env[`${credentialKey}_NODE_API_KEY`] ?? '';
      const subaccount = process.env[`${credentialKey}_SUBACCOUNT`] ?? '';
      const builderAddress = process.env[`${credentialKey}_BUILDER_ADDRESS`]?.trim() ?? '';
      const gasStationApiKey = process.env[`${credentialKey}_GAS_STATION_API_KEY`];
      
      if (!privateKey) {
        throw new Error(
          `Missing credentials for ${exchange}. Required env var: ${credentialKey}_PRIVATE_KEY`
        );
      }
      
      console.log(`[adapterFactory] Creating DecibelAdapter with credentialKey: ${credentialKey}`);
      return new DecibelAdapter(
        privateKey,
        nodeApiKey,
        subaccount,
        builderAddress,
        10, // builderFeeBps
        gasStationApiKey
      );
    }
    
    default:
      throw new Error(
        `Unsupported exchange: "${exchange}". Supported exchanges: sodex, dango, decibel`
      );
  }
}
