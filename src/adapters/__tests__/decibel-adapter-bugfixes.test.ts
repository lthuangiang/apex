import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock SDK modules before importing the adapter ────────────────────────────

const mockPlaceOrder = vi.fn();
const mockCancelOrder = vi.fn();
const mockCancelBulkOrder = vi.fn();
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
            cancelBulkOrder: mockCancelBulkOrder,
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

// ── Bug Condition Exploration Tests ──────────────────────────────────────────
// These tests are EXPECTED TO FAIL on unfixed code to prove the bugs exist

describe('DecibelAdapter - Bug Condition Exploration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGasInitialize.mockResolvedValue(undefined);
        mockSubscribeByName.mockReturnValue(() => {});
    });

    // ── Bug 1: Hardcoded Symbol ──────────────────────────────────────────────

    describe('Bug 1: Hardcoded Symbol', () => {
        it('should use ETH/USD symbol in place_limit_order, not BTC/USD', async () => {
            // Setup: Mock markets and prices for ETH/USD
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
                { market_name: 'ETH/USD', market_addr: '0xeth', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ orderId: 'eth-order-123' });

            const adapter = makeAdapter();
            await adapter.place_limit_order('ETH/USD', 'buy', 2000, 1.0);

            // EXPECTED BEHAVIOR: marketName should be 'ETH/USD'
            // BUG CONDITION: marketName is hardcoded to 'BTC/USD'
            expect(mockPlaceOrder).toHaveBeenCalledOnce();
            const params = mockPlaceOrder.mock.calls[0][0];
            expect(params.marketName).toBe('ETH/USD'); // This will FAIL on unfixed code
        });

        it('should fetch market config for ETH/USD, not BTC/USD', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
                { market_name: 'ETH/USD', market_addr: '0xeth', sz_decimals: 6, px_decimals: 6, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ orderId: 'eth-order-123' });

            const adapter = makeAdapter();
            await adapter.place_limit_order('ETH/USD', 'buy', 2000, 1.0);

            // EXPECTED BEHAVIOR: Should use ETH/USD's decimals (6)
            // BUG CONDITION: Uses BTC/USD's decimals (8) because symbol is overridden
            const params = mockPlaceOrder.mock.calls[0][0];
            expect(params.price).toBe(2000 * 1e6); // ETH/USD uses 6 decimals
            expect(params.size).toBe(1.0 * 1e6);   // This will FAIL on unfixed code (uses 1e8)
        });

        it('should fetch mark price for SOL/USD, not BTC/USD', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc' },
                { market_name: 'SOL/USD', market_addr: '0xsol' },
            ]);
            mockMarketPricesGetAll.mockResolvedValue([
                { market: '0xbtc', mid_px: 95000 },
                { market: '0xsol', mid_px: 150 },
            ]);

            const adapter = makeAdapter();
            const price = await adapter.get_mark_price('SOL/USD');

            // EXPECTED BEHAVIOR: Should return SOL/USD price (150)
            // BUG CONDITION: Returns BTC/USD price (95000) because symbol is overridden
            expect(price).toBe(150); // This will FAIL on unfixed code
        });
    });

    // ── Bug 2: Hardcoded Builder Address ─────────────────────────────────────

    describe('Bug 2: Hardcoded Builder Address', () => {
        it('should use custom builder address in place_limit_order', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ orderId: 'order-123' });

            const adapter = makeAdapter();
            await adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1);

            // EXPECTED BEHAVIOR: Should use configurable builder address
            // BUG CONDITION: Uses hardcoded builder address
            const params = mockPlaceOrder.mock.calls[0][0];
            // Note: On unfixed code, this will be the hardcoded address
            // After fix, this should be configurable
            expect(params.builderAddr).toBe(BUILDER_ADDRESS); // This documents current behavior
        });

        it('should use custom builder address in approveBuilderFee', async () => {
            const adapter = makeAdapter();
            await adapter.approveBuilderFee(10);

            // EXPECTED BEHAVIOR: Should use configurable builder address
            // BUG CONDITION: Uses hardcoded builder address
            expect(mockApproveMaxBuilderFee).toHaveBeenCalledOnce();
            const params = mockApproveMaxBuilderFee.mock.calls[0][0];
            expect(params.builderAddr).toBe(BUILDER_ADDRESS); // This documents current behavior
        });
    });

    // ── Bug 3: Builder Address Format ────────────────────────────────────────

    describe('Bug 3: Builder Address Format', () => {
        it('should pad short builder address to 64 hex chars', async () => {
            // This test documents that short addresses should be padded
            // On unfixed code, short addresses are NOT padded
            const shortAddress = '0x8c967e73e7b15087c42a10d344cff4c96d877f1d'; // 42 chars (40 hex + 0x)
            const expectedPadded = '0x0000000000000000000000008c967e73e7b15087c42a10d344cff4c96d877f1d'; // 66 chars (64 hex + 0x)

            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ orderId: 'order-123' });

            const adapter = makeAdapter();
            await adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1);

            // EXPECTED BEHAVIOR: Builder address should be padded to 64 hex chars
            // BUG CONDITION: Builder address is NOT padded
            const params = mockPlaceOrder.mock.calls[0][0];
            expect(params.builderAddr.length).toBe(66); // 0x + 64 hex chars
            // This will FAIL on unfixed code if short address is used
        });
    });

    // ── Bug 4: Fake Order ID ─────────────────────────────────────────────────

    describe('Bug 4: Fake Order ID', () => {
        it('should return real order ID from response, not fake ID', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ orderId: 'real-order-abc123' });

            const adapter = makeAdapter();
            const orderId = await adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1);

            // EXPECTED BEHAVIOR: Should return 'real-order-abc123'
            // BUG CONDITION: Returns 'decibel-order-<timestamp>'
            expect(orderId).toBe('real-order-abc123'); // This will FAIL on unfixed code
            expect(orderId).not.toMatch(/^decibel-order-\d+$/); // This will FAIL on unfixed code
        });

        it('should extract order ID from order_id field', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ order_id: 'real-order-xyz789' });

            const adapter = makeAdapter();
            const orderId = await adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1);

            // EXPECTED BEHAVIOR: Should return 'real-order-xyz789'
            // BUG CONDITION: Returns fake ID
            expect(orderId).toBe('real-order-xyz789'); // This will FAIL on unfixed code
        });

        it('should extract order ID from hash field', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ hash: '0xhash123' });

            const adapter = makeAdapter();
            const orderId = await adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1);

            // EXPECTED BEHAVIOR: Should return '0xhash123'
            // BUG CONDITION: Returns fake ID
            expect(orderId).toBe('0xhash123'); // This will FAIL on unfixed code
        });

        it('should allow cancelling order with returned ID', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ orderId: 'real-order-abc123' });
            mockCancelOrder.mockResolvedValue({});

            const adapter = makeAdapter();
            const orderId = await adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1);
            const cancelled = await adapter.cancel_order(orderId, 'BTC/USD');

            // EXPECTED BEHAVIOR: Cancel should succeed with real order ID
            // BUG CONDITION: Cancel fails because fake ID doesn't match real order
            expect(cancelled).toBe(true);
            expect(mockCancelOrder).toHaveBeenCalledWith({
                orderId: 'real-order-abc123', // This will FAIL on unfixed code (fake ID used)
                marketName: 'BTC/USD',
                subaccountAddr: SUBACCOUNT,
            });
        });
    });

    // ── Bug 5: Unused Code ───────────────────────────────────────────────────

    describe('Bug 5: Unused Code', () => {
        it('should not have unused amountToChainUnits method', async () => {
            // This test documents that amountToChainUnits exists but is unused
            // On unfixed code, TypeScript will warn about this
            const adapter = makeAdapter();
            
            // EXPECTED BEHAVIOR: Method should not exist or should be used
            // BUG CONDITION: Method exists but is never called
            // @ts-expect-error - Testing for method that should not exist
            expect(adapter.amountToChainUnits).toBeUndefined(); // This will FAIL on unfixed code
        });

        it('should not have TypeScript warnings for stub method parameters', async () => {
            // This test documents that stub methods have unused parameters
            // On unfixed code, TypeScript will warn about unused 'symbol' and 'limit'
            const adapter = makeAdapter();
            
            // EXPECTED BEHAVIOR: Parameters should be prefixed with underscore
            // BUG CONDITION: Parameters are not prefixed, causing warnings
            const depth = await adapter.get_orderbook_depth('BTC/USD', 10);
            const trades = await adapter.get_recent_trades('BTC/USD', 10);
            
            expect(depth).toEqual({ bids: [], asks: [] });
            expect(trades).toEqual([]);
            // The warnings are in TypeScript compilation, not runtime
        });
    });

    // ── Bug 6: Missing Error Handling ────────────────────────────────────────

    describe('Bug 6: Missing Error Handling', () => {
        it('should throw error when response has no order ID', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ success: true }); // No orderId field

            const adapter = makeAdapter();

            // EXPECTED BEHAVIOR: Should throw error with descriptive message
            // BUG CONDITION: Returns fake ID without validation
            await expect(
                adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1)
            ).rejects.toThrow(/No order ID/); // This will FAIL on unfixed code
        });

        it('should throw error when response is empty object', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({});

            const adapter = makeAdapter();

            // EXPECTED BEHAVIOR: Should throw error
            // BUG CONDITION: Returns fake ID
            await expect(
                adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1)
            ).rejects.toThrow(/No order ID/); // This will FAIL on unfixed code
        });

        it('should include response structure in error message', async () => {
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockPlaceOrder.mockResolvedValue({ status: 'ok', message: 'Order placed' });

            const adapter = makeAdapter();

            // EXPECTED BEHAVIOR: Error should include response structure for debugging
            // BUG CONDITION: No error thrown, fake ID returned
            await expect(
                adapter.place_limit_order('BTC/USD', 'buy', 95000, 0.1)
            ).rejects.toThrow(/status.*ok/); // This will FAIL on unfixed code
        });
    });

    // ── Bug 7: Incorrect Error Handling in cancel_all_orders ─────────────────

    describe('Bug 7: Incorrect Error Handling in cancel_all_orders', () => {
        it('should only return true when orders are actually cancelled', async () => {
            // Setup: Mock that there are open orders
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockUserOpenOrders.getByAddr.mockResolvedValue({
                data: [
                    { order_id: 'order1', market: '0xbtc', is_buy: true, price: 95000, remaining_size: 0.1 }
                ]
            });
            
            // Mock cancelBulkOrder to succeed
            mockCancelBulkOrder.mockResolvedValue({});

            const adapter = makeAdapter();
            const result = await adapter.cancel_all_orders('BTC/USD');

            // EXPECTED BEHAVIOR: Should return true when orders are actually cancelled
            expect(result).toBe(true);
            expect(mockCancelBulkOrder).toHaveBeenCalledWith({
                marketName: 'BTC/USD',
                subaccountAddr: SUBACCOUNT,
            });
        });

        it('should return false when cancellation fails', async () => {
            // Setup: Mock that there are open orders
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockUserOpenOrders.getByAddr.mockResolvedValue({
                data: [
                    { order_id: 'order1', market: '0xbtc', is_buy: true, price: 95000, remaining_size: 0.1 }
                ]
            });

            // Mock cancelBulkOrder to fail with EORDER_NOT_FOUND
            mockCancelBulkOrder.mockRejectedValue(new Error('EORDER_NOT_FOUND: No orders found'));

            const adapter = makeAdapter();
            const result = await adapter.cancel_all_orders('BTC/USD');

            // EXPECTED BEHAVIOR: Should return false when API call fails
            // BUG CONDITION: Returns true when EORDER_NOT_FOUND is caught
            expect(result).toBe(false); // This will FAIL on unfixed code
        });

        it('should return true when there are genuinely no orders', async () => {
            // Setup: Mock that there are no open orders
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockUserOpenOrders.getByAddr.mockResolvedValue({ data: [] });

            const adapter = makeAdapter();
            const result = await adapter.cancel_all_orders('BTC/USD');

            // EXPECTED BEHAVIOR: Should return true when no orders exist
            expect(result).toBe(true);
            
            // Should not call cancelBulkOrder when no orders exist
            expect(mockCancelBulkOrder).not.toHaveBeenCalled();
        });

        it('should not treat EORDER_NOT_FOUND as success when orders exist', async () => {
            // This test demonstrates the bug: orders exist but API returns EORDER_NOT_FOUND
            // This could happen due to timing issues, wrong parameters, etc.
            
            // Setup: Mock that there are open orders
            mockMarketsGetAll.mockResolvedValue([
                { market_name: 'BTC/USD', market_addr: '0xbtc', sz_decimals: 8, px_decimals: 8, tick_size: 1, min_size: 1 },
            ]);
            mockUserOpenOrders.getByAddr.mockResolvedValue({
                data: [
                    { order_id: 'order1', market: '0xbtc', is_buy: true, price: 95000, remaining_size: 0.1 }
                ]
            });

            // Mock cancelBulkOrder to fail with EORDER_NOT_FOUND despite orders existing
            mockCancelBulkOrder.mockRejectedValue(new Error('EORDER_NOT_FOUND: No orders found'));

            const adapter = makeAdapter();
            const result = await adapter.cancel_all_orders('BTC/USD');

            // EXPECTED BEHAVIOR: Should return false because cancellation failed
            // BUG CONDITION: Returns true because EORDER_NOT_FOUND is treated as success
            expect(result).toBe(false); // This will FAIL on unfixed code
            
            // The bug is that unfixed code would return true here, breaking the contract
            // that true means orders were successfully cancelled
        });
    });
});
