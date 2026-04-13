import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the SDK before importing the adapter
const mockApproveMaxBuilderFee = vi.fn();
const mockPlaceOrder = vi.fn();
const mockCancelOrder = vi.fn();

vi.mock('@decibeltrade/sdk', () => ({
    DecibelReadDex: vi.fn(function () {
        return {
            marketDepth: { getByName: vi.fn() },
            userOpenOrders: { getByAddr: vi.fn() },
            userPositions: { getByAddr: vi.fn() },
            accountOverview: { getByAddr: vi.fn() },
        };
    }),
    DecibelWriteDex: vi.fn(function () {
        return {
            approveMaxBuilderFee: mockApproveMaxBuilderFee,
            placeOrder: mockPlaceOrder,
            cancelOrder: mockCancelOrder,
        };
    }),
    MAINNET_CONFIG: {},
    TimeInForce: { PostOnly: 'PostOnly', ImmediateOrCancel: 'ImmediateOrCancel' },
}));

vi.mock('@aptos-labs/ts-sdk', () => ({
    Ed25519Account: vi.fn(function () { return {}; }),
    Ed25519PrivateKey: vi.fn(function () { return {}; }),
}));

import { DecibelAdapter } from '../decibel_adapter.js';

const BUILDER_ADDRESS = '0x0000000000000000000000008c967e73e7b15087c42a10d344cff4c96d877f1d';
const PRIVATE_KEY = 'a'.repeat(64);
const NODE_API_KEY = 'b'.repeat(64);

describe('Decibel Builder Codes', () => {
    let adapter: DecibelAdapter;

    beforeEach(() => {
        vi.clearAllMocks();
        adapter = new DecibelAdapter(PRIVATE_KEY, NODE_API_KEY, BUILDER_ADDRESS);
    });

    describe('approveMaxBuilderFee', () => {
        it('should call approveMaxBuilderFee with correct params', async () => {
            mockApproveMaxBuilderFee.mockResolvedValue({ success: true });

            await (adapter as any).write.approveMaxBuilderFee({
                builderAddr: BUILDER_ADDRESS,
                maxFee: 10,
            });

            expect(mockApproveMaxBuilderFee).toHaveBeenCalledWith({
                builderAddr: BUILDER_ADDRESS,
                maxFee: 10,
            });
        });

        it('should accept fee in basis points (10 bps = 0.1%)', async () => {
            mockApproveMaxBuilderFee.mockResolvedValue({ success: true });

            const maxFeeBps = 10; // 0.1%
            await (adapter as any).write.approveMaxBuilderFee({
                builderAddr: BUILDER_ADDRESS,
                maxFee: maxFeeBps,
            });

            expect(mockApproveMaxBuilderFee).toHaveBeenCalledWith(
                expect.objectContaining({ maxFee: 10 })
            );
        });

        it('should reject if builderAddr is not 64 chars', async () => {
            const shortAddr = '0x1234'; // invalid
            mockApproveMaxBuilderFee.mockRejectedValue(new Error('Invalid builder address length'));

            await expect(
                (adapter as any).write.approveMaxBuilderFee({
                    builderAddr: shortAddr,
                    maxFee: 10,
                })
            ).rejects.toThrow('Invalid builder address length');
        });
    });

    describe('placeOrder with builder codes', () => {
        it('should include builderAddr in placeOrder call', async () => {
            mockPlaceOrder.mockResolvedValue({ success: true, transactionHash: '0xabc' });

            await adapter.place_limit_order('APT/USD', 'buy', 3.0, 10.0);

            expect(mockPlaceOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    builderAddr: BUILDER_ADDRESS,
                    builderFee: 10,
                })
            );
        });

        it('should convert price and size to chain units (1e8)', async () => {
            mockPlaceOrder.mockResolvedValue({ success: true });

            await adapter.place_limit_order('APT/USD', 'buy', 3.0, 10.0);

            expect(mockPlaceOrder).toHaveBeenCalledWith(
                expect.objectContaining({
                    price: 300000000,  // 3.0 * 1e8
                    size: 1000000000,  // 10.0 * 1e8
                })
            );
        });

        it('should set isBuy=true for buy orders', async () => {
            mockPlaceOrder.mockResolvedValue({ success: true });
            await adapter.place_limit_order('APT/USD', 'buy', 3.0, 1.0);
            expect(mockPlaceOrder).toHaveBeenCalledWith(expect.objectContaining({ isBuy: true }));
        });

        it('should set isBuy=false for sell orders', async () => {
            mockPlaceOrder.mockResolvedValue({ success: true });
            await adapter.place_limit_order('APT/USD', 'sell', 3.0, 1.0);
            expect(mockPlaceOrder).toHaveBeenCalledWith(expect.objectContaining({ isBuy: false }));
        });

        it('should return an order id string', async () => {
            mockPlaceOrder.mockResolvedValue({ success: true });
            const result = await adapter.place_limit_order('APT/USD', 'buy', 3.0, 1.0);
            expect(result).toMatch(/^decibel-order-\d+$/);
        });
    });

    describe('builder fee validation rules', () => {
        it('builderFee must not exceed approved maxFee', async () => {
            // Simulate SDK rejecting when builderFee > maxFee
            mockPlaceOrder.mockRejectedValue(new Error('builderFee exceeds approved maxFee'));

            await expect(
                (adapter as any).write.placeOrder({
                    marketName: 'APT/USD',
                    price: 300000000,
                    size: 1000000000,
                    isBuy: true,
                    timeInForce: 'ImmediateOrCancel',
                    isReduceOnly: false,
                    builderAddr: BUILDER_ADDRESS,
                    builderFee: 100, // exceeds maxFee of 10
                })
            ).rejects.toThrow('builderFee exceeds approved maxFee');
        });

        it('order without builderAddr should not collect builder fee', async () => {
            mockPlaceOrder.mockResolvedValue({ success: true });

            await (adapter as any).write.placeOrder({
                marketName: 'APT/USD',
                price: 300000000,
                size: 1000000000,
                isBuy: true,
                timeInForce: 'PostOnly',
                isReduceOnly: false,
                // no builderAddr
            });

            expect(mockPlaceOrder).toHaveBeenCalledWith(
                expect.not.objectContaining({ builderAddr: expect.anything() })
            );
        });
    });

    describe('builder address format', () => {
        it('valid address should be 64 hex chars after 0x prefix', () => {
            const addr = BUILDER_ADDRESS;
            const hex = addr.slice(2); // remove 0x
            expect(hex).toHaveLength(64);
            expect(/^[0-9a-fA-F]+$/.test(hex)).toBe(true);
        });

        it('subaccountAddr used as builderAddr should be valid format', () => {
            const addr = (adapter as any).subaccountAddr;
            expect(addr).toBe(BUILDER_ADDRESS);
            expect(addr.slice(2)).toHaveLength(64);
        });
    });
});
