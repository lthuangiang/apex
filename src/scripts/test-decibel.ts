/**
 * Mainnet integration test for DecibelAdapter — debug real API calls.
 * Usage: npx tsx src/scripts/test-decibel.ts [test]
 *
 * Tests:
 *   orderbook       — fetch BTC-USD orderbook
 *   balance         — fetch account balance
 *   open_orders     — fetch open orders
 *   position        — fetch current position
 *   place_order     — place a tiny buy limit order (USE WITH CAUTION)
 *   cancel_all      — cancel all open orders
 *   all             — run all read-only tests (default)
 */
import 'dotenv/config';
import { DecibelAdapter } from '../adapters/decibel_adapter.js';

const SYMBOL = process.env.DECIBELS_SYMBOL ?? 'BTC/USD';

function ok(label: string, value: unknown) {
    console.log(`  ✅ ${label}:`, JSON.stringify(value, null, 2));
}
function fail(label: string, err: unknown) {
    const msg = (err as any)?.response?.data ?? (err as any)?.message ?? err;
    console.error(`  ❌ ${label}:`, JSON.stringify(msg, null, 2));
}
function section(name: string) {
    console.log(`\n── ${name} ${'─'.repeat(50 - name.length)}`);
}

async function main() {
    const { DECIBELS_PRIVATE_KEY, DECIBELS_NODE_API_KEY, DECIBELS_SUBACCOUNT } = process.env;

    if (!DECIBELS_PRIVATE_KEY || !DECIBELS_SUBACCOUNT) {
        console.error('❌ Missing DECIBELS_PRIVATE_KEY or DECIBELS_SUBACCOUNT in .env');
        process.exit(1);
    }

    const test = process.argv[2] ?? 'all';

    console.log(`\n🔌 Connecting to Decibel mainnet`);
    console.log(`   Subaccount : ${DECIBELS_SUBACCOUNT}`);
    console.log(`   Symbol     : ${SYMBOL}`);
    console.log(`   Test       : ${test}`);

    const adapter = new DecibelAdapter(
        DECIBELS_PRIVATE_KEY,
        DECIBELS_NODE_API_KEY ?? '0x0',
        DECIBELS_SUBACCOUNT,
        process.env.DECIBELS_BUILDER_ADDRESS ?? '0x5eefc26ee8f0b537717e57718a9a0c365e32081d96dc618a56041b3b7ff31ed5',
        10,
        process.env.DECIBELS_GAS_STATION_API_KEY,
    );

    // ── orderbook ─────────────────────────────────────────────────────────────
    async function testOrderbook() {
        section('get_orderbook');
        // First dump available markets to confirm correct symbol name
        try {
            const markets = await adapter['read'].markets.getAll();
            console.log('  Available markets:', markets.map((m: any) => m.market_name).join(', '));
        } catch {}
        try {
            const ob = await adapter.get_orderbook(SYMBOL);
            ok('best_bid', ob.best_bid);
            ok('best_ask', ob.best_ask);
            ok('spread', (ob.best_ask - ob.best_bid).toFixed(2));
        } catch (e) { fail('get_orderbook', e); }
    }

    // ── mark price ────────────────────────────────────────────────────────────
    async function testMarkPrice() {
        section('get_mark_price');
        try {
            // First list available markets so we know the correct name
            const markets = await adapter['read'].markets.getAll();
            console.log('  Available markets:', markets.map((m: any) => m.market_name).join(', '));
            const price = await adapter.get_mark_price(SYMBOL);
            ok('mark_price', price);
        } catch (e) { fail('get_mark_price', e); }
    }

    // ── balance ───────────────────────────────────────────────────────────────
    async function testBalance() {
        section('get_balance');
        try {
            const balance = await adapter.get_balance();
            ok('perp_equity_balance', balance);
        } catch (e) { fail('get_balance', e); }
    }

    // ── open orders ───────────────────────────────────────────────────────────
    async function testOpenOrders() {
        section('get_open_orders');
        try {
            const orders = await adapter.get_open_orders(SYMBOL);
            ok(`count`, orders.length);
            orders.forEach((o, i) => ok(`order[${i}]`, o));
        } catch (e) { fail('get_open_orders', e); }
    }

    // ── position ──────────────────────────────────────────────────────────────
    async function testPosition() {
        section('get_position');
        try {
            const pos = await adapter.get_position(SYMBOL);
            ok('position', pos ?? 'no open position');
        } catch (e) { fail('get_position', e); }
    }

    // ── place order (LIVE — places a real order far from market) ──────────────
    async function testPlaceOrder() {
        section('place_limit_order (LIVE)');
        try {
            const ob = await adapter.get_orderbook(SYMBOL);
            // Place 10% below best bid — very unlikely to fill, easy to cancel
            const safePrice = Math.floor(ob.best_bid * 0.9 * 100) / 100;
            const minSize = 0.001; // smallest reasonable size
            console.log(`  Placing BUY ${minSize} @ ${safePrice} (10% below market)`);
            const orderId = await adapter.place_limit_order(SYMBOL, 'buy', safePrice, minSize);
            ok('order_id', orderId);
        } catch (e) { fail('place_limit_order', e); }
    }

    // ── cancel all ────────────────────────────────────────────────────────────
    async function testCancelAll() {
        section('cancel_all_orders');
        try {
            const result = await adapter.cancel_all_orders(SYMBOL);
            ok('cancelled', result);
        } catch (e) { fail('cancel_all_orders', e); }
    }

    // ── subaccount info ───────────────────────────────────────────────────────
    async function testSubaccount() {
        section('subaccount info');
        try {
            // Query all subaccounts for this API wallet
            const subs = await adapter['read'].userSubaccounts?.getByAddr?.({ addr: adapter['account']?.accountAddress?.toString() });
            ok('subaccounts', subs);
        } catch (e) { fail('userSubaccounts', e); }
        try {
            // Also try to get balance (will fail if subaccount not created)
            const balance = await adapter.get_balance();
            ok('balance', balance);
        } catch (e) { fail('balance (subaccount may not exist yet)', e); }
    }

    // ── run ───────────────────────────────────────────────────────────────────
    switch (test) {
        case 'orderbook':    await testOrderbook(); break;
        case 'mark_price':   await testMarkPrice(); break;
        case 'balance':      await testBalance(); break;
        case 'open_orders':  await testOpenOrders(); break;
        case 'position':     await testPosition(); break;
        case 'place_order':  await testPlaceOrder(); break;
        case 'cancel_all':   await testCancelAll(); break;
        case 'subaccount':   await testSubaccount(); break;
        case 'all':
        default:
            await testOrderbook();
            await testMarkPrice();
            await testBalance();
            await testOpenOrders();
            await testPosition();
            break;
    }

    console.log('\n✅ Done\n');
}

main().catch(e => {
    console.error('\n💥 Fatal:', e);
    process.exit(1);
});
