/**
 * Test script: Dango Exchange mainnet integration
 * Tests: connection, balance, orderbook, place limit order, cancel order, close position
 *
 * Usage: npx tsx src/scripts/test-dango.ts
 *
 * Required .env:
 *   DANGO_PRIVATE_KEY=0x...   (Secp256k1 private key, 32 bytes hex)
 *   DANGO_USER_ADDRESS=0x...  (your account address on Dango)
 *   DANGO_NETWORK=mainnet     (or testnet)
 */
import 'dotenv/config';
import { DangoAdapter } from '../adapters/dango_adapter.js';

const SYMBOL = 'BTC-USD';
const SLEEP = (ms: number) => new Promise(r => setTimeout(r, ms));

function log(section: string, data?: unknown) {
    console.log(`\n── ${section} ${'─'.repeat(Math.max(0, 50 - section.length))}`);
    if (data !== undefined) console.log(JSON.stringify(data, null, 2));
}

async function main() {
    const { DANGO_PRIVATE_KEY, DANGO_USER_ADDRESS, DANGO_NETWORK } = process.env;

    if (!DANGO_PRIVATE_KEY || !DANGO_USER_ADDRESS) {
        console.error('❌ Missing DANGO_PRIVATE_KEY or DANGO_USER_ADDRESS in .env');
        process.exit(1);
    }

    const network = (DANGO_NETWORK as 'mainnet' | 'testnet') ?? 'mainnet';
    console.log(`\n🚀 Dango Exchange Test — ${network.toUpperCase()}`);
    console.log(`   Address: ${DANGO_USER_ADDRESS}`);

    const adapter = new DangoAdapter(DANGO_PRIVATE_KEY, DANGO_USER_ADDRESS, network);

    // ── 1. Balance ────────────────────────────────────────────────────────────
    log('1. Balance');
    try {
        const balance = await adapter.get_balance();
        console.log(`Margin balance: $${balance.toFixed(2)} USD`);
        if (balance < 10) {
            console.warn('⚠️  Balance < $10 — order tests may fail (min_order_size = $10)');
        }
    } catch (e: any) {
        console.error('❌ get_balance failed:', e.message);
    }

    // ── 2. Mark price ─────────────────────────────────────────────────────────
    log('2. Mark price');
    let markPrice = 0;
    try {
        markPrice = await adapter.get_mark_price(SYMBOL);
        console.log(`Mark price: $${markPrice.toFixed(2)}`);
    } catch (e: any) {
        console.error('❌ get_mark_price failed:', e.message);
    }

    // ── 3. Orderbook ──────────────────────────────────────────────────────────
    log('3. Orderbook (top 3 levels)');
    try {
        const ob = await adapter.get_orderbook(SYMBOL);
        console.log(`Best bid: $${ob.best_bid.toFixed(2)}`);
        console.log(`Best ask: $${ob.best_ask.toFixed(2)}`);
        console.log(`Spread:   $${(ob.best_ask - ob.best_bid).toFixed(2)} (${((ob.best_ask - ob.best_bid) / ob.best_bid * 10000).toFixed(2)} bps)`);

        const depth = await adapter.get_orderbook_depth(SYMBOL, 3);
        console.log('Bids:', depth.bids.slice(0, 3).map(([p, s]) => `$${p} × ${s.toFixed(4)}`).join(', '));
        console.log('Asks:', depth.asks.slice(0, 3).map(([p, s]) => `$${p} × ${s.toFixed(4)}`).join(', '));
    } catch (e: any) {
        console.error('❌ orderbook failed:', e.message);
    }

    // ── 4. Recent trades ──────────────────────────────────────────────────────
    log('4. Recent trades (last 5)');
    try {
        const trades = await adapter.get_recent_trades(SYMBOL, 5);
        trades.forEach(t => console.log(`  ${t.side.toUpperCase()} ${t.size.toFixed(4)} @ $${t.price.toFixed(2)}`));
    } catch (e: any) {
        console.error('❌ get_recent_trades failed:', e.message);
    }

    // ── 5. Open position ──────────────────────────────────────────────────────
    log('5. Current position');
    try {
        const pos = await adapter.get_position(SYMBOL);
        if (pos) {
            console.log(`Side: ${pos.side.toUpperCase()}`);
            console.log(`Size: ${pos.size.toFixed(6)} BTC`);
            console.log(`Entry: $${pos.entryPrice.toFixed(2)}`);
            console.log(`Unrealized PnL: $${pos.unrealizedPnl.toFixed(4)}`);
        } else {
            console.log('No open position');
        }
    } catch (e: any) {
        console.error('❌ get_position failed:', e.message);
    }

    // ── 6. Open orders ────────────────────────────────────────────────────────
    log('6. Open orders');
    try {
        const orders = await adapter.get_open_orders(SYMBOL);
        if (orders.length === 0) {
            console.log('No open orders');
        } else {
            orders.forEach(o => console.log(`  #${o.id} ${o.side.toUpperCase()} ${o.size.toFixed(4)} @ $${o.price.toFixed(2)}`));
        }
    } catch (e: any) {
        console.error('❌ get_open_orders failed:', e.message);
    }

    // ── 7. Place limit order (far from market, won't fill) ────────────────────
    log('7. Place limit order (POST-Only, far from market)');
    let orderId: string | null = null;
    if (markPrice > 0) {
        // Place a buy limit 5% below market — won't fill, safe to cancel
        const limitPrice = Math.round(markPrice * 0.95);
        const sizeUsd = 10; // $10 minimum notional
        const sizeBtc = sizeUsd / limitPrice;

        console.log(`Placing BUY ${sizeBtc.toFixed(6)} BTC @ $${limitPrice} (POST-Only)`);
        try {
            orderId = await adapter.place_limit_order(SYMBOL, 'buy', limitPrice, sizeBtc, false, 4);
            console.log(`✅ Order placed: ID = ${orderId}`);
        } catch (e: any) {
            console.error('❌ place_limit_order failed:', e.message);
        }
    } else {
        console.log('⚠️  Skipping order placement (mark price unavailable)');
    }

    // ── 8. Verify order appears ───────────────────────────────────────────────
    if (orderId) {
        await SLEEP(3000); // wait for chain to process
        log('8. Verify order in open orders');
        try {
            const orders = await adapter.get_open_orders(SYMBOL);
            const found = orders.find(o => o.id === orderId);
            if (found) {
                console.log(`✅ Order #${orderId} confirmed: ${found.side.toUpperCase()} ${found.size.toFixed(4)} @ $${found.price.toFixed(2)}`);
            } else {
                console.log(`⚠️  Order #${orderId} not found in open orders (may have filled or failed)`);
            }
        } catch (e: any) {
            console.error('❌ get_open_orders failed:', e.message);
        }
    }

    // ── 9. Cancel order ───────────────────────────────────────────────────────
    if (orderId) {
        log('9. Cancel order');
        try {
            const ok = await adapter.cancel_order(orderId, SYMBOL);
            console.log(ok ? `✅ Order #${orderId} cancelled` : `❌ Cancel returned false`);
        } catch (e: any) {
            console.error('❌ cancel_order failed:', e.message);
        }

        await SLEEP(3000);
        // Verify cancelled
        try {
            const orders = await adapter.get_open_orders(SYMBOL);
            const stillOpen = orders.find(o => o.id === orderId);
            console.log(stillOpen ? `⚠️  Order still open` : `✅ Order confirmed cancelled`);
        } catch { /* ignore */ }
    }

    // ── 10. Close position (if any) ───────────────────────────────────────────
    log('10. Close position (market order, if position exists)');
    try {
        const pos = await adapter.get_position(SYMBOL);
        if (pos && Math.abs(pos.size) > 0) {
            const closeSide = pos.side === 'long' ? 'sell' : 'buy';
            // Use market order: place at aggressive price (5% through market)
            const closePrice = pos.side === 'long'
                ? Math.round(markPrice * 0.95)  // sell below market
                : Math.round(markPrice * 1.05); // buy above market
            console.log(`Closing ${pos.side.toUpperCase()} ${pos.size.toFixed(6)} BTC via ${closeSide.toUpperCase()} @ $${closePrice} (IOC)`);
            const closeId = await adapter.place_limit_order(SYMBOL, closeSide, closePrice, pos.size, true, 3 /* IOC */);
            console.log(`✅ Close order sent: ID = ${closeId}`);
        } else {
            console.log('No position to close');
        }
    } catch (e: any) {
        console.error('❌ close position failed:', e.message);
    }

    console.log('\n✅ Dango test complete\n');
}

main().catch(e => {
    console.error('\n❌ Fatal error:', e.message ?? e);
    process.exit(1);
});
