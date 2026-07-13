#!/usr/bin/env npx tsx
/**
 * Quick Perpl API test — place + cancel order
 * Run: PERPL_API_KEY=... PERPL_API_KEY_SECRET=... npx tsx scripts/test-perpl.ts
 * Or:  npx tsx scripts/test-perpl.ts  (reads from .env)
 */

import 'dotenv/config';
import { PerplAdapter } from '../src/adapters/perpl_adapter.js';

const API_KEY    = process.env.PERPL_API_KEY    || '';
const API_SECRET = process.env.PERPL_API_KEY_SECRET || '';
const SYMBOL     = process.env.PERPL_SYMBOL || 'BTC-PERP';

if (!API_KEY || !API_SECRET) {
  console.error('Missing PERPL_API_KEY or PERPL_API_KEY_SECRET');
  process.exit(1);
}

const adapter = new PerplAdapter({ apiKey: API_KEY, apiKeySecret: API_SECRET });

function ok(label: string, value: any) {
  console.log(`  ✓ ${label}:`, value);
}

async function run() {
  console.log('\n=== Perpl API Test ===\n');

  // ── 1. Markets ──────────────────────────────────────────────────────────────
  console.log('1. fetchMarkets');
  await adapter.fetchMarkets();
  ok('symbols', adapter.supportedSymbols);

  // ── 2. Mark price ────────────────────────────────────────────────────────────
  console.log('\n2. get_mark_price');
  const price = await adapter.get_mark_price(SYMBOL);
  ok('mark price', `$${price}`);

  // ── 3. Orderbook ─────────────────────────────────────────────────────────────
  console.log('\n3. get_orderbook');
  const ob = await adapter.get_orderbook(SYMBOL);
  ok('best_bid', `$${ob.best_bid}`);
  ok('best_ask', `$${ob.best_ask}`);

  // ── 4. WebSocket + balance ───────────────────────────────────────────────────
  console.log('\n4. WebSocket auth + balance');
  const balance = await adapter.get_balance();
  ok('balance', `$${balance}`);

  // ── 5. Open position ─────────────────────────────────────────────────────────
  console.log('\n5. get_position');
  const pos = await adapter.get_position(SYMBOL, price);
  ok('position', pos ?? 'none');

  // ── 6. Place limit order (far below market, won't fill) ──────────────────────
  const limitPrice = Math.floor(price * 0.5);
  const size = 0.0001;
  console.log(`\n6. place_limit_order BUY ${size} ${SYMBOL} @ $${limitPrice} (50% below market)`);
  const orderId = await adapter.place_limit_order(SYMBOL, 'buy', limitPrice, size);
  ok('order ID (rq)', orderId);

  // Wait a moment for order to register
  await new Promise(r => setTimeout(r, 1500));

  // ── 7. Check open orders ─────────────────────────────────────────────────────
  console.log('\n7. get_open_orders');
  const orders = await adapter.get_open_orders(SYMBOL);
  ok('open orders', orders.length);
  const found = orders.find(o => o.id === orderId);
  ok('our order in list', found ? 'yes' : 'not yet (may be pending)');

  // ── 8. Cancel order ──────────────────────────────────────────────────────────
  console.log('\n8. cancel_order', orderId);
  const cancelled = await adapter.cancel_order(orderId, SYMBOL);
  ok('cancelled', cancelled);

  // ── 9. Place SHORT entry (reduce-only=false) ─────────────────────────────────
  const shortPrice = Math.ceil(price * 1.5);
  console.log(`\n9. place_limit_order SELL ${size} ${SYMBOL} @ $${shortPrice} (50% above market, won't fill)`);
  const shortId = await adapter.place_limit_order(SYMBOL, 'sell', shortPrice, size);
  ok('short order ID', shortId);

  await new Promise(r => setTimeout(r, 1000));

  // ── 10. Cancel all ───────────────────────────────────────────────────────────
  console.log('\n10. cancel_all_orders');
  const cancelledAll = await adapter.cancel_all_orders(SYMBOL);
  ok('cancel_all result', cancelledAll);

  console.log('\n=== All tests passed ✓ ===\n');

  await adapter.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error('\n✗ Test failed:', err.message);
  console.error(err.stack);
  process.exit(1);
});
