import { describe, it, expect, beforeAll } from 'vitest';
import { PerplAdapter } from '../perpl_adapter.js';

/**
 * Perpl integration tests — hit the real API.
 * Run manually: npx vitest run src/adapters/__tests__/perpl_integration.test.ts
 * All tests are .skip by default to avoid running in CI.
 *
 * Set env vars before running:
 *   PERPL_API_KEY=OgGqTSum...
 *   PERPL_API_KEY_SECRET=0x466a5c...
 */

const adapter = new PerplAdapter({
  apiKey: process.env.PERPL_API_KEY || '',
  apiKeySecret: process.env.PERPL_API_KEY_SECRET || '',
});

const SYMBOL = 'BTC-PERP';

// ── 1. Public context (no auth needed) ───────────────────────────────────────

describe('Perpl — raw context (debug)', () => {
  it('logs raw /v1/pub/context response', async () => {
    const url = 'https://app.perpl.xyz/api/v1/pub/context';
    const res = await fetch(url);
    const raw = await res.json();
    console.log('HTTP status:', res.status);
    console.log('Keys:', Object.keys(raw));
    console.log('Markets sample:', JSON.stringify((raw.markets ?? []).slice(0, 2), null, 2));
    expect(res.ok).toBe(true);
  }, 10_000);
});

describe('Perpl — fetchMarkets (public)', () => {
  it('should fetch markets and map symbols', async () => {
    await adapter.fetchMarkets();

    console.log('Supported symbols:', adapter.supportedSymbols);

    expect(adapter.supportedSymbols.length).toBeGreaterThan(0);
    expect(adapter.supportedSymbols).toContain('BTC-PERP');
    expect(adapter.supportedSymbols.some(s => s.endsWith('-PERP'))).toBe(true);
  }, 10_000);
});

// ── 2. Market data (public) ───────────────────────────────────────────────────

describe('Perpl — market data (public)', () => {
  beforeAll(() => adapter.fetchMarkets());

  it('get_mark_price — returns a positive number', async () => {
    const price = await adapter.get_mark_price(SYMBOL);
    console.log('Mark price:', price);
    expect(typeof price).toBe('number');
    expect(price).toBeGreaterThan(0);
  }, 10_000);

  it('get_orderbook — returns best bid/ask', async () => {
    const ob = await adapter.get_orderbook(SYMBOL);
    console.log('Orderbook:', ob);
    expect(ob.best_bid).toBeGreaterThan(0);
    expect(ob.best_ask).toBeGreaterThan(ob.best_bid);
  }, 10_000);

  it('get_klines — returns candles array', async () => {
    const klines = await adapter.get_klines!(SYMBOL, '1h', 10);
    console.log(`Klines (${klines.length}):`, klines[0]);
    expect(Array.isArray(klines)).toBe(true);
    expect(klines.length).toBeGreaterThan(0);
    const k = klines[0];
    expect(k).toHaveProperty('t');
    expect(k).toHaveProperty('o');
    expect(k).toHaveProperty('h');
    expect(k).toHaveProperty('l');
    expect(k).toHaveProperty('c');
    expect(k.h).toBeGreaterThanOrEqual(k.l);
  }, 15_000);
});

// ── 3. Authenticated — WebSocket + account (requires real credentials) ────────

describe.skip('Perpl — authenticated (WebSocket)', () => {
  beforeAll(async () => {
    await adapter.connect();
    // Give WalletSnapshot a moment to arrive
    await new Promise(r => setTimeout(r, 2000));
  }, 15_000);

  it('isConnected — WebSocket authenticated', () => {
    expect(adapter.isConnected()).toBe(true);
  });

  it('get_balance — returns a number', async () => {
    const balance = await adapter.get_balance();
    console.log('Balance:', balance);
    expect(typeof balance).toBe('number');
    expect(balance).toBeGreaterThanOrEqual(0);
  }, 10_000);

  it('get_position — returns null or Position', async () => {
    const pos = await adapter.get_position(SYMBOL);
    console.log('Position:', pos);
    if (pos !== null) {
      expect(pos).toHaveProperty('symbol', SYMBOL);
      expect(['long', 'short']).toContain(pos.side);
      expect(pos.size).toBeGreaterThan(0);
      expect(pos.entryPrice).toBeGreaterThan(0);
    }
  }, 10_000);

  it('get_open_orders — returns array', async () => {
    const orders = await adapter.get_open_orders(SYMBOL);
    console.log('Open orders:', orders.length);
    expect(Array.isArray(orders)).toBe(true);
  }, 10_000);
});

// ── 4. Order placement — WARNING: places real orders ─────────────────────────

describe.skip('Perpl — order placement (REAL ORDERS — testnet only)', () => {
  beforeAll(async () => {
    await adapter.connect();
    await new Promise(r => setTimeout(r, 2000));
  }, 15_000);

  it('place_limit_order + cancel_order round-trip', async () => {
    const price = await adapter.get_mark_price(SYMBOL);
    // Place far below market to avoid fill
    const limitPrice = Math.floor(price * 0.5);
    const size = 0.0001;

    console.log(`Placing limit BUY ${size} ${SYMBOL} @ $${limitPrice}`);
    const orderId = await adapter.place_limit_order(SYMBOL, 'buy', limitPrice, size);
    console.log('Order ID (rq):', orderId);
    expect(orderId).toBeTruthy();

    // Small delay for server to register
    await new Promise(r => setTimeout(r, 1000));

    const cancelled = await adapter.cancel_order(orderId, SYMBOL);
    console.log('Cancelled:', cancelled);
    expect(cancelled).toBe(true);
  }, 30_000);

  it('cancel_all_orders — completes without throwing', async () => {
    const result = await adapter.cancel_all_orders(SYMBOL);
    console.log('cancel_all result:', result);
    expect(typeof result).toBe('boolean');
  }, 15_000);
});
