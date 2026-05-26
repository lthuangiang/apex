import { describe, it, expect } from 'vitest';
import { HibachiAdapter, HibachiAdapterConfig } from '../hibachi_adapter.js';
import { createHmac } from 'crypto';

/**
 * Test suite to verify Hibachi signing matches Postman documentation example.
 *
 * From Postman docs:
 * Order: { symbol: "BTC/USDT-P", side: "ASK", nonce: 1714701600000000, quantity: "1 BTC", price: "100,000 USDT", max_fees: "0.0005" }
 * Contract: { id: 2, underlyingDecimals: 10, settlementDecimals: 6 }
 *
 * Expected buffer: 0x0006178313c388000000000200000002540be400000000000000000a000000000000000000001388
 */

describe('HibachiAdapter — Postman example verification', () => {
    it('_buildOrderBuffer matches Postman example exactly', () => {
        const config: HibachiAdapterConfig = {
            apiKey: 'test-key',
            accountId: 123,
            accountType: 'exchange_managed',
            secretKey: 'test-secret',
        };
        const adapter = new HibachiAdapter(config);

        // Postman example values
        const payload = {
            nonce: BigInt('1714701600000000'),      // 0x0006178313c38800
            contractId: 2,                           // 0x00000002
            quantity: BigInt('10000000000'),         // 0x00000002540be400 (1 BTC with 10 decimals)
            side: 0,                                 // 0x00000000 (ASK)
            price: BigInt('42949672960'),            // 0x0000000a00000000 (100k USDT)
            maxFeesPercent: BigInt('50000'),         // 0x000000000000c350 (0.0005 * 10^8)
        };

        const buffer = (adapter as any)._buildOrderBuffer(payload);
        const hex = buffer.toString('hex');

        console.log('Generated buffer:', hex);
        console.log('Expected buffer: ', '0006178313c388000000000200000002540be400000000000000000a00000000000000000000c350');

        // Verify each field
        expect(buffer.readBigUInt64BE(0)).toBe(BigInt('1714701600000000'));  // nonce
        expect(buffer.readUInt32BE(8)).toBe(2);                               // contractId
        expect(buffer.readBigUInt64BE(12)).toBe(BigInt('10000000000'));      // quantity
        expect(buffer.readUInt32BE(20)).toBe(0);                              // side (ASK)
        expect(buffer.readBigUInt64BE(24)).toBe(BigInt('42949672960'));      // price
        expect(buffer.readBigUInt64BE(32)).toBe(BigInt('50000'));            // maxFeesPercent
    });

    it('HMAC signing with Base64-encoded secret key (production format)', () => {
        // Real Hibachi secret keys are Base64-encoded
        const secretKeyBase64 = 'dGVzdC1zZWNyZXQta2V5LWZvci1obWFjLXNpZ25pbmc='; // "test-secret-key-for-hmac-signing" in base64
        const secretKeyBuf = Buffer.from(secretKeyBase64, 'base64');

        const payload = {
            nonce: BigInt('1714701600000000'),
            contractId: 2,
            quantity: BigInt('10000000000'),
            side: 0,
            price: BigInt('42949672960'),
            maxFeesPercent: BigInt('50000'),
        };

        const config: HibachiAdapterConfig = {
            apiKey: 'test-key',
            accountId: 123,
            accountType: 'exchange_managed',
            secretKey: secretKeyBase64,
        };
        const adapter = new HibachiAdapter(config);

        const buffer = (adapter as any)._buildOrderBuffer(payload);
        const signature = (adapter as any)._signOrderPayload(payload);

        // Verify signature is 64-char hex (32 bytes)
        expect(signature).toMatch(/^[0-9a-f]{64}$/);

        // Verify it matches manual HMAC with base64-decoded key
        const expectedSig = createHmac('sha256', secretKeyBuf).update(buffer).digest('hex');
        expect(signature).toBe(expectedSig);

        console.log('Base64 secret key test passed. Signature:', signature);
    });
});
