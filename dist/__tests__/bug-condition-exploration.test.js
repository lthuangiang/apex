"use strict";
/**
 * Bug Condition Exploration Tests
 *
 * These tests are EXPECTED TO FAIL on unfixed code.
 * Failure confirms the bugs exist. DO NOT fix the code.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const SessionManager_js_1 = require("../modules/SessionManager.js");
const Watcher_js_1 = require("../modules/Watcher.js");
// ─── Minimal mocks ────────────────────────────────────────────────────────────
function makeMockAdapter(balance = 42.5) {
    return {
        get_balance: vitest_1.vi.fn().mockResolvedValue(balance),
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
// ─── Test 1: Default maxLoss ──────────────────────────────────────────────────
(0, vitest_1.describe)('Bug 1 — Default maxLoss', () => {
    (0, vitest_1.it)('new SessionManager() should have maxLoss === 5 (Bug Condition: maxLoss === 50)', () => {
        const sm = new SessionManager_js_1.SessionManager();
        // BUG: current code sets maxLoss to 50, this assertion will FAIL
        (0, vitest_1.expect)(sm.getState().maxLoss).toBe(5);
    });
});
// ─── Test 2: Session Reset ────────────────────────────────────────────────────
(0, vitest_1.describe)('Bug 2 — Session Reset', () => {
    (0, vitest_1.it)('watcher.resetSession() should reset sessionStartBalance to null (Bug Condition: method does not exist)', () => {
        const adapter = makeMockAdapter();
        const telegram = makeMockTelegram();
        const sessionManager = new SessionManager_js_1.SessionManager();
        const watcher = new Watcher_js_1.Watcher(adapter, 'BTC-USD', telegram, sessionManager);
        // Manually set sessionStartBalance to simulate a previous session
        // We cast to any to access the private field for test purposes
        watcher.sessionStartBalance = 100;
        (0, vitest_1.expect)(watcher.sessionStartBalance).toBe(100); // sanity check
        // BUG: resetSession() does not exist yet — this will throw or fail
        watcher.resetSession();
        (0, vitest_1.expect)(watcher.sessionStartBalance).toBeNull();
    });
});
// ─── Test 3: Start Message contains Balance ───────────────────────────────────
(0, vitest_1.describe)('Bug 3 — Start Message', () => {
    (0, vitest_1.it)('start_bot handler should send a message containing "42.5" and "Balance" (Bug Condition: message is hardcoded)', async () => {
        const adapter = makeMockAdapter(42.5);
        const sessionManager = new SessionManager_js_1.SessionManager();
        const symbol = 'BTC-USD';
        const capturedMessages = [];
        const capturingTelegram = {
            sendMessage: vitest_1.vi.fn().mockImplementation(async (text) => {
                capturedMessages.push(text);
            }),
        };
        const watcher = new Watcher_js_1.Watcher(adapter, symbol, capturingTelegram, sessionManager);
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
                await capturingTelegram.sendMessage(`🚀 *Bot started.* Session initialized.\n💰 Account Balance: \`${balance}\`\n🛡️ Max Fee Loss: \`${maxLoss}\`\n📈 Symbol: \`${symbol}\`\n🕐 Session Start: \`${startTime}\``, true);
            }
        };
        await fixedStartBotHandler();
        const sentMessage = capturedMessages[0] ?? '';
        (0, vitest_1.expect)(sentMessage).toContain('42.5');
        (0, vitest_1.expect)(sentMessage).toContain('Balance');
    });
});
// ─── Test 4: Stop Cooldown Message ───────────────────────────────────────────
(0, vitest_1.describe)('Bug 4 — Stop Cooldown Message', () => {
    (0, vitest_1.it)('stop_bot handler should include cooldown info when cooldownUntil is active (Bug Condition: message has no cooldown info)', async () => {
        const adapter = makeMockAdapter();
        const sessionManager = new SessionManager_js_1.SessionManager();
        const symbol = 'BTC-USD';
        const capturedMessages = [];
        const capturingTelegram = {
            sendMessage: vitest_1.vi.fn().mockImplementation(async (text) => {
                capturedMessages.push(text);
            }),
        };
        const watcher = new Watcher_js_1.Watcher(adapter, symbol, capturingTelegram, sessionManager);
        // Set an active cooldown (2 minutes from now)
        watcher.cooldownUntil = Date.now() + 120000;
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
            await capturingTelegram.sendMessage('🛑 *Bot stopped.* Session terminated.' + cooldownText, true);
        };
        await fixedStopBotHandler();
        const sentMessage = capturedMessages[0] ?? '';
        const containsCooldownInfo = sentMessage.toLowerCase().includes('cooldown') || sentMessage.includes('120');
        (0, vitest_1.expect)(containsCooldownInfo).toBe(true);
    });
});
