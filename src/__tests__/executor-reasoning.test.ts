// Feature: ai-alpha-execution-engine
// Property 6: Telegram reasoning is always truncated to ≤ 200 characters
// Property 7: Fallback signals are always labeled in Telegram notifications
// **Validates: Requirements 5.1, 5.2, 5.3**

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';
import { Executor } from '../modules/Executor.js';
import type { ExchangeAdapter } from '../adapters/ExchangeAdapter.js';
import type { TelegramManager } from '../modules/TelegramManager.js';

function makeMockAdapter(): ExchangeAdapter {
    return {
        get_orderbook: vi.fn().mockResolvedValue({ best_bid: 49999, best_ask: 50001 }),
        get_orderbook_depth: vi.fn(),
        get_recent_trades: vi.fn(),
        get_mark_price: vi.fn(),
        place_limit_order: vi.fn(),
        cancel_order: vi.fn(),
        cancel_all_orders: vi.fn(),
        get_open_orders: vi.fn(),
        get_position: vi.fn(),
        get_balance: vi.fn(),
    } as unknown as ExchangeAdapter;
}

function makeMockTelegram(): { telegram: TelegramManager; capturedMessages: string[] } {
    const capturedMessages: string[] = [];
    const telegram = {
        sendMessage: vi.fn().mockImplementation((msg: string) => {
            capturedMessages.push(msg);
            return Promise.resolve();
        }),
    } as unknown as TelegramManager;
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

describe('Executor reasoning notifications', () => {
    let adapter: ExchangeAdapter;

    beforeEach(() => {
        adapter = makeMockAdapter();
    });

    // **Validates: Requirements 5.1, 5.2**
    // Property 6: Telegram reasoning is always truncated to ≤ 200 characters
    it('P6: notifyEntryFilled reasoning snippet is always ≤ 200 chars', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 0, maxLength: 1000 }),
                async (reasoning) => {
                    const { telegram, capturedMessages } = makeMockTelegram();
                    const executor = new Executor(adapter, telegram);

                    await executor.notifyEntryFilled('BTC-USD', 'long', 0.001, 50000, {
                        ...BASE_META,
                        reasoning,
                        fallback: false,
                    });

                    expect(capturedMessages).toHaveLength(1);
                    const msg = capturedMessages[0];

                    // Extract the reasoning snippet from the message
                    const match = msg.match(/💬 \*Reasoning:\* `([^`]*)`/);
                    expect(match).not.toBeNull();
                    const snippet = match![1];
                    expect(snippet.length).toBeLessThanOrEqual(200);
                }
            ),
            { numRuns: 50 }
        );
    });

    // **Validates: Requirements 5.1, 5.2**
    // Property 6 (exit): notifyExitFilled reasoning snippet is always ≤ 200 chars
    it('P6: notifyExitFilled reasoning snippet is always ≤ 200 chars', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.string({ minLength: 0, maxLength: 1000 }),
                async (reasoning) => {
                    const { telegram, capturedMessages } = makeMockTelegram();
                    const executor = new Executor(adapter, telegram);

                    await executor.notifyExitFilled('BTC-USD', 'long', 0.001, 51000, 1.5, {
                        sessionPnl: 11.5,
                        sessionVolume: 550,
                        reasoning,
                        fallback: false,
                    });

                    expect(capturedMessages).toHaveLength(1);
                    const msg = capturedMessages[0];

                    const match = msg.match(/💬 \*Reasoning:\* `([^`]*)`/);
                    expect(match).not.toBeNull();
                    const snippet = match![1];
                    expect(snippet.length).toBeLessThanOrEqual(200);
                }
            ),
            { numRuns: 50 }
        );
    });

    // **Validates: Requirements 5.3**
    // Property 7: Fallback signals are always labeled in Telegram notifications
    it('P7: notifyEntryFilled with fallback:true always contains [Fallback Mode] and no raw reasoning', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    reasoning: fc.string({ minLength: 1, maxLength: 500 }),
                    baseScore: fc.float({ min: -1, max: 1 }),
                    bias: fc.float({ min: -0.5, max: 0.5 }),
                    regime: fc.constantFrom('TREND_UP', 'TREND_DOWN', 'SIDEWAY'),
                    finalScore: fc.float({ min: -1, max: 1 }),
                }),
                async ({ reasoning, baseScore, bias, regime, finalScore }) => {
                    const { telegram, capturedMessages } = makeMockTelegram();
                    const executor = new Executor(adapter, telegram);

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

                    expect(capturedMessages).toHaveLength(1);
                    const msg = capturedMessages[0];

                    // Must contain fallback label
                    expect(msg).toContain('[Fallback Mode]');
                    // Must NOT contain the reasoning line
                    expect(msg).not.toContain('💬 *Reasoning:*');
                }
            ),
            { numRuns: 50 }
        );
    });

    // **Validates: Requirements 5.3**
    // Property 7 (exit): notifyExitFilled with fallback:true always contains [Fallback Mode] and no raw reasoning
    it('P7: notifyExitFilled with fallback:true always contains [Fallback Mode] and no raw reasoning', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.record({
                    reasoning: fc.string({ minLength: 1, maxLength: 500 }),
                    pnl: fc.float({ min: -100, max: 100 }),
                }),
                async ({ reasoning, pnl }) => {
                    const { telegram, capturedMessages } = makeMockTelegram();
                    const executor = new Executor(adapter, telegram);

                    await executor.notifyExitFilled('BTC-USD', 'short', 0.001, 49000, pnl, {
                        sessionPnl: 5,
                        sessionVolume: 200,
                        reasoning,
                        fallback: true,
                    });

                    expect(capturedMessages).toHaveLength(1);
                    const msg = capturedMessages[0];

                    // Must contain fallback label
                    expect(msg).toContain('[Fallback Mode]');
                    // Must NOT contain the reasoning line
                    expect(msg).not.toContain('💬 *Reasoning:*');
                }
            ),
            { numRuns: 50 }
        );
    });
});
