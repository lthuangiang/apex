/**
 * Dango adapter factory implementation
 * 
 * Creates and configures Dango exchange adapters with proper validation
 * and feature detection.
 */

import { IExchangeAdapter } from '../../types/core.js';
import { AdapterConfig } from '../../types/config.js';
import { BaseAdapterFactory } from './BaseAdapterFactory.js';
import { DangoAdapter } from '../../adapters/dango_adapter.js';

/**
 * Factory for creating Dango exchange adapters
 */
export class DangoAdapterFactory extends BaseAdapterFactory {
  constructor() {
    super(
      'dango',
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
        'liquidity_provision'
      ],
      [
        'privateKey',
        'userAddress'
      ],
      [
        'gasStationApiKey'
      ]
    );
  }

  /**
   * Create Dango adapter instance
   */
  create(config: AdapterConfig): IExchangeAdapter {
    const {
      privateKey,
      userAddress,
      gasStationApiKey
    } = config.credentials;

    if (!privateKey || !userAddress) {
      throw new Error('Missing required credentials for Dango adapter');
    }

    // Determine network from parameters
    const useTestnet = config.parameters?.useTestnet || false;
    const network = useTestnet ? 'testnet' : 'mainnet';

    // Create the adapter instance
    const adapter = new DangoAdapter(
      privateKey,
      userAddress,
      network
    );

    return adapter;
  }

  /**
   * Get default endpoints for Dango
   */
  protected getDefaultEndpoints(): Record<string, string> {
    return {
      rest: 'https://api.dango.exchange',
      websocket: 'wss://ws.dango.exchange',
      graphql: 'https://graph.dango.exchange/graphql',
      testnetRest: 'https://testnet-api.dango.exchange',
      testnetWebsocket: 'wss://testnet-ws.dango.exchange',
      testnetGraphql: 'https://testnet-graph.dango.exchange/graphql'
    };
  }

  /**
   * Get default parameters for Dango
   */
  protected getDefaultParameters(): Record<string, any> {
    return {
      chainId: 1, // Ethereum mainnet
      contractAddress: '0x0000000000000000000000000000000000000000', // Placeholder
      gasLimit: 500000,
      gasPriceMultiplier: 1.2,
      slippageTolerance: 0.005, // 0.5%
      useTestnet: false
    };
  }

  /**
   * Validate Dango-specific credential formats
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

    // Validate user address format
    if (credentials.userAddress && !this.isValidEthereumAddress(credentials.userAddress)) {
      throw new Error('User address must be a valid Ethereum address');
    }
  }

  /**
   * Validate Dango-specific configuration
   */
  protected validateCustom(config: AdapterConfig): void {
    super.validateCustom(config);

    // Validate network parameter if provided
    if (config.parameters?.useTestnet !== undefined) {
      const useTestnet = config.parameters.useTestnet;
      if (typeof useTestnet !== 'boolean') {
        throw new Error('useTestnet parameter must be a boolean');
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
   * Get Dango-specific credential schema
   */
  protected getCredentialSchema(): Record<string, any> {
    return {
      privateKey: {
        type: 'string',
        pattern: '^0x[a-fA-F0-9]{64}$',
        description: 'Private key for signing transactions (64 hex chars with 0x prefix)'
      },
      userAddress: {
        type: 'string',
        pattern: '^0x[a-fA-F0-9]{40}$',
        description: 'User address for the account (40 hex chars with 0x prefix)'
      },
      gasStationApiKey: {
        type: 'string',
        description: 'Optional API key for gas price estimation service'
      }
    };
  }

  /**
   * Get supported symbols for Dango
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
      'COMP-USD',
      'MKR-USD',
      'YFI-USD',
      'SNX-USD',
      'BAL-USD'
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
      maker: 0.0003, // 0.03%
      taker: 0.0007  // 0.07%
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
      'COMP-USD': 0.001,
      'MKR-USD': 0.0001,
      'YFI-USD': 0.00001,
      'SNX-USD': 0.1,
      'BAL-USD': 0.01
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
      'CRV-USD': 0.0001,
      'COMP-USD': 0.01,
      'MKR-USD': 0.1,
      'YFI-USD': 1.0,
      'SNX-USD': 0.001,
      'BAL-USD': 0.001
    };
  }

  /**
   * Get supported chain IDs
   */
  getSupportedChainIds(): number[] {
    return [
      1,    // Ethereum Mainnet
      137,  // Polygon
      42161, // Arbitrum One
      10,   // Optimism
      5,    // Goerli Testnet
      80001 // Mumbai Testnet
    ];
  }

  /**
   * Get chain name by ID
   */
  getChainName(chainId: number): string {
    const chainNames: Record<number, string> = {
      1: 'Ethereum Mainnet',
      137: 'Polygon',
      42161: 'Arbitrum One',
      10: 'Optimism',
      5: 'Goerli Testnet',
      80001: 'Mumbai Testnet'
    };

    return chainNames[chainId] || `Chain ${chainId}`;
  }

  /**
   * Check if chain ID is supported
   */
  isChainSupported(chainId: number): boolean {
    return this.getSupportedChainIds().includes(chainId);
  }

  /**
   * Get default contract addresses by chain
   */
  getDefaultContractAddresses(): Record<number, string> {
    return {
      1: '0x0000000000000000000000000000000000000000',     // Ethereum Mainnet
      137: '0x0000000000000000000000000000000000000000',   // Polygon
      42161: '0x0000000000000000000000000000000000000000', // Arbitrum One
      10: '0x0000000000000000000000000000000000000000',    // Optimism
      5: '0x0000000000000000000000000000000000000000',     // Goerli Testnet
      80001: '0x0000000000000000000000000000000000000000'  // Mumbai Testnet
    };
  }

  /**
   * Get gas limits by operation type
   */
  getGasLimits(): Record<string, number> {
    return {
      swap: 300000,
      addLiquidity: 400000,
      removeLiquidity: 350000,
      placeOrder: 250000,
      cancelOrder: 100000,
      claimRewards: 150000
    };
  }
}