/**
 * Unit tests for AdapterRegistry
 * 
 * Tests adapter registration, creation, lifecycle management, and hot-swapping functionality.
 */

import { describe, it, expect, beforeEach, afterEach, vi, Mock } from 'vitest';
import { AdapterRegistry } from '../AdapterRegistry.js';
import { IExchangeAdapter, ConnectionHealth } from '../../types/core.js';
import { AdapterConfig } from '../../types/config.js';
import { AdapterFactory } from '../../types/utils.js';

// Mock adapter implementation
class MockAdapter implements IExchangeAdapter {
  readonly exchangeName: string;
  readonly supportedSymbols: string[] = ['BTC-USD', 'ETH-USD'];
  
  private connected = false;
  private health: ConnectionHealth = { isHealthy: false };

  constructor(exchangeName: string) {
    this.exchangeName = exchangeName;
  }

  async getMarkPrice(symbol: string): Promise<number> {
    return 50000;
  }

  async getOrderbook(symbol: string) {
    return {
      bestBid: 49999,
      bestAsk: 50001,
      bids: [[49999, 1.0]],
      asks: [[50001, 1.0]]
    };
  }

  async getOrderbookDepth(symbol: string, limit: number) {
    return {
      bids: [[49999, 1.0], [49998, 2.0]],
      asks: [[50001, 1.0], [50002, 2.0]]
    };
  }

  async getRecentTrades(symbol: string, limit: number) {
    return [
      { side: 'buy' as const, price: 50000, size: 0.1, timestamp: Date.now() }
    ];
  }

  async getPosition(symbol: string, markPrice?: number) {
    return null;
  }

  async getBalance(): Promise<number> {
    return 1000;
  }

  async placeLimitOrder(params: any): Promise<string> {
    return 'order-123';
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    return true;
  }

  async cancelAllOrders(symbol: string): Promise<boolean> {
    return true;
  }

  async getOpenOrders(symbol: string) {
    return [];
  }

  async connect(): Promise<void> {
    this.connected = true;
    this.health = { isHealthy: true, lastPing: new Date() };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.health = { isHealthy: false, error: 'Disconnected' };
  }

  isConnected(): boolean {
    return this.connected;
  }

  getHealthStatus(): ConnectionHealth {
    return this.health;
  }
}

// Mock adapter factory
class MockAdapterFactory implements AdapterFactory {
  constructor(private adapterType: string) {}

  create(config: AdapterConfig): IExchangeAdapter {
    return new MockAdapter(this.adapterType);
  }

  validate(config: AdapterConfig): boolean {
    return config.type === this.adapterType && config.enabled;
  }

  getSupportedFeatures(): string[] {
    return ['spot_trading', 'limit_orders'];
  }

  getDefaultConfig(): Partial<AdapterConfig> {
    return {
      type: this.adapterType,
      enabled: true,
      credentials: {},
      endpoints: {},
      limits: {
        requestsPerSecond: 10,
        requestsPerMinute: 600
      },
      features: this.getSupportedFeatures()
    };
  }
}

describe('AdapterRegistry', () => {
  let registry: AdapterRegistry;
  let mockFactory: MockAdapterFactory;
  let mockConfig: AdapterConfig;

  beforeEach(() => {
    registry = new AdapterRegistry();
    mockFactory = new MockAdapterFactory('test-exchange');
    mockConfig = {
      type: 'test-exchange',
      enabled: true,
      credentials: {
        apiKey: 'test-key',
        apiSecret: 'test-secret'
      },
      endpoints: {
        rest: 'https://api.test.com',
        websocket: 'wss://ws.test.com'
      },
      limits: {
        requestsPerSecond: 10,
        requestsPerMinute: 600
      },
      features: ['spot_trading', 'limit_orders']
    };
  });

  afterEach(async () => {
    await registry.cleanup();
  });

  describe('Lifecycle Management', () => {
    it('should initialize successfully', async () => {
      await registry.initialize();
      const status = registry.getStatus();
      expect(status.state).toBe('stopped');
      expect(status.name).toBe('AdapterRegistry');
    });

    it('should start and stop successfully', async () => {
      await registry.initialize();
      await registry.start();
      
      let status = registry.getStatus();
      expect(status.state).toBe('running');

      await registry.stop();
      status = registry.getStatus();
      expect(status.state).toBe('stopped');
    });

    it('should cleanup all resources', async () => {
      registry.register('test', mockFactory);
      await registry.initialize();
      await registry.start();
      
      expect(registry.has('test')).toBe(true);
      
      await registry.cleanup();
      expect(registry.has('test')).toBe(false);
    });
  });

  describe('Factory Management', () => {
    it('should register a factory successfully', () => {
      const eventSpy = vi.fn();
      registry.on('adapter:registered', eventSpy);

      registry.register('test-exchange', mockFactory);

      expect(registry.has('test-exchange')).toBe(true);
      expect(registry.list()).toContain('test-exchange');
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            name: 'test-exchange',
            factory: mockFactory
          })
        })
      );
    });

    it('should throw error when registering duplicate factory', () => {
      registry.register('test-exchange', mockFactory);
      
      expect(() => {
        registry.register('test-exchange', mockFactory);
      }).toThrow("Adapter factory 'test-exchange' is already registered");
    });

    it('should throw error when registering invalid factory', () => {
      expect(() => {
        registry.register('', mockFactory);
      }).toThrow('Adapter name must be a non-empty string');

      expect(() => {
        registry.register('test', {} as AdapterFactory);
      }).toThrow('Factory must implement AdapterFactory interface');
    });

    it('should unregister a factory successfully', () => {
      const eventSpy = vi.fn();
      registry.on('adapter:unregistered', eventSpy);

      registry.register('test-exchange', mockFactory);
      registry.unregister('test-exchange');

      expect(registry.has('test-exchange')).toBe(false);
      expect(registry.list()).not.toContain('test-exchange');
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            name: 'test-exchange'
          })
        })
      );
    });

    it('should throw error when unregistering non-existent factory', () => {
      expect(() => {
        registry.unregister('non-existent');
      }).toThrow("Adapter factory 'non-existent' is not registered");
    });

    it('should get factory by name', () => {
      registry.register('test-exchange', mockFactory);
      
      const factory = registry.getFactory('test-exchange');
      expect(factory).toBe(mockFactory);
      
      const nonExistent = registry.getFactory('non-existent');
      expect(nonExistent).toBeUndefined();
    });
  });

  describe('Adapter Creation and Management', () => {
    beforeEach(() => {
      registry.register('test-exchange', mockFactory);
    });

    it('should create adapter successfully', () => {
      const eventSpy = vi.fn();
      registry.on('adapter:created', eventSpy);

      const adapter = registry.create('test-exchange', mockConfig);

      expect(adapter).toBeInstanceOf(MockAdapter);
      expect(adapter.exchangeName).toBe('test-exchange');
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            name: 'test-exchange',
            adapter
          })
        })
      );
    });

    it('should throw error when creating adapter with unregistered factory', () => {
      expect(() => {
        registry.create('non-existent', mockConfig);
      }).toThrow("No factory registered for adapter 'non-existent'");
    });

    it('should throw error when creating adapter with invalid config', () => {
      const invalidConfig = { ...mockConfig, enabled: false };
      
      expect(() => {
        registry.create('test-exchange', invalidConfig);
      }).toThrow("Invalid configuration for adapter 'test-exchange'");
    });

    it('should get adapter and create if not exists', () => {
      // Store config first
      registry.create('test-exchange', mockConfig);
      
      const adapter = registry.getAdapter('test-exchange');
      expect(adapter).toBeInstanceOf(MockAdapter);
      expect(adapter.exchangeName).toBe('test-exchange');
    });

    it('should throw error when getting adapter without config', () => {
      expect(() => {
        registry.getAdapter('test-exchange');
      }).toThrow("No configuration found for exchange 'test-exchange'");
    });
  });

  describe('Adapter Discovery and Validation', () => {
    beforeEach(() => {
      registry.register('test-exchange', mockFactory);
      registry.create('test-exchange', mockConfig);
    });

    it('should check if exchange and symbol are supported', () => {
      const supported = registry.isSupported('test-exchange', 'BTC-USD');
      expect(supported).toBe(true);

      const unsupported = registry.isSupported('test-exchange', 'UNSUPPORTED-USD');
      expect(unsupported).toBe(false);

      const nonExistent = registry.isSupported('non-existent', 'BTC-USD');
      expect(nonExistent).toBe(false);
    });

    it('should get active adapters', async () => {
      const adapter = registry.getAdapter('test-exchange');
      await adapter.connect();

      const activeAdapters = registry.getActiveAdapters();
      expect(activeAdapters.size).toBe(1);
      expect(activeAdapters.has('test-exchange')).toBe(true);
    });

    it('should get supported exchanges', () => {
      const exchanges = registry.getSupportedExchanges();
      expect(exchanges).toContain('test-exchange');
    });

    it('should get supported symbols', () => {
      const symbols = registry.getSupportedSymbols('test-exchange');
      expect(symbols).toEqual(['BTC-USD', 'ETH-USD']);

      const allSymbols = registry.getSupportedSymbols();
      expect(allSymbols).toContain('BTC-USD');
      expect(allSymbols).toContain('ETH-USD');
    });
  });

  describe('Connection Management', () => {
    beforeEach(() => {
      registry.register('test-exchange', mockFactory);
      registry.create('test-exchange', mockConfig);
    });

    it('should connect adapter successfully', async () => {
      const eventSpy = vi.fn();
      registry.on('adapter:connected', eventSpy);

      await registry.connectAdapter('test-exchange');

      const adapter = registry.getAdapter('test-exchange');
      expect(adapter.isConnected()).toBe(true);
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            name: 'test-exchange',
            adapter
          })
        })
      );
    });

    it('should disconnect adapter successfully', async () => {
      const eventSpy = vi.fn();
      registry.on('adapter:disconnected', eventSpy);

      const adapter = registry.getAdapter('test-exchange');
      await adapter.connect();
      await registry.disconnectAdapter('test-exchange');

      expect(adapter.isConnected()).toBe(false);
      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            name: 'test-exchange',
            adapter
          })
        })
      );
    });

    it('should disconnect all adapters', async () => {
      const adapter = registry.getAdapter('test-exchange');
      await adapter.connect();
      expect(adapter.isConnected()).toBe(true);

      await registry.disconnectAll();
      expect(adapter.isConnected()).toBe(false);
    });

    it('should handle connection errors', async () => {
      const errorSpy = vi.fn();
      registry.on('adapter:error', errorSpy);

      // Mock connection failure
      const adapter = registry.getAdapter('test-exchange');
      vi.spyOn(adapter, 'connect').mockRejectedValue(new Error('Connection failed'));

      await expect(registry.connectAdapter('test-exchange')).rejects.toThrow('Connection failed');
      expect(errorSpy).toHaveBeenCalled();
    });
  });

  describe('Hot-swapping Support', () => {
    beforeEach(() => {
      registry.register('test-exchange', mockFactory);
      registry.create('test-exchange', mockConfig);
    });

    it('should hot-swap adapter successfully', async () => {
      const eventSpy = vi.fn();
      registry.on('adapter:hot_swapped', eventSpy);

      const oldAdapter = registry.getAdapter('test-exchange');
      await oldAdapter.connect();

      const newConfig = { ...mockConfig, credentials: { ...mockConfig.credentials, apiKey: 'new-key' } };
      await registry.hotSwapAdapter('test-exchange', newConfig);

      const newAdapter = registry.getAdapter('test-exchange');
      expect(newAdapter).not.toBe(oldAdapter);
      expect(newAdapter.isConnected()).toBe(true);
      expect(eventSpy).toHaveBeenCalled();
    });

    it('should update adapter config', () => {
      const configUpdates = { enabled: false };
      registry.updateAdapterConfig('test-exchange', configUpdates);

      const adapterInfo = registry.getAdapterInfo('test-exchange');
      expect(adapterInfo?.config.enabled).toBe(false);
    });

    it('should throw error when updating non-existent adapter config', () => {
      expect(() => {
        registry.updateAdapterConfig('non-existent', {});
      }).toThrow("No configuration found for adapter 'non-existent'");
    });
  });

  describe('Health Monitoring', () => {
    beforeEach(async () => {
      registry.register('test-exchange', mockFactory);
      registry.create('test-exchange', mockConfig);
      await registry.initialize();
      await registry.start();
    });

    it('should perform health check', async () => {
      const eventSpy = vi.fn();
      registry.on('registry:health_check', eventSpy);

      const adapter = registry.getAdapter('test-exchange');
      await adapter.connect();

      const results = await registry.healthCheck();
      expect(results.get('test-exchange')).toBe(true);
      expect(eventSpy).toHaveBeenCalled();
    });

    it('should get adapter health status', async () => {
      const adapter = registry.getAdapter('test-exchange');
      await registry.connectAdapter('test-exchange');

      const health = registry.getAdapterHealth('test-exchange');
      expect(health?.isHealthy).toBe(true);
    });

    it('should get all adapter health statuses', async () => {
      const adapter = registry.getAdapter('test-exchange');
      await registry.connectAdapter('test-exchange');

      const allHealth = registry.getAllAdapterHealth();
      expect(allHealth.size).toBe(1);
      expect(allHealth.get('test-exchange')?.isHealthy).toBe(true);
    });
  });

  describe('Utility Methods', () => {
    beforeEach(() => {
      registry.register('test-exchange', mockFactory);
      registry.create('test-exchange', mockConfig);
    });

    it('should get correct counts', async () => {
      expect(registry.getFactoryCount()).toBe(1);
      expect(registry.getAdapterCount()).toBe(1);
      expect(registry.getConnectedAdapterCount()).toBe(0);

      const adapter = registry.getAdapter('test-exchange');
      await adapter.connect();
      expect(registry.getConnectedAdapterCount()).toBe(1);
    });

    it('should get adapter info', () => {
      const info = registry.getAdapterInfo('test-exchange');
      expect(info).toBeDefined();
      expect(info?.adapter.exchangeName).toBe('test-exchange');
      expect(info?.config).toEqual(mockConfig);
    });

    it('should get all adapter info', () => {
      const allInfo = registry.getAllAdapterInfo();
      expect(allInfo.size).toBe(1);
      expect(allInfo.has('test-exchange')).toBe(true);
    });
  });

  describe('Event Emission', () => {
    it('should emit events with proper structure', () => {
      const eventSpy = vi.fn();
      registry.on('adapter:registered', eventSpy);

      registry.register('test-exchange', mockFactory);

      expect(eventSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'adapter:registered',
          payload: expect.objectContaining({
            name: 'test-exchange',
            factory: mockFactory
          }),
          timestamp: expect.any(Date),
          source: 'AdapterRegistry'
        })
      );
    });
  });
});