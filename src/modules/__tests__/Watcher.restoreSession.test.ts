/**
 * Unit test for Watcher.restoreSessionFromPersistence() method
 * 
 * Validates that the method correctly syncs Watcher's in-memory session fields
 * with restored BotSharedState values.
 */

import { describe, it, expect, vi } from 'vitest';
import { Watcher } from '../Watcher.js';
import { SessionManager } from '../SessionManager.js';
import { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';
import { TelegramManager } from '../TelegramManager.js';
import { createBotSharedState, type BotSharedState } from '../../bot/BotSharedState.js';

// ─── Minimal mocks ────────────────────────────────────────────────────────────

function makeMockAdapter(balance = 500): ExchangeAdapter {
  return {
    get_balance: vi.fn().mockResolvedValue(balance),
    get_position: vi.fn().mockResolvedValue(null),
    get_mark_price: vi.fn().mockResolvedValue(100),
    get_open_orders: vi.fn().mockResolvedValue([]),
    place_order: vi.fn().mockResolvedValue({ orderId: 'order-123', price: 100, size: 0.1 }),
    cancel_order: vi.fn().mockResolvedValue(true),
    cancel_all_orders: vi.fn().mockResolvedValue(true),
    get_orderbook: vi.fn().mockResolvedValue({ bids: [[100, 1]], asks: [[101, 1]] }),
    get_klines: vi.fn().mockResolvedValue([]),
  } as unknown as ExchangeAdapter;
}

function makeMockTelegram(): TelegramManager {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onCommand: vi.fn(),
    onCallback: vi.fn(),
    setupMenu: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockReturnValue(false),
    sendMessageWithInlineButtons: vi.fn(),
  } as unknown as TelegramManager;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test: restoreSessionFromPersistence() syncs fields from BotSharedState
// ─────────────────────────────────────────────────────────────────────────────

describe('Watcher.restoreSessionFromPersistence()', () => {
  it('should sync sessionFees from BotSharedState', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();
    const botState = createBotSharedState('test-bot');
    
    // Set persisted values in BotSharedState
    botState.sessionFees = 5.0;
    
    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager, botState);
    
    // Initially, Watcher's internal field is 0 (from resetSession or constructor)
    expect((watcher as any).sessionFees).toBe(0);
    
    // Call restoreSessionFromPersistence
    (watcher as any).restoreSessionFromPersistence();
    
    // Verify field is synced
    expect((watcher as any).sessionFees).toBe(5.0);
  });

  it('should sync sessionGrossPnl from BotSharedState', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();
    const botState = createBotSharedState('test-bot');
    
    botState.sessionGrossPnl = 10.0;
    
    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager, botState);
    expect((watcher as any).sessionGrossPnl).toBe(0);
    
    (watcher as any).restoreSessionFromPersistence();
    
    expect((watcher as any).sessionGrossPnl).toBe(10.0);
  });

  it('should sync sessionVolume from BotSharedState', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();
    const botState = createBotSharedState('test-bot');
    
    botState.sessionVolume = 1000.0;
    
    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager, botState);
    expect((watcher as any).sessionVolume).toBe(0);
    
    (watcher as any).restoreSessionFromPersistence();
    
    expect((watcher as any).sessionVolume).toBe(1000.0);
  });

  it('should sync sessionStartBalance from BotSharedState', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();
    const botState = createBotSharedState('test-bot');
    
    botState.sessionStartBalance = 500;
    
    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager, botState);
    expect((watcher as any).sessionStartBalance).toBeNull();
    
    (watcher as any).restoreSessionFromPersistence();
    
    expect((watcher as any).sessionStartBalance).toBe(500);
  });

  it('should sync sessionCurrentPnl from BotSharedState.sessionPnl', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();
    const botState = createBotSharedState('test-bot');
    
    botState.sessionPnl = 12.5;
    
    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager, botState);
    expect((watcher as any).sessionCurrentPnl).toBe(0);
    
    (watcher as any).restoreSessionFromPersistence();
    
    expect((watcher as any).sessionCurrentPnl).toBe(12.5);
  });

  it('should sync all session fields at once', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();
    const botState = createBotSharedState('test-bot');
    
    // Set all persisted values
    botState.sessionFees = 5.0;
    botState.sessionGrossPnl = 10.0;
    botState.sessionVolume = 1000.0;
    botState.sessionStartBalance = 500;
    botState.sessionPnl = 5.0;
    
    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager, botState);
    
    // Verify initial state (all zeros/null)
    expect((watcher as any).sessionFees).toBe(0);
    expect((watcher as any).sessionGrossPnl).toBe(0);
    expect((watcher as any).sessionVolume).toBe(0);
    expect((watcher as any).sessionStartBalance).toBeNull();
    expect((watcher as any).sessionCurrentPnl).toBe(0);
    
    // Call restoreSessionFromPersistence
    (watcher as any).restoreSessionFromPersistence();
    
    // Verify all fields are synced
    expect((watcher as any).sessionFees).toBe(5.0);
    expect((watcher as any).sessionGrossPnl).toBe(10.0);
    expect((watcher as any).sessionVolume).toBe(1000.0);
    expect((watcher as any).sessionStartBalance).toBe(500);
    expect((watcher as any).sessionCurrentPnl).toBe(5.0);
  });

  it('should handle null sessionStartBalance correctly', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();
    const botState = createBotSharedState('test-bot');
    
    // sessionStartBalance can legitimately be null before first balance fetch
    botState.sessionStartBalance = null;
    
    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager, botState);
    
    (watcher as any).restoreSessionFromPersistence();
    
    // Should remain null
    expect((watcher as any).sessionStartBalance).toBeNull();
  });
});
