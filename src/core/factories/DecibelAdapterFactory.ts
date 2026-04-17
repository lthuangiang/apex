/**
 * Decibel adapter factory implementation
 * 
 * Creates and configures Decibel exchange adapters with proper validation
 * and feature detection.
 */

import { IExchangeAdapter } from '../../types/core.js';
import { AdapterConfig } from '../../types/config.js';
import { BaseAdapterFactory } from './BaseAdapterFactory.js';
import { DecibelAdapter } from '../../adapters/decibel_adapter.js';

/**
 * Factory for creating Decibel exchange adapters
 */
export class DecibelAdapterFactory extends BaseAdapterFactory {
  constructor() {
    super(
      'decibel',
      [
        'spot_trading',
        'perpetual_trading',
        'limit_orders',
        'market_orders',
        'position_tracking',
        'balance_tracking',
        'orderbook_data',
        'trade_history',
        'real_time_data'
      ],
      [
        'privateKey',
        'nodeApiKey',
        'subaccountAddr',
        'builderAddr'
      ],
      [
        'gasStationApiKey'
      ]
    );
  }

  /**
   * Create Decibel adapter instance
   */
  create(config: AdapterConfig): IExchangeAdapter {
    const {
      privateKey,
      nodeApiKey,
      subaccountAddr,
      builderAddr,
      gasStationApiKey
    } = config.credentials;

    // Extract builder fee from parameters or use default
    const builderFeeBps = config.parameters?.builderFeeBps || 10;

    if (!privateKey || !nodeApiKey || !subaccountAddr || !builderAddr) {
      throw new Error('Missing required credentials for Decibel adapter');
    }

    // Create the adapter instance
    const adapter = new DecibelAdapter(
      privateKey,
      nodeApiKey,
      subaccountAddr,
      builderAddr,
      builderFeeBps,
      gasStationApiKey
    );

    return adapter;
  }

  /**
   * Get default endpoints for Decibel
   */
  protected getDefaultEndpoints(): Record<string, string> {
    return {
      rest: 'https://api.decibel.trade',
      websocket: 'wss://ws.decibel.trade',
      testnetRest: 'https://testnet-api.decibel.trade',
      testnetWebsocket: 'wss://testnet-ws.decibel.trade'
    };
  }

  /**
   * Get default parameters for Decibel
   */
  protected getDefaultParameters(): Record<string, any> {
    return {
      builderFeeBps: 10,
      useTestnet: false,
      gasLimit: 500000,
      gasPriceMultiplier: 1.1
    };
  }

  /**
   * Validate Decibel-specific credential formats
   */
  protected validateCredentialFormats(credentials: Record<string, string | undefined>): void {
    super.validateCredentialFormats(credentials);

    // Validate private key format
    if (credentials.privateKey) {
      const privateKey = credentials.privateKey;
      if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
        throw new Error('Private key must be a valid 32-byte hex string with 0x prefix');
      }
    }

    // Validate Ethereum addresses
    if (credentials.subaccountAddr && !this.isValidEthereumAddress(credentials.subaccountAddr)) {
      throw new Error('Subaccount address must be a valid Ethereum address');
    }

    if (credentials.builderAddr && !this.isValidEthereumAddress(credentials.builderAddr)) {
      throw new Error('Builder address must be a valid Ethereum address');
    }

    // Validate node API key format
    if (credentials.nodeApiKey && credentials.nodeApiKey.length < 20) {
      throw new Error('Node API key appears to be too short');
    }
  }

  /**
   * Validate Decibel-specific configuration
   */
  protected validateCustom(config: AdapterConfig): void {
    super.validateCustom(config);

    // Validate builder fee
    if (config.parameters?.builderFeeBps !== undefined) {
      const builderFeeBps = config.parameters.builderFeeBps;
      if (typeof builderFeeBps !== 'number' || builderFeeBps < 0 || builderFeeBps > 10000) {
        throw new Error('Builder fee must be a number between 0 and 10000 basis points');
      }
    }

    // Validate gas parameters
    if (config.parameters?.gasLimit !== undefined) {
      const gasLimit = config.parameters.gasLimit;
      if (typeof gasLimit !== 'number' || gasLimit < 21000) {
        throw new Error('Gas limit must be a number >= 21000');
      }
    }

    if (config.parameters?.gasPriceMultiplier !== undefined) {
      const multiplier = config.parameters.gasPriceMultiplier;
      if (typeof multiplier !== 'number' || multiplier < 0.1 || multiplier > 10) {
        throw new Error('Gas price multiplier must be between 0.1 and 10');
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
   * Get Decibel-specific credential schema
   */
  protected getCredentialSchema(): Record<string, any> {
    return {
      privateKey: {
        type: 'string',
        pattern: '^0x[a-fA-F0-9]{64}$',
        description: 'Private key for signing transactions (64 hex chars with 0x prefix)'
      },
      nodeApiKey: {
        type: 'string',
        minLength: 20,
        description: 'API key for accessing Decibel node services'
      },
      subaccountAddr: {
        type: 'string',
        pattern: '^0x[a-fA-F0-9]{40}$',
        description: 'Ethereum address of the subaccount'
      },
      builderAddr: {
        type: 'string',
        pattern: '^0x[a-fA-F0-9]{40}$',
        description: 'Ethereum address of the builder'
      },
      gasStationApiKey: {
        type: 'string',
        description: 'Optional API key for gas price estimation service'
      }
    };
  }

  /**
   * Get supported symbols for Decibel
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
      'CRV-USD'
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
      maker: 0.0002, // 0.02%
      taker: 0.0005  // 0.05%
    };
  }

  /**
   * Get minimum order sizes by symbol
   */
  getMinimumOrderSizes(): Record<string, number> {
    return {
      'BTC-USD': 0.001,
      'ETH-USD': 0.01,
      'SOL-USD': 0.1,
      'AVAX-USD': 0.1,
      'MATIC-USD': 1.0,
      'LINK-USD': 0.1,
      'UNI-USD': 0.1,
      'AAVE-USD': 0.01,
      'SUSHI-USD': 1.0,
      'CRV-USD': 1.0
    };
  }

  /**
   * Get tick sizes by symbol
   */
  getTickSizes(): Record<string, number> {
    return {
      'BTC-USD': 0.01,
      'ETH-USD': 0.01,
      'SOL-USD': 0.001,
      'AVAX-USD': 0.001,
      'MATIC-USD': 0.0001,
      'LINK-USD': 0.001,
      'UNI-USD': 0.001,
      'AAVE-USD': 0.01,
      'SUSHI-USD': 0.001,
      'CRV-USD': 0.0001
    };
  }
}