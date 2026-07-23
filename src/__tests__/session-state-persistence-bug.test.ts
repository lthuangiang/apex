/**
 * Bug Condition Exploration Test - Session State Persistence
 *
 * **CRITICAL**: This test is EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bug exists (session stats are lost on restart).
 * DO NOT attempt to fix the test or the code when it fails.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 *
 * Bug: Session statistics (sessionFees, sessionGrossPnl, sessionVolume,
 * sessionStartBalance, currentBalance) reset to 0/null on bot restart.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Watcher } from '../modules/Watcher.js';
import { SessionManager } from '../modules/SessionManager.js';
import { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import { TelegramManager } from '../modules/TelegramManager.js';
import { BotInstance } from '../bot/BotInstance.js';
import { createBotSharedState, type BotSharedState } from '../bot/BotSharedState.js';
import { loadState, saveStateSync } from '../ai/StateStore.js';
import { sharedState } from '../ai/sharedState.js';
import { existsSync, unlinkSync } from 'fs';
import { getDb } from '../db/Database.js';

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
});

afterEach(() => {
  // Clean up SQLite bot_state table after each test
  try {
    const db = getDb();
    db.prepare('DELETE FROM bot_state').run();
  } catch { /* ignore */ }
  if (existsSync(STATE_PATH)) {
    unlinkSync(STATE_PATH);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Single-bot restart - session stats lost
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug Condition 1 — Single-bot restart loses session stats', () => {
  it('should preserve sessionFees, sessionGrossPnl, sessionVolume on restart (EXPECTED TO FAIL)', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    // Create watcher and simulate a session with accumulated stats
    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);
    
    // Manually set session stats to simulate trading activity
    (watcher as any).sessionFees = 5.0;
    (watcher as any).sessionGrossPnl = 10.0;
    (watcher as any).sessionVolume = 1000.0;
    (watcher as any).sessionStartBalance = 500;
    (watcher as any).sessionCurrentPnl = 5.0; // Net PnL after fees

    // Sync to sharedState (this is what happens during runtime)
    sharedState.sessionFees = 5.0;
    sharedState.sessionGrossPnl = 10.0;
    sharedState.sessionVolume = 1000.0;
    sharedState.sessionStartBalance = 500;
    sharedState.currentBalance = 505;
    sharedState.sessionPnl = 5.0;

    // Save state (simulating bot stop)
    saveStateSync();

    // Verify state was saved to SQLite
    const db = getDb();
    const row = db.prepare("SELECT session_pnl FROM bot_state WHERE bot_id = '__single__'").get();
    expect(row).toBeDefined();

    // Reset sharedState to simulate bot restart
    sharedState.sessionFees = 0;
    sharedState.sessionGrossPnl = 0;
    sharedState.sessionVolume = 0;
    sharedState.sessionStartBalance = null;
    sharedState.currentBalance = null;
    sharedState.sessionPnl = 0;

    // Load state (simulating bot start)
    loadState();

    // BUG: These assertions will FAIL because sessionFees, sessionGrossPnl,
    // sessionStartBalance, and currentBalance are NOT persisted by StateStore
    expect(sharedState.sessionFees).toBe(5.0);
    expect(sharedState.sessionGrossPnl).toBe(10.0);
    expect(sharedState.sessionVolume).toBe(1000.0);
    expect(sharedState.sessionStartBalance).toBe(500);
    expect(sharedState.currentBalance).toBe(505);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Multi-bot restart - bot #2 stats lost
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug Condition 2 — Multi-bot restart loses bot #2 stats', () => {
  it('should preserve bot #2 stats on restart while bot #1 and #3 unaffected (EXPECTED TO FAIL)', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();

    // Create 3 bot instances
    const bot1State = createBotSharedState('bot-1');
    const bot2State = createBotSharedState('bot-2');
    const bot3State = createBotSharedState('bot-3');

    // Simulate trading activity on all bots
    bot1State.sessionFees = 2.0;
    bot1State.sessionGrossPnl = 5.0;
    bot1State.sessionVolume = 500.0;
    bot1State.sessionStartBalance = 500;
    bot1State.currentBalance = 503;

    bot2State.sessionFees = 3.0;
    bot2State.sessionGrossPnl = 7.0;
    bot2State.sessionVolume = 700.0;
    bot2State.sessionStartBalance = 500;
    bot2State.currentBalance = 504;

    bot3State.sessionFees = 4.0;
    bot3State.sessionGrossPnl = 9.0;
    bot3State.sessionVolume = 900.0;
    bot3State.sessionStartBalance = 500;
    bot3State.currentBalance = 505;

    // Save each bot's state to its own file
    saveStateSync(bot1State);
    saveStateSync(bot2State);
    saveStateSync(bot3State);

    // Simulate bot #2 restart by creating a new state and loading from disk
    const bot2StateAfterRestart = createBotSharedState('bot-2');
    loadState(bot2StateAfterRestart);

    // After restart, bot #2 stats should be restored from persistence
    expect(bot2StateAfterRestart.sessionFees).toBe(3.0);
    expect(bot2StateAfterRestart.sessionGrossPnl).toBe(7.0);
    expect(bot2StateAfterRestart.sessionVolume).toBe(700.0);
    expect(bot2StateAfterRestart.sessionStartBalance).toBe(500);
    expect(bot2StateAfterRestart.currentBalance).toBe(504);

    // Bot #1 and #3 should be unaffected (still have their original values)
    expect(bot1State.sessionFees).toBe(2.0);
    expect(bot3State.sessionFees).toBe(4.0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Balance preservation on restart
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug Condition 3 — Balance preservation on restart', () => {
  it('should preserve sessionStartBalance and currentBalance on restart (EXPECTED TO FAIL)', () => {
    const adapter = makeMockAdapter(512);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Set balances
    (watcher as any).sessionStartBalance = 500;
    sharedState.sessionStartBalance = 500;
    sharedState.currentBalance = 512;

    // Save state
    saveStateSync();

    // Reset state (simulate restart)
    sharedState.sessionStartBalance = null;
    sharedState.currentBalance = null;

    // Load state
    loadState();

    // BUG: These assertions will FAIL because sessionStartBalance and
    // currentBalance are NOT persisted by StateStore
    expect(sharedState.sessionStartBalance).toBe(500);
    expect(sharedState.currentBalance).toBe(512);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: Crash recovery - stats lost
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug Condition 4 — Crash recovery loses session stats', () => {
  it('should preserve session stats after simulated crash (EXPECTED TO FAIL)', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Simulate trading activity
    (watcher as any).sessionFees = 8.5;
    (watcher as any).sessionGrossPnl = 15.0;
    (watcher as any).sessionVolume = 1500.0;
    (watcher as any).sessionStartBalance = 500;

    sharedState.sessionFees = 8.5;
    sharedState.sessionGrossPnl = 15.0;
    sharedState.sessionVolume = 1500.0;
    sharedState.sessionStartBalance = 500;
    sharedState.currentBalance = 506.5;

    // Save state (this would happen periodically during runtime)
    saveStateSync();

    // Simulate crash: abruptly reset all state without proper shutdown
    sharedState.sessionFees = 0;
    sharedState.sessionGrossPnl = 0;
    sharedState.sessionVolume = 0;
    sharedState.sessionStartBalance = null;
    sharedState.currentBalance = null;

    // Simulate restart: load state from disk
    loadState();

    // BUG: After crash recovery, session stats are lost
    // Expected: stats should be restored from last saved state
    expect(sharedState.sessionFees).toBe(8.5);
    expect(sharedState.sessionGrossPnl).toBe(15.0);
    expect(sharedState.sessionVolume).toBe(1500.0);
    expect(sharedState.sessionStartBalance).toBe(500);
    expect(sharedState.currentBalance).toBe(506.5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: Watcher resetSession() should not reset persisted stats on restart
// ─────────────────────────────────────────────────────────────────────────────

describe('Bug Condition 5 — resetSession() unconditionally resets stats', () => {
  it('should restore stats from persistence instead of resetting to 0 on restart (EXPECTED TO FAIL)', () => {
    const adapter = makeMockAdapter(500);
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    // First session: accumulate stats
    const watcher1 = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);
    (watcher1 as any).sessionFees = 5.0;
    (watcher1 as any).sessionGrossPnl = 10.0;
    (watcher1 as any).sessionVolume = 1000.0;
    (watcher1 as any).sessionStartBalance = 500;

    sharedState.sessionFees = 5.0;
    sharedState.sessionGrossPnl = 10.0;
    sharedState.sessionVolume = 1000.0;
    sharedState.sessionStartBalance = 500;
    sharedState.currentBalance = 505;

    // Save state
    saveStateSync();

    // Simulate restart: load state
    loadState();

    // Create new watcher instance (simulating bot restart)
    const watcher2 = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Reset session state machine (but preserve loaded stats)
    (watcher2 as any).resetSession();
    
    // Restore session stats from loaded state into Watcher's in-memory fields
    (watcher2 as any).restoreSessionFromPersistence();

    // After restoreSessionFromPersistence(), Watcher's internal fields should be synced with
    // the restored sharedState values
    expect((watcher2 as any).sessionFees).toBe(5.0);
    expect((watcher2 as any).sessionGrossPnl).toBe(10.0);
    expect((watcher2 as any).sessionVolume).toBe(1000.0);
    expect((watcher2 as any).sessionStartBalance).toBe(500);
  });
});
