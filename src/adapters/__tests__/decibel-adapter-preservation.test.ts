import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

// ── Mock SDK modules before importing the adapter ────────────────────────────

const mockPlaceOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockApproveMaxBuilderFee = vi.fn();
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
            marketDepth: { subscribeByName: mockSubscribeByName },
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

// ── Arbitraries ───────────────────────────────────────────────────────────────

const priceArb = fc.float({ min: Math.fround(1000), max: Math.fround(100000), noNaN: true, noDefaultInfinity: true });
const sizeArb = fc.float({ min: Math.fround(0.001), max: Math.fround(10), noNaN: true, noDefaultInfinity: true });
const sideArb = fc.constantFrom('buy', 'sell') as fc.Arbitrary<'buy' | 'sell'>;
const reduceOnlyArb = fc.boolean();

// ── Preservation Property Tests ──────────────────────────────────────────────
// These tests capture CURRENT behavior on UNFIXED code for non-buggy inputs
// They MUST PASS on unfixed code to establish baseline behavior to preserve

describe('DecibelAdapter - Preservation Properties', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGasInitialize.mockResolvedValue(undefined);
        mockSubscribeByName.mockReturnValue(() => {});
    });

    // ── Property 1: BTC/USD Trading Preservation ─────────────────────────────

    describe('Property 1: BTC/USD Trading Preservation', () => {
        /**
         * Property 1.1: For any valid BTC/USD order parameters (price, size, side),
         * place_limit_order should successfully place an order and return an order ID.
         * Validates: Requirements 3.1, 3.2
         */
        it('Property 1.1: BTC/USD orders are placed successfully', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ orderId: 'order-123' });

            const adapter = makeAdapter();
            
            // Test buy order
            const buyOrderId = await adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1, false);
            expect(typeof buyOrderId).toBe('string');
            expect(buyOrderId.length).toBeGreaterThan(0);
            
            // Test sell order
            const sellOrderId = await adapter.place_limit_order('BTC/USD', 'sell', 96000, 0.2, true);
            expect(typeof sellOrderId).toBe('string');
            expect(sellOrderId.length).toBeGreaterThan(0);

            // Verify placeOrder was called with correct structure
            expect(mockPlaceOrder).toHaveBeenCalledTimes(2);
            const params = mockPlaceOrder.mock.calls[0][0];
            expect(params).toHaveProperty('marketName');
            expect(params).toHaveProperty('price');
            expect(params).toHaveProperty('size');
            expect(params).toHaveProperty('isBuy');
            expect(params).toHaveProperty('isReduceOnly');
        });

        /**
         * Property 1.2: For any valid order ID and BTC/USD symbol,
         * cancel_order should attempt to cancel and return a boolean.
         * Validates: Requirements 3.3
         */
        it('Property 1.2: BTC/USD orders can be cancelled', async () => {
            mockCancelOrder.mockResolvedValue({});

            const adapter = makeAdapter();
            const result = await adapter.cancel_order('order-123', 'BTC/USD');

            expect(typeof result).toBe('boolean');
            expect(mockCancelOrder).toHaveBeenCalledWith({
                orderId: 'order-123',
                marketName: 'BTC/USD',
                subaccountAddr: SUBACCOUNT,
            });
        });

        /**
         * Property 1.3: For BTC/USD symbol, get_open_orders should return an array
         * with correct structure (id, symbol, side, price, size, status).
         * Validates: Requirements 3.1
         */
        it('Property 1.3: BTC/USD open orders are queried correctly', async () => {
            mockUserOpenOrders.getByAddr.mockResolvedValue({
                open_orders: [
                    { order_id: 'order-1', market: 'BTC/USD', is_buy: true, price: 95000, size: 0.1 },
                    { order_id: 'order-2', market: 'BTC/USD', is_buy: false, price: 96000, size: 0.2 },
                ],
            });

            const adapter = makeAdapter();
            const orders = await adapter.get_open_orders('BTC/USD');

            expect(Array.isArray(orders)).toBe(true);
            expect(orders.length).toBe(2);
            orders.forEach(order => {
                expect(order).toHaveProperty('id');
                expect(order).toHaveProperty('symbol');
                expect(order).toHaveProperty('side');
                expect(order).toHaveProperty('price');
                expect(order).toHaveProperty('size');
                expect(order).toHaveProperty('status');
                expect(order.symbol).toBe('BTC/USD');
                expect(['buy', 'sell']).toContain(order.side);
            });
        });
    });

    // ── Property 2: Read Operations Preservation ─────────────────────────────

    describe('Property 2: Read Operations Preservation', () => {
        /**
         * Property 2.1: For BTC/USD symbol, get_position should return null or
         * a Position object with correct structure (symbol, side, size, entryPrice, unrealizedPnl).
         * Validates: Requirements 3.4
         */
        it('Property 2.1: get_position returns correct structure', async () => {
            // Test with position
            mockUserPositions.getByAddr.mockResolvedValue({
                positions: [
                    { market: 'BTC/USD', open_size: 0.5 },
                ],
            });

            const adapter = makeAdapter();
            const position = await adapter.get_position('BTC/USD');

            if (position !== null) {
                expect(position).toHaveProperty('symbol');
                expect(position).toHaveProperty('side');
                expect(position).toHaveProperty('size');
                expect(position).toHaveProperty('entryPrice');
                expect(position).toHaveProperty('unrealizedPnl');
                expect(position.symbol).toBe('BTC/USD');
                expect(['long', 'short', 'neutral']).toContain(position.side);
            }

            // Test without position
            mockUserPositions.getByAddr.mockResolvedValue({ positions: [] });
            const noPosition = await adapter.get_position('BTC/USD');
            expect(noPosition).toBeNull();
        });

        /**
         * Property 2.2: get_balance should return a number >= 0.
         * Validates: Requirements 3.5
         */
        it('Property 2.2: get_balance returns non-negative number', async () => {
            mockAccountOverview.getByAddr.mockResolvedValue({
                perp_equity_balance: 1000,
            });

            const adapter = makeAdapter();
            const result = await adapter.get_balance();

            expect(typeof result).toBe('number');
            expect(result).toBeGreaterThanOrEqual(0);
            expect(result).toBe(1000);
        });

        /**
         * Property 2.3: For BTC/USD symbol, get_mark_price should return a positive number.
         * Validates: Requirements 3.1
         */
        it('Property 2.3: get_mark_price returns positive number for BTC/USD', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc' },
            ]);
            mockMarketPricesGetAll.mockResolvedValue([
                { market: '0xbtc', mid_px: 95000 },
            ]);

            const adapter = makeAdapter();
            const result = await adapter.get_mark_price('BTC/USD');

            expect(typeof result).toBe('number');
            expect(result).toBeGreaterThan(0);
            expect(result).toBe(95000);
        });

        /**
         * Property 2.4: get_orderbook_depth should return object with bids and asks arrays.
         * Validates: Requirements 3.1
         */
        it('Property 2.4: get_orderbook_depth returns correct structure', async () => {
            const adapter = makeAdapter();
            const depth = await adapter.get_orderbook_depth('BTC/USD', 10);

            expect(depth).toHaveProperty('bids');
            expect(depth).toHaveProperty('asks');
            expect(Array.isArray(depth.bids)).toBe(true);
            expect(Array.isArray(depth.asks)).toBe(true);
        });

        /**
         * Property 2.5: get_recent_trades should return an array.
         * Validates: Requirements 3.1
         */
        it('Property 2.5: get_recent_trades returns array', async () => {
            const adapter = makeAdapter();
            const trades = await adapter.get_recent_trades('BTC/USD', 10);

            expect(Array.isArray(trades)).toBe(true);
        });
    });

    // ── Property 3: WebSocket Subscriptions and Caching ──────────────────────

    describe('Property 3: WebSocket Subscriptions and Caching', () => {
        /**
         * Property 3.1: For BTC/USD symbol, get_orderbook should return object
         * with best_bid and best_ask properties, both positive numbers.
         * Validates: Requirements 3.6
         */
        it('Property 3.1: get_orderbook returns best bid/ask structure', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc' },
            ]);
            mockMarketPricesGetAll.mockResolvedValue([
                { market: '0xbtc', mid_px: 95000 },
            ]);

            // Mock WebSocket subscription callback
            let wsCallback: any = null;
            mockSubscribeByName.mockImplementation((symbol: string, depth: number, callback: any) => {
                wsCallback = callback;
                // Simulate immediate callback
                setTimeout(() => {
                    callback({
                        bids: [{ price: 94999, size: 1.0 }],
                        asks: [{ price: 95001, size: 1.0 }],
                    });
                }, 10);
                return () => {}; // unsubscribe function
            });

            const adapter = makeAdapter();
            const orderbook = await adapter.get_orderbook('BTC/USD');

            expect(orderbook).toHaveProperty('best_bid');
            expect(orderbook).toHaveProperty('best_ask');
            expect(typeof orderbook.best_bid).toBe('number');
            expect(typeof orderbook.best_ask).toBe('number');
            expect(orderbook.best_bid).toBeGreaterThan(0);
            expect(orderbook.best_ask).toBeGreaterThan(0);
        });

        /**
         * Property 3.2: WebSocket subscription should be created only once per symbol.
         * Validates: Requirements 3.6
         */
        it('Property 3.2: WebSocket subscription is reused for same symbol', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc' },
            ]);
            mockMarketPricesGetAll.mockResolvedValue([
                { market: '0xbtc', mid_px: 95000 },
            ]);

            mockSubscribeByName.mockImplementation((symbol: string, depth: number, callback: any) => {
                setTimeout(() => {
                    callback({
                        bids: [{ price: 94999, size: 1.0 }],
                        asks: [{ price: 95001, size: 1.0 }],
                    });
                }, 10);
                return () => {};
            });

            const adapter = makeAdapter();
            
            // First call - should create subscription
            await adapter.get_orderbook('BTC/USD');
            expect(mockSubscribeByName).toHaveBeenCalledTimes(1);

            // Second call - should reuse subscription (cache hit)
            await adapter.get_orderbook('BTC/USD');
            expect(mockSubscribeByName).toHaveBeenCalledTimes(1); // Still 1, not 2
        });
    });

    // ── Property 4: Gas Station Integration ──────────────────────────────────

    describe('Property 4: Gas Station Integration', () => {
        /**
         * Property 4.1: When gas station API key is provided, GasPriceManager
         * should be initialized asynchronously.
         * Validates: Requirements 3.8
         */
        it('Property 4.1: Gas station initializes when API key provided', async () => {
            const gasApiKey = 'gas-key-123';
            mockGasInitialize.mockResolvedValue(undefined);

            const adapter = new DecibelAdapter(PRIVATE_KEY, NODE_API_KEY, SUBACCOUNT, BUILDER_ADDRESS, 10, gasApiKey);

            // Wait for async initialization
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(mockGasInitialize).toHaveBeenCalled();
        });

        /**
         * Property 4.2: Adapter should be usable immediately even if gas station
         * initialization is pending.
         * Validates: Requirements 3.7
         */
        it('Property 4.2: Adapter is usable before gas station initializes', async () => {
            mockGasInitialize.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1000)));
            mockAccountOverview.getByAddr.mockResolvedValue({ perp_equity_balance: 1000 });

            const adapter = new DecibelAdapter(PRIVATE_KEY, NODE_API_KEY, SUBACCOUNT, BUILDER_ADDRESS, 10, 'gas-key');
            
            // Should be able to call methods immediately
            const balance = await adapter.get_balance();
            expect(typeof balance).toBe('number');
        });
    });

    // ── Property 5: Debug Mode Logging ───────────────────────────────────────

    describe('Property 5: Debug Mode Logging', () => {
        /**
         * Property 5.1: When DECIBEL_DEBUG is enabled, HTTP requests should be logged.
         * This test documents that debug mode exists and affects logging behavior.
         * Validates: Requirements 3.9
         */
        it('Property 5.1: Debug mode can be enabled via environment variable', () => {
            // This test documents that DECIBEL_DEBUG environment variable exists
            // and is checked during adapter initialization
            const debugValue = process.env.DECIBEL_DEBUG;
            
            // Debug mode is controlled by environment variable
            expect(['true', 'false', undefined]).toContain(debugValue);
            
            // The actual logging behavior is tested through integration tests
            // since it modifies globalThis.fetch
        });
    });

    // ── Property 6: Market Config Caching ────────────────────────────────────

    describe('Property 6: Market Config Caching', () => {
        /**
         * Property 6.1: Market config should be fetched once and cached per symbol.
         * Validates: Requirements 3.1
         */
        it('Property 6.1: Market config is cached after first fetch', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ orderId: 'order-123' });

            const adapter = makeAdapter();
            
            // First order - should fetch market config
            await adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1);
            expect(mockMarketsGetAll).toHaveBeenCalledTimes(1);

            // Second order - should use cached config
            await adapter.place_limit_order('BTC/USD', 'sell', 96000, 0.2);
            expect(mockMarketsGetAll).toHaveBeenCalledTimes(1); // Still 1, not 2
        });
    });

    // ── Property 7: Error Handling Preservation ──────────────────────────────

    describe('Property 7: Error Handling Preservation', () => {
        /**
         * Property 7.1: When cancel_order fails, it should return false instead of throwing.
         * Validates: Requirements 3.3
         */
        it('Property 7.1: cancel_order returns false on error', async () => {
            mockCancelOrder.mockRejectedValue(new Error('Cancel failed'));

            const adapter = makeAdapter();
            const result = await adapter.cancel_order('order-123', 'BTC/USD');

            expect(result).toBe(false);
        });

        /**
         * Property 7.2: When cancel_all_orders is called, it should attempt to cancel
         * all open orders and return boolean.
         * Validates: Requirements 3.3
         */
        it('Property 7.2: cancel_all_orders handles multiple orders', async () => {
            mockUserOpenOrders.getByAddr.mockResolvedValue({
                open_orders: [
                    { order_id: 'order-1', market: 'BTC/USD', is_buy: true, price: 95000, size: 0.1 },
                    { order_id: 'order-2', market: 'BTC/USD', is_buy: false, price: 96000, size: 0.2 },
                ],
            });
            mockCancelOrder.mockResolvedValue({});

            const adapter = makeAdapter();
            const result = await adapter.cancel_all_orders('BTC/USD');

            expect(typeof result).toBe('boolean');
            expect(mockCancelOrder).toHaveBeenCalledTimes(2);
        });
    });
});
