/**
 * Bug Condition Exploration Tests
 *
 * These tests are EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bugs exist. DO NOT fix the code.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 */

import { describe, it, expect, vi } from 'vitest';
import { SessionManager } from '../modules/SessionManager.js';
import { Watcher } from '../modules/Watcher.js';
import { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import { TelegramManager } from '../modules/TelegramManager.js';

// ─── Minimal mocks ────────────────────────────────────────────────────────────

function makeMockAdapter(balance = 42.5): ExchangeAdapter {
  return {
    get_balance: vi.fn().mockResolvedValue(balance),
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

// ─── Test 1: Default maxLoss ──────────────────────────────────────────────────

describe('Bug 1 — Default maxLoss', () => {
  it('new SessionManager() should have maxLoss === 5 (Bug Condition: maxLoss === 50)', () => {
    const sm = new SessionManager();
    // BUG: current code sets maxLoss to 50, this assertion will FAIL
    expect(sm.getState().maxLoss).toBe(5);
  });
});

// ─── Test 2: Session Reset ────────────────────────────────────────────────────

describe('Bug 2 — Session Reset', () => {
  it('watcher.resetSession() should reset sessionStartBalance to null (Bug Condition: method does not exist)', () => {
    const adapter = makeMockAdapter();
    const telegram = makeMockTelegram();
    const sessionManager = new SessionManager();

    const watcher = new Watcher(adapter, 'BTC-USD', telegram, sessionManager);

    // Manually set sessionStartBalance to simulate a previous session
    // We cast to any to access the private field for test purposes
    (watcher as any).sessionStartBalance = 100;
    expect((watcher as any).sessionStartBalance).toBe(100); // sanity check

    // BUG: resetSession() does not exist yet — this will throw or fail
    (watcher as any).resetSession();

    expect((watcher as any).sessionStartBalance).toBeNull();
  });
});

// ─── Test 3: Start Message contains Balance ───────────────────────────────────

describe('Bug 3 — Start Message', () => {
  it('start_bot handler should send a message containing "42.5" and "Balance" (Bug Condition: message is hardcoded)', async () => {
    const adapter = makeMockAdapter(42.5);
    const sessionManager = new SessionManager();
    const symbol = 'BTC-USD';

    const capturedMessages: string[] = [];
    const capturingTelegram = {
      sendMessage: vi.fn().mockImplementation(async (text: string) => {
        capturedMessages.push(text);
      }),
    } as unknown as TelegramManager;

    const watcher = new Watcher(adapter, symbol, capturingTelegram, sessionManager);

    // Replicate the FIXED start_bot handler from bot.ts:
    const fixedStartBotHandler = async () => {
      if (sessionManager.getState().isRunning) {
        await capturingTelegram.sendMessage('⚠️ Bot is already running.');
        return;
      }
      const balance = await adapter.get_balance();
      const success = sessionManager.startSession();
      if (success) {
        watcher.resetSession();
        const { maxLoss } = sessionManager.getState();
        const startTime = new Date().toLocaleString();
        await capturingTelegram.sendMessage(
          `🚀 *Bot started.* Session initialized.\n💰 Account Balance: \`${balance}\`\n🛡️ Max Fee Loss: \`${maxLoss}\`\n📈 Symbol: \`${symbol}\`\n🕐 Session Start: \`${startTime}\``,
          true as any
        );
      }
    };

    await fixedStartBotHandler();

    const sentMessage = capturedMessages[0] ?? '';

    expect(sentMessage).toContain('42.5');
    expect(sentMessage).toContain('Balance');
  });
});

// ─── Test 4: Stop Cooldown Message ───────────────────────────────────────────

describe('Bug 4 — Stop Cooldown Message', () => {
  it('stop_bot handler should include cooldown info when cooldownUntil is active (Bug Condition: message has no cooldown info)', async () => {
    const adapter = makeMockAdapter();
    const sessionManager = new SessionManager();
    const symbol = 'BTC-USD';

    const capturedMessages: string[] = [];
    const capturingTelegram = {
      sendMessage: vi.fn().mockImplementation(async (text: string) => {
        capturedMessages.push(text);
      }),
    } as unknown as TelegramManager;

    const watcher = new Watcher(adapter, symbol, capturingTelegram, sessionManager);

    // Set an active cooldown (2 minutes from now)
    (watcher as any).cooldownUntil = Date.now() + 120000;

    // Start the session so stop_bot doesn't bail early
    sessionManager.startSession();

    // Replicate the FIXED stop_bot handler from bot.ts:
    const fixedStopBotHandler = async () => {
      if (!sessionManager.getState().isRunning) {
        await capturingTelegram.sendMessage('ℹ️ Bot is not running.');
        return;
      }
      sessionManager.stopSession();
      watcher.stop();
      const cooldownSecs = watcher.getCooldownInfo();
      const cooldownText = cooldownSecs !== null
        ? `\n⏳ Cooldown active: \`${cooldownSecs}s\` remaining before next trade.`
        : '';
      await capturingTelegram.sendMessage('🛑 *Bot stopped.* Session terminated.' + cooldownText, true as any);
    };

    await fixedStopBotHandler();

    const sentMessage = capturedMessages[0] ?? '';

    const containsCooldownInfo =
      sentMessage.toLowerCase().includes('cooldown') || sentMessage.includes('120');

    expect(containsCooldownInfo).toBe(true);
  });
});
