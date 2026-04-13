import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Executor } from '../Executor';
import type { ExchangeAdapter } from '../../adapters/ExchangeAdapter';
import type { TelegramManager } from '../TelegramManager';
import type { ExecutionEdge, OffsetResult } from '../ExecutionEdge';

// Minimal mock helpers
function makeMockAdapter(overrides: Partial<ExchangeAdapter> = {}): ExchangeAdapter {
    return {
        get_mark_price: vi.fn(),
        get_orderbook: vi.fn(),
        place_limit_order: vi.fn(),
        cancel_order: vi.fn(),
        cancel_all_orders: vi.fn(),
        get_open_orders: vi.fn(),
        get_position: vi.fn(),
        get_balance: vi.fn(),
        get_orderbook_depth: vi.fn(),
        get_recent_trades: vi.fn(),
        ...overrides,
    } as unknown as ExchangeAdapter;
}

function makeMockTelegram(): TelegramManager {
    return {
        sendMessage: vi.fn().mockResolvedValue(undefined),
    } as unknown as TelegramManager;
}

function makeMockEdge(result: Partial<OffsetResult>): ExecutionEdge {
    const defaultResult: OffsetResult = {
        offset: 0,
        spreadBps: 0,
        spreadOk: true,
        depthScore: 0,
        fillRatePenalty: 0,
        ...result,
    };
    return {
        computeOffset: vi.fn().mockResolvedValue(defaultResult),
    } as unknown as ExecutionEdge;
}

describe('Executor.placeEntryOrder — ExecutionEdge integration', () => {
    // Task 9.1: placeEntryOrder returns null when spreadOk=false
    describe('9.1 — spreadOk=false skips order placement', () => {
        it('returns null and does not call place_limit_order when spread is too wide', async () => {
            const mockAdapter = makeMockAdapter({
                get_orderbook: vi.fn().mockResolvedValue({ best_bid: 100000, best_ask: 100010 }),
            });
            const mockTelegram = makeMockTelegram();
            const mockEdge = makeMockEdge({ spreadOk: false, spreadBps: 15, offset: 0 });

            const executor = new Executor(mockAdapter, mockTelegram, mockEdge);
            const result = await executor.placeEntryOrder('BTC-PERP', 'long', 0.001);

            expect(result).toBeNull();
            expect(mockAdapter.place_limit_order).not.toHaveBeenCalled();
        });
    });

    // Task 9.2: placeEntryOrder uses edgeResult.offset in price calculation
    describe('9.2 — edgeResult.offset is applied to price', () => {
        it('long: price = floor((best_bid - offset) * 100) / 100', async () => {
            const mockAdapter = makeMockAdapter({
                get_orderbook: vi.fn().mockResolvedValue({ best_bid: 100000, best_ask: 100010 }),
                place_limit_order: vi.fn().mockResolvedValue('order-123'),
            });
            const mockTelegram = makeMockTelegram();
            const mockEdge = makeMockEdge({ spreadOk: true, offset: 2.5 });

            const executor = new Executor(mockAdapter, mockTelegram, mockEdge);
            await executor.placeEntryOrder('BTC-PERP', 'long', 0.001);

            // floor((100000 - 2.5) * 100) / 100 = floor(9999750) / 100 = 99997.5
            expect(mockAdapter.place_limit_order).toHaveBeenCalledWith(
                'BTC-PERP',
                'buy',
                99997.5,
                0.001,
            );
        });

        it('short: price = ceil((best_ask + offset) * 100) / 100', async () => {
            const mockAdapter = makeMockAdapter({
                get_orderbook: vi.fn().mockResolvedValue({ best_bid: 100000, best_ask: 100010 }),
                place_limit_order: vi.fn().mockResolvedValue('order-456'),
            });
            const mockTelegram = makeMockTelegram();
            const mockEdge = makeMockEdge({ spreadOk: true, offset: 2.5 });

            const executor = new Executor(mockAdapter, mockTelegram, mockEdge);
            await executor.placeEntryOrder('BTC-PERP', 'short', 0.001);

            // ceil((100010 + 2.5) * 100) / 100 = ceil(10001250) / 100 = 100012.5
            expect(mockAdapter.place_limit_order).toHaveBeenCalledWith(
                'BTC-PERP',
                'sell',
                100012.5,
                0.001,
            );
        });
    });
});
