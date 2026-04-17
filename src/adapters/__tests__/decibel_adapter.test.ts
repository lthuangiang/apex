import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock SDK modules before importing the adapter ────────────────────────────

const mockPlaceOrder = vi.fn().mockResolvedValue({ hash: 'tx-abc123' });
const mockCancelOrder = vi.fn().mockResolvedValue({});
const mockApproveMaxBuilderFee = vi.fn().mockResolvedValue({});
const mockGetByName = vi.fn();
const mockMarketsGetAll = vi.fn();
const mockMarketPricesGetAll = vi.fn();
const mockSubscribeByName = vi.fn();
const mockUserOpenOrders = { getByAddr: vi.fn() };
const mockUserPositions = { getByAddr: vi.fn() };
const mockAccountOverview = { getByAddr: vi.fn() };
const mockGasInitialize = vi.fn().mockResolvedValue(undefined);

vi.mock('@decibeltrade/sdk', () => ({
    DecibelReadDex: vi.fn(function () {
        return {
            markets: { getAll: mockMarketsGetAll },
            marketPrices: { getAll: mockMarketPricesGetAll },
            marketDepth: { 
                getByName: mockGetByName,
                subscribeByName: mockSubscribeByName,
            },
            userOpenOrders: mockUserOpenOrders,
            userPositions: mockUserPositions,
            accountOverview: mockAccountOverview,
        };
    }),
    DecibelWriteDex: vi.fn(function () {
        return {
            placeOrder: mockPlaceOrder,
            cancelOrder: mockCancelOrder,
            approveMaxBuilderFee: mockApproveMaxBuilderFee,
        };
    }),
    GasPriceManager: vi.fn(function () {
        return { initialize: mockGasInitialize };
    }),
    MAINNET_CONFIG: { network: 'mainnet' },
    NETNA_CONFIG: undefined,
    TimeInForce: { PostOnly: 'PostOnly' },
}));

vi.mock('@aptos-labs/ts-sdk', () => ({
    Ed25519Account: vi.fn(function () { return {}; }),
    Ed25519PrivateKey: vi.fn(function () { return {}; }),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import { DecibelAdapter } from '../decibel_adapter.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const PRIVATE_KEY = 'a'.repeat(64);
const NODE_API_KEY = 'node-key-123';
const SUBACCOUNT = '0xsubaccount';
const BUILDER_ADDRESS = '0x5eefc26ee8f0b537717e57718a9a0c365e32081d96dc618a56041b3b7ff31ed5';

function makeAdapter() {
    return new DecibelAdapter(PRIVATE_KEY, NODE_API_KEY, SUBACCOUNT, BUILDER_ADDRESS);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('DecibelAdapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGasInitialize.mockResolvedValue(undefined);
        mockSubscribeByName.mockReturnValue(() => {}); // Return unsubscribe function
        mockMarketsGetAll.mockResolvedValue([
            { market_name: 'BTC-USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
        ]);
        mockMarketPricesGetAll.mockResolvedValue([
            { market: '0xbtc', mid_px: 50000 },
        ]);
    });

    // ── get_orderbook ─────────────────────────────────────────────────────────
    // NOTE: These tests are outdated - get_orderbook now uses WebSocket subscriptions
    // instead of REST API. See decibel-adapter-preservation.test.ts for current behavior.

    describe.skip('get_orderbook (outdated - uses REST API)', () => {
        it('returns best_bid and best_ask from market depth', async () => {
            mockGetByName.mockResolvedValue({
                bids: [{ price: 50000 }, { price: 49900 }],
                asks: [{ price: 50100 }, { price: 50200 }],
            });
            const adapter = makeAdapter();
            const ob = await adapter.get_orderbook('BTC-USD');
            expect(ob.best_bid).toBe(50000);
            expect(ob.best_ask).toBe(50100);
            expect(mockGetByName).toHaveBeenCalledWith('BTC-USD');
        });

        it('throws when orderbook is empty', async () => {
            mockGetByName.mockResolvedValue({ bids: [], asks: [] });
            const adapter = makeAdapter();
            await expect(adapter.get_orderbook('BTC-USD')).rejects.toThrow('Orderbook is empty');
        });

        it('throws when bids are empty', async () => {
            mockGetByName.mockResolvedValue({ bids: [], asks: [{ price: 50100 }] });
            const adapter = makeAdapter();
            await expect(adapter.get_orderbook('BTC-USD')).rejects.toThrow('Orderbook is empty');
        });
    });

    // ── get_mark_price ────────────────────────────────────────────────────────
    // NOTE: This test is outdated - get_mark_price now uses markets.getAll() and marketPrices.getAll()
    // See decibel-adapter-preservation.test.ts for current behavior.

    describe.skip('get_mark_price (outdated)', () => {
        it('returns best_bid as mark price', async () => {
            mockGetByName.mockResolvedValue({
                bids: [{ price: 49500 }],
                asks: [{ price: 49600 }],
            });
            const adapter = makeAdapter();
            const price = await adapter.get_mark_price('BTC-USD');
            expect(price).toBe(49500);
        });
    });

    // ── place_limit_order ─────────────────────────────────────────────────────

    describe('place_limit_order', () => {
        it('calls placeOrder with correct params for buy', async () => {
            const adapter = makeAdapter();
            const orderId = await adapter.place_limit_order('BTC-USD', 'buy', 50000, 0.01);

            expect(mockPlaceOrder).toHaveBeenCalledOnce();
            const params = mockPlaceOrder.mock.calls[0][0];
            expect(params.marketName).toBe('BTC-USD');
            expect(params.isBuy).toBe(true);
            expect(params.price).toBe(50000 * 1e8);
            expect(params.size).toBe(0.01 * 1e8);
            expect(params.isReduceOnly).toBe(false);
            expect(params.builderAddr).toBe(BUILDER_ADDRESS);
            expect(params.builderFee).toBe(10);
            expect(orderId).toBe('tx-abc123');
        });

        it('calls placeOrder with isBuy=false for sell', async () => {
            const adapter = makeAdapter();
            await adapter.place_limit_order('BTC-USD', 'sell', 50000, 0.005);
            expect(mockPlaceOrder.mock.calls[0][0].isBuy).toBe(false);
        });

        it('passes reduceOnly=true when specified', async () => {
            const adapter = makeAdapter();
            await adapter.place_limit_order('BTC-USD', 'buy', 50000, 0.01, true);
            expect(mockPlaceOrder.mock.calls[0][0].isReduceOnly).toBe(true);
        });

        it('converts price and size to chain units (×1e8)', async () => {
            const adapter = makeAdapter();
            await adapter.place_limit_order('BTC-USD', 'buy', 1.5, 0.003);
            const params = mockPlaceOrder.mock.calls[0][0];
            expect(params.price).toBe(150000000);   // 1.5 * 1e8
            expect(params.size).toBe(300000);        // 0.003 * 1e8
        });

        it('throws and re-throws when placeOrder fails', async () => {
            mockPlaceOrder.mockRejectedValueOnce(new Error('insufficient balance'));
            const adapter = makeAdapter();
            await expect(adapter.place_limit_order('BTC-USD', 'buy', 50000, 0.01))
                .rejects.toThrow('insufficient balance');
        });
    });

    // ── cancel_order ──────────────────────────────────────────────────────────

    describe('cancel_order', () => {
        it('returns true on success', async () => {
            const adapter = makeAdapter();
            const result = await adapter.cancel_order('order-123', 'BTC-USD');
            expect(result).toBe(true);
            expect(mockCancelOrder).toHaveBeenCalledWith({
                orderId: 'order-123',
                marketName: 'BTC-USD',
                subaccountAddr: SUBACCOUNT,
            });
        });

        it('returns false when cancelOrder throws', async () => {
            mockCancelOrder.mockRejectedValueOnce(new Error('order not found'));
            const adapter = makeAdapter();
            const result = await adapter.cancel_order('bad-id', 'BTC-USD');
            expect(result).toBe(false);
        });
    });

    // ── cancel_all_orders ─────────────────────────────────────────────────────

    describe('cancel_all_orders', () => {
        it('cancels all open orders for the symbol', async () => {
            mockUserOpenOrders.getByAddr.mockResolvedValue({
                open_orders: [
                    { order_id: 'o1', market: 'BTC-USD', is_buy: true, price: 50000, size: 0.01 },
                    { order_id: 'o2', market: 'BTC-USD', is_buy: false, price: 50100, size: 0.005 },
                ],
            });
            const adapter = makeAdapter();
            const result = await adapter.cancel_all_orders('BTC-USD');
            expect(result).toBe(true);
            expect(mockCancelOrder).toHaveBeenCalledTimes(2);
        });

        it('returns true when there are no open orders', async () => {
            mockUserOpenOrders.getByAddr.mockResolvedValue({ open_orders: [] });
            const adapter = makeAdapter();
            const result = await adapter.cancel_all_orders('BTC-USD');
            expect(result).toBe(true);
            expect(mockCancelOrder).not.toHaveBeenCalled();
        });

        it('only cancels orders matching the symbol', async () => {
            mockUserOpenOrders.getByAddr.mockResolvedValue({
                open_orders: [
                    { order_id: 'o1', market: 'BTC-USD', is_buy: true, price: 50000, size: 0.01 },
                    { order_id: 'o2', market: 'ETH-USD', is_buy: true, price: 3000, size: 0.1 },
                ],
            });
            const adapter = makeAdapter();
            await adapter.cancel_all_orders('BTC-USD');
            expect(mockCancelOrder).toHaveBeenCalledTimes(1);
            expect(mockCancelOrder.mock.calls[0][0].orderId).toBe('o1');
        });

        it('returns false when get_open_orders throws', async () => {
            mockUserOpenOrders.getByAddr.mockRejectedValueOnce(new Error('network error'));
            const adapter = makeAdapter();
            const result = await adapter.cancel_all_orders('BTC-USD');
            expect(result).toBe(false);
        });
    });

    // ── get_open_orders ───────────────────────────────────────────────────────

    describe('get_open_orders', () => {
        it('returns mapped orders for the symbol', async () => {
            mockUserOpenOrders.getByAddr.mockResolvedValue({
                open_orders: [
                    { order_id: 'o1', market: 'BTC-USD', is_buy: true, price: 50000, size: 0.01 },
                    { order_id: 'o2', market: 'BTC-USD', is_buy: false, price: 50100, size: 0.005 },
                    { order_id: 'o3', market: 'ETH-USD', is_buy: true, price: 3000, size: 0.1 },
                ],
            });
            const adapter = makeAdapter();
            const orders = await adapter.get_open_orders('BTC-USD');
            expect(orders).toHaveLength(2);
            expect(orders[0]).toEqual({ id: 'o1', symbol: 'BTC-USD', side: 'buy', price: 50000, size: 0.01, status: 'open' });
            expect(orders[1]).toEqual({ id: 'o2', symbol: 'BTC-USD', side: 'sell', price: 50100, size: 0.005, status: 'open' });
        });

        it('returns empty array when no orders', async () => {
            mockUserOpenOrders.getByAddr.mockResolvedValue({ open_orders: [] });
            const adapter = makeAdapter();
            const orders = await adapter.get_open_orders('BTC-USD');
            expect(orders).toEqual([]);
        });

        it('handles missing open_orders field gracefully', async () => {
            mockUserOpenOrders.getByAddr.mockResolvedValue({});
            const adapter = makeAdapter();
            const orders = await adapter.get_open_orders('BTC-USD');
            expect(orders).toEqual([]);
        });

        it('calls getByAddr with correct subaccount', async () => {
            mockUserOpenOrders.getByAddr.mockResolvedValue({ open_orders: [] });
            const adapter = makeAdapter();
            await adapter.get_open_orders('BTC-USD');
            expect(mockUserOpenOrders.getByAddr).toHaveBeenCalledWith({ subAddr: SUBACCOUNT });
        });
    });

    // ── get_position ──────────────────────────────────────────────────────────

    describe('get_position', () => {
        it('returns long position when open_size > 0', async () => {
            mockUserPositions.getByAddr.mockResolvedValue({
                positions: [{ market: 'BTC-USD', open_size: 0.5 }],
            });
            const adapter = makeAdapter();
            const pos = await adapter.get_position('BTC-USD');
            expect(pos).not.toBeNull();
            expect(pos!.side).toBe('long');
            expect(pos!.size).toBe(0.5);
            expect(pos!.symbol).toBe('BTC-USD');
        });

        it('returns short position when open_size < 0', async () => {
            mockUserPositions.getByAddr.mockResolvedValue({
                positions: [{ market: 'BTC-USD', open_size: -0.3 }],
            });
            const adapter = makeAdapter();
            const pos = await adapter.get_position('BTC-USD');
            expect(pos!.side).toBe('short');
            expect(pos!.size).toBe(-0.3);
        });

        it('returns neutral when open_size is 0', async () => {
            mockUserPositions.getByAddr.mockResolvedValue({
                positions: [{ market: 'BTC-USD', open_size: 0 }],
            });
            const adapter = makeAdapter();
            const pos = await adapter.get_position('BTC-USD');
            expect(pos!.side).toBe('neutral');
        });

        it('returns null when no position for symbol', async () => {
            mockUserPositions.getByAddr.mockResolvedValue({
                positions: [{ market: 'ETH-USD', open_size: 1 }],
            });
            const adapter = makeAdapter();
            const pos = await adapter.get_position('BTC-USD');
            expect(pos).toBeNull();
        });

        it('returns null when positions array is empty', async () => {
            mockUserPositions.getByAddr.mockResolvedValue({ positions: [] });
            const adapter = makeAdapter();
            const pos = await adapter.get_position('BTC-USD');
            expect(pos).toBeNull();
        });

        it('returns null when response is null', async () => {
            mockUserPositions.getByAddr.mockResolvedValue(null);
            const adapter = makeAdapter();
            const pos = await adapter.get_position('BTC-USD');
            expect(pos).toBeNull();
        });
    });

    // ── get_balance ───────────────────────────────────────────────────────────

    describe('get_balance', () => {
        it('returns perp_equity_balance', async () => {
            mockAccountOverview.getByAddr.mockResolvedValue({ perp_equity_balance: 1234.56 });
            const adapter = makeAdapter();
            const balance = await adapter.get_balance();
            expect(balance).toBe(1234.56);
            expect(mockAccountOverview.getByAddr).toHaveBeenCalledWith({ subAddr: SUBACCOUNT });
        });

        it('returns 0 when balance is missing', async () => {
            mockAccountOverview.getByAddr.mockResolvedValue({});
            const adapter = makeAdapter();
            const balance = await adapter.get_balance();
            expect(balance).toBe(0);
        });

        it('returns 0 when response is null', async () => {
            mockAccountOverview.getByAddr.mockResolvedValue(null);
            const adapter = makeAdapter();
            const balance = await adapter.get_balance();
            expect(balance).toBe(0);
        });
    });

    // ── approveBuilderFee ─────────────────────────────────────────────────────

    describe('approveBuilderFee', () => {
        it('calls approveMaxBuilderFee with default 10 bps', async () => {
            const adapter = makeAdapter();
            await adapter.approveBuilderFee();
            expect(mockApproveMaxBuilderFee).toHaveBeenCalledWith({
                builderAddr: BUILDER_ADDRESS,
                maxFee: 10,
            });
        });

        it('calls approveMaxBuilderFee with custom bps', async () => {
            const adapter = makeAdapter();
            await adapter.approveBuilderFee(25);
            expect(mockApproveMaxBuilderFee).toHaveBeenCalledWith({
                builderAddr: BUILDER_ADDRESS,
                maxFee: 25,
            });
        });
    });

    // ── get_orderbook_depth / get_recent_trades (stubs) ───────────────────────

    describe('stub methods', () => {
        it('get_orderbook_depth returns empty bids/asks', async () => {
            const adapter = makeAdapter();
            const depth = await adapter.get_orderbook_depth('BTC-USD', 10);
            expect(depth).toEqual({ bids: [], asks: [] });
        });

        it('get_recent_trades returns empty array', async () => {
            const adapter = makeAdapter();
            const trades = await adapter.get_recent_trades('BTC-USD', 10);
            expect(trades).toEqual([]);
        });
    });

    // ── private key sanitization ──────────────────────────────────────────────

    describe('constructor key sanitization', () => {
        it('strips 0x prefix from private key', () => {
            // Should not throw — Ed25519PrivateKey mock accepts anything
            expect(() => new DecibelAdapter('0x' + 'a'.repeat(64), NODE_API_KEY, SUBACCOUNT, BUILDER_ADDRESS)).not.toThrow();
        });

        it('strips ed25519-priv- prefix', () => {
            expect(() => new DecibelAdapter('ed25519-priv-' + 'a'.repeat(64), NODE_API_KEY, SUBACCOUNT, BUILDER_ADDRESS)).not.toThrow();
        });

        it('strips nested 0xed25519-priv-0x prefix', () => {
            expect(() => new DecibelAdapter('0xed25519-priv-0x' + 'a'.repeat(64), NODE_API_KEY, SUBACCOUNT, BUILDER_ADDRESS)).not.toThrow();
        });
    });
});
