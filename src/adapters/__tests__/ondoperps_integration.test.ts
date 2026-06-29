import { describe, it, expect } from 'vitest';
import { OndoPerpsAdapter } from '../ondoperps_adapter';

/**
 * Integration tests for OndoPerps API
 * These tests require real credentials and hit the actual API
 * Use .skip to prevent running in CI - only run manually for verification
 */

const adapter = new OndoPerpsAdapter({
  apiKeyId: process.env.ONDOPERPS_API_KEY_ID || 'test-key',
  apiKeySecret: process.env.ONDOPERPS_API_KEY_SECRET || 'test-secret',
  baseUrl: process.env.ONDOPERPS_BASE_URL
});

describe('OndoPerps Integration Tests', () => {
  it.skip('should fetch real markets', async () => {
    await adapter.connect();

    console.log('✓ Connected successfully');
    console.log('✓ Supported symbols:', adapter.supportedSymbols.slice(0, 5));

    expect(adapter.supportedSymbols.length).toBeGreaterThan(0);
    expect(adapter.isConnected()).toBe(true);
  }, 10000);

  it.skip('should fetch real balance', async () => {
    const balance = await adapter.getBalance();

    console.log('✓ Balance:', balance);

    expect(balance).toHaveProperty('total');
    expect(balance).toHaveProperty('available');
    expect(balance).toHaveProperty('currency');
  }, 10000);

  it.skip('should fetch real positions', async () => {
    const positions = await adapter.getPositions();

    console.log('✓ Positions:', positions);

    expect(Array.isArray(positions)).toBe(true);
  }, 10000);

  it.skip('should fetch open orders', async () => {
    const orders = await adapter.getOpenOrders();

    console.log('✓ Open orders:', orders);

    expect(Array.isArray(orders)).toBe(true);
  }, 10000);

  /**
   * WARNING: This test places a REAL order
   * Uncomment only when testing with small amounts on testnet/sandbox
   */
  it.skip('should place and cancel real order', async () => {
    // Place a limit order far from market price to avoid fill
    const order = await adapter.placeOrder({
      symbol: 'XAU-PERP',
      side: 'long',
      type: 'LIMIT',
      price: 1000, // Far below market
      size: 0.01 // Minimum size
    });

    console.log('✓ Order placed:', order);

    expect(order.id).toBeDefined();
    expect(order.status).toBe('OPEN');

    // Cancel the order
    await adapter.cancelOrder(order.id);
    console.log('✓ Order cancelled');

    // Verify cancellation
    const cancelledOrder = await adapter.getOrder(order.id);
    expect(cancelledOrder.status).toBe('CANCELLED');
  }, 15000);
});
