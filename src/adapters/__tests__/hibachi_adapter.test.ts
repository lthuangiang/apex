import { describe, it, expect } from 'vitest';
import { HibachiAdapter, HibachiAdapterConfig } from '../hibachi_adapter.js';

// ── Test adapter instances ────────────────────────────────────────────────────

// Hardhat test key #0 — well-known, safe to use in tests
const TRUSTLESS_PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const trustlessConfig: HibachiAdapterConfig = {
    apiKey: 'test-api-key',
    accountId: 123,
    accountType: 'trustless',
    privateKey: TRUSTLESS_PRIVATE_KEY,
};

const hmacConfig: HibachiAdapterConfig = {
    apiKey: 'test-api-key',
    accountId: 123,
    accountType: 'exchange_managed',
    secretKey: 'test-secret-key',
};

const trustlessAdapter = new HibachiAdapter(trustlessConfig);
const hmacAdapter = new HibachiAdapter(hmacConfig);

// ── Encoding helpers ──────────────────────────────────────────────────────────

describe('HibachiAdapter — encoding helpers', () => {
    it('_encodeQuantity(0.001, 8) → 100000n', () => {
        const result = (trustlessAdapter as any)._encodeQuantity(0.001, 8);
        expect(result).toBe(100000n);
    });

    it('_encodeQuantity(1.5, 6) → 1500000n', () => {
        const result = (trustlessAdapter as any)._encodeQuantity(1.5, 6);
        expect(result).toBe(1500000n);
    });

    it('_encodePrice(65000.0, 8, 6) → expected positive BigInt', () => {
        const result = (trustlessAdapter as any)._encodePrice(65000.0, 8, 6);
        // Formula: BigInt(Math.round(65000 * 2^32 * 10^(6-8)))
        const expected = BigInt(Math.round(65000 * Math.pow(2, 32) * Math.pow(10, 6 - 8)));
        expect(result).toBe(expected);
        expect(result > 0n).toBe(true);
    });

    it('_decodeQuantity(100000n, 8) → 0.001', () => {
        const result = (trustlessAdapter as any)._decodeQuantity(100000n, 8);
        expect(result).toBeCloseTo(0.001, 10);
    });

    it('_decodePrice round-trip: encode then decode ≈ original', () => {
        const originalPrice = 65000.0;
        const underlyingDecimals = 8;
        const settlementDecimals = 6;

        const encoded = (trustlessAdapter as any)._encodePrice(
            originalPrice,
            underlyingDecimals,
            settlementDecimals
        );
        const decoded = (trustlessAdapter as any)._decodePrice(
            encoded,
            underlyingDecimals,
            settlementDecimals
        );

        // Round-trip should be within floating-point precision
        expect(decoded).toBeCloseTo(originalPrice, 2);
    });
});

// ── Nonce generation ──────────────────────────────────────────────────────────

describe('HibachiAdapter — nonce generation', () => {
    it('two consecutive calls → second > first', () => {
        const nonce1 = (trustlessAdapter as any)._buildNonce();
        const nonce2 = (trustlessAdapter as any)._buildNonce();
        expect(nonce2 > nonce1).toBe(true);
    });

    it('nonce is a BigInt', () => {
        const nonce = (trustlessAdapter as any)._buildNonce();
        expect(typeof nonce).toBe('bigint');
    });

    it('nonce is positive', () => {
        const nonce = (trustlessAdapter as any)._buildNonce();
        expect(nonce > 0n).toBe(true);
    });
});

// ── ECDSA signing ─────────────────────────────────────────────────────────────

describe('HibachiAdapter — ECDSA signing', () => {
    const testPayload = {
        nonce: 1700000000000000n,
        contractId: 1,
        quantity: 100000n,
        side: 0,
        price: 279172874240000n,
        maxFeesPercent: 100n,
    };

    it('_signOrderPayload → 132-char hex string starting with 0x', () => {
        const sig = (trustlessAdapter as any)._signOrderPayload(testPayload);
        expect(typeof sig).toBe('string');
        expect(sig.length).toBe(132);
        expect(sig.startsWith('0x')).toBe(true);
    });

    it('_signCancelOrder(12345n) → 132-char hex string starting with 0x', () => {
        const sig = (trustlessAdapter as any)._signCancelOrder(12345n);
        expect(typeof sig).toBe('string');
        expect(sig.length).toBe(132);
        expect(sig.startsWith('0x')).toBe(true);
    });

    it('_signCancelAll(nonce) → 132-char hex string starting with 0x', () => {
        const nonce = (trustlessAdapter as any)._buildNonce();
        const sig = (trustlessAdapter as any)._signCancelAll(nonce);
        expect(typeof sig).toBe('string');
        expect(sig.length).toBe(132);
        expect(sig.startsWith('0x')).toBe(true);
    });

    it('_signOrderPayload produces deterministic output for same input', () => {
        // Create a fresh adapter with the same key to avoid nonce state interference
        const adapter2 = new HibachiAdapter(trustlessConfig);
        const sig1 = (trustlessAdapter as any)._signOrderPayload(testPayload);
        const sig2 = (adapter2 as any)._signOrderPayload(testPayload);
        // ECDSA with the same key and payload should produce the same signature
        expect(sig1).toBe(sig2);
    });
});

// ── HMAC signing ──────────────────────────────────────────────────────────────

describe('HibachiAdapter — HMAC signing', () => {
    const testPayload = {
        nonce: 1700000000000000n,
        contractId: 1,
        quantity: 100000n,
        side: 0,
        price: 279172874240000n,
        maxFeesPercent: 100n,
    };

    it('_signOrderPayload with hmacAdapter → 64-char hex string (no 0x prefix)', () => {
        const sig = (hmacAdapter as any)._signOrderPayload(testPayload);
        expect(typeof sig).toBe('string');
        expect(sig.length).toBe(64);
        expect(sig.startsWith('0x')).toBe(false);
    });

    it('_signCancelOrder with hmacAdapter → 64-char hex string', () => {
        const sig = (hmacAdapter as any)._signCancelOrder(12345n);
        expect(typeof sig).toBe('string');
        expect(sig.length).toBe(64);
        expect(sig.startsWith('0x')).toBe(false);
    });

    it('_signCancelAll with hmacAdapter → 64-char hex string', () => {
        const nonce = (hmacAdapter as any)._buildNonce();
        const sig = (hmacAdapter as any)._signCancelAll(nonce);
        expect(typeof sig).toBe('string');
        expect(sig.length).toBe(64);
        expect(sig.startsWith('0x')).toBe(false);
    });

    it('_signOrderPayload HMAC is deterministic for same input', () => {
        const adapter2 = new HibachiAdapter(hmacConfig);
        const sig1 = (hmacAdapter as any)._signOrderPayload(testPayload);
        const sig2 = (adapter2 as any)._signOrderPayload(testPayload);
        expect(sig1).toBe(sig2);
    });
});
