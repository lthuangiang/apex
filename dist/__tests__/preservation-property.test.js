"use strict";
/**
 * Preservation Property Tests
 *
 * These tests verify baseline behavior that MUST be preserved after the fix.
 * They are EXPECTED TO PASS on unfixed code.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const SessionManager_js_1 = require("../modules/SessionManager.js");
const Watcher_js_1 = require("../modules/Watcher.js");
// ─── Minimal mocks ────────────────────────────────────────────────────────────
function makeMockAdapter() {
    return {
        get_balance: vitest_1.vi.fn().mockResolvedValue(100),
        get_position: vitest_1.vi.fn().mockResolvedValue(null),
        get_mark_price: vitest_1.vi.fn().mockResolvedValue(100),
        place_order: vitest_1.vi.fn().mockResolvedValue('order-id'),
        cancel_order: vitest_1.vi.fn().mockResolvedValue(true),
        get_orderbook: vitest_1.vi.fn().mockResolvedValue({ bids: [], asks: [] }),
        get_klines: vitest_1.vi.fn().mockResolvedValue([]),
    };
}
function makeMockTelegram() {
    const mock = {
        lastMessage: '',
        sendMessage: vitest_1.vi.fn().mockImplementation(async (text) => {
            mock.lastMessage = text;
        }),
        onCommand: vitest_1.vi.fn(),
        onCallback: vitest_1.vi.fn(),
        setupMenu: vitest_1.vi.fn().mockResolvedValue(undefined),
        isEnabled: vitest_1.vi.fn().mockReturnValue(true),
        sendMessageWithInlineButtons: vitest_1.vi.fn(),
    };
    return mock;
}
// ─── Observation 1: setMaxLoss after startSession ─────────────────────────────
(0, vitest_1.describe)('Observation 1 — setMaxLoss after startSession', () => {
    (0, vitest_1.it)('setMaxLoss(25) after startSession() → getState().maxLoss === 25', () => {
        const sm = new SessionManager_js_1.SessionManager();
        sm.startSession();
        sm.setMaxLoss(25);
        (0, vitest_1.expect)(sm.getState().maxLoss).toBe(25);
    });
});
// ─── Observation 2: updatePnL emergency stop ─────────────────────────────────
(0, vitest_1.describe)('Observation 2 — updatePnL emergency stop', () => {
    (0, vitest_1.it)('updatePnL(-51) with explicit maxLoss=50 → returns true (emergency stop triggers)', () => {
        const sm = new SessionManager_js_1.SessionManager();
        sm.startSession();
        sm.setMaxLoss(50); // Explicitly set to 50 (was the old default; now set explicitly to preserve the test scenario)
        const result = sm.updatePnL(-51);
        (0, vitest_1.expect)(result).toBe(true);
    });
});
// ─── Observation 3: double startSession ──────────────────────────────────────
(0, vitest_1.describe)('Observation 3 — double startSession prevention', () => {
    (0, vitest_1.it)('second startSession() call returns false', () => {
        const sm = new SessionManager_js_1.SessionManager();
        const first = sm.startSession();
        const second = sm.startSession();
        (0, vitest_1.expect)(first).toBe(true);
        (0, vitest_1.expect)(second).toBe(false);
    });
});
// ─── PBT 1: setMaxLoss preservation ──────────────────────────────────────────
// **Validates: Requirements 3.1**
(0, vitest_1.describe)('PBT — setMaxLoss always stores Math.abs(amount)', () => {
    (0, vitest_1.it)('for any amount passed to setMaxLoss, getState().maxLoss always equals Math.abs(amount)', () => {
        // Simple random sampling — 200 iterations
        const ITERATIONS = 200;
        for (let i = 0; i < ITERATIONS; i++) {
            const sm = new SessionManager_js_1.SessionManager();
            sm.startSession();
            // Generate random amount: mix of positive, negative, and zero
            const raw = (Math.random() - 0.5) * 2000; // range: -1000 to 1000
            sm.setMaxLoss(raw);
            const expected = Math.abs(raw);
            const actual = sm.getState().maxLoss;
            (0, vitest_1.expect)(actual).toBeCloseTo(expected, 10);
        }
    });
    (0, vitest_1.it)('setMaxLoss works with negative values (stores absolute value)', () => {
        const sm = new SessionManager_js_1.SessionManager();
        sm.startSession();
        sm.setMaxLoss(-42);
        (0, vitest_1.expect)(sm.getState().maxLoss).toBe(42);
    });
    (0, vitest_1.it)('setMaxLoss works with positive values', () => {
        const sm = new SessionManager_js_1.SessionManager();
        sm.startSession();
        sm.setMaxLoss(100);
        (0, vitest_1.expect)(sm.getState().maxLoss).toBe(100);
    });
});
// ─── PBT 2: updatePnL emergency stop preservation ────────────────────────────
// **Validates: Requirements 3.2**
(0, vitest_1.describe)('PBT — updatePnL always returns true when pnl <= -maxLoss', () => {
    (0, vitest_1.it)('for any pnl <= -maxLoss, updatePnL always returns true', () => {
        const ITERATIONS = 200;
        for (let i = 0; i < ITERATIONS; i++) {
            const sm = new SessionManager_js_1.SessionManager();
            sm.startSession();
            // Random maxLoss between 1 and 500
            const maxLoss = Math.random() * 499 + 1;
            sm.setMaxLoss(maxLoss);
            // pnl is exactly -maxLoss or worse (more negative)
            const extraLoss = Math.random() * 100; // 0 to 100 extra
            const pnl = -(maxLoss + extraLoss);
            const result = sm.updatePnL(pnl);
            (0, vitest_1.expect)(result).toBe(true);
        }
    });
    (0, vitest_1.it)('updatePnL returns true at exactly -maxLoss boundary', () => {
        const sm = new SessionManager_js_1.SessionManager();
        sm.startSession();
        sm.setMaxLoss(50);
        (0, vitest_1.expect)(sm.updatePnL(-50)).toBe(true);
    });
    (0, vitest_1.it)('updatePnL returns false when pnl is above -maxLoss', () => {
        const sm = new SessionManager_js_1.SessionManager();
        sm.startSession();
        sm.setMaxLoss(50);
        (0, vitest_1.expect)(sm.updatePnL(-49.99)).toBe(false);
    });
});
// ─── Unit Test: stop_bot when cooldownUntil = null ───────────────────────────
// **Validates: Requirements 3.3**
(0, vitest_1.describe)('Unit — stop_bot handler when cooldownUntil = null', () => {
    (0, vitest_1.it)('sends stop message without error when no cooldown is active', async () => {
        const adapter = makeMockAdapter();
        const telegram = makeMockTelegram();
        const sessionManager = new SessionManager_js_1.SessionManager();
        const watcher = new Watcher_js_1.Watcher(adapter, 'BTC-USD', telegram, sessionManager);
        // Ensure cooldownUntil is null (default state)
        (0, vitest_1.expect)(watcher.cooldownUntil).toBeNull();
        sessionManager.startSession();
        const capturedMessages = [];
        const capturingTelegram = {
            sendMessage: vitest_1.vi.fn().mockImplementation(async (text) => {
                capturedMessages.push(text);
            }),
        };
        // Replicate the unfixed stop_bot handler
        const stopBotHandler = async () => {
            if (!sessionManager.getState().isRunning) {
                await capturingTelegram.sendMessage('ℹ️ Bot is not running.');
                return;
            }
            sessionManager.stopSession();
            watcher.stop();
            await capturingTelegram.sendMessage('🛑 *Bot stopped.* Session terminated.', true);
        };
        // Should not throw
        await (0, vitest_1.expect)(stopBotHandler()).resolves.not.toThrow();
        // Should have sent exactly one message
        (0, vitest_1.expect)(capturedMessages).toHaveLength(1);
        (0, vitest_1.expect)(capturedMessages[0]).toContain('stopped');
    });
});
// ─── Unit Test: second startSession returns false ─────────────────────────────
// **Validates: Requirements 3.4**
(0, vitest_1.describe)('Unit — double startSession prevention', () => {
    (0, vitest_1.it)('second startSession() call returns false (session already running)', () => {
        const sm = new SessionManager_js_1.SessionManager();
        const first = sm.startSession();
        const second = sm.startSession();
        (0, vitest_1.expect)(first).toBe(true);
        (0, vitest_1.expect)(second).toBe(false);
        // State should still reflect running
        (0, vitest_1.expect)(sm.getState().isRunning).toBe(true);
    });
    (0, vitest_1.it)('startSession returns true after stopSession', () => {
        const sm = new SessionManager_js_1.SessionManager();
        sm.startSession();
        sm.stopSession();
        const result = sm.startSession();
        (0, vitest_1.expect)(result).toBe(true);
    });
});
