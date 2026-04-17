/**
 * EventBus usage examples
 * 
 * This file demonstrates how to use the EventBus for event-driven communication
 * in the modular architecture.
 */

import { EventBus } from './EventBus.js';
import { EventData } from '../types/core.js';

// Example: Trading system components communicating via EventBus
async function tradingSystemExample() {
  const eventBus = new EventBus();

  // Strategy component - generates trading signals
  class TradingStrategy {
    constructor(private eventBus: EventBus) {}

    async generateSignal(symbol: string, confidence: number) {
      // Strategy emits signal event instead of calling execution engine directly
      await this.eventBus.emit('trading-signal', {
        symbol,
        direction: confidence > 0.6 ? 'long' : 'short',
        confidence,
        reasoning: `Confidence: ${confidence}`
      }, 'TradingStrategy');
    }
  }

  // Execution engine - handles order placement
  class ExecutionEngine {
    private orders: any[] = [];

    constructor(private eventBus: EventBus) {
      // Subscribe to trading signals
      this.eventBus.subscribe('trading-signal', this.handleTradingSignal.bind(this));
      
      // Subscribe to order events with high priority
      this.eventBus.subscribe('order-placed', this.handleOrderPlaced.bind(this), { priority: 10 });
    }

    private async handleTradingSignal(data: EventData) {
      const signal = data.payload;
      console.log(`ExecutionEngine: Received signal for ${signal.symbol}: ${signal.direction}`);
      
      // Place order and emit order event
      const orderId = `order-${Date.now()}`;
      this.orders.push({ id: orderId, ...signal });
      
      await this.eventBus.emit('order-placed', {
        orderId,
        symbol: signal.symbol,
        side: signal.direction === 'long' ? 'buy' : 'sell',
        size: signal.confidence * 100
      }, 'ExecutionEngine');
    }

    private handleOrderPlaced(data: EventData) {
      const order = data.payload;
      console.log(`ExecutionEngine: Order placed - ${order.orderId} for ${order.symbol}`);
    }
  }

  // Risk manager - monitors and validates trades
  class RiskManager {
    constructor(private eventBus: EventBus) {
      // Subscribe to order events with medium priority
      this.eventBus.subscribe('order-placed', this.handleOrderPlaced.bind(this), { priority: 5 });
    }

    private handleOrderPlaced(data: EventData) {
      const order = data.payload;
      console.log(`RiskManager: Validating order ${order.orderId}`);
      
      // Perform risk checks
      if (order.size > 1000) {
        console.log(`RiskManager: WARNING - Large order size: ${order.size}`);
      }
    }
  }

  // Logger - records all events
  class EventLogger {
    constructor(private eventBus: EventBus) {
      // Subscribe to all events with low priority
      this.eventBus.subscribe('trading-signal', this.logEvent.bind(this), { priority: 1 });
      this.eventBus.subscribe('order-placed', this.logEvent.bind(this), { priority: 1 });
    }

    private logEvent(data: EventData) {
      console.log(`Logger: [${data.type}] from ${data.source} at ${data.timestamp.toISOString()}`);
    }
  }

  // Create components
  const strategy = new TradingStrategy(eventBus);
  const executionEngine = new ExecutionEngine(eventBus);
  const riskManager = new RiskManager(eventBus);
  const logger = new EventLogger(eventBus);

  // Generate some trading signals
  console.log('=== Trading System Example ===');
  await strategy.generateSignal('BTC-USD', 0.8);
  await strategy.generateSignal('ETH-USD', 0.4);
  
  // Wait for all events to be processed
  await new Promise(resolve => setTimeout(resolve, 100));
  
  // Get metrics
  const metrics = eventBus.getMetrics();
  console.log('\n=== EventBus Metrics ===');
  console.log(`Events emitted: ${metrics.eventsEmitted}`);
  console.log(`Events processed: ${metrics.eventsProcessed}`);
  console.log(`Subscribers: ${metrics.subscriberCount}`);
  console.log('Subscribers by type:', metrics.subscribersByType);

  await eventBus.shutdown();
}

// Example: Event ordering and priority
async function eventOrderingExample() {
  const eventBus = new EventBus({
    ordering: { enabled: true, strategy: 'timestamp' }
  });

  const results: string[] = [];

  // High priority handler
  eventBus.subscribe('test-event', (data: EventData) => {
    results.push(`High: ${data.payload.message}`);
  }, { priority: 10 });

  // Medium priority handler
  eventBus.subscribe('test-event', (data: EventData) => {
    results.push(`Medium: ${data.payload.message}`);
  }, { priority: 5 });

  // Low priority handler
  eventBus.subscribe('test-event', (data: EventData) => {
    results.push(`Low: ${data.payload.message}`);
  }, { priority: 1 });

  console.log('\n=== Event Ordering Example ===');
  
  // Emit events
  await eventBus.emit('test-event', { message: 'First event' });
  await eventBus.emit('test-event', { message: 'Second event' });
  
  // Wait for processing
  await new Promise(resolve => setTimeout(resolve, 50));
  
  console.log('Results (should be in priority order):');
  results.forEach(result => console.log(`  ${result}`));

  await eventBus.shutdown();
}

// Example: Once-only subscriptions
async function onceOnlyExample() {
  const eventBus = new EventBus();

  let callCount = 0;
  
  // Subscribe with once: true
  eventBus.subscribe('startup-event', (data: EventData) => {
    callCount++;
    console.log(`Startup handler called: ${data.payload.message}`);
  }, { once: true });

  console.log('\n=== Once-Only Subscription Example ===');
  
  // Emit multiple events
  await eventBus.emit('startup-event', { message: 'System starting...' });
  await eventBus.emit('startup-event', { message: 'System ready' });
  await eventBus.emit('startup-event', { message: 'Another event' });
  
  // Wait for processing
  await new Promise(resolve => setTimeout(resolve, 50));
  
  console.log(`Handler was called ${callCount} time(s) (should be 1)`);

  await eventBus.shutdown();
}

// Run examples
async function runExamples() {
  try {
    await tradingSystemExample();
    await eventOrderingExample();
    await onceOnlyExample();
  } catch (error) {
    console.error('Example error:', error);
  }
}

// Export for use in other files
export { runExamples };

// Run examples if this file is executed directly
if (require.main === module) {
  runExamples();
}