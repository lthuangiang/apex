/**
 * SoDEX Testnet API Endpoint Test Suite
 * Tests all REST API v1 Perps endpoints and reports bugs/issues.
 *
 * Usage: npx tsx src/scripts/test-sodex-api.ts
 *
 * Required .env:
 *   SODEX_API_KEY=0x...       (EVM address used as API key)
 *   SODEX_API_SECRET=0x...    (EVM private key for signing)
 *   SODEX_SUBACCOUNT=0x...    (account address to query)
 */
import 'dotenv/config';
import { ethers } from 'ethers';

// Testnet base URL
const BASE = 'https://testnet-gw.sodex.dev/api/v1/perps';
const SYMBOL = 'BTC-USD';
// Testnet symbol name may differ from mainnet — auto-detected below
let TESTNET_SYMBOL = SYMBOL; // will be overridden if BTC-USD not found
const SLEEP = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Result tracking ───────────────────────────────────────────────────────────
interface TestResult {
    endpoint: string;
    method: string;
    status: 'PASS' | 'FAIL' | 'WARN';
    statusCode?: number;
    note?: string;
    bug?: string;
}
const results: TestResult[] = [];

function pass(endpoint: string, method: string, note?: string) {
    results.push({ endpoint, method, status: 'PASS', note });
    console.log(`  ✅ PASS${note ? ` — ${note}` : ''}`);
}
function fail(endpoint: string, method: string, statusCode: number, bug: string) {
    results.push({ endpoint, method, status: 'FAIL', statusCode, bug });
    console.error(`  ❌ FAIL [${statusCode}] — ${bug}`);
}
function warn(endpoint: string, method: string, note: string) {
    results.push({ endpoint, method, status: 'WARN', note });
    console.warn(`  ⚠️  WARN — ${note}`);
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function get(path: string, params?: Record<string, string>): Promise<{ status: number; data: any }> {
    const url = new URL(`${BASE}${path}`);
    if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
    const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    const text = await res.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = text; }
    console.log(`  [${res.status}] GET ${path}${params ? '?' + new URLSearchParams(params) : ''}`);
    console.log(`  RAW: ${text.slice(0, 400)}`);
    return { status: res.status, data };
}

// ── Signing — mirrors SodexAdapter exactly ────────────────────────────────────
let lastNonce = 0;

async function getSignature(
    nonce: number,
    method: string,
    paramsStr: string,
    wallet: ethers.Wallet
): Promise<string> {
    const actionType = method === 'DELETE' ? 'cancelOrder' : 'newOrder';
    const payloadStr = `{"type":"${actionType}","params":${paramsStr}}`;
    const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(payloadStr));

    console.log(`  [SIGN] Payload : ${payloadStr.slice(0, 120)}`);
    console.log(`  [SIGN] Hash    : ${payloadHash}`);

    const domain = {
        name: 'futures',
        version: '1',
        chainId: 138565,
        verifyingContract: '0x0000000000000000000000000000000000000000',
    };
    const types = {
        ExchangeAction: [
            { name: 'payloadHash', type: 'bytes32' },
            { name: 'nonce', type: 'uint64' },
        ],
    };
    const message = { payloadHash, nonce: BigInt(nonce) };

    const signature = await wallet.signTypedData(domain, types, message);
    const sig = signature.slice(2);
    const r = sig.slice(0, 64), s = sig.slice(64, 128);
    let vInt = parseInt(sig.slice(128, 130), 16);
    if (vInt >= 27) vInt -= 27;
    const finalSig = '0x01' + r + s + vInt.toString(16).padStart(2, '0');
    console.log(`  [SIGN] Sig     : ${finalSig.slice(0, 20)}...`);
    return finalSig;
}

async function signedRequest(
    method: 'POST' | 'DELETE',
    path: string,
    paramsStr: string,
    wallet: ethers.Wallet,
    apiKey: string
): Promise<{ status: number; data: any; raw: string }> {
    let nonceVal = Date.now();
    if (nonceVal <= lastNonce) nonceVal = lastNonce + 1;
    lastNonce = nonceVal;

    const sig = await getSignature(nonceVal, method, paramsStr, wallet);

    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-API-Key': apiKey,
            'X-API-Sign': sig,
            'X-API-Nonce': nonceVal.toString(),
        },
        body: paramsStr,
    });
    const raw = await res.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { data = raw; }
    console.log(`  [HTTP] ${method} ${path} → ${res.status}`);
    console.log(`  [RESP] ${raw.slice(0, 300)}`);
    return { status: res.status, data, raw };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const { SODEX_API_KEY, SODEX_API_SECRET, SODEX_SUBACCOUNT } = process.env;
    if (!SODEX_API_KEY || !SODEX_API_SECRET || !SODEX_SUBACCOUNT) {
        console.error('❌ Missing SODEX_API_KEY, SODEX_API_SECRET, or SODEX_SUBACCOUNT in .env');
        process.exit(1);
    }

    const wallet = new ethers.Wallet(SODEX_API_SECRET);
    const userAddr = SODEX_SUBACCOUNT;

    console.log('\n🧪 SoDEX Testnet API Test Suite');
    console.log(`   Base URL : ${BASE}`);
    console.log(`   Account  : ${userAddr}`);
    console.log(`   API Key  : ${SODEX_API_KEY}`);
    console.log(`   Symbol   : ${SYMBOL}\n`);

    // ── MARKET ENDPOINTS ──────────────────────────────────────────────────────

    console.log('── Market Endpoints ─────────────────────────────────────────');

    // GET /markets/symbols
    {
        const ep = '/markets/symbols';
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200 && Array.isArray(data?.data)) {
            // Log first item to see actual field names
            const first = data.data[0];
            console.log(`  FIRST ITEM KEYS: ${Object.keys(first ?? {}).join(', ')}`);
            console.log(`  FIRST ITEM: ${JSON.stringify(first)}`);

            // API uses "name" field, not "symbol"
            const getSymbol = (s: any) => s.name ?? s.symbol ?? '';
            const allSymbols = data.data.map((s: any) => getSymbol(s));
            console.log(`  ALL SYMBOLS: ${allSymbols.join(', ')}`);

            const btc = data.data.find((s: any) =>
                getSymbol(s) === SYMBOL ||
                getSymbol(s) === 'BTC-USD' ||
                getSymbol(s)?.toUpperCase().includes('BTC')
            );
            if (btc) {
                TESTNET_SYMBOL = getSymbol(btc);
                pass(ep, 'GET', `${data.data.length} symbols, found "${TESTNET_SYMBOL}" (id=${btc.id})`);
            } else {
                pass(ep, 'GET', `${data.data.length} symbols — all: ${allSymbols.join(', ')}`);
                warn(ep, 'GET', `BTC symbol not found — available: ${allSymbols.join(', ')}`);
            }
        } else {
            fail(ep, 'GET', status, `Expected array, got: ${JSON.stringify(data).slice(0, 100)}`);
        }
    }

    // GET /markets/coins
    {
        const ep = '/markets/coins';
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200 && Array.isArray(data?.data)) {
            pass(ep, 'GET', `${data.data.length} coins`);
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /markets/tickers
    {
        const ep = '/markets/tickers';
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200 && Array.isArray(data?.data)) {
            const btc = data.data.find((t: any) => t.symbol === TESTNET_SYMBOL);
            pass(ep, 'GET', `${data.data.length} tickers, ${TESTNET_SYMBOL} lastPrice=${btc?.lastPrice ?? 'N/A'}`);
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /markets/miniTickers
    {
        const ep = '/markets/miniTickers';
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200 && Array.isArray(data?.data)) {
            pass(ep, 'GET', `${data.data.length} miniTickers`);
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /markets/mark-prices
    {
        const ep = '/markets/mark-prices';
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200 && Array.isArray(data?.data)) {
            const btc = data.data.find((m: any) => m.symbol === TESTNET_SYMBOL);
            pass(ep, 'GET', `${TESTNET_SYMBOL} markPrice=${btc?.markPrice ?? 'N/A'}`);
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /markets/bookTickers
    {
        const ep = '/markets/bookTickers';
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200 && Array.isArray(data?.data)) {
            const btc = data.data.find((b: any) => b.symbol === TESTNET_SYMBOL);
            pass(ep, 'GET', `${TESTNET_SYMBOL} bid=${btc?.bidPrice ?? 'N/A'} ask=${btc?.askPrice ?? 'N/A'}`);
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /markets/{symbol}/orderbook
    {
        const ep = `/markets/${TESTNET_SYMBOL}/orderbook`;
        console.log(`\nGET ${ep}?limit=5`);
        const { status, data } = await get(ep, { limit: '5' });
        if (status === 200 && data?.data?.bids && data?.data?.asks) {
            const bids = data.data.bids.length, asks = data.data.asks.length;
            pass(ep, 'GET', `${bids} bids, ${asks} asks`);
            if (bids === 0 && asks === 0) warn(ep, 'GET', 'Empty orderbook — testnet may have no liquidity');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /markets/{symbol}/klines
    {
        const ep = `/markets/${TESTNET_SYMBOL}/klines`;
        console.log(`\nGET ${ep}?interval=1h&limit=5`);
        const { status, data } = await get(ep, { interval: '1h', limit: '5' });
        if (status === 200 && Array.isArray(data?.data)) {
            pass(ep, 'GET', `${data.data.length} candles`);
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /markets/{symbol}/trades
    {
        const ep = `/markets/${TESTNET_SYMBOL}/trades`;
        console.log(`\nGET ${ep}?limit=5`);
        const { status, data } = await get(ep, { limit: '5' });
        if (status === 200 && Array.isArray(data?.data)) {
            pass(ep, 'GET', `${data.data.length} recent trades`);
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // ── ACCOUNT ENDPOINTS ─────────────────────────────────────────────────────

    console.log('\n── Account Endpoints ────────────────────────────────────────');

    // GET /accounts/{userAddress}/balances
    {
        const ep = `/accounts/${userAddr}/balances`;
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200) {
            const balances = data?.data;
            pass(ep, 'GET', `raw: ${JSON.stringify(balances).slice(0, 80)}`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found on testnet');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /accounts/{userAddress}/state — also extract accountId here
    let accountId: number | null = null;
    {
        const ep = `/accounts/${userAddr}/state`;
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200) {
            // Response: { data: { aid: number, ... } }
            accountId = data?.data?.aid ?? null;
            pass(ep, 'GET', `aid=${accountId ?? 'not found'}`);
            if (!accountId) warn(ep, 'GET', `aid field missing in response: ${JSON.stringify(data?.data).slice(0, 100)}`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /accounts/{userAddress}/orders
    {
        const ep = `/accounts/${userAddr}/orders`;
        console.log(`\nGET ${ep}?symbol=${TESTNET_SYMBOL}`);
        const { status, data } = await get(ep, { symbol: TESTNET_SYMBOL });
        if (status === 200) {
            const orders = data?.data?.orders ?? data?.data ?? [];
            pass(ep, 'GET', `${Array.isArray(orders) ? orders.length : 0} open orders`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /accounts/{userAddress}/positions
    {
        const ep = `/accounts/${userAddr}/positions`;
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200) {
            const positions = data?.data?.positions ?? data?.data ?? [];
            pass(ep, 'GET', `${Array.isArray(positions) ? positions.length : 0} open positions`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /accounts/{userAddress}/api-keys
    {
        const ep = `/accounts/${userAddr}/api-keys`;
        console.log(`\nGET ${ep}`);
        const { status, data } = await get(ep);
        if (status === 200) {
            const keys = data?.data;
            pass(ep, 'GET', `${Array.isArray(keys) ? keys.length : 0} API keys`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /accounts/{userAddress}/fee-rate
    {
        const ep = `/accounts/${userAddr}/fee-rate`;
        console.log(`\nGET ${ep}?symbol=${SYMBOL}`);
        const { status, data } = await get(ep, { symbol: SYMBOL });
        if (status === 200) {
            const fee = data?.data;
            pass(ep, 'GET', `maker=${fee?.makerFeeRate ?? 'N/A'} taker=${fee?.takerFeeRate ?? 'N/A'}`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /accounts/{userAddress}/orders/history
    {
        const ep = `/accounts/${userAddr}/orders/history`;
        console.log(`\nGET ${ep}?symbol=${SYMBOL}`);
        const { status, data } = await get(ep, { symbol: SYMBOL });
        if (status === 200) {
            const orders = data?.data?.orders ?? data?.data ?? [];
            pass(ep, 'GET', `${Array.isArray(orders) ? orders.length : 0} historical orders`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /accounts/{userAddress}/positions/history
    {
        const ep = `/accounts/${userAddr}/positions/history`;
        console.log(`\nGET ${ep}?symbol=${SYMBOL}`);
        const { status, data } = await get(ep, { symbol: SYMBOL });
        if (status === 200) {
            const positions = data?.data?.positions ?? data?.data ?? [];
            pass(ep, 'GET', `${Array.isArray(positions) ? positions.length : 0} historical positions`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /accounts/{userAddress}/trades
    {
        const ep = `/accounts/${userAddr}/trades`;
        console.log(`\nGET ${ep}?symbol=${SYMBOL}&limit=10`);
        const { status, data } = await get(ep, { symbol: SYMBOL, limit: '10' });
        if (status === 200) {
            const trades = data?.data?.trades ?? data?.data ?? [];
            pass(ep, 'GET', `${Array.isArray(trades) ? trades.length : 0} trades`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // GET /accounts/{userAddress}/fundings
    {
        const ep = `/accounts/${userAddr}/fundings`;
        console.log(`\nGET ${ep}?symbol=${SYMBOL}`);
        const { status, data } = await get(ep, { symbol: SYMBOL });
        if (status === 200) {
            const fundings = data?.data?.fundings ?? data?.data ?? [];
            pass(ep, 'GET', `${Array.isArray(fundings) ? fundings.length : 0} funding payments`);
        } else if (status === 404) {
            warn(ep, 'GET', 'Account not found');
        } else {
            fail(ep, 'GET', status, JSON.stringify(data).slice(0, 100));
        }
    }

    // ── TRADING ENDPOINTS ─────────────────────────────────────────────────────

    console.log('\n── Trading Endpoints ────────────────────────────────────────');

    // Get symbolId and markPrice
    let symbolId: number | null = null;
    let markPrice = 0;

    {
        const { data: symData } = await get('/markets/symbols');
        const arr = Array.isArray(symData?.data) ? symData.data : [];
        const btc = arr.find((s: any) => (s.name ?? s.symbol) === TESTNET_SYMBOL);
        symbolId = btc?.id ?? null;
        console.log(`\n   accountId:      ${accountId ?? 'N/A'}`);
        console.log(`   TESTNET_SYMBOL: ${TESTNET_SYMBOL}`);
        console.log(`   symbolId:       ${symbolId ?? 'N/A'}`);
        if (!symbolId) {
            console.log(`   All symbols: ${arr.map((s:any) => `${s.name ?? s.symbol}(id=${s.id})`).join(', ')}`);
        }
    }

    {
        const { data: mpData } = await get('/markets/mark-prices');
        const arr = Array.isArray(mpData?.data) ? mpData.data : [];
        const btc = arr.find((m: any) => (m.symbol ?? m.name) === TESTNET_SYMBOL);
        markPrice = parseFloat(btc?.markPrice ?? '0');
        console.log(`   markPrice: $${markPrice.toFixed(2)}`);
    }

    if (!accountId || !symbolId || markPrice === 0) {
        warn('/trade/orders', 'POST', `Skipping trading tests — accountId=${accountId}, symbolId=${symbolId}, markPrice=${markPrice}`);
    } else {
        // POST /trade/orders — place limit order (5% below market, POST-Only)
        let placedClOrdID: string | null = null;
        {
            const ep = '/trade/orders';
            console.log(`\nPOST ${ep} (limit buy, 5% below market, POST-Only)`);

            const limitPrice = Math.round(markPrice * 0.95);
            const clOrdID = `ext-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            placedClOrdID = clOrdID;

            // Strict field order matching Go RawOrder struct
            const orderItemStr = `{"clOrdID":"${clOrdID}","modifier":1,"side":1,"type":1,"timeInForce":4,"price":"${limitPrice}","quantity":"0.003","reduceOnly":false,"positionSide":1}`;
            const paramsStr = `{"accountID":${accountId},"symbolID":${symbolId},"orders":[${orderItemStr}]}`;

            const { status, data } = await signedRequest('POST', ep, paramsStr, wallet, SODEX_API_KEY);

            if (status === 200 && data?.data) {
                const orderId = data.data?.[0]?.orderId ?? data.data?.[0]?.clOrdID ?? clOrdID;
                pass(ep, 'POST', `Order placed: ID=${orderId} clOrdID=${clOrdID} price=${limitPrice}`);

                await SLEEP(2000);

                // Verify order in open orders
                const { data: openData } = await get(`/accounts/${userAddr}/orders`, { symbol: SYMBOL });
                const openOrders = openData?.data?.orders ?? openData?.data ?? [];
                const found = Array.isArray(openOrders) && openOrders.some((o: any) =>
                    o.clOrdID === clOrdID || o.orderId?.toString() === orderId?.toString()
                );
                if (found) {
                    pass(`/accounts/{addr}/orders (verify)`, 'GET', `Order ${clOrdID} confirmed in open orders`);
                } else {
                    warn(`/accounts/{addr}/orders (verify)`, 'GET', `Order ${clOrdID} not found in open orders — raw: ${JSON.stringify(openOrders).slice(0, 100)}`);
                }
            } else if (status === 400 && JSON.stringify(data).toLowerCase().includes('margin')) {
                warn(ep, 'POST', `Insufficient margin on testnet — deposit funds first`);
                placedClOrdID = null;
            } else {
                fail(ep, 'POST', status, JSON.stringify(data).slice(0, 200));
                placedClOrdID = null;
            }
        }

        // DELETE /trade/orders — cancel the order placed above
        if (placedClOrdID) {
            const ep = '/trade/orders';
            console.log(`\nDELETE ${ep} (cancel clOrdID=${placedClOrdID})`);

            // Strict field order for PerpsCancelOrderRequest: accountID, cancels
            const cancelParamsStr = `{"accountID":${accountId},"cancels":[{"symbolID":${symbolId},"clOrdID":"${placedClOrdID}"}]}`;
            const { status, data } = await signedRequest('DELETE', ep, cancelParamsStr, wallet, SODEX_API_KEY);

            if (status === 200) {
                pass(ep, 'DELETE', `Order ${placedClOrdID} cancelled`);
            } else {
                fail(ep, 'DELETE', status, JSON.stringify(data).slice(0, 150));
            }

            await SLEEP(1000);
        }

        // POST /trade/leverage — update leverage (only works with no open orders/positions)
        {
            const ep = '/trade/leverage';
            console.log(`\nPOST ${ep} (set leverage=5 CROSS)`);
            const paramsStr = JSON.stringify({ symbolID: symbolId, leverage: 5, marginMode: 'CROSS' });
            const { status, data } = await signedRequest('POST', ep, paramsStr, wallet, SODEX_API_KEY);
            if (status === 200) {
                pass(ep, 'POST', 'Leverage updated to 5x CROSS');
            } else if (status === 400 && JSON.stringify(data).includes('position')) {
                warn(ep, 'POST', 'Cannot change leverage with open position/orders (expected behavior)');
            } else {
                fail(ep, 'POST', status, JSON.stringify(data).slice(0, 150));
            }
        }

        // POST /trade/orders/schedule-cancel — clear any scheduled cancel
        {
            const ep = '/trade/orders/schedule-cancel';
            console.log(`\nPOST ${ep} (clear scheduled cancel)`);
            // Omit scheduledTimestamp to clear
            const paramsStr = JSON.stringify({ accountID: accountId });
            const { status, data } = await signedRequest('POST', ep, paramsStr, wallet, SODEX_API_KEY);
            if (status === 200) {
                pass(ep, 'POST', 'Scheduled cancel cleared');
            } else {
                fail(ep, 'POST', status, JSON.stringify(data).slice(0, 150));
            }
        }
    }

    // ── REPORT ────────────────────────────────────────────────────────────────

    console.log('\n\n══════════════════════════════════════════════════════════════');
    console.log('  TEST REPORT — SoDEX Testnet API');
    console.log('══════════════════════════════════════════════════════════════\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const warned = results.filter(r => r.status === 'WARN').length;

    console.log(`  Total: ${results.length}  ✅ ${passed}  ❌ ${failed}  ⚠️  ${warned}\n`);

    if (failed > 0) {
        console.log('  🐛 BUGS / FAILURES:');
        results.filter(r => r.status === 'FAIL').forEach(r => {
            console.log(`     [${r.method}] ${r.endpoint} — HTTP ${r.statusCode}: ${r.bug}`);
        });
        console.log('');
    }

    if (warned > 0) {
        console.log('  ⚠️  WARNINGS:');
        results.filter(r => r.status === 'WARN').forEach(r => {
            console.log(`     [${r.method}] ${r.endpoint} — ${r.note}`);
        });
        console.log('');
    }

    if (failed === 0) {
        console.log('  🎉 All endpoints passed!\n');
    }
}

main().catch(e => {
    console.error('\n❌ Fatal error:', e.message ?? e);
    process.exit(1);
});
