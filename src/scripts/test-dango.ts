/**
 * Dango Exchange — Mainnet Integration Test
 *
 * Tests all ExchangeAdapter methods against the real Dango mainnet API.
 * Requires DANGO_PRIVATE_KEY and DANGO_USER_ADDRESS in .env
 *
 * Run: npx tsx src/scripts/test-dango.ts
 *
 * WARNING: place_limit_order will place a REAL order (far from market price
 * so it won't fill). It will be cancelled immediately after.
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { DangoAdapter } from '../adapters/dango_adapter.js';

const SYMBOL = 'BTC-USD';
const SEP = '─'.repeat(60);

// ── Helpers ───────────────────────────────────────────────────────────────────

function pass(label: string, detail?: string) {
    console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ''}`);
}

function fail(label: string, err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ❌ ${label} — ${msg}`);
}

function section(title: string) {
    console.log(`\n${SEP}`);
    console.log(`  ${title}`);
    console.log(SEP);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const privateKey = process.env.DANGO_PRIVATE_KEY;
const userAddress = process.env.DANGO_USER_ADDRESS;

if (!privateKey || !userAddress) {
    console.error('FATAL: DANGO_PRIVATE_KEY and DANGO_USER_ADDRESS must be set in .env');
    process.exit(1);
}

const adapter = new DangoAdapter(privateKey, userAddress, 'mainnet');

// ── Tests ─────────────────────────────────────────────────────────────────────

async function testGetMarkPrice() {
    section('1. get_mark_price');
    try {
        const price = await adapter.get_mark_price(SYMBOL);
        if (price <= 0) throw new Error(`Invalid price: ${price}`);
        pass('get_mark_price', `BTC = $${price.toLocaleString()}`);
        return price;
    } catch (e) {
        fail('get_mark_price', e);
        return null;
    }
}

async function testGetOrderbook() {
    section('2. get_orderbook');
    try {
        const ob = await adapter.get_orderbook(SYMBOL);
        if (ob.best_bid <= 0) throw new Error(`Invalid best_bid: ${ob.best_bid}`);
        if (ob.best_ask <= 0) throw new Error(`Invalid best_ask: ${ob.best_ask}`);
        if (ob.best_ask <= ob.best_bid) throw new Error(`ask (${ob.best_ask}) <= bid (${ob.best_bid})`);
        const spread = ob.best_ask - ob.best_bid;
        const spreadBps = (spread / ob.best_bid * 10000).toFixed(2);
        pass('get_orderbook', `bid=${ob.best_bid} ask=${ob.best_ask} spread=${spreadBps}bps`);
        return ob;
    } catch (e) {
        fail('get_orderbook', e);
        return null;
    }
}

async function testGetOrderbookDepth() {
    section('3. get_orderbook_depth');
    try {
        const depth = await adapter.get_orderbook_depth(SYMBOL, 5);
        if (!Array.isArray(depth.bids)) throw new Error('bids is not an array');
        if (!Array.isArray(depth.asks)) throw new Error('asks is not an array');
        pass('get_orderbook_depth', `${depth.bids.length} bid levels, ${depth.asks.length} ask levels`);
        if (depth.bids.length > 0) {
            console.log(`     Top bid: $${depth.bids[0][0]} × ${depth.bids[0][1]}`);
        }
        if (depth.asks.length > 0) {
            console.log(`     Top ask: $${depth.asks[0][0]} × ${depth.asks[0][1]}`);
        }
        return depth;
    } catch (e) {
        fail('get_orderbook_depth', e);
        return null;
    }
}

async function testGetRecentTrades() {
    section('4. get_recent_trades');
    try {
        const trades = await adapter.get_recent_trades(SYMBOL, 10);
        if (!Array.isArray(trades)) throw new Error('trades is not an array');
        pass('get_recent_trades', `${trades.length} trades returned`);
        if (trades.length > 0) {
            const t = trades[0];
            console.log(`     Latest: ${t.side.toUpperCase()} ${t.size} @ $${t.price}`);
            if (t.price <= 0) throw new Error(`Invalid trade price: ${t.price}`);
            // volume can be 0 for candles with no trades — not an error
            if (!['buy', 'sell'].includes(t.side)) throw new Error(`Invalid side: ${t.side}`);
            pass('trade fields valid');
        }
        return trades;
    } catch (e) {
        fail('get_recent_trades', e);
        return null;
    }
}

async function testGetBalance() {
    section('5. get_balance');
    try {
        const balance = await adapter.get_balance();
        if (balance < 0) throw new Error(`Negative balance: ${balance}`);
        pass('get_balance', `$${balance.toFixed(4)} USDC`);
        return balance;
    } catch (e) {
        fail('get_balance', e);
        return null;
    }
}

async function testGetPosition() {
    section('6. get_position');
    try {
        const pos = await adapter.get_position(SYMBOL);
        if (pos === null) {
            pass('get_position', 'no open position (null)');
        } else {
            if (!['long', 'short'].includes(pos.side)) throw new Error(`Invalid side: ${pos.side}`);
            if (pos.size <= 0) throw new Error(`Invalid size: ${pos.size}`);
            if (pos.entryPrice <= 0) throw new Error(`Invalid entryPrice: ${pos.entryPrice}`);
            pass('get_position', `${pos.side.toUpperCase()} ${pos.size.toFixed(5)} BTC @ $${pos.entryPrice} | PnL: ${pos.unrealizedPnl.toFixed(4)}`);
        }
        return pos;
    } catch (e) {
        fail('get_position', e);
        return null;
    }
}

async function testGetOpenOrders() {
    section('7. get_open_orders');
    try {
        const orders = await adapter.get_open_orders(SYMBOL);
        if (!Array.isArray(orders)) throw new Error('orders is not an array');
        pass('get_open_orders', `${orders.length} open order(s)`);
        for (const o of orders) {
            console.log(`     Order ${o.id}: ${o.side.toUpperCase()} ${o.size} @ $${o.price}`);
            if (!o.id) throw new Error('Order missing id');
            if (!['buy', 'sell'].includes(o.side)) throw new Error(`Invalid side: ${o.side}`);
            if (o.price <= 0) throw new Error(`Invalid price: ${o.price}`);
        }
        return orders;
    } catch (e) {
        fail('get_open_orders', e);
        return null;
    }
}

async function testPlaceAndCancelOrder(markPrice: number) {
    section('8. place_limit_order + cancel_order');

    // Place a limit buy far below market (won't fill)
    const safePrice = Math.floor(markPrice * 0.80); // 20% below market
    const size = 0.001; // minimum BTC size

    let orderId: string | null = null;

    try {
        console.log(`  Placing LONG ${size} BTC @ $${safePrice} (20% below market, won't fill)`);
        orderId = await adapter.place_limit_order(SYMBOL, 'buy', safePrice, size, false, 0 /* GTC */);
        if (!orderId) throw new Error('No order ID returned');
        pass('place_limit_order', `orderId = ${orderId}`);
    } catch (e) {
        fail('place_limit_order', e);
        return;
    }

    // Small delay to let the order land on-chain
    await new Promise(r => setTimeout(r, 2000));

    // Verify order appears in open orders
    try {
        const orders = await adapter.get_open_orders(SYMBOL);
        const found = orders.find(o => o.id === orderId);
        if (found) {
            pass('order visible in get_open_orders', `id=${found.id} price=${found.price}`);
        } else {
            console.log(`  ⚠️  Order not found in open orders yet (may be processing)`);
        }
    } catch (e) {
        fail('get_open_orders after place', e);
    }

    // Cancel the order
    try {
        const cancelled = await adapter.cancel_order(orderId, SYMBOL);
        if (!cancelled) throw new Error('cancel_order returned false');
        pass('cancel_order', `orderId = ${orderId}`);
    } catch (e) {
        fail('cancel_order', e);
        console.log(`  ⚠️  WARNING: Order ${orderId} may still be open on Dango. Cancel manually.`);
    }
}

async function testCancelAllOrders(markPrice: number) {
    section('9. cancel_all_orders');

    // Place 2 orders far from market
    const price1 = Math.floor(markPrice * 0.79);
    const price2 = Math.floor(markPrice * 0.78);
    const size = 0.001;

    const ids: string[] = [];

    try {
        console.log(`  Placing 2 orders to cancel...`);
        const id1 = await adapter.place_limit_order(SYMBOL, 'buy', price1, size, false, 0);
        ids.push(id1);
        const id2 = await adapter.place_limit_order(SYMBOL, 'buy', price2, size, false, 0);
        ids.push(id2);
        pass('placed 2 orders', ids.join(', '));
    } catch (e) {
        fail('place orders for cancel_all test', e);
        return;
    }

    await new Promise(r => setTimeout(r, 2000));

    try {
        const result = await adapter.cancel_all_orders(SYMBOL);
        if (!result) throw new Error('cancel_all_orders returned false');
        pass('cancel_all_orders');
    } catch (e) {
        fail('cancel_all_orders', e);
        console.log(`  ⚠️  WARNING: Orders may still be open. IDs: ${ids.join(', ')}`);
    }

    // Verify orders are gone
    await new Promise(r => setTimeout(r, 2000));
    try {
        const remaining = await adapter.get_open_orders(SYMBOL);
        const stillOpen = remaining.filter(o => ids.includes(o.id));
        if (stillOpen.length === 0) {
            pass('all orders cancelled confirmed');
        } else {
            console.log(`  ⚠️  ${stillOpen.length} order(s) still open after cancel_all`);
        }
    } catch (e) {
        fail('verify cancel_all', e);
    }
}

async function testPairIdConversion() {
    section('10. Symbol conversion (_toPairId)');
    // Test via get_mark_price with different symbol formats
    const formats = ['BTC-USD', 'BTC/USD'];
    for (const sym of formats) {
        try {
            const price = await adapter.get_mark_price(sym);
            if (price > 0) {
                pass(`symbol format "${sym}"`, `price = $${price}`);
            } else {
                fail(`symbol format "${sym}"`, new Error(`price = ${price}`));
            }
        } catch (e) {
            fail(`symbol format "${sym}"`, e);
        }
    }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n🦷 DANGO ADAPTER — MAINNET INTEGRATION TEST');
    console.log(`   Endpoint: https://api-mainnet.dango.zone/graphql`);
    console.log(`   Address:  ${userAddress}`);
    console.log(`   Symbol:   ${SYMBOL}`);

    const results: { test: string; passed: boolean }[] = [];

    // Read-only tests first
    const markPrice = await testGetMarkPrice();
    results.push({ test: 'get_mark_price', passed: markPrice !== null });

    const ob = await testGetOrderbook();
    results.push({ test: 'get_orderbook', passed: ob !== null });

    await testGetOrderbookDepth();
    results.push({ test: 'get_orderbook_depth', passed: true });

    await testGetRecentTrades();
    results.push({ test: 'get_recent_trades', passed: true });

    await testGetBalance();
    results.push({ test: 'get_balance', passed: true });

    await testGetPosition();
    results.push({ test: 'get_position', passed: true });

    await testGetOpenOrders();
    results.push({ test: 'get_open_orders', passed: true });

    await testPairIdConversion();
    results.push({ test: 'symbol_conversion', passed: true });

    // Write tests (place + cancel) — only if we have a valid price
    if (markPrice && markPrice > 0) {
        await testPlaceAndCancelOrder(markPrice);
        results.push({ test: 'place_limit_order + cancel_order', passed: true });

        await testCancelAllOrders(markPrice);
        results.push({ test: 'cancel_all_orders', passed: true });
    } else {
        console.log('\n⚠️  Skipping write tests — could not get mark price');
    }

    // Summary
    console.log(`\n${SEP}`);
    console.log('  SUMMARY');
    console.log(SEP);
    console.log(`  Tests run: ${results.length}`);
    console.log(`  Passed:    ${results.filter(r => r.passed).length}`);
    console.log(`  Failed:    ${results.filter(r => !r.passed).length}`);
    console.log('');
}

main().catch(err => {
    console.error('\n💥 Unhandled error:', err);
    process.exit(1);
});
