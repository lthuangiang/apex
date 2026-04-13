"use strict";
// Feature: ai-alpha-execution-engine
// Property 6: Telegram reasoning is always truncated to ≤ 200 characters
// Property 7: Fallback signals are always labeled in Telegram notifications
// **Validates: Requirements 5.1, 5.2, 5.3**
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fc = __importStar(require("fast-check"));
const Executor_js_1 = require("../modules/Executor.js");
function makeMockAdapter() {
    return {
        get_orderbook: vitest_1.vi.fn().mockResolvedValue({ best_bid: 49999, best_ask: 50001 }),
        get_orderbook_depth: vitest_1.vi.fn(),
        get_recent_trades: vitest_1.vi.fn(),
        get_mark_price: vitest_1.vi.fn(),
        place_limit_order: vitest_1.vi.fn(),
        cancel_order: vitest_1.vi.fn(),
        cancel_all_orders: vitest_1.vi.fn(),
        get_open_orders: vitest_1.vi.fn(),
        get_position: vitest_1.vi.fn(),
        get_balance: vitest_1.vi.fn(),
    };
}
function makeMockTelegram() {
    const capturedMessages = [];
    const telegram = {
        sendMessage: vitest_1.vi.fn().mockImplementation((msg) => {
            capturedMessages.push(msg);
            return Promise.resolve();
        }),
    };
    return { telegram, capturedMessages };
}
const BASE_META = {
    baseScore: 0.7,
    bias: 0.1,
    regime: 'TREND_UP',
    finalScore: 0.8,
    sessionPnl: 10.5,
    sessionVolume: 500,
};
(0, vitest_1.describe)('Executor reasoning notifications', () => {
    let adapter;
    (0, vitest_1.beforeEach)(() => {
        adapter = makeMockAdapter();
    });
    // **Validates: Requirements 5.1, 5.2**
    // Property 6: Telegram reasoning is always truncated to ≤ 200 characters
    (0, vitest_1.it)('P6: notifyEntryFilled reasoning snippet is always ≤ 200 chars', async () => {
        await fc.assert(fc.asyncProperty(fc.string({ minLength: 0, maxLength: 1000 }), async (reasoning) => {
            const { telegram, capturedMessages } = makeMockTelegram();
            const executor = new Executor_js_1.Executor(adapter, telegram);
            await executor.notifyEntryFilled('BTC-USD', 'long', 0.001, 50000, {
                ...BASE_META,
                reasoning,
                fallback: false,
            });
            (0, vitest_1.expect)(capturedMessages).toHaveLength(1);
            const msg = capturedMessages[0];
            // Extract the reasoning snippet from the message
            const match = msg.match(/💬 \*Reasoning:\* `([^`]*)`/);
            (0, vitest_1.expect)(match).not.toBeNull();
            const snippet = match[1];
            (0, vitest_1.expect)(snippet.length).toBeLessThanOrEqual(200);
        }), { numRuns: 50 });
    });
    // **Validates: Requirements 5.1, 5.2**
    // Property 6 (exit): notifyExitFilled reasoning snippet is always ≤ 200 chars
    (0, vitest_1.it)('P6: notifyExitFilled reasoning snippet is always ≤ 200 chars', async () => {
        await fc.assert(fc.asyncProperty(fc.string({ minLength: 0, maxLength: 1000 }), async (reasoning) => {
            const { telegram, capturedMessages } = makeMockTelegram();
            const executor = new Executor_js_1.Executor(adapter, telegram);
            await executor.notifyExitFilled('BTC-USD', 'long', 0.001, 51000, 1.5, {
                sessionPnl: 11.5,
                sessionVolume: 550,
                reasoning,
                fallback: false,
            });
            (0, vitest_1.expect)(capturedMessages).toHaveLength(1);
            const msg = capturedMessages[0];
            const match = msg.match(/💬 \*Reasoning:\* `([^`]*)`/);
            (0, vitest_1.expect)(match).not.toBeNull();
            const snippet = match[1];
            (0, vitest_1.expect)(snippet.length).toBeLessThanOrEqual(200);
        }), { numRuns: 50 });
    });
    // **Validates: Requirements 5.3**
    // Property 7: Fallback signals are always labeled in Telegram notifications
    (0, vitest_1.it)('P7: notifyEntryFilled with fallback:true always contains [Fallback Mode] and no raw reasoning', async () => {
        await fc.assert(fc.asyncProperty(fc.record({
            reasoning: fc.string({ minLength: 1, maxLength: 500 }),
            baseScore: fc.float({ min: -1, max: 1 }),
            bias: fc.float({ min: -0.5, max: 0.5 }),
            regime: fc.constantFrom('TREND_UP', 'TREND_DOWN', 'SIDEWAY'),
            finalScore: fc.float({ min: -1, max: 1 }),
        }), async ({ reasoning, baseScore, bias, regime, finalScore }) => {
            const { telegram, capturedMessages } = makeMockTelegram();
            const executor = new Executor_js_1.Executor(adapter, telegram);
            await executor.notifyEntryFilled('BTC-USD', 'long', 0.001, 50000, {
                baseScore,
                bias,
                regime,
                finalScore,
                sessionPnl: 0,
                sessionVolume: 0,
                reasoning,
                fallback: true,
            });
            (0, vitest_1.expect)(capturedMessages).toHaveLength(1);
            const msg = capturedMessages[0];
            // Must contain fallback label
            (0, vitest_1.expect)(msg).toContain('[Fallback Mode]');
            // Must NOT contain the reasoning line
            (0, vitest_1.expect)(msg).not.toContain('💬 *Reasoning:*');
        }), { numRuns: 50 });
    });
    // **Validates: Requirements 5.3**
    // Property 7 (exit): notifyExitFilled with fallback:true always contains [Fallback Mode] and no raw reasoning
    (0, vitest_1.it)('P7: notifyExitFilled with fallback:true always contains [Fallback Mode] and no raw reasoning', async () => {
        await fc.assert(fc.asyncProperty(fc.record({
            reasoning: fc.string({ minLength: 1, maxLength: 500 }),
            pnl: fc.float({ min: -100, max: 100 }),
        }), async ({ reasoning, pnl }) => {
            const { telegram, capturedMessages } = makeMockTelegram();
            const executor = new Executor_js_1.Executor(adapter, telegram);
            await executor.notifyExitFilled('BTC-USD', 'short', 0.001, 49000, pnl, {
                sessionPnl: 5,
                sessionVolume: 200,
                reasoning,
                fallback: true,
            });
            (0, vitest_1.expect)(capturedMessages).toHaveLength(1);
            const msg = capturedMessages[0];
            // Must contain fallback label
            (0, vitest_1.expect)(msg).toContain('[Fallback Mode]');
            // Must NOT contain the reasoning line
            (0, vitest_1.expect)(msg).not.toContain('💬 *Reasoning:*');
        }), { numRuns: 50 });
    });
});
