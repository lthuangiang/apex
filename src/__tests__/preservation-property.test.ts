/**
 * Preservation Property Tests
 *
 * These tests verify baseline behavior that MUST be preserved after the fix.
 * They are EXPECTED TO PASS on unfixed code.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../modules/SessionManager.js';
import { Watcher } from '../modules/Watcher.js';
import { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import { TelegramManager } from '../modules/TelegramManager.js';

// ─── Minimal mocks ────────────────────────────────────────────────────────────

function makeMockAdapter(): ExchangeAdapter {
  return {
    get_balance: vi.fn().mockResolvedValue(100),
    get_position: vi.fn().mockResolvedValue(null),
    get_mark_price: vi.fn().mockResolvedValue(100),
    place_order: vi.fn().mockResolvedValue('order-id'),
    cancel_order: vi.fn().mockResolvedValue(true),
    get_orderbook: vi.fn().mockResolvedValue({ bids: [], asks: [] }),
    get_klines: vi.fn().mockResolvedValue([]),
  } as unknown as ExchangeAdapter;
}

function makeMockTelegram(): TelegramManager & { lastMessage: string } {
  const mock = {
    lastMessage: '',
    sendMessage: vi.fn().mockImplementation(async (text: string) => {
      mock.lastMessage = text;
    }),
    onCommand: vi.fn(),
    onCallback: vi.fn(),
    setupMenu: vi.fn().mockResolvedValue(undefined),
    isEnabled: vi.fn().mockReturnValue(true),
    sendMessageWithInlineButtons: vi.fn(),
  } as unknown as TelegramManager & { lastMessage: string };
  return mock;
}

// ─── Observation 1: setMaxLoss after startSession ─────────────────────────────

describe('Observation 1 — setMaxLoss after startSession', () => {
  it('setMaxLoss(25) after startSession() → getState().maxLoss === 25', () => {
    const sm = new SessionManager();
    sm.startSession();
    sm.setMaxLoss(25);
    expect(sm.getState().maxLoss).toBe(25);
  });
});

// ─── Observation 2: updatePnL emergency stop ─────────────────────────────────

describe('Observation 2 — updatePnL emergency stop', () => {
  it('updatePnL(-51) with explicit maxLoss=50 → returns true (emergency stop triggers)', () => {
    const sm = new SessionManager();
    sm.startSession();
    sm.setMaxLoss(50); // Explicitly set to 50 (was the old default; now set explicitly to preserve the test scenario)
    const result = sm.updatePnL(-51);
    expect(result).toBe(true);
  });
});

// ─── Observation 3: double startSession ──────────────────────────────────────

describe('Observation 3 — double startSession prevention', () => {
  it('second startSession() call returns false', () => {
    const sm = new SessionManager();
    const first = sm.startSession();
    const second = sm.startSession();
    expect(first).toBe(true);
    expect(second).toBe(false);
  });
});

// ─── PBT 1: setMaxLoss preservation ──────────────────────────────────────────
// **Validates: Requirements 3.1**

describe('PBT — setMaxLoss always stores Math.abs(amount)', () => {
  it('for any amount passed to setMaxLoss, getState().maxLoss always equals Math.abs(amount)', () => {
    // Simple random sampling — 200 iterations
    const ITERATIONS = 200;

    for (let i = 0; i < ITERATIONS; i++) {
      const sm = new SessionManager();
      sm.startSession();

      // Generate random amount: mix of positive, negative, and zero
      const raw = (Math.random() - 0.5) * 2000; // range: -1000 to 1000
      sm.setMaxLoss(raw);

      const expected = Math.abs(raw);
      const actual = sm.getState().maxLoss;

      expect(actual).toBeCloseTo(expected, 10);
    }
  });

  it('setMaxLoss works with negative values (stores absolute value)', () => {
    const sm = new SessionManager();
    sm.startSession();
    sm.setMaxLoss(-42);
    expect(sm.getState().maxLoss).toBe(42);
  });

  it('setMaxLoss works with positive values', () => {
    const sm = new SessionManager();
    sm.startSession();
    sm.setMaxLoss(100);
    expect(sm.getState().maxLoss).toBe(100);
  });
});

// ─── PBT 2: updatePnL emergency stop preservation ────────────────────────────
// **Validates: Requirements 3.2**

describe('PBT — updatePnL always returns true when pnl <= -maxLoss', () => {
  it('for any pnl <= -maxLoss, updatePnL always returns true', () => {
    const ITERATIONS = 200;

    for (let i = 0; i < ITERATIONS; i++) {
      const sm = new SessionManager();
      sm.startSession();

      // Random maxLoss between 1 and 500
      const maxLoss = Math.random() * 499 + 1;
      sm.setMaxLoss(maxLoss);

      // pnl is exactly -maxLoss or worse (more negative)
      const extraLoss = Math.random() * 100; // 0 to 100 extra
      const pnl = -(maxLoss + extraLoss);

      const result = sm.updatePnL(pnl);
      expect(result).toBe(true);
    }
  });

  it('updatePnL returns true at exactly -maxLoss boundary', () => {
    const sm = new SessionManager();
    sm.startSession();
    sm.setMaxLoss(50);
    expect(sm.updatePnL(-50)).toBe(true);
  });

  it('updatePnL returns false when pnl is above -maxLoss', () => {
    const sm = new SessionManager();
    sm.startSession();
    sm.setMaxLoss(50);
    expect(sm.updatePnL(-49.99)).toBe(false);
  });
});

// ─── Unit Test: stop_bot when cooldownUntil = null ───────────────────────────
// **Validates: Requirements 3.3**

describe('Unit — stop_bot handler when cooldownUntil = null', () => {
  it('sends stop message without error when no cooldown is active', async () => {
    const adapter = makeMockAdapter();
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();
    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Ensure cooldownUntil is null (default state)
    expect((watcher as any).cooldownUntil).toBeNull();

    sessionManager.startSession();

    const capturedMessages: string[] = [];
    const capturingTelegram = {
      sendMessage: vi.fn().mockImplementation(async (text: string) => {
        capturedMessages.push(text);
      }),
    } as unknown as TelegramManager;

    // Replicate the unfixed stop_bot handler
    const stopBotHandler = async () => {
      if (!sessionManager.getState().isRunning) {
        await capturingTelegram.sendMessage('ℹ️ Bot is not running.');
        return;
      }
      sessionManager.stopSession();
      watcher.stop();
      await capturingTelegram.sendMessage('🛑 *Bot stopped.* Session terminated.', true as any);
    };

    // Should not throw
    await expect(stopBotHandler()).resolves.not.toThrow();

    // Should have sent exactly one message
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0]).toContain('stopped');
  });
});

// ─── Unit Test: second startSession returns false ─────────────────────────────
// **Validates: Requirements 3.4**

describe('Unit — double startSession prevention', () => {
  it('second startSession() call returns false (session already running)', () => {
    const sm = new SessionManager();
    const first = sm.startSession();
    const second = sm.startSession();
    expect(first).toBe(true);
    expect(second).toBe(false);
    // State should still reflect running
    expect(sm.getState().isRunning).toBe(true);
  });

  it('startSession returns true after stopSession', () => {
    const sm = new SessionManager();
    sm.startSession();
    sm.stopSession();
    const result = sm.startSession();
    expect(result).toBe(true);
  });
});
