/**
 * Tests for core type definitions
 */

import { describe, it, expect } from 'vitest';
import {
  TradingSignal,
  MarketContext,
  ExecutionContext,
  OrderRequest,
  Position,
  Order,
  BotState,
  OrderStatus,
  OrderType,
  TimeInForce,
  TradingRegime,
  RiskLimits,
  SystemError,
  ConfigurationError,
  AdapterError,
  ValidationRules
} from '../index.js';

describe('Core Types', () => {
  it('should create valid TradingSignal', () => {
    const signal: TradingSignal = {
      direction: 'long',
      confidence: 0.8,
      reasoning: 'Strong bullish momentum',
      metadata: { source: 'ai-engine' }
    };
    
    expect(signal.direction).toBe('long');
    expect(signal.confidence).toBe(0.8);
    expect(signal.reasoning).toBe('Strong bullish momentum');
    expect(signal.metadata.source).toBe('ai-engine');
  });

  it('should create valid MarketContext', () => {
    const context: MarketContext = {
      currentPrice: 50000,
      balance: 1000,
      volatility: {
        atr: 0.02,
        bbWidth: 0.015,
        volRatio: 1.2
      },
      orderbook: {
        bestBid: 49995,
        bestAsk: 50005,
        spread: 10,
        imbalance: 1.1
      }
    };
    
    expect(context.currentPrice).toBe(50000);
    expect(context.balance).toBe(1000);
    expect(context.volatility?.atr).toBe(0.02);
    expect(context.orderbook?.bestBid).toBe(49995);
  });

  it('should create valid ExecutionContext', () => {
    const riskLimits: RiskLimits = {
      maxPositionSize: 0.1,
      maxLossPerTrade: 100,
      maxDailyLoss: 500,
      maxDrawdown: 0.05
    };

    const context: ExecutionContext = {
      symbol: 'BTC-USD',
      balance: 1000,
      riskLimits
    };
    
    expect(context.symbol).toBe('BTC-USD');
    expect(context.balance).toBe(1000);
    expect(context.riskLimits.maxPositionSize).toBe(0.1);
  });

  it('should create valid OrderRequest', () => {
    const orderRequest: OrderRequest = {
      symbol: 'BTC-USD',
      side: 'buy',
      price: 50000,
      size: 0.01,
      reduceOnly: false,
      timeInForce: 'GTC',
      type: 'limit'
    };
    
    expect(orderRequest.symbol).toBe('BTC-USD');
    expect(orderRequest.side).toBe('buy');
    expect(orderRequest.price).toBe(50000);
    expect(orderRequest.size).toBe(0.01);
  });

  it('should create valid Position', () => {
    const position: Position = {
      symbol: 'BTC-USD',
      side: 'long',
      size: 0.01,
      entryPrice: 49000,
      unrealizedPnl: 10,
      timestamp: new Date()
    };
    
    expect(position.symbol).toBe('BTC-USD');
    expect(position.side).toBe('long');
    expect(position.size).toBe(0.01);
    expect(position.entryPrice).toBe(49000);
  });

  it('should create valid Order', () => {
    const order: Order = {
      id: 'order-123',
      symbol: 'BTC-USD',
      side: 'buy',
      price: 50000,
      size: 0.01,
      status: 'pending',
      timestamp: new Date(),
      type: 'limit',
      timeInForce: 'GTC'
    };
    
    expect(order.id).toBe('order-123');
    expect(order.symbol).toBe('BTC-USD');
    expect(order.side).toBe('buy');
    expect(order.status).toBe('pending');
  });

  it('should validate enum types', () => {
    const botStates: BotState[] = ['IDLE', 'PENDING_ENTRY', 'IN_POSITION', 'PENDING_EXIT', 'ERROR', 'STOPPED'];
    const orderStatuses: OrderStatus[] = ['pending', 'filled', 'cancelled', 'rejected', 'partially_filled'];
    const orderTypes: OrderType[] = ['market', 'limit', 'stop', 'stop_limit'];
    const timeInForces: TimeInForce[] = ['GTC', 'IOC', 'FOK', 'post-only'];
    const tradingRegimes: TradingRegime[] = ['TREND_UP', 'TREND_DOWN', 'SIDEWAY', 'HIGH_VOLATILITY'];
    
    expect(botStates).toContain('IDLE');
    expect(orderStatuses).toContain('pending');
    expect(orderTypes).toContain('limit');
    expect(timeInForces).toContain('GTC');
    expect(tradingRegimes).toContain('TREND_UP');
  });
});

describe('Error Types', () => {
  it('should create SystemError with proper properties', () => {
    const error = new ConfigurationError('Test error', { field: 'test' });
    
    expect(error).toBeInstanceOf(SystemError);
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.context.field).toBe('test');
    expect(error.recoverable).toBe(false);
    expect(error.timestamp).toBeInstanceOf(Date);
  });

  it('should create AdapterError with exchange name', () => {
    const error = new AdapterError('decibel', 'Connection failed', { reason: 'timeout' }, true);
    
    expect(error).toBeInstanceOf(SystemError);
    expect(error.exchangeName).toBe('decibel');
    expect(error.message).toBe('Connection failed');
    expect(error.code).toBe('ADAPTER_ERROR');
    expect(error.recoverable).toBe(true);
  });

  it('should serialize error to JSON', () => {
    const error = new ConfigurationError('Test error', { field: 'test' });
    const json = error.toJSON();
    
    expect(json.name).toBe('ConfigurationError');
    expect(json.message).toBe('Test error');
    expect(json.code).toBe('CONFIG_ERROR');
    expect(json.context.field).toBe('test');
    expect(json.recoverable).toBe(false);
    expect(json.timestamp).toBeDefined();
  });
});

describe('Validation Rules', () => {
  it('should validate required fields', () => {
    const rule = ValidationRules.required();
    
    expect(rule.validate(null).isValid).toBe(false);
    expect(rule.validate(undefined).isValid).toBe(false);
    expect(rule.validate('').isValid).toBe(false);
    expect(rule.validate('value').isValid).toBe(true);
    expect(rule.validate(0).isValid).toBe(true);
  });

  it('should validate minimum values', () => {
    const rule = ValidationRules.min(10);
    
    expect(rule.validate(5).isValid).toBe(false);
    expect(rule.validate(10).isValid).toBe(true);
    expect(rule.validate(15).isValid).toBe(true);
    expect(rule.validate('not a number').isValid).toBe(false);
  });

  it('should validate positive numbers', () => {
    const rule = ValidationRules.positive();
    
    expect(rule.validate(-1).isValid).toBe(false);
    expect(rule.validate(0).isValid).toBe(false);
    expect(rule.validate(1).isValid).toBe(true);
    expect(rule.validate('not a number').isValid).toBe(false);
  });

  it('should validate one of values', () => {
    const rule = ValidationRules.oneOf(['long', 'short', 'skip']);
    
    expect(rule.validate('long').isValid).toBe(true);
    expect(rule.validate('short').isValid).toBe(true);
    expect(rule.validate('skip').isValid).toBe(true);
    expect(rule.validate('invalid').isValid).toBe(false);
  });

  it('should validate string patterns', () => {
    const rule = ValidationRules.pattern(/^[A-Z]{3}-[A-Z]{3}$/);
    
    expect(rule.validate('BTC-USD').isValid).toBe(true);
    expect(rule.validate('ETH-USD').isValid).toBe(true);
    expect(rule.validate('btc-usd').isValid).toBe(false);
    expect(rule.validate('INVALID').isValid).toBe(false);
  });
});