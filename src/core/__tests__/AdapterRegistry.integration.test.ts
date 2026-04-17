/**
 * Integration tests for AdapterRegistry with factory pattern
 * 
 * Tests the AdapterRegistry working with factory implementations without
 * depending on external adapter libraries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdapterRegistry } from '../AdapterRegistry.js';
import { BaseAdapterFactory } from '../factories/BaseAdapterFactory.js';
import { IExchangeAdapter, ConnectionHealth } from '../../types/core.js';
import { AdapterConfig } from '../../types/config.js';

// Test adapter implementation
class TestExchangeAdapter implements IExchangeAdapter {
  readonly exchangeName: string;
  readonly supportedSymbols: string[] = ['BTC-USD', 'ETH-USD'];
  
  private connected = false;
  private health: ConnectionHealth = { isHealthy: false };

  constructor(exchangeName: string) {
    this.exchangeName = exchangeName;
  }

  async getMarkPrice(symbol: string): Promise<number> { return 50000; }
  async getOrderbook(symbol: string) { 
    return { bestBid: 49999, bestAsk: 50001, bids: [], asks: [] }; 
  }
  async getOrderbookDepth(symbol: string, limit: number) { 
    return { bids: [], asks: [] }; 
  }
  async getRecentTrades(symbol: string, limit: number) { return []; }
  async getPosition(symbol: string, markPrice?: number) { return null; }
  async getBalance(): Promise<number> { return 1000; }
  async placeLimitOrder(params: any): Promise<string> { return 'order-123'; }
  async cancelOrder(orderId: string, symbol: string): Promise<boolean> { return true; }
  async cancelAllOrders(symbol: string): Promise<boolean> { return true; }
  async getOpenOrders(symbol: string) { return []; }

  async connect(): Promise<void> {
    this.connected = true;
    this.health = { isHealthy: true, lastPing: new Date() };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.health = { isHealthy: false, error: 'Disconnected' };
  }

  isConnected(): boolean { return this.connected; }
  getHealthStatus(): ConnectionHealth { return this.health; }
}

// Test factory implementation
class TestAdapterFactory extends BaseAdapterFactory {
  constructor(adapterType: string) {
    super(
      adapterType,
      ['spot_trading', 'limit_orders', 'position_tracking'],
      ['apiKey', 'apiSecret'],
      ['userAddress']
    );
  }

  create(config: AdapterConfig): IExchangeAdapter {
    return new TestExchangeAdapter(this.adapterType);
  }

  protected getDefaultEndpoints(): Record<string, string> {
    return {
      rest: `https://api.${this.adapterType}.com`,
      websocket: `wss://ws.${this.adapterType}.com`
    };
  }
}

describe('AdapterRegistry Integration', () => {
  let registry: AdapterRegistry;

  beforeEach(async () => {
    registry = new AdapterRegistry();
    await registry.initialize();
    await registry.start();
  });

  afterEach(async () => {
    await registry.cleanup();
  });

  describe('Factory Pattern Integration', () => {
    it('should work with BaseAdapterFactory implementations', () => {
      const factory = new TestAdapterFactory('test-exchange');
      
      registry.register('test-exchange', factory);
      
      expect(registry.has('test-exchange')).toBe(true);
      expect(registry.getSupportedExchanges()).toContain('test-exchange');
      
      const retrievedFactory = registry.getFactory('test-exchange');
      expect(retrievedFactory).toBe(factory);
      expect(retrievedFactory?.getSupportedFeatures()).toContain('spot_trading');
    });

    it('should validate configurations using factory validation', () => {
      const factory = new TestAdapterFactory('test-exchange');
      registry.register('test-exchange', factory);
      
      // Valid configuration
      const validConfig: AdapterConfig = {
        type: 'test-exchange',
        enabled: true,
        credentials: {
          apiKey: 'test-api-key-12345',
          apiSecret: 'test-api-secret-67890'
        },
        endpoints: {
          rest: 'https://api.test-exchange.com',
          websocket: 'wss://ws.test-exchange.com'
        },
        limits: {
          requestsPerSecond: 10,
          requestsPerMinute: 600
        },
        features: ['spot_trading', 'limit_orders']
      };
      
      expect(() => {
        registry.create('test-exchange', validConfig);
      }).not.toThrow();
      
      // Invalid configuration (missing required credential)
      const invalidConfig: AdapterConfig = {
        ...validConfig,
        credentials: {
          apiKey: 'test-api-key-12345'
          // Missing apiSecret
        }
      };
      
      expect(() => {
        registry.create('test-exchange', invalidConfig);
      }).toThrow();
    });

    it('should create adapters using factory pattern', () => {
      const factory = new TestAdapterFactory('test-exchange');
      registry.register('test-exchange', factory);
      
      const config: AdapterConfig = {
        type: 'test-exchange',
        enabled: true,
        credentials: {
          apiKey: 'test-api-key-12345',
          apiSecret: 'test-api-secret-67890'
        },
        endpoints: {
          rest: 'https://api.test-exchange.com'
        },
        limits: {
          requestsPerSecond: 10,
          requestsPerMinute: 600
        },
        features: ['spot_trading']
      };
      
      const adapter = registry.create('test-exchange', config);
      
      expect(adapter).toBeInstanceOf(TestExchangeAdapter);
      expect(adapter.exchangeName).toBe('test-exchange');
      expect(adapter.supportedSymbols).toContain('BTC-USD');
    });

    it('should support multiple factory types', () => {
      const factory1 = new TestAdapterFactory('exchange-1');
      const factory2 = new TestAdapterFactory('exchange-2');
      
      registry.register('exchange-1', factory1);
      registry.register('exchange-2', factory2);
      
      expect(registry.getFactoryCount()).toBe(2);
      expect(registry.getSupportedExchanges()).toEqual(
        expect.arrayContaining(['exchange-1', 'exchange-2'])
      );
      
      // Create adapters from different factories
      const config1: AdapterConfig = {
        type: 'exchange-1',
        enabled: true,
        credentials: { apiKey: 'test-api-key-12345', apiSecret: 'test-api-secret-67890' },
        endpoints: { rest: 'https://api.exchange-1.com' },
        limits: { requestsPerSecond: 10, requestsPerMinute: 600 },
        features: []
      };
      
      const config2: AdapterConfig = {
        type: 'exchange-2',
        enabled: true,
        credentials: { apiKey: 'test-api-key-67890', apiSecret: 'test-api-secret-12345' },
        endpoints: { rest: 'https://api.exchange-2.com' },
        limits: { requestsPerSecond: 10, requestsPerMinute: 600 },
        features: []
      };
      
      const adapter1 = registry.create('exchange-1', config1);
      const adapter2 = registry.create('exchange-2', config2);
      
      expect(adapter1.exchangeName).toBe('exchange-1');
      expect(adapter2.exchangeName).toBe('exchange-2');
    });

    it('should handle factory default configurations', () => {
      const factory = new TestAdapterFactory('test-exchange');
      registry.register('test-exchange', factory);
      
      const defaults = factory.getDefaultConfig();
      
      expect(defaults.type).toBe('test-exchange');
      expect(defaults.enabled).toBe(true);
      expect(defaults.features).toContain('spot_trading');
      expect(defaults.limits?.requestsPerSecond).toBeGreaterThan(0);
      expect(defaults.endpoints?.rest).toContain('test-exchange');
    });

    it('should validate factory-specific features', () => {
      const factory = new TestAdapterFactory('test-exchange');
      registry.register('test-exchange', factory);
      
      const supportedFeatures = factory.getSupportedFeatures();
      expect(supportedFeatures).toContain('spot_trading');
      expect(supportedFeatures).toContain('limit_orders');
      expect(supportedFeatures).toContain('position_tracking');
      
      // Test configuration with unsupported feature
      const configWithUnsupportedFeature: AdapterConfig = {
        type: 'test-exchange',
        enabled: true,
        credentials: { apiKey: 'key', apiSecret: 'secret' },
        endpoints: { rest: 'https://api.test.com' },
        limits: { requestsPerSecond: 10, requestsPerMinute: 600 },
        features: ['unsupported_feature']
      };
      
      expect(() => {
        registry.create('test-exchange', configWithUnsupportedFeature);
      }).toThrow();
    });
  });

  describe('Lifecycle Integration', () => {
    it('should manage adapter lifecycle through registry', async () => {
      const factory = new TestAdapterFactory('test-exchange');
      registry.register('test-exchange', factory);
      
      const config: AdapterConfig = {
        type: 'test-exchange',
        enabled: true,
        credentials: { apiKey: 'test-api-key-12345', apiSecret: 'test-api-secret-67890' },
        endpoints: { rest: 'https://api.test.com' },
        limits: { requestsPerSecond: 10, requestsPerMinute: 600 },
        features: []
      };
      
      // Create adapter
      const adapter = registry.create('test-exchange', config);
      expect(adapter.isConnected()).toBe(false);
      
      // Connect through registry
      await registry.connectAdapter('test-exchange');
      expect(adapter.isConnected()).toBe(true);
      
      // Check health status
      const health = registry.getAdapterHealth('test-exchange');
      expect(health?.isHealthy).toBe(true);
      
      // Disconnect through registry
      await registry.disconnectAdapter('test-exchange');
      expect(adapter.isConnected()).toBe(false);
    });

    it('should support hot-swapping with factory pattern', async () => {
      const factory = new TestAdapterFactory('test-exchange');
      registry.register('test-exchange', factory);
      
      const config1: AdapterConfig = {
        type: 'test-exchange',
        enabled: true,
        credentials: { apiKey: 'test-api-key-12345', apiSecret: 'test-api-secret-67890' },
        endpoints: { rest: 'https://api.test.com' },
        limits: { requestsPerSecond: 10, requestsPerMinute: 600 },
        features: []
      };
      
      const config2: AdapterConfig = {
        type: 'test-exchange',
        enabled: true,
        credentials: { apiKey: 'test-api-key-67890', apiSecret: 'test-api-secret-12345' },
        endpoints: { rest: 'https://api.test.com' },
        limits: { requestsPerSecond: 20, requestsPerMinute: 1200 },
        features: []
      };
      
      // Create and connect first adapter
      registry.create('test-exchange', config1);
      await registry.connectAdapter('test-exchange');
      
      const adapter1 = registry.getAdapter('test-exchange');
      expect(adapter1.isConnected()).toBe(true);
      
      // Hot-swap to new configuration
      await registry.hotSwapAdapter('test-exchange', config2);
      
      const adapter2 = registry.getAdapter('test-exchange');
      expect(adapter2).not.toBe(adapter1); // Different instance
      expect(adapter2.isConnected()).toBe(true);
    });
  });
});