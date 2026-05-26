import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HibachiAdapter } from '../hibachi_adapter.js';

// ── Mock fetch globally ───────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ── Helper to create a mock Response ─────────────────────────────────────────

function mockResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EXCHANGE_INFO_FIXTURE = {
    contracts: [
        {
            contractId: 1,
            symbol: 'BTC-USDT',
            underlyingDecimals: 8,
            settlementDecimals: 6,
            settlementAsset: 'USDT',
            minQuantity: 0.001,
            tickSize: 0.1,
        },
        {
            contractId: 2,
            symbol: 'ETH-USDT',
            underlyingDecimals: 8,
            settlementDecimals: 6,
            settlementAsset: 'USDT',
            minQuantity: 0.01,
            tickSize: 0.01,
        },
    ],
};

// ── Adapter config ────────────────────────────────────────────────────────────

// Hardhat test key #0 — well-known, safe to use in tests
const TRUSTLESS_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const adapter = new HibachiAdapter({
    apiKey: 'test-api-key',
    accountId: 123,
    accountType: 'trustless',
    privateKey: TRUSTLESS_PRIVATE_KEY,
});

// ── Reset mocks between tests ─────────────────────────────────────────────────

beforeEach(() => {
    mockFetch.mockReset();
    // Also clear the internal exchange info cache so each test starts fresh
    (adapter as any)._infoCache.clear();
    (adapter as any)._infoCacheExpiry.clear();
});

// ── Integration tests ─────────────────────────────────────────────────────────

describe('HibachiAdapter — integration tests (mocked HTTP)', () => {

    // ── 1. place_limit_order full flow ────────────────────────────────────────

    describe('place_limit_order', () => {
        it('fetches exchange-info, signs, POSTs to /trade/order, and returns orderId', async () => {
            // First call: GET /market/exchange-info
            mockFetch.mockResolvedValueOnce(mockResponse(EXCHANGE_INFO_FIXTURE));
            // Second call: POST /trade/order
            mockFetch.mockResolvedValueOnce(mockResponse({ orderId: '999' }));

            const result = await adapter.place_limit_order('BTC-USDT', 'buy', 65000, 0.001);

            expect(result).toBe('999');

            // Verify the POST was made to /trade/order
            const calls = mockFetch.mock.calls;
            expect(calls.length).toBe(2);

            const postCall = calls[1];
            const postUrl: string = postCall[0];
            expect(postUrl).toContain('/trade/order');

            const postOptions = postCall[1];
            expect(postOptions.method).toBe('POST');
        });
    });

    // ── 2. get_open_orders filters by contractId ──────────────────────────────

    describe('get_open_orders', () => {
        it('filters orders by contractId and returns only BTC-USDT orders', async () => {
            // First call: GET /market/exchange-info
            mockFetch.mockResolvedValueOnce(mockResponse(EXCHANGE_INFO_FIXTURE));
            // Second call: GET /account/orders — returns orders for both contractId 1 and 2
            mockFetch.mockResolvedValueOnce(mockResponse([
                {
                    orderId: 'order-btc-1',
                    contractId: 1,
                    side: 0,
                    price: '279172874240000',
                    quantity: '100000',
                    status: 'open',
                },
                {
                    orderId: 'order-eth-1',
                    contractId: 2,
                    side: 1,
                    price: '18000000000000',
                    quantity: '500000',
                    status: 'open',
                },
                {
                    orderId: 'order-btc-2',
                    contractId: 1,
                    side: 1,
                    price: '280000000000000',
                    quantity: '200000',
                    status: 'open',
                },
            ]));

            const orders = await adapter.get_open_orders('BTC-USDT');

            // Only BTC-USDT orders (contractId 1) should be returned
            expect(orders.length).toBe(2);
            expect(orders.every(o => o.symbol === 'BTC-USDT')).toBe(true);
            expect(orders.map(o => o.id)).toContain('order-btc-1');
            expect(orders.map(o => o.id)).toContain('order-btc-2');
            expect(orders.map(o => o.id)).not.toContain('order-eth-1');
        });
    });

    // ── 3. get_position returns null for zero-size position ───────────────────

    describe('get_position', () => {
        it('returns null when position size is zero', async () => {
            // First call: GET /market/exchange-info
            mockFetch.mockResolvedValueOnce(mockResponse(EXCHANGE_INFO_FIXTURE));
            // Second call: GET /account/positions — returns a zero-size position
            mockFetch.mockResolvedValueOnce(mockResponse([
                { contractId: 1, size: '0', entryPrice: '0' },
            ]));

            const position = await adapter.get_position('BTC-USDT');

            expect(position).toBeNull();
        });

        it('returns null when no position exists for the symbol', async () => {
            // First call: GET /market/exchange-info
            mockFetch.mockResolvedValueOnce(mockResponse(EXCHANGE_INFO_FIXTURE));
            // Second call: GET /account/positions — returns positions for a different contract
            mockFetch.mockResolvedValueOnce(mockResponse([
                { contractId: 2, size: '500000', entryPrice: '18000000000000' },
            ]));

            const position = await adapter.get_position('BTC-USDT');

            expect(position).toBeNull();
        });
    });

    // ── 4. get_balance returns 0 on 404 ──────────────────────────────────────

    describe('get_balance', () => {
        it('returns 0 when /account/info returns 404', async () => {
            // The adapter may call exchange-info first if cache is empty,
            // but get_balance itself only calls /account/info.
            // We mock /account/info to return 404 (null from _request).
            mockFetch.mockResolvedValueOnce(mockResponse(null, 404));

            const balance = await adapter.get_balance();

            expect(balance).toBe(0);
        });

        it('returns the balance value on success', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({ equity: '1234.56' }));

            const balance = await adapter.get_balance();

            expect(balance).toBeCloseTo(1234.56, 2);
        });
    });

    // ── 5. cancel_order returns false on API error ────────────────────────────

    describe('cancel_order', () => {
        it('returns false (does not throw) when fetch throws an error', async () => {
            // Pre-populate the cache so cancel_order doesn't need exchange-info
            // (cancel_order doesn't call _getContractInfo, so no exchange-info needed)
            mockFetch.mockRejectedValueOnce(new Error('Network error'));

            const result = await adapter.cancel_order('12345', 'BTC-USDT');

            expect(result).toBe(false);
        });

        it('returns false when API returns a non-2xx error', async () => {
            mockFetch.mockResolvedValueOnce(mockResponse({ error: 'Order not found' }, 500));

            const result = await adapter.cancel_order('12345', 'BTC-USDT');

            expect(result).toBe(false);
        });
    });

    // ── 6. get_markets returns sorted symbol list ─────────────────────────────

    describe('get_markets', () => {
        it('returns sorted array of symbol strings', async () => {
            // Mock exchange-info with BTC-USDT and ETH-USDT
            mockFetch.mockResolvedValueOnce(mockResponse(EXCHANGE_INFO_FIXTURE));

            const markets = await adapter.get_markets();

            expect(markets).toEqual(['BTC-USDT', 'ETH-USDT']);
        });

        it('returns symbols in alphabetical order', async () => {
            // Fixture with reversed order to verify sorting
            const reversedFixture = {
                contracts: [
                    EXCHANGE_INFO_FIXTURE.contracts[1], // ETH-USDT first
                    EXCHANGE_INFO_FIXTURE.contracts[0], // BTC-USDT second
                ],
            };
            mockFetch.mockResolvedValueOnce(mockResponse(reversedFixture));

            const markets = await adapter.get_markets();

            expect(markets).toEqual(['BTC-USDT', 'ETH-USDT']);
        });
    });

});
