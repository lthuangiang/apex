/**
 * Sodex adapter factory implementation
 * 
 * Creates and configures Sodex exchange adapters with proper validation
 * and feature detection.
 */

import { IExchangeAdapter } from '../../types/core.js';
import { AdapterConfig } from '../../types/config.js';
import { BaseAdapterFactory } from './BaseAdapterFactory.js';
import { SodexAdapter } from '../../adapters/sodex_adapter.js';

/**
 * Factory for creating Sodex exchange adapters
 */
export class SodexAdapterFactory extends BaseAdapterFactory {
  constructor() {
    super(
      'sodex',
      [
        'spot_trading',
        'perpetual_trading',
        'limit_orders',
        'market_orders',
        'position_tracking',
        'balance_tracking',
        'orderbook_data',
        'trade_history',
        'real_time_data',
        'margin_trading'
      ],
      [
        'apiKey',
        'apiSecret',
        'userAddress'
      ],
      []
    );
  }

  /**
   * Create Sodex adapter instance
   */
  create(config: AdapterConfig): IExchangeAdapter {
    const {
      apiKey,
      apiSecret,
      userAddress
    } = config.credentials;

    if (!apiKey || !apiSecret || !userAddress) {
      throw new Error('Missing required credentials for Sodex adapter');
    }

    // Create the adapter instance
    const adapter = new SodexAdapter(
      apiKey,
      apiSecret,
      userAddress
    );

    return adapter;
  }

  /**
   * Get default endpoints for Sodex
   */
  protected getDefaultEndpoints(): Record<string, string> {
    return {
      rest: 'https://api.sodex.io',
      websocket: 'wss://ws.sodex.io',
      testnetRest: 'https://testnet-api.sodex.io',
      testnetWebsocket: 'wss://testnet-ws.sodex.io'
    };
  }

  /**
   * Get default parameters for Sodex
   */
  protected getDefaultParameters(): Record<string, any> {
    return {
      useTestnet: false,
      defaultLeverage: 1,
      maxLeverage: 10,
      marginMode: 'cross'
    };
  }

  /**
   * Validate Sodex-specific credential formats
   */
  protected validateCredentialFormats(credentials: Record<string, string | undefined>): void {
    super.validateCredentialFormats(credentials);

    // Validate API key format
    if (credentials.apiKey && credentials.apiKey.length < 16) {
      throw new Error('API key appears to be too short');
    }

    // Validate API secret format
    if (credentials.apiSecret && credentials.apiSecret.length < 32) {
      throw new Error('API secret appears to be too short');
    }

    // Validate user address format (assuming Ethereum-like address)
    if (credentials.userAddress && !this.isValidEthereumAddress(credentials.userAddress)) {
      throw new Error('User address must be a valid Ethereum address');
    }
  }

  /**
   * Validate Sodex-specific configuration
   */
  protected validateCustom(config: AdapterConfig): void {
    super.validateCustom(config);

    // Validate leverage settings
    if (config.parameters?.defaultLeverage !== undefined) {
      const leverage = config.parameters.defaultLeverage;
      if (typeof leverage !== 'number' || leverage < 1 || leverage > 100) {
        throw new Error('Default leverage must be a number between 1 and 100');
      }
    }

    if (config.parameters?.maxLeverage !== undefined) {
      const maxLeverage = config.parameters.maxLeverage;
      if (typeof maxLeverage !== 'number' || maxLeverage < 1 || maxLeverage > 100) {
        throw new Error('Max leverage must be a number between 1 and 100');
      }
    }

    // Validate margin mode
    if (config.parameters?.marginMode !== undefined) {
      const marginMode = config.parameters.marginMode;
      if (!['cross', 'isolated'].includes(marginMode)) {
        throw new Error('Margin mode must be either "cross" or "isolated"');
      }
    }
  }

  /**
   * Validate Ethereum address format
   */
  private isValidEthereumAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
  }

  /**
   * Get Sodex-specific credential schema
   */
  protected getCredentialSchema(): Record<string, any> {
    return {
      apiKey: {
        type: 'string',
        minLength: 16,
        description: 'API key for Sodex exchange access'
      },
      apiSecret: {
        type: 'string',
        minLength: 32,
        description: 'API secret for request signing'
      },
      userAddress: {
        type: 'string',
        pattern: '^0x[a-fA-F0-9]{40}$',
        description: 'Ethereum address of the user account'
      }
    };
  }

  /**
   * Get supported symbols for Sodex
   */
  getSupportedSymbols(): string[] {
    return [
      'BTC-USD',
      'ETH-USD',
      'SOL-USD',
      'AVAX-USD',
      'MATIC-USD',
      'LINK-USD',
      'UNI-USD',
      'AAVE-USD',
      'SUSHI-USD',
      'CRV-USD',
      'DOT-USD',
      'ADA-USD',
      'ATOM-USD',
      'NEAR-USD',
      'FTM-USD'
    ];
  }

  /**
   * Check if symbol is supported
   */
  isSymbolSupported(symbol: string): boolean {
    return this.getSupportedSymbols().includes(symbol);
  }

  /**
   * Get trading fees information
   */
  getTradingFees(): { maker: number; taker: number } {
    return {
      maker: 0.0001, // 0.01%
      taker: 0.0003  // 0.03%
    };
  }

  /**
   * Get minimum order sizes by symbol
   */
  getMinimumOrderSizes(): Record<string, number> {
    return {
      'BTC-USD': 0.0001,
      'ETH-USD': 0.001,
      'SOL-USD': 0.01,
      'AVAX-USD': 0.01,
      'MATIC-USD': 0.1,
      'LINK-USD': 0.01,
      'UNI-USD': 0.01,
      'AAVE-USD': 0.001,
      'SUSHI-USD': 0.1,
      'CRV-USD': 0.1,
      'DOT-USD': 0.01,
      'ADA-USD': 1.0,
      'ATOM-USD': 0.01,
      'NEAR-USD': 0.01,
      'FTM-USD': 1.0
    };
  }

  /**
   * Get tick sizes by symbol
   */
  getTickSizes(): Record<string, number> {
    return {
      'BTC-USD': 0.1,
      'ETH-USD': 0.01,
      'SOL-USD': 0.001,
      'AVAX-USD': 0.001,
      'MATIC-USD': 0.0001,
      'LINK-USD': 0.001,
      'UNI-USD': 0.001,
      'AAVE-USD': 0.01,
      'SUSHI-USD': 0.001,
      'CRV-USD': 0.0001,
      'DOT-USD': 0.001,
      'ADA-USD': 0.0001,
      'ATOM-USD': 0.001,
      'NEAR-USD': 0.001,
      'FTM-USD': 0.0001
    };
  }

  /**
   * Get leverage limits by symbol
   */
  getLeverageLimits(): Record<string, { min: number; max: number }> {
    return {
      'BTC-USD': { min: 1, max: 50 },
      'ETH-USD': { min: 1, max: 50 },
      'SOL-USD': { min: 1, max: 25 },
      'AVAX-USD': { min: 1, max: 25 },
      'MATIC-USD': { min: 1, max: 20 },
      'LINK-USD': { min: 1, max: 20 },
      'UNI-USD': { min: 1, max: 20 },
      'AAVE-USD': { min: 1, max: 20 },
      'SUSHI-USD': { min: 1, max: 15 },
      'CRV-USD': { min: 1, max: 15 },
      'DOT-USD': { min: 1, max: 20 },
      'ADA-USD': { min: 1, max: 15 },
      'ATOM-USD': { min: 1, max: 20 },
      'NEAR-USD': { min: 1, max: 20 },
      'FTM-USD': { min: 1, max: 15 }
    };
  }

  /**
   * Get margin requirements by symbol
   */
  getMarginRequirements(): Record<string, { initial: number; maintenance: number }> {
    return {
      'BTC-USD': { initial: 0.02, maintenance: 0.01 },   // 2% initial, 1% maintenance
      'ETH-USD': { initial: 0.02, maintenance: 0.01 },
      'SOL-USD': { initial: 0.04, maintenance: 0.02 },   // 4% initial, 2% maintenance
      'AVAX-USD': { initial: 0.04, maintenance: 0.02 },
      'MATIC-USD': { initial: 0.05, maintenance: 0.025 }, // 5% initial, 2.5% maintenance
      'LINK-USD': { initial: 0.05, maintenance: 0.025 },
      'UNI-USD': { initial: 0.05, maintenance: 0.025 },
      'AAVE-USD': { initial: 0.05, maintenance: 0.025 },
      'SUSHI-USD': { initial: 0.067, maintenance: 0.033 }, // 6.7% initial, 3.3% maintenance
      'CRV-USD': { initial: 0.067, maintenance: 0.033 },
      'DOT-USD': { initial: 0.05, maintenance: 0.025 },
      'ADA-USD': { initial: 0.067, maintenance: 0.033 },
      'ATOM-USD': { initial: 0.05, maintenance: 0.025 },
      'NEAR-USD': { initial: 0.05, maintenance: 0.025 },
      'FTM-USD': { initial: 0.067, maintenance: 0.033 }
    };
  }
}