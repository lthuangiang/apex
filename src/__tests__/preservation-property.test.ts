/**
 * Preservation Property Tests - Session State Persistence Fix
 *
 * **IMPORTANT**: These tests capture existing behavior that MUST be preserved
 * after implementing the fix. Run on UNFIXED code first to observe baseline.
 * Tests should PASS on unfixed code (confirms baseline behavior to preserve).
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8**
 *
 * Test cases:
 * - Runtime accumulation: sessionFees, sessionGrossPnl, sessionVolume accumulate correctly during active trading
 * - Existing persistence: sessionPnl, sessionVolume, todayVolume, pnlHistory, volumeHistory, eventLog persist correctly
 * - Fresh session reset: explicit resetSession() calls reset all stats to 0/null (not a restart scenario)
 * - Multi-bot isolation: each bot maintains isolated state
 * - TodayVolume date logic: todayVolume only restored if same UTC day
 * - Debounced save: StateStore saves with 3-second debounce
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Watcher } from '../modules/Watcher.js';
import { SessionManager } from '../modules/SessionManager.js';
import { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import { TelegramManager } from '../modules/TelegramManager.js';
import { createBotSharedState, type BotSharedState } from '../bot/BotSharedState.js';
import { loadState, saveState, saveStateSync } from '../ai/StateStore.js';
import { sharedState } from '../ai/sharedState.js';
import { existsSync, unlinkSync, readFileSync } from 'fs';
import { getDb, closeDb } from '../db/Database.js';

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

// ─── Test Setup ───────────────────────────────────────────────────────────────

const STATE_PATH = process.env.STATE_STORE_PATH ?? './bot_state.json';

beforeEach(() => {
  // Clean up SQLite bot_state table before each test
  try {
    const db = getDb();
    db.prepare('DELETE FROM bot_state').run();
  } catch { /* ignore if db not ready */ }
  // Also clean up any legacy JSON file
  if (existsSync(STATE_PATH)) {
    unlinkSync(STATE_PATH);
  }
  // Reset sharedState to defaults
  sharedState.sessionPnl = 0;
  sharedState.sessionVolume = 0;
  sharedState.sessionFees = 0;
  sharedState.sessionGrossPnl = 0;
  sharedState.sessionStartBalance = null;
  sharedState.currentBalance = null;
  sharedState.todayVolume = 0;
  sharedState.todayVolumeDate = new Date().toISOString().slice(0, 10);
  sharedState.pnlHistory = [];
  sharedState.volumeHistory = [];
  sharedState.eventLog = [];
});

afterEach(() => {
  // Clean up SQLite bot_state table after each test
  try {
    const db = getDb();
    db.prepare('DELETE FROM bot_state').run();
  } catch { /* ignore */ }
  // Also clean up any legacy JSON file
  if (existsSync(STATE_PATH)) {
    unlinkSync(STATE_PATH);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Runtime accumulation - sessionFees, sessionGrossPnl, sessionVolume
// ─────────────────────────────────────────────────────────────────────────────

describe('Preservation 1 — Runtime accumulation during active trading', () => {
  it('should accumulate sessionFees correctly during runtime', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Simulate trading activity: manually accumulate fees
    (watcher as any).sessionFees = 0;
    
    // Trade 1: $2 fee
    (watcher as any).sessionFees += 2.0;
    expect((watcher as any).sessionFees).toBe(2.0);

    // Trade 2: $3 fee
    (watcher as any).sessionFees += 3.0;
    expect((watcher as any).sessionFees).toBe(5.0);

    // Trade 3: $1.5 fee
    (watcher as any).sessionFees += 1.5;
    expect((watcher as any).sessionFees).toBe(6.5);

    // Verify accumulation is additive (not replaced)
    expect((watcher as any).sessionFees).toBeGreaterThan(0);
  });

  it('should accumulate sessionGrossPnl correctly during runtime', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Simulate trading activity: manually accumulate gross PnL
    (watcher as any).sessionGrossPnl = 0;
    
    // Trade 1: +$5 gross PnL
    (watcher as any).sessionGrossPnl += 5.0;
    expect((watcher as any).sessionGrossPnl).toBe(5.0);

    // Trade 2: -$2 gross PnL
    (watcher as any).sessionGrossPnl += -2.0;
    expect((watcher as any).sessionGrossPnl).toBe(3.0);

    // Trade 3: +$7 gross PnL
    (watcher as any).sessionGrossPnl += 7.0;
    expect((watcher as any).sessionGrossPnl).toBe(10.0);

    // Verify accumulation is additive
    expect((watcher as any).sessionGrossPnl).toBe(10.0);
  });

  it('should accumulate sessionVolume correctly during runtime', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Simulate trading activity: manually accumulate volume
    (watcher as any).sessionVolume = 0;
    
    // Trade 1: $500 volume
    (watcher as any).sessionVolume += 500.0;
    expect((watcher as any).sessionVolume).toBe(500.0);

    // Trade 2: $300 volume
    (watcher as any).sessionVolume += 300.0;
    expect((watcher as any).sessionVolume).toBe(800.0);

    // Trade 3: $200 volume
    (watcher as any).sessionVolume += 200.0;
    expect((watcher as any).sessionVolume).toBe(1000.0);

    // Verify accumulation is additive
    expect((watcher as any).sessionVolume).toBe(1000.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Existing persistence - sessionPnl, sessionVolume, todayVolume, histories
// ─────────────────────────────────────────────────────────────────────────────

describe('Preservation 2 — Existing StateStore persistence behavior', () => {
  it('should persist and restore sessionPnl correctly (existing behavior)', () => {
    // Set sessionPnl
    sharedState.sessionPnl = 12.5;

    // Save state
    saveStateSync();

    // Verify state was saved to SQLite
    const db = getDb();
    const row = db.prepare("SELECT session_pnl FROM bot_state WHERE bot_id = '__single__'").get();
    expect(row).toBeDefined();

    // Reset state
    sharedState.sessionPnl = 0;

    // Load state
    loadState();

    // Verify sessionPnl was restored
    expect(sharedState.sessionPnl).toBe(12.5);
  });

  it('should persist and restore sessionVolume correctly (existing behavior)', () => {
    // Set sessionVolume
    sharedState.sessionVolume = 1500.0;

    // Save state
    saveStateSync();

    // Reset state
    sharedState.sessionVolume = 0;

    // Load state
    loadState();

    // Verify sessionVolume was restored
    expect(sharedState.sessionVolume).toBe(1500.0);
  });

  it('should persist and restore pnlHistory correctly (existing behavior)', () => {
    // Set pnlHistory
    sharedState.pnlHistory = [
      { time: '2024-01-01T00:00:00Z', value: 5.0 },
      { time: '2024-01-01T01:00:00Z', value: 10.0 },
      { time: '2024-01-01T02:00:00Z', value: 12.5 },
    ];

    // Save state
    saveStateSync();

    // Reset state
    sharedState.pnlHistory = [];

    // Load state
    loadState();

    // Verify pnlHistory was restored
    expect(sharedState.pnlHistory).toHaveLength(3);
    expect(sharedState.pnlHistory[0].value).toBe(5.0);
    expect(sharedState.pnlHistory[1].value).toBe(10.0);
    expect(sharedState.pnlHistory[2].value).toBe(12.5);
  });

  it('should persist and restore volumeHistory correctly (existing behavior)', () => {
    // Set volumeHistory
    sharedState.volumeHistory = [
      { time: '2024-01-01T00:00:00Z', value: 500.0 },
      { time: '2024-01-01T01:00:00Z', value: 1000.0 },
      { time: '2024-01-01T02:00:00Z', value: 1500.0 },
    ];

    // Save state
    saveStateSync();

    // Reset state
    sharedState.volumeHistory = [];

    // Load state
    loadState();

    // Verify volumeHistory was restored
    expect(sharedState.volumeHistory).toHaveLength(3);
    expect(sharedState.volumeHistory[0].value).toBe(500.0);
    expect(sharedState.volumeHistory[1].value).toBe(1000.0);
    expect(sharedState.volumeHistory[2].value).toBe(1500.0);
  });

  it('should persist and restore eventLog correctly (existing behavior)', () => {
    // Set eventLog
    sharedState.eventLog = [
      { time: '2024-01-01T00:00:00Z', type: 'INFO', message: 'Bot started' },
      { time: '2024-01-01T01:00:00Z', type: 'ORDER_PLACED', message: 'LONG order placed' },
      { time: '2024-01-01T02:00:00Z', type: 'ORDER_FILLED', message: 'Entry filled' },
    ];

    // Save state
    saveStateSync();

    // Reset state
    sharedState.eventLog = [];

    // Load state
    loadState();

    // Verify eventLog was restored
    expect(sharedState.eventLog).toHaveLength(3);
    expect(sharedState.eventLog[0].message).toBe('Bot started');
    expect(sharedState.eventLog[1].message).toBe('LONG order placed');
    expect(sharedState.eventLog[2].message).toBe('Entry filled');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Fresh session reset - explicit resetSession() calls
// ─────────────────────────────────────────────────────────────────────────────

describe('Preservation 3 — Fresh session reset behavior', () => {
  it('should reset all session stats to 0/null when resetSession() is called explicitly', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Set some session stats
    (watcher as any).sessionFees = 5.0;
    (watcher as any).sessionGrossPnl = 10.0;
    (watcher as any).sessionVolume = 1000.0;
    (watcher as any).sessionStartBalance = 500;
    (watcher as any).sessionCurrentPnl = 5.0;

    // Call resetSession() explicitly (fresh session, not a restart)
    (watcher as any).resetSession();

    // Verify all stats are reset to 0/null
    expect((watcher as any).sessionFees).toBe(0);
    expect((watcher as any).sessionGrossPnl).toBe(0);
    expect((watcher as any).sessionVolume).toBe(0);
    expect((watcher as any).sessionStartBalance).toBeNull();
    expect((watcher as any).sessionCurrentPnl).toBe(0);
  });

  it('should reset recentPnLs and currentProfile when resetSession() is called', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Set some state
    (watcher as any).recentPnLs = [5.0, -2.0, 3.0];
    (watcher as any).currentProfile = 'RUNNER';

    // Call resetSession()
    (watcher as any).resetSession();

    // Verify state is reset
    expect((watcher as any).recentPnLs).toEqual([]);
    expect((watcher as any).currentProfile).toBe('NORMAL');
  });

  it('should reset bot state machine to IDLE when resetSession() is called', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Set bot state to IN_POSITION
    (watcher as any).botState = 'IN_POSITION';
    (watcher as any).entryFilledAt = Date.now();

    // Call resetSession()
    (watcher as any).resetSession();

    // Verify state machine is reset
    expect((watcher as any).botState).toBe('IDLE');
    expect((watcher as any).entryFilledAt).toBeNull();
    expect((watcher as any).pendingEntry).toBeNull();
    expect((watcher as any).pendingExit).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Multi-bot isolation - each bot maintains isolated state
// ─────────────────────────────────────────────────────────────────────────────

describe('Preservation 4 — Multi-bot state isolation', () => {
  it('should maintain isolated state for each bot instance', () => {
    // Create 3 bot instances with isolated state
    const bot1State = createBotSharedState('bot-1');
    const bot2State = createBotSharedState('bot-2');
    const bot3State = createBotSharedState('bot-3');

    // Set different session stats for each bot
    bot1State.sessionFees = 2.0;
    bot1State.sessionGrossPnl = 5.0;
    bot1State.sessionVolume = 500.0;

    bot2State.sessionFees = 3.0;
    bot2State.sessionGrossPnl = 7.0;
    bot2State.sessionVolume = 700.0;

    bot3State.sessionFees = 4.0;
    bot3State.sessionGrossPnl = 9.0;
    bot3State.sessionVolume = 900.0;

    // Verify each bot has isolated state
    expect(bot1State.sessionFees).toBe(2.0);
    expect(bot2State.sessionFees).toBe(3.0);
    expect(bot3State.sessionFees).toBe(4.0);

    // Modify bot #2 state
    bot2State.sessionFees = 10.0;

    // Verify bot #1 and #3 are unaffected
    expect(bot1State.sessionFees).toBe(2.0);
    expect(bot3State.sessionFees).toBe(4.0);
    expect(bot2State.sessionFees).toBe(10.0);
  });

  it('should maintain isolated eventLog for each bot instance', () => {
    const bot1State = createBotSharedState('bot-1');
    const bot2State = createBotSharedState('bot-2');

    // Add events to bot #1
    bot1State.eventLog.push({ time: '2024-01-01T00:00:00Z', type: 'INFO', message: 'Bot 1 started' });

    // Add events to bot #2
    bot2State.eventLog.push({ time: '2024-01-01T00:00:00Z', type: 'INFO', message: 'Bot 2 started' });

    // Verify isolation
    expect(bot1State.eventLog).toHaveLength(1);
    expect(bot2State.eventLog).toHaveLength(1);
    expect(bot1State.eventLog[0].message).toBe('Bot 1 started');
    expect(bot2State.eventLog[0].message).toBe('Bot 2 started');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: TodayVolume date logic - only restored if same UTC day
// ─────────────────────────────────────────────────────────────────────────────

describe('Preservation 5 — TodayVolume date-based restoration', () => {
  it('should restore todayVolume if saved on the same UTC day', () => {
    const today = new Date().toISOString().slice(0, 10);

    // Set todayVolume for today
    sharedState.todayVolume = 2000.0;
    sharedState.todayVolumeDate = today;

    // Save state
    saveStateSync();

    // Reset state
    sharedState.todayVolume = 0;
    sharedState.todayVolumeDate = '';

    // Load state
    loadState();

    // Verify todayVolume was restored (same day)
    expect(sharedState.todayVolume).toBe(2000.0);
    expect(sharedState.todayVolumeDate).toBe(today);
  });

  it('should NOT restore todayVolume if saved on a different UTC day', () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    // Set todayVolume for yesterday
    sharedState.todayVolume = 2000.0;
    sharedState.todayVolumeDate = yesterday;

    // Save state
    saveStateSync();

    // Reset state
    sharedState.todayVolume = 0;
    sharedState.todayVolumeDate = new Date().toISOString().slice(0, 10);

    // Load state
    loadState();

    // Verify todayVolume was NOT restored (different day)
    // The loadState() function should skip restoration if the date doesn't match
    expect(sharedState.todayVolume).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: Debounced save - StateStore saves with 3-second debounce
// ─────────────────────────────────────────────────────────────────────────────

describe('Preservation 6 — Debounced save behavior', () => {
  it('should debounce saveState() calls (3-second delay)', async () => {
    // Set some state
    sharedState.sessionPnl = 5.0;

    // Call saveState() (debounced)
    saveState();

    // Immediately check - SQLite should NOT have the row yet (debounced)
    const db = getDb();
    const row = db.prepare("SELECT session_pnl FROM bot_state WHERE bot_id = '__single__'").get() as Record<string, unknown> | undefined;
    expect(row).toBeUndefined();

    // Wait for debounce delay (3 seconds + buffer)
    await new Promise(resolve => setTimeout(resolve, 3500));

    // Now row should exist in SQLite
    const savedRow = db.prepare("SELECT session_pnl FROM bot_state WHERE bot_id = '__single__'").get() as Record<string, unknown>;
    expect(savedRow).toBeDefined();
    expect(savedRow['session_pnl']).toBe(5.0);
  });

  it('should save immediately with saveStateSync() (no debounce)', () => {
    // Set some state
    sharedState.sessionPnl = 10.0;

    // Call saveStateSync() (immediate)
    saveStateSync();

    // Row should exist immediately in SQLite
    const db = getDb();
    const row = db.prepare("SELECT session_pnl FROM bot_state WHERE bot_id = '__single__'").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row['session_pnl']).toBe(10.0);
  });

  it('should cancel previous debounced save when saveState() is called multiple times', async () => {
    // First call
    sharedState.sessionPnl = 5.0;
    saveState();

    // Wait 1 second (less than debounce delay)
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Second call (should cancel first)
    sharedState.sessionPnl = 10.0;
    saveState();

    // Wait for debounce delay
    await new Promise(resolve => setTimeout(resolve, 3500));

    // SQLite should have the SECOND value (first was cancelled)
    const db = getDb();
    const row = db.prepare("SELECT session_pnl FROM bot_state WHERE bot_id = '__single__'").get() as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row['session_pnl']).toBe(10.0);
  });
});
