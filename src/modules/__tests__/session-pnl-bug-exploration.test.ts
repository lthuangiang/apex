/**
 * Bug Condition Exploration Test - Session PnL Calculation
 * 
 * Property 1: Bug Condition - Session PnL Excludes Unrealized PnL
 * 
 * CRITICAL: This test MUST FAIL on unfixed code - failure confirms the bug exists.
 * 
 * Bug Condition: Session PnL is calculated using balance difference (balance - sessionStartBalance)
 * which includes unrealized PnL fluctuations from open positions.
 * 
 * Expected Behavior: Session PnL should remain unchanged when positions are opened and held,
 * and should only change when trades are closed (realized PnL accumulated).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Watcher } from '../Watcher.js';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter.js';
import { TelegramManager } from '../TelegramManager.js';
import { SessionManager } from '../SessionManager.js';

// Mock adapter that simulates balance changes with unrealized PnL
function makeMockAdapter(): ExchangeAdapter {
  let mockBalance = 100; // Starting balance
  let mockPosition: any = null;
  
  return {
    get_balance: vi.fn(async () => mockBalance),
    get_mark_price: vi.fn(async () => 50000),
    get_position: vi.fn(async () => mockPosition),
    get_open_orders: vi.fn(async () => []),
    cancel_all_orders: vi.fn(async () => {}),
    place_order: vi.fn(async () => ({ orderId: 'test-order', price: 50000, size: 0.001 })),
    
    // Helper methods to simulate balance/position changes
    _setBalance: (balance: number) => { mockBalance = balance; },
    _setPosition: (position: any) => { mockPosition = position; },
  } as any;
}

function makeMockTelegram(): TelegramManager {
  return {
    sendMessage: vi.fn(async () => {}),
  } as any;
}

describe('Property 1: Bug Condition - Session PnL Excludes Unrealized PnL', () => {
  let adapter: ExchangeAdapter & { _setBalance: (b: number) => void; _setPosition: (p: any) => void };
  let telegram: TelegramManager;
  let sessionManager: SessionManager;
  let watcher: Watcher;

  beforeEach(() => {
    adapter = makeMockAdapter();
    telegram = makeMockTelegram();
    sessionManager = new SessionManager();
    watcher = new Watcher(adapter, 'BTC-PERP', telegram, sessionManager);
  });

  it('EXPLORATION: Session PnL should NOT fluctuate with unrealized PnL changes (EXPECTED TO FAIL on unfixed code)', async () => {
    // Arrange: Start session with balance = $100, no open positions
    sessionManager.startSession();
    (watcher as any).resetSession();
    
    // Initial tick: balance = $100, no position
    adapter._setBalance(100);
    adapter._setPosition(null);
    
    // Simulate first tick to initialize sessionStartBalance
    await (watcher as any)._tick();
    
    // Verify initial state
    const initialSessionPnl = (watcher as any).sessionCurrentPnl;
    expect(initialSessionPnl).toBe(0); // Session PnL should start at 0
    
    // Act 1: Open a position with unrealized PnL = +$5
    // Balance now includes unrealized PnL: $100 + $5 = $105
    adapter._setBalance(105);
    adapter._setPosition({
      size: 0.001,
      side: 'long',
      entryPrice: 50000,
      unrealizedPnl: 5,
    });
    
    // Simulate tick with open position
    await (watcher as any)._tick();
    
    // Assert 1: Session PnL should remain 0 (not include unrealized PnL)
    // BUG: On unfixed code, sessionCurrentPnl = 105 - 100 = 5 (WRONG)
    const sessionPnlAfterOpen = (watcher as any).sessionCurrentPnl;
    expect(sessionPnlAfterOpen).toBe(0); // EXPECTED TO FAIL: unfixed code will show +$5
    
    // Act 2: Unrealized PnL drops to +$2
    // Balance changes: $100 + $2 = $102
    adapter._setBalance(102);
    adapter._setPosition({
      size: 0.001,
      side: 'long',
      entryPrice: 50000,
      unrealizedPnl: 2,
    });
    
    // Simulate tick with changed unrealized PnL
    await (watcher as any)._tick();
    
    // Assert 2: Session PnL should still remain 0 (not fluctuate with mark price)
    // BUG: On unfixed code, sessionCurrentPnl = 102 - 100 = 2 (WRONG)
    const sessionPnlAfterFluctuation = (watcher as any).sessionCurrentPnl;
    expect(sessionPnlAfterFluctuation).toBe(0); // EXPECTED TO FAIL: unfixed code will show +$2
    
    // Counterexample documented:
    // - Session starts with balance = $100
    // - Position opened → unrealized PnL = +$5 → balance = $105 → session PnL = +$5 (WRONG)
    // - Unrealized PnL drops to +$2 → balance = $102 → session PnL = +$2 (WRONG)
    // - Session PnL fluctuates with mark price changes instead of remaining 0
  });

  it('EXPLORATION: Session PnL should only change when trades are closed (EXPECTED TO FAIL on unfixed code)', async () => {
    // Arrange: Start session
    sessionManager.startSession();
    (watcher as any).resetSession();
    
    adapter._setBalance(100);
    adapter._setPosition(null);
    await (watcher as any)._tick();
    
    // Act 1: Open position with unrealized PnL
    adapter._setBalance(105);
    adapter._setPosition({
      size: 0.001,
      side: 'long',
      entryPrice: 50000,
      unrealizedPnl: 5,
    });
    await (watcher as any)._tick();
    
    // Session PnL should be 0 (position not closed yet)
    expect((watcher as any).sessionCurrentPnl).toBe(0); // EXPECTED TO FAIL on unfixed code
    
    // Act 2: Simulate trade close through _onExitFilled()
    // Set up pendingExit state to simulate exit order filled
    (watcher as any).pendingExit = {
      order: { orderId: 'exit-1', price: 49990, size: 0.001 },
      positionSide: 'long',
      pnl: -1, // Realized PnL = -$1
      forceClose: false,
      placedAt: Date.now(),
    };
    
    // Set position to null to simulate fill
    adapter._setPosition(null);
    adapter._setBalance(99); // Balance after close: $100 - $1 = $99
    
    // Call _onExitFilled() directly to accumulate realized PnL
    await (watcher as any)._onExitFilled();
    
    // Assert: Session PnL should now be -$1 (realized PnL from closed trade)
    const sessionPnlAfterClose = (watcher as any).sessionCurrentPnl;
    
    // The key insight: session PnL should have been 0 throughout the hold period,
    // then jumped to -1 only when the trade closed via _onExitFilled().
    expect(sessionPnlAfterClose).toBe(-1);
  });

  it('EXPLORATION: Multi-bot environment - session PnL should be isolated per bot (EXPECTED TO FAIL on unfixed code)', async () => {
    // This test simulates the critical multi-bot scenario where two bots share the same exchange account
    
    // Arrange: Bot 1 starts session
    sessionManager.startSession();
    (watcher as any).resetSession();
    
    adapter._setBalance(100);
    adapter._setPosition(null);
    await (watcher as any)._tick();
    
    // Act: Bot 2 (on same exchange) opens a position with unrealized PnL = +$10
    // This changes the SHARED account balance that adapter.get_balance() returns
    adapter._setBalance(110); // Account balance now includes Bot 2's unrealized PnL
    adapter._setPosition(null); // Bot 1 has no position
    
    await (watcher as any)._tick();
    
    // Assert: Bot 1's session PnL should remain 0 (not affected by Bot 2's trades)
    // BUG: On unfixed code, Bot 1's sessionCurrentPnl = 110 - 100 = +$10 (WRONG - includes Bot 2's PnL)
    const bot1SessionPnl = (watcher as any).sessionCurrentPnl;
    expect(bot1SessionPnl).toBe(0); // EXPECTED TO FAIL: unfixed code will show +$10
    
    // Counterexample documented:
    // - Bot 1 starts with balance = $100
    // - Bot 2 opens position → account balance = $110 (includes Bot 2's unrealized PnL)
    // - Bot 1's session PnL = $110 - $100 = +$10 (WRONG - Bot 1 didn't trade!)
    // - Session PnL is NOT isolated per bot in multi-bot environments
  });
});
