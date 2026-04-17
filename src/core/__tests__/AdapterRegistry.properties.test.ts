/**
 * Property-based tests for AdapterRegistry
 * 
 * Tests universal properties that should hold across all valid executions
 * of the AdapterRegistry system.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import { AdapterRegistry } from '../AdapterRegistry.js';
import { IExchangeAdapter, ConnectionHealth } from '../../types/core.js';
import { AdapterConfig } from '../../types/config.js';
import { AdapterFactory } from '../../types/utils.js';

// Mock adapter for property testing
class PropertyTestAdapter implements IExchangeAdapter {
  readonly exchangeName: string;
  readonly supportedSymbols: string[];
  
  private connected = false;
  private health: ConnectionHealth = { isHealthy: false };

  constructor(exchangeName: string, supportedSymbols: string[] = ['BTC-USD']) {
    this.exchangeName = exchangeName;
    this.supportedSymbols = supportedSymbols;
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

// Mock factory for property testing
class PropertyTestFactory implements AdapterFactory {
  constructor(private adapterType: string, private supportedSymbols: string[] = ['BTC-USD']) {}

  create(config: AdapterConfig): IExchangeAdapter {
    return new PropertyTestAdapter(this.adapterType, this.supportedSymbols);
  }

  validate(config: AdapterConfig): boolean {
    return config.type === this.adapterType && config.enabled;
  }

  getSupportedFeatures(): string[] {
    return ['spot_trading'];
  }

  getDefaultConfig(): Partial<AdapterConfig> {
    return {
      type: this.adapterType,
      enabled: true,
      credentials: {},
      endpoints: {},
      limits: { requestsPerSecond: 10, requestsPerMinute: 600 },
      features: []
    };
  }
}

// Generators for property testing
const exchangeNameGen = fc.string({ minLength: 1, maxLength: 20 }).filter(s => /^[a-zA-Z0-9_-]+$/.test(s));

const symbolGen = fc.string({ minLength: 3, maxLength: 10 }).filter(s => /^[A-Z-]+$/.test(s));

const adapterConfigGen = (exchangeName: string) => fc.record({
  type: fc.constant(exchangeName),
  enabled: fc.boolean(),
  credentials: fc.record({
    apiKey: fc.string({ minLength: 10, maxLength: 50 }),
    apiSecret: fc.string({ minLength: 20, maxLength: 100 })
  }),
  endpoints: fc.record({
    rest: fc.constant('https://api.example.com'),
    websocket: fc.constant('wss://ws.example.com')
  }),
  limits: fc.record({
    requestsPerSecond: fc.integer({ min: 1, max: 100 }),
    requestsPerMinute: fc.integer({ min: 60, max: 6000 })
  }),
  features: fc.array(fc.constantFrom('spot_trading', 'limit_orders', 'market_orders'))
});

describe('AdapterRegistry Properties', () => {
  let registry: AdapterRegistry;

  beforeEach(async () => {
    registry = new AdapterRegistry();
    await registry.initialize();
  });

  afterEach(async () => {
    await registry.cleanup();
  });

  describe('Property 6: Adapter Registry Uniqueness', () => {
    /**
     * **Validates: Requirements 5.1, 5.2**
     * 
     * For any supported exchange, there SHALL exist exactly one registered adapter 
     * in the AdapterRegistry, with no duplicate or conflicting adapters
     */
    it('should maintain exactly one adapter per exchange name', () => {
      fc.assert(fc.property(
        fc.array(exchangeNameGen, { minLength: 1, maxLength: 10 }),
        (exchangeNames) => {
          // Register factories for each exchange
          const uniqueNames = [...new Set(exchangeNames)];
          
          for (const name of uniqueNames) {
            const factory = new PropertyTestFactory(name);
            registry.register(name, factory);
          }

          // Verify each exchange has exactly one factory
          for (const name of uniqueNames) {
            expect(registry.has(name)).toBe(true);
            expect(registry.getFactory(name)).toBeDefined();
          }

          // Verify total count matches unique names
          expect(registry.getFactoryCount()).toBe(uniqueNames.length);
          expect(registry.list().sort()).toEqual(uniqueNames.sort());

          // Verify no duplicates can be registered
          for (const name of uniqueNames) {
            expect(() => {
              registry.register(name, new PropertyTestFactory(name));
            }).toThrow();
          }
        }
      ));
    });

    it('should maintain adapter instance uniqueness', () => {
      fc.assert(fc.property(
        fc.array(exchangeNameGen, { minLength: 1, maxLength: 5 }),
        async (exchangeNames) => {
          const uniqueNames = [...new Set(exchangeNames)];
          
          // Register factories and create adapters
          for (const name of uniqueNames) {
            const factory = new PropertyTestFactory(name);
            registry.register(name, factory);
            
            const config = await adapterConfigGen(name).sample();
            if (config) {
              registry.create(name, config);
            }
          }

          // Verify each exchange has at most one adapter instance
          const adapterInfo = registry.getAllAdapterInfo();
          expect(adapterInfo.size).toBeLessThanOrEqual(uniqueNames.length);

          // Verify adapter names match exchange names
          for (const [name, info] of adapterInfo) {
            expect(info.adapter.exchangeName).toBe(name);
            expect(uniqueNames).toContain(name);
          }
        }
      ));
    });
  });

  describe('Registry State Consistency', () => {
    it('should maintain consistent state across operations', () => {
      fc.assert(fc.property(
        fc.array(fc.tuple(exchangeNameGen, fc.boolean()), { minLength: 1, maxLength: 10 }),
        (operations) => {
          const registeredNames = new Set<string>();
          
          for (const [name, shouldRegister] of operations) {
            if (shouldRegister && !registeredNames.has(name)) {
              // Register new factory
              const factory = new PropertyTestFactory(name);
              registry.register(name, factory);
              registeredNames.add(name);
              
              expect(registry.has(name)).toBe(true);
              expect(registry.list()).toContain(name);
            } else if (!shouldRegister && registeredNames.has(name)) {
              // Unregister existing factory
              registry.unregister(name);
              registeredNames.delete(name);
              
              expect(registry.has(name)).toBe(false);
              expect(registry.list()).not.toContain(name);
            }
          }

          // Verify final state consistency
          expect(registry.getFactoryCount()).toBe(registeredNames.size);
          expect(new Set(registry.list())).toEqual(registeredNames);
        }
      ));
    });
  });

  describe('Symbol Support Properties', () => {
    it('should correctly report symbol support', () => {
      fc.assert(fc.property(
        fc.array(fc.tuple(exchangeNameGen, fc.array(symbolGen, { minLength: 1, maxLength: 5 })), { minLength: 1, maxLength: 5 }),
        async (exchangeSymbolPairs) => {
          const supportMap = new Map<string, string[]>();
          
          // Register exchanges with their supported symbols
          for (const [exchangeName, symbols] of exchangeSymbolPairs) {
            const uniqueSymbols = [...new Set(symbols)];
            supportMap.set(exchangeName, uniqueSymbols);
            
            const factory = new PropertyTestFactory(exchangeName, uniqueSymbols);
            registry.register(exchangeName, factory);
            
            const config = await adapterConfigGen(exchangeName).sample();
            if (config) {
              registry.create(exchangeName, config);
            }
          }

          // Verify symbol support reporting
          for (const [exchangeName, expectedSymbols] of supportMap) {
            for (const symbol of expectedSymbols) {
              expect(registry.isSupported(exchangeName, symbol)).toBe(true);
            }
            
            // Test with a symbol that shouldn't be supported
            const unsupportedSymbol = 'UNSUPPORTED-SYMBOL';
            if (!expectedSymbols.includes(unsupportedSymbol)) {
              expect(registry.isSupported(exchangeName, unsupportedSymbol)).toBe(false);
            }
          }

          // Verify non-existent exchange returns false
          expect(registry.isSupported('NON_EXISTENT_EXCHANGE', 'BTC-USD')).toBe(false);
        }
      ));
    });
  });

  describe('Connection State Properties', () => {
    it('should maintain connection state consistency', () => {
      fc.assert(fc.property(
        fc.array(exchangeNameGen, { minLength: 1, maxLength: 5 }),
        async (exchangeNames) => {
          const uniqueNames = [...new Set(exchangeNames)];
          const adapters = new Map<string, IExchangeAdapter>();
          
          // Setup adapters
          for (const name of uniqueNames) {
            const factory = new PropertyTestFactory(name);
            registry.register(name, factory);
            
            const config = await adapterConfigGen(name).sample();
            if (config) {
              const adapter = registry.create(name, config);
              adapters.set(name, adapter);
            }
          }

          // Test connection operations
          for (const [name, adapter] of adapters) {
            // Initially disconnected
            expect(adapter.isConnected()).toBe(false);
            
            // Connect
            await registry.connectAdapter(name);
            expect(adapter.isConnected()).toBe(true);
            
            // Verify health status
            const health = registry.getAdapterHealth(name);
            expect(health?.isHealthy).toBe(true);
            
            // Disconnect
            await registry.disconnectAdapter(name);
            expect(adapter.isConnected()).toBe(false);
          }

          // Verify active adapters count
          const connectedCount = registry.getConnectedAdapterCount();
          expect(connectedCount).toBe(0);
        }
      ));
    });
  });

  describe('Health Check Properties', () => {
    it('should provide accurate health information', () => {
      fc.assert(fc.property(
        fc.array(exchangeNameGen, { minLength: 1, maxLength: 3 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 3 }),
        async (exchangeNames, connectionStates) => {
          const uniqueNames = [...new Set(exchangeNames)];
          const states = connectionStates.slice(0, uniqueNames.length);
          
          // Setup adapters with different connection states
          for (let i = 0; i < uniqueNames.length; i++) {
            const name = uniqueNames[i];
            const shouldConnect = states[i] || false;
            
            const factory = new PropertyTestFactory(name);
            registry.register(name, factory);
            
            const config = await adapterConfigGen(name).sample();
            if (config) {
              const adapter = registry.create(name, config);
              
              if (shouldConnect) {
                await adapter.connect();
              }
            }
          }

          // Perform health check
          const healthResults = await registry.healthCheck();
          
          // Verify health results match connection states
          for (let i = 0; i < uniqueNames.length; i++) {
            const name = uniqueNames[i];
            const expectedHealth = states[i] || false;
            
            if (registry.getAdapterInfo(name)) {
              expect(healthResults.get(name)).toBe(expectedHealth);
              
              const adapterHealth = registry.getAdapterHealth(name);
              expect(adapterHealth?.isHealthy).toBe(expectedHealth);
            }
          }
        }
      ));
    });
  });

  describe('Configuration Validation Properties', () => {
    it('should validate configurations consistently', () => {
      fc.assert(fc.property(
        exchangeNameGen,
        fc.boolean(),
        async (exchangeName, configEnabled) => {
          const factory = new PropertyTestFactory(exchangeName);
          registry.register(exchangeName, factory);
          
          const config = await adapterConfigGen(exchangeName).sample();
          if (config) {
            config.enabled = configEnabled;
            
            if (configEnabled) {
              // Valid config should create adapter successfully
              expect(() => {
                registry.create(exchangeName, config);
              }).not.toThrow();
              
              expect(registry.getAdapterCount()).toBe(1);
            } else {
              // Invalid config should throw error
              expect(() => {
                registry.create(exchangeName, config);
              }).toThrow();
              
              expect(registry.getAdapterCount()).toBe(0);
            }
          }
        }
      ));
    });
  });

  describe('Event Emission Properties', () => {
    it('should emit events for all significant operations', () => {
      fc.assert(fc.property(
        fc.array(exchangeNameGen, { minLength: 1, maxLength: 5 }),
        (exchangeNames) => {
          const uniqueNames = [...new Set(exchangeNames)];
          const events: string[] = [];
          
          // Track all events
          registry.on('adapter:registered', () => events.push('registered'));
          registry.on('adapter:unregistered', () => events.push('unregistered'));
          registry.on('adapter:created', () => events.push('created'));
          
          // Perform operations
          for (const name of uniqueNames) {
            const factory = new PropertyTestFactory(name);
            registry.register(name, factory);
          }

          // Verify registration events
          expect(events.filter(e => e === 'registered')).toHaveLength(uniqueNames.length);
          
          // Unregister some factories
          const toUnregister = uniqueNames.slice(0, Math.ceil(uniqueNames.length / 2));
          for (const name of toUnregister) {
            registry.unregister(name);
          }
          
          // Verify unregistration events
          expect(events.filter(e => e === 'unregistered')).toHaveLength(toUnregister.length);
        }
      ));
    });
  });

  describe('Resource Management Properties', () => {
    it('should properly manage resources during lifecycle', () => {
      fc.assert(fc.property(
        fc.array(exchangeNameGen, { minLength: 1, maxLength: 5 }),
        async (exchangeNames) => {
          const uniqueNames = [...new Set(exchangeNames)];
          
          // Setup registry with adapters
          for (const name of uniqueNames) {
            const factory = new PropertyTestFactory(name);
            registry.register(name, factory);
            
            const config = await adapterConfigGen(name).sample();
            if (config) {
              registry.create(name, config);
            }
          }

          const initialFactoryCount = registry.getFactoryCount();
          const initialAdapterCount = registry.getAdapterCount();
          
          expect(initialFactoryCount).toBeGreaterThan(0);
          expect(initialAdapterCount).toBeGreaterThan(0);
          
          // Cleanup should clear all resources
          await registry.cleanup();
          
          expect(registry.getFactoryCount()).toBe(0);
          expect(registry.getAdapterCount()).toBe(0);
          expect(registry.list()).toHaveLength(0);
        }
      ));
    });
  });
});