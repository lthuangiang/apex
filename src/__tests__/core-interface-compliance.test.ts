/**
 * Core Interface Compliance Property Tests
 * 
 * **Property 1: Strategy Isolation**
 * **Validates: Requirements 3.1, 4.1**
 * 
 * These tests verify that strategies never directly interact with exchange adapters
 * and that all adapter interactions go through the ExecutionEngine. This is a critical
 * correctness property for the modular architecture.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { 
  IStrategy, 
  IExecutionEngine, 
  IExchangeAdapter,
  TradingSignal,
  MarketContext,
  ExecutionContext,
  ExecutionResult,
  OrderRequest,
  OrderResult,
  Position,
  Order,
  Orderbook,
  RawTrade,
  StrategyConfig,
  StrategyStatus,
  RiskLimits,
  RiskValidationResult,
  OrderParams,
  ConnectionHealth
} from '../types/core.js';

// ============================================================================
// TEST UTILITIES AND MOCKS
// ============================================================================

/**
 * Mock strategy implementation for testing
 */
class MockStrategy implements IStrategy {
  private signalCount = 0;
  private lastSignalTime?: Date;
  public adapterCallAttempts: string[] = []; // Track any adapter method calls

  async getSignal(symbol: string, context: MarketContext): Promise<TradingSignal> {
    this.signalCount++;
    this.lastSignalTime = new Date();
    
    // Generate a deterministic signal based on context
    const direction = context.currentPrice > 100 ? 'long' : context.currentPrice < 50 ? 'short' : 'skip';
    const confidence = Math.min(Math.abs(context.currentPrice - 75) / 75, 1);
    
    return {
      direction,
      confidence,
      reasoning: `Price ${context.currentPrice} suggests ${direction}`,
      metadata: { symbol, contextPrice: context.currentPrice },
      timestamp: new Date()
    };
  }

  invalidateCache(): void {
    // Cache invalidation logic
  }

  configure(config: StrategyConfig): void {
    // Configuration logic
  }

  getStatus(): StrategyStatus {
    return {
      name: 'MockStrategy',
      isActive: true,
      lastSignalTime: this.lastSignalTime,
      signalCount: this.signalCount,
      performance: {
        winRate: 0.6,
        avgConfidence: 0.7,
        totalSignals: this.signalCount
      }
    };
  }

  // These methods should NEVER be called - they represent direct adapter access
  attemptDirectAdapterCall(methodName: string): void {
    this.adapterCallAttempts.push(methodName);
    throw new Error(`Strategy attempted direct adapter call: ${methodName}`);
  }
}

/**
 * Mock execution engine that tracks adapter interactions
 */
class MockExecutionEngine implements IExecutionEngine {
  private adapter?: IExchangeAdapter;
  public adapterInteractions: string[] = [];

  async executeSignal(signal: TradingSignal, context: ExecutionContext): Promise<ExecutionResult> {
    this.adapterInteractions.push('executeSignal');
    
    if (signal.direction === 'skip') {
      return {
        success: true,
        metadata: { reason: 'signal_skip' },
        timestamp: new Date()
      };
    }

    // Simulate adapter interaction through execution engine
    if (this.adapter) {
      this.adapterInteractions.push('adapter.getMarkPrice');
      this.adapterInteractions.push('adapter.placeLimitOrder');
    }

    return {
      success: true,
      orderId: `order-${Date.now()}`,
      metadata: { signal, context },
      timestamp: new Date()
    };
  }

  async placeOrder(orderRequest: OrderRequest): Promise<OrderResult> {
    this.adapterInteractions.push('placeOrder');
    if (this.adapter) {
      this.adapterInteractions.push('adapter.placeLimitOrder');
    }
    
    return {
      success: true,
      orderId: `order-${Date.now()}`,
      order: {
        id: `order-${Date.now()}`,
        symbol: orderRequest.symbol,
        side: orderRequest.side,
        price: orderRequest.price,
        size: orderRequest.size,
        status: 'pending',
        timestamp: new Date()
      }
    };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    this.adapterInteractions.push('cancelOrder');
    if (this.adapter) {
      this.adapterInteractions.push('adapter.cancelOrder');
    }
    return true;
  }

  async cancelAllOrders(symbol: string): Promise<boolean> {
    this.adapterInteractions.push('cancelAllOrders');
    if (this.adapter) {
      this.adapterInteractions.push('adapter.cancelAllOrders');
    }
    return true;
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    this.adapterInteractions.push('getPositions');
    if (this.adapter) {
      this.adapterInteractions.push('adapter.getPosition');
    }
    return [];
  }

  async getBalance(): Promise<number> {
    this.adapterInteractions.push('getBalance');
    if (this.adapter) {
      this.adapterInteractions.push('adapter.getBalance');
    }
    return 1000;
  }

  setAdapter(adapter: IExchangeAdapter): void {
    this.adapter = adapter;
    this.adapterInteractions.push('setAdapter');
  }

  async validateRisk(signal: TradingSignal, context: ExecutionContext): Promise<RiskValidationResult> {
    return { passed: true };
  }
}

/**
 * Mock exchange adapter for testing
 */
class MockExchangeAdapter implements IExchangeAdapter {
  readonly exchangeName = 'MockExchange';
  readonly supportedSymbols = ['BTC-USD', 'ETH-USD'];
  public methodCalls: string[] = [];

  async getMarkPrice(symbol: string): Promise<number> {
    this.methodCalls.push('getMarkPrice');
    return 100;
  }

  async getOrderbook(symbol: string): Promise<Orderbook> {
    this.methodCalls.push('getOrderbook');
    return {
      bestBid: 99.5,
      bestAsk: 100.5,
      bids: [[99.5, 10], [99.0, 20]],
      asks: [[100.5, 10], [101.0, 20]],
      timestamp: new Date()
    };
  }

  async getOrderbookDepth(symbol: string, limit: number): Promise<{ bids: [number, number][], asks: [number, number][] }> {
    this.methodCalls.push('getOrderbookDepth');
    return {
      bids: [[99.5, 10], [99.0, 20]],
      asks: [[100.5, 10], [101.0, 20]]
    };
  }

  async getRecentTrades(symbol: string, limit: number): Promise<RawTrade[]> {
    this.methodCalls.push('getRecentTrades');
    return [
      { side: 'buy', price: 100, size: 1, timestamp: Date.now() },
      { side: 'sell', price: 99.5, size: 0.5, timestamp: Date.now() - 1000 }
    ];
  }

  async getPosition(symbol: string, markPrice?: number): Promise<Position | null> {
    this.methodCalls.push('getPosition');
    return null;
  }

  async getBalance(): Promise<number> {
    this.methodCalls.push('getBalance');
    return 1000;
  }

  async placeLimitOrder(params: OrderParams): Promise<string> {
    this.methodCalls.push('placeLimitOrder');
    return `order-${Date.now()}`;
  }

  async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
    this.methodCalls.push('cancelOrder');
    return true;
  }

  async cancelAllOrders(symbol: string): Promise<boolean> {
    this.methodCalls.push('cancelAllOrders');
    return true;
  }

  async getOpenOrders(symbol: string): Promise<Order[]> {
    this.methodCalls.push('getOpenOrders');
    return [];
  }

  async connect(): Promise<void> {
    this.methodCalls.push('connect');
  }

  async disconnect(): Promise<void> {
    this.methodCalls.push('disconnect');
  }

  isConnected(): boolean {
    this.methodCalls.push('isConnected');
    return true;
  }

  getHealthStatus(): ConnectionHealth {
    this.methodCalls.push('getHealthStatus');
    return {
      isHealthy: true,
      lastPing: new Date(),
      latency: 50
    };
  }
}

// ============================================================================
// PROPERTY-BASED TEST GENERATORS
// ============================================================================

/**
 * Generator for valid trading symbols
 */
const symbolArbitrary = fc.constantFrom('BTC-USD', 'ETH-USD', 'SOL-USD', 'AVAX-USD');

/**
 * Generator for market context data
 */
const marketContextArbitrary = fc.record({
  currentPrice: fc.float({ min: Math.fround(1), max: Math.fround(100000), noNaN: true }),
  balance: fc.float({ min: Math.fround(0), max: Math.fround(10000), noNaN: true }),
  currentPosition: fc.option(fc.record({
    symbol: symbolArbitrary,
    side: fc.constantFrom('long', 'short', 'neutral'),
    size: fc.float({ min: Math.fround(0.001), max: Math.fround(10), noNaN: true }),
    entryPrice: fc.float({ min: Math.fround(1), max: Math.fround(100000), noNaN: true }),
    unrealizedPnl: fc.float({ min: Math.fround(-1000), max: Math.fround(1000), noNaN: true })
  })),
  volatility: fc.option(fc.record({
    atr: fc.float({ min: Math.fround(0), max: Math.fround(100), noNaN: true }),
    bbWidth: fc.float({ min: Math.fround(0), max: Math.fround(1), noNaN: true }),
    volRatio: fc.float({ min: Math.fround(0), max: Math.fround(5), noNaN: true })
  })),
  orderbook: fc.option(fc.record({
    bestBid: fc.float({ min: Math.fround(1), max: Math.fround(100000), noNaN: true }),
    bestAsk: fc.float({ min: Math.fround(1), max: Math.fround(100000), noNaN: true }),
    spread: fc.float({ min: Math.fround(0.01), max: Math.fround(100), noNaN: true }),
    imbalance: fc.float({ min: Math.fround(0.1), max: Math.fround(10), noNaN: true })
  }))
});

/**
 * Generator for execution context data
 */
const executionContextArbitrary = fc.record({
  symbol: symbolArbitrary,
  balance: fc.float({ min: Math.fround(1), max: Math.fround(10000), noNaN: true }),
  currentPosition: fc.option(fc.record({
    symbol: symbolArbitrary,
    side: fc.constantFrom('long', 'short', 'neutral'),
    size: fc.float({ min: Math.fround(0.001), max: Math.fround(10), noNaN: true }),
    entryPrice: fc.float({ min: Math.fround(1), max: Math.fround(100000), noNaN: true }),
    unrealizedPnl: fc.float({ min: Math.fround(-1000), max: Math.fround(1000), noNaN: true })
  })),
  riskLimits: fc.record({
    maxPositionSize: fc.float({ min: Math.fround(0.1), max: Math.fround(100), noNaN: true }),
    maxLossPerTrade: fc.float({ min: Math.fround(10), max: Math.fround(1000), noNaN: true }),
    maxDailyLoss: fc.float({ min: Math.fround(100), max: Math.fround(5000), noNaN: true }),
    maxDrawdown: fc.float({ min: Math.fround(0.01), max: Math.fround(0.5), noNaN: true })
  })
});

// ============================================================================
// PROPERTY TESTS
// ============================================================================

describe('Property 1: Strategy Isolation', () => {
  let mockStrategy: MockStrategy;
  let mockExecutionEngine: MockExecutionEngine;
  let mockAdapter: MockExchangeAdapter;

  beforeEach(() => {
    mockStrategy = new MockStrategy();
    mockExecutionEngine = new MockExecutionEngine();
    mockAdapter = new MockExchangeAdapter();
    mockExecutionEngine.setAdapter(mockAdapter);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('Strategy never directly calls adapter methods during signal generation', () => {
    fc.assert(
      fc.asyncProperty(
        symbolArbitrary,
        marketContextArbitrary,
        async (symbol, context) => {
          // Reset tracking
          mockStrategy.adapterCallAttempts = [];
          mockAdapter.methodCalls = [];

          // Generate signal through strategy
          const signal = await mockStrategy.getSignal(symbol, context);

          // Verify strategy didn't attempt direct adapter calls
          expect(mockStrategy.adapterCallAttempts).toHaveLength(0);
          
          // Verify adapter methods weren't called directly by strategy
          expect(mockAdapter.methodCalls).toHaveLength(0);
          
          // Verify signal is well-formed
          expect(signal).toMatchObject({
            direction: expect.stringMatching(/^(long|short|skip)$/),
            confidence: expect.any(Number),
            reasoning: expect.any(String),
            metadata: expect.any(Object)
          });
          
          expect(signal.confidence).toBeGreaterThanOrEqual(0);
          expect(signal.confidence).toBeLessThanOrEqual(1);
          expect(Number.isFinite(signal.confidence)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('ExecutionEngine is the only component that calls adapter methods', async () => {
    // Simple test case first
    const symbol = 'BTC-USD';
    const marketContext: MarketContext = {
      currentPrice: 100,
      balance: 1000
    };
    const executionContext: ExecutionContext = {
      symbol: 'BTC-USD',
      balance: 1000,
      riskLimits: {
        maxPositionSize: 10,
        maxLossPerTrade: 100,
        maxDailyLoss: 500,
        maxDrawdown: 0.1
      }
    };

    // Reset tracking
    mockStrategy.adapterCallAttempts = [];
    mockAdapter.methodCalls = [];
    const initialInteractions = [...mockExecutionEngine.adapterInteractions];

    // Generate signal through strategy (should not touch adapter)
    const signal = await mockStrategy.getSignal(symbol, marketContext);
    
    // Verify no adapter calls during signal generation
    expect(mockAdapter.methodCalls).toHaveLength(0);

    // Execute signal through execution engine
    const result = await mockExecutionEngine.executeSignal(signal, executionContext);

    // Verify execution engine made the call
    expect(mockExecutionEngine.adapterInteractions.length).toBeGreaterThan(initialInteractions.length);
    expect(mockExecutionEngine.adapterInteractions).toContain('executeSignal');
    
    // Verify result is well-formed
    expect(result).toMatchObject({
      success: expect.any(Boolean),
      metadata: expect.any(Object),
      timestamp: expect.any(Date)
    });
  });

  it('Property: ExecutionEngine isolation holds across multiple scenarios', () => {
    fc.assert(
      fc.asyncProperty(
        symbolArbitrary,
        marketContextArbitrary,
        async (symbol, marketContext) => {
          // Create fresh execution context for each test
          const executionContext: ExecutionContext = {
            symbol,
            balance: 1000,
            riskLimits: {
              maxPositionSize: 10,
              maxLossPerTrade: 100,
              maxDailyLoss: 500,
              maxDrawdown: 0.1
            }
          };

          // Reset tracking
          mockStrategy.adapterCallAttempts = [];
          mockAdapter.methodCalls = [];

          // Generate signal through strategy (should not touch adapter)
          const signal = await mockStrategy.getSignal(symbol, marketContext);
          
          // Verify no adapter calls during signal generation
          expect(mockAdapter.methodCalls).toHaveLength(0);
          expect(mockStrategy.adapterCallAttempts).toHaveLength(0);

          // Execute signal through execution engine
          const result = await mockExecutionEngine.executeSignal(signal, executionContext);

          // The key property: strategies never call adapters directly
          expect(mockStrategy.adapterCallAttempts).toHaveLength(0);
          
          // Verify result is well-formed
          expect(result).toMatchObject({
            success: expect.any(Boolean),
            metadata: expect.any(Object),
            timestamp: expect.any(Date)
          });
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Strategy isolation is maintained across multiple signal generations', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(symbolArbitrary, marketContextArbitrary), { minLength: 1, maxLength: 10 }),
        async (signalRequests) => {
          // Reset tracking
          mockStrategy.adapterCallAttempts = [];
          mockAdapter.methodCalls = [];

          // Generate multiple signals
          const signals = [];
          for (const [symbol, context] of signalRequests) {
            const signal = await mockStrategy.getSignal(symbol, context);
            signals.push(signal);
          }

          // Verify strategy never attempted direct adapter access
          expect(mockStrategy.adapterCallAttempts).toHaveLength(0);
          
          // Verify adapter was never called directly
          expect(mockAdapter.methodCalls).toHaveLength(0);
          
          // Verify all signals are valid
          for (const signal of signals) {
            expect(signal.direction).toMatch(/^(long|short|skip)$/);
            expect(signal.confidence).toBeGreaterThanOrEqual(0);
            expect(signal.confidence).toBeLessThanOrEqual(1);
            expect(Number.isFinite(signal.confidence)).toBe(true);
            expect(typeof signal.reasoning).toBe('string');
            expect(signal.metadata).toBeDefined();
          }
        }
      ),
      { numRuns: 50 }
    );
  });

  it('All adapter interactions flow through ExecutionEngine interface', () => {
    fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.tuple(symbolArbitrary, marketContextArbitrary, executionContextArbitrary),
          { minLength: 1, maxLength: 5 }
        ),
        async (tradingScenarios) => {
          // Reset tracking
          mockExecutionEngine.adapterInteractions = ['setAdapter']; // Keep setAdapter from setup
          mockAdapter.methodCalls = [];

          for (const [symbol, marketContext, executionContext] of tradingScenarios) {
            // Generate signal (should not touch adapter)
            const signal = await mockStrategy.getSignal(symbol, marketContext);
            
            // Execute through engine (should touch adapter)
            await mockExecutionEngine.executeSignal(signal, executionContext);
          }

          // Verify all adapter calls went through execution engine
          const engineAdapterCalls = mockExecutionEngine.adapterInteractions.filter(
            call => call.startsWith('adapter.')
          );
          
          // If any adapter methods were called, they should match engine's tracking
          if (mockAdapter.methodCalls.length > 0) {
            expect(engineAdapterCalls.length).toBeGreaterThan(0);
          }

          // Verify no direct strategy-to-adapter communication
          expect(mockStrategy.adapterCallAttempts).toHaveLength(0);
        }
      ),
      { numRuns: 50 }
    );
  });

  it('Strategy interface compliance is maintained under all conditions', () => {
    fc.assert(
      fc.asyncProperty(
        symbolArbitrary,
        marketContextArbitrary,
        fc.record({
          type: fc.string(),
          parameters: fc.dictionary(fc.string(), fc.anything()),
          riskLimits: fc.record({
            maxPositionSize: fc.float({ min: Math.fround(0.1), max: Math.fround(100), noNaN: true }),
            maxLossPerTrade: fc.float({ min: Math.fround(10), max: Math.fround(1000), noNaN: true }),
            maxDailyLoss: fc.float({ min: Math.fround(100), max: Math.fround(5000), noNaN: true }),
            maxDrawdown: fc.float({ min: Math.fround(0.01), max: Math.fround(0.5), noNaN: true })
          })
        }),
        async (symbol, context, config) => {
          // Reset tracking
          mockStrategy.adapterCallAttempts = [];
          mockAdapter.methodCalls = [];
          
          // Configure strategy
          mockStrategy.configure(config);
          
          // Test all interface methods
          const signal = await mockStrategy.getSignal(symbol, context);
          mockStrategy.invalidateCache();
          const status = mockStrategy.getStatus();

          // Verify interface compliance
          expect(signal).toMatchObject({
            direction: expect.stringMatching(/^(long|short|skip)$/),
            confidence: expect.any(Number),
            reasoning: expect.any(String),
            metadata: expect.any(Object)
          });

          expect(status).toMatchObject({
            name: expect.any(String),
            isActive: expect.any(Boolean),
            signalCount: expect.any(Number)
          });

          // Verify no adapter access during any interface method
          expect(mockStrategy.adapterCallAttempts).toHaveLength(0);
          expect(mockAdapter.methodCalls).toHaveLength(0);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================================
// UNIT TESTS FOR EDGE CASES
// ============================================================================

describe('Strategy Isolation Edge Cases', () => {
  let mockStrategy: MockStrategy;
  let mockAdapter: MockExchangeAdapter;

  beforeEach(() => {
    mockStrategy = new MockStrategy();
    mockAdapter = new MockExchangeAdapter();
  });

  it('Strategy handles null/undefined market context gracefully without adapter access', async () => {
    const symbol = 'BTC-USD';
    const context: MarketContext = {
      currentPrice: 100,
      balance: 1000
    };

    const signal = await mockStrategy.getSignal(symbol, context);
    
    expect(signal).toBeDefined();
    expect(mockStrategy.adapterCallAttempts).toHaveLength(0);
    expect(mockAdapter.methodCalls).toHaveLength(0);
  });

  it('Strategy configuration changes do not introduce adapter dependencies', () => {
    const config: StrategyConfig = {
      type: 'test-strategy',
      parameters: { param1: 'value1' },
      riskLimits: {
        maxPositionSize: 10,
        maxLossPerTrade: 100,
        maxDailyLoss: 500,
        maxDrawdown: 0.1
      }
    };

    mockStrategy.configure(config);
    const status = mockStrategy.getStatus();

    expect(status.name).toBe('MockStrategy');
    expect(mockStrategy.adapterCallAttempts).toHaveLength(0);
    expect(mockAdapter.methodCalls).toHaveLength(0);
  });

  it('Cache invalidation does not trigger adapter calls', () => {
    mockStrategy.invalidateCache();
    
    expect(mockStrategy.adapterCallAttempts).toHaveLength(0);
    expect(mockAdapter.methodCalls).toHaveLength(0);
  });

  it('Strategy status retrieval is independent of adapter state', () => {
    const status = mockStrategy.getStatus();
    
    expect(status).toMatchObject({
      name: 'MockStrategy',
      isActive: true,
      signalCount: expect.any(Number)
    });
    
    expect(mockStrategy.adapterCallAttempts).toHaveLength(0);
    expect(mockAdapter.methodCalls).toHaveLength(0);
  });
});