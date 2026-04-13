import { ExchangeAdapter, Order, Position, RawTrade } from './ExchangeAdapter.js';
import { createHash } from 'crypto';
import axios from 'axios';

// ─── Dango GraphQL Adapter ────────────────────────────────────────────────────
// Docs: https://docs.dango.exchange/perps/8-api.html
//
// Key differences from SoDEX:
// - GraphQL endpoint (not REST)
// - Secp256k1 signing: SHA-256(canonical JSON of SignDoc) → sign hash
// - Size is USD notional (not BTC quantity)
// - Market orders only (no Post-Only maker)
// - Pair format: "perp/btcusd"

const MAINNET_HTTP = 'https://api-mainnet.dango.zone/graphql';
const TESTNET_HTTP = 'https://api-testnet.dango.zone/graphql';
const PERPS_CONTRACT = '0x90bc84df68d1aa59a857e04ed529e9a26edbea4f';
const CHAIN_ID = 'dango-1';

export class DangoAdapter implements ExchangeAdapter {
    private readonly endpoint: string;
    private readonly userAddress: string;
    private readonly privateKeyHex: string; // 32-byte hex, no 0x prefix
    private cachedUserIndex: number | null = null;
    private lastNonce: number = 0;

    constructor(
        privateKey: string,
        userAddress: string,
        network: 'mainnet' | 'testnet' = 'mainnet'
    ) {
        // Strip 0x prefix if present
        this.privateKeyHex = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
        this.userAddress = userAddress.toLowerCase();
        this.endpoint = network === 'mainnet' ? MAINNET_HTTP : TESTNET_HTTP;
    }

    // ── GraphQL helpers ───────────────────────────────────────────────────────

    private async gql<T = any>(query: string, variables?: Record<string, unknown>): Promise<T> {
        const res = await axios.post(
            this.endpoint,
            { query, variables },
            { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        if (res.data.errors) {
            throw new Error(`[DangoAdapter] GraphQL error: ${JSON.stringify(res.data.errors)}`);
        }
        return res.data.data as T;
    }

    /** Query a contract via wasm_smart */
    private async queryContract<T = any>(msg: Record<string, unknown>): Promise<T> {
        const data = await this.gql<{ queryApp: unknown }>(`
            query QueryContract($msg: JSON!) {
                queryApp(request: { wasm_smart: { contract: "${PERPS_CONTRACT}", msg: $msg } })
            }
        `, { msg });
        return data.queryApp as T;
    }

    // ── Signing ───────────────────────────────────────────────────────────────

    private async getUserIndex(): Promise<number> {
        if (this.cachedUserIndex !== null) return this.cachedUserIndex;
        // Query account factory to find user index by address
        const data = await this.gql<{ accounts: { nodes: Array<{ users: Array<{ userIndex: number }> }> } }>(`
            query {
                accounts(address: "${this.userAddress}", first: 1) {
                    nodes { users { userIndex } }
                }
            }
        `);
        const userIndex = data.accounts?.nodes?.[0]?.users?.[0]?.userIndex;
        if (userIndex === undefined) throw new Error('[DangoAdapter] Could not find user index for address');
        this.cachedUserIndex = userIndex;
        return userIndex;
    }

    private getNextNonce(): number {
        const n = Date.now();
        if (n <= this.lastNonce) { this.lastNonce += 1; return this.lastNonce; }
        this.lastNonce = n % 100000; // keep nonce reasonable
        return this.lastNonce;
    }

    /**
     * Sign a transaction using Secp256k1.
     * SignDoc is SHA-256 hashed (canonical JSON, keys sorted alphabetically).
     * Returns the 64-byte hex signature.
     */
    private async signTx(signDoc: Record<string, unknown>): Promise<string> {
        // Canonical JSON: sort keys alphabetically (recursive)
        const canonical = JSON.stringify(signDoc, Object.keys(signDoc).sort());
        const hash = createHash('sha256').update(canonical).digest();

        // Dynamic import of secp256k1 (already in package.json as @noble/secp256k1)
        const { secp256k1 } = await import('@noble/secp256k1');
        const privKeyBytes = Buffer.from(this.privateKeyHex, 'hex');
        const sig = secp256k1.sign(hash, privKeyBytes, { lowS: true });
        return Buffer.from(sig.toCompactRawBytes()).toString('hex');
    }

    /**
     * Build, sign, and broadcast a transaction.
     * Returns the tx result JSON.
     */
    private async broadcastTx(msgs: unknown[]): Promise<unknown> {
        const userIndex = await this.getUserIndex();
        const nonce = this.getNextNonce();

        const signDoc = {
            data: { chain_id: CHAIN_ID, expiry: null, nonce, user_index: userIndex },
            gas_limit: 1500000,
            messages: msgs,
            sender: this.userAddress,
        };

        const sig = await this.signTx(signDoc);

        // Get key_hash: SHA-256 of compressed public key bytes
        const { secp256k1 } = await import('@noble/secp256k1');
        const privKeyBytes = Buffer.from(this.privateKeyHex, 'hex');
        const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true); // compressed 33 bytes
        const keyHash = createHash('sha256').update(pubKeyBytes).digest('hex').toUpperCase();

        const tx = {
            sender: this.userAddress,
            gas_limit: 1500000,
            msgs,
            data: { user_index: userIndex, chain_id: CHAIN_ID, nonce, expiry: null },
            credential: {
                standard: {
                    key_hash: keyHash,
                    signature: { secp256k1: sig },
                },
            },
        };

        const result = await this.gql<{ broadcastTxSync: unknown }>(`
            mutation BroadcastTx($tx: Tx!) {
                broadcastTxSync(tx: $tx)
            }
        `, { tx });

        console.log(`[DangoAdapter] Tx broadcast result:`, JSON.stringify(result.broadcastTxSync).slice(0, 200));
        return result.broadcastTxSync;
    }

    // ── ExchangeAdapter interface ─────────────────────────────────────────────

    async get_mark_price(symbol: string): Promise<number> {
        const pairId = this._toPairId(symbol);
        const data = await this.gql<{ perpsPairStats: { currentPrice: string } }>(`
            query {
                perpsPairStats(pairId: "${pairId}") {
                    currentPrice
                }
            }
        `);
        return parseFloat(data.perpsPairStats?.currentPrice ?? '0');
    }

    async get_orderbook(symbol: string): Promise<{ best_bid: number; best_ask: number }> {
        const depth = await this.get_orderbook_depth(symbol, 1);
        const best_bid = depth.bids[0]?.[0] ?? 0;
        const best_ask = depth.asks[0]?.[0] ?? 0;
        return { best_bid, best_ask };
    }

    async get_orderbook_depth(symbol: string, limit: number): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
        const pairId = this._toPairId(symbol);
        // Use bucket_size=10 (smallest standard bucket for BTC)
        const result = await this.queryContract<{ bids: Record<string, { size: string; notional: string }>; asks: Record<string, { size: string; notional: string }> }>({
            liquidity_depth: { pair_id: pairId, bucket_size: '10.000000', limit },
        });

        const parseLevels = (levels: Record<string, { size: string; notional: string }>): [number, number][] =>
            Object.entries(levels)
                .map(([price, { size }]) => [parseFloat(price), parseFloat(size)] as [number, number])
                .sort((a, b) => b[0] - a[0]); // descending for bids

        return {
            bids: parseLevels(result?.bids ?? {}),
            asks: parseLevels(result?.asks ?? {}).reverse(), // ascending for asks
        };
    }

    async get_recent_trades(symbol: string, limit: number): Promise<RawTrade[]> {
        const pairId = this._toPairId(symbol);
        const data = await this.gql<{ perpsTrades: { orderId: string; fillPrice: string; fillSize: string; createdAt: string } }>(`
            query {
                perpsTrades(pairId: "${pairId}", first: ${limit}) {
                    orderId fillPrice fillSize createdAt
                }
            }
        `);
        const trades = Array.isArray(data.perpsTrades) ? data.perpsTrades : [];
        return (trades as any[]).map((t: any) => ({
            side: parseFloat(t.fillSize) > 0 ? 'buy' : 'sell',
            price: parseFloat(t.fillPrice),
            size: Math.abs(parseFloat(t.fillSize)),
            timestamp: new Date(t.createdAt).getTime(),
        }));
    }

    /**
     * Place a limit order on Dango.
     * Note: Dango size is USD notional. We convert BTC size × price → USD notional.
     * timeInForce mapping: 4 (Post-Only) → "POST", 3 (IOC) → "IOC", default → "GTC"
     */
    async place_limit_order(
        symbol: string,
        side: 'buy' | 'sell',
        price: number,
        size: number,
        reduceOnly = false,
        timeInForce = 4,
    ): Promise<string> {
        const pairId = this._toPairId(symbol);

        // Dango size = USD notional (positive = buy, negative = sell)
        // size param is BTC quantity → convert to USD notional
        const usdNotional = (size * price).toFixed(6);
        const dangoSize = side === 'buy' ? usdNotional : `-${usdNotional}`;

        // Map timeInForce
        const tifMap: Record<number, string> = { 4: 'POST', 3: 'IOC' };
        const tif = tifMap[timeInForce] ?? 'GTC';

        // Align price to tick_size (1.0 for BTC)
        const alignedPrice = Math.round(price).toFixed(6);

        const msg = {
            execute: {
                contract: PERPS_CONTRACT,
                msg: {
                    trade: {
                        submit_order: {
                            pair_id: pairId,
                            size: dangoSize,
                            kind: {
                                limit: {
                                    limit_price: alignedPrice,
                                    time_in_force: tif,
                                },
                            },
                            reduce_only: reduceOnly,
                        },
                    },
                },
                funds: {},
            },
        };

        console.log(`[DangoAdapter] Placing ${side.toUpperCase()} ${dangoSize} USD @ ${alignedPrice} (${tif})`);
        const result = await this.broadcastTx([msg]);

        // Extract order_id from events
        const resultStr = JSON.stringify(result);
        const match = resultStr.match(/"order_id"\s*:\s*"(\d+)"/);
        return match ? match[1] : `dango-${Date.now()}`;
    }

    async cancel_order(order_id: string, _symbol: string): Promise<boolean> {
        try {
            const msg = {
                execute: {
                    contract: PERPS_CONTRACT,
                    msg: { trade: { cancel_order: { one: order_id } } },
                    funds: {},
                },
            };
            await this.broadcastTx([msg]);
            return true;
        } catch (e) {
            console.error('[DangoAdapter] cancel_order failed:', e);
            return false;
        }
    }

    async cancel_all_orders(_symbol: string): Promise<boolean> {
        try {
            const msg = {
                execute: {
                    contract: PERPS_CONTRACT,
                    msg: { trade: { cancel_order: 'all' } },
                    funds: {},
                },
            };
            await this.broadcastTx([msg]);
            return true;
        } catch (e) {
            console.error('[DangoAdapter] cancel_all_orders failed:', e);
            return false;
        }
    }

    async get_open_orders(symbol: string): Promise<Order[]> {
        const pairId = this._toPairId(symbol);
        const result = await this.queryContract<Record<string, { pair_id: string; size: string; limit_price: string; reduce_only: boolean }>>({
            orders_by_user: { user: this.userAddress },
        });
        if (!result) return [];
        return Object.entries(result)
            .filter(([, o]) => o.pair_id === pairId)
            .map(([id, o]) => ({
                id,
                symbol,
                side: parseFloat(o.size) > 0 ? 'buy' : 'sell',
                price: parseFloat(o.limit_price),
                size: Math.abs(parseFloat(o.size)),
                status: 'open',
            }));
    }

    async get_position(symbol: string): Promise<Position | null> {
        const pairId = this._toPairId(symbol);
        const result = await this.queryContract<{
            positions?: Record<string, { size: string; entry_price: string }>;
        }>({
            user_state_extended: {
                user: this.userAddress,
                include_unrealized_pnl: true,
                include_equity: false,
                include_available_margin: false,
                include_maintenance_margin: false,
                include_unrealized_funding: false,
                include_liquidation_price: false,
            },
        });

        const pos = result?.positions?.[pairId];
        if (!pos) return null;

        const size = parseFloat(pos.size);
        if (size === 0) return null;

        // Dango size is USD notional — convert back to BTC quantity using entry_price
        const entryPrice = parseFloat(pos.entry_price);
        const btcSize = entryPrice > 0 ? Math.abs(size) / entryPrice : 0;
        const unrealizedPnl = parseFloat((pos as any).unrealized_pnl ?? '0');

        return {
            symbol,
            side: size > 0 ? 'long' : 'short',
            size: btcSize,
            entryPrice,
            unrealizedPnl,
        };
    }

    async get_balance(): Promise<number> {
        const result = await this.queryContract<{ margin?: string }>({
            user_state: { user: this.userAddress },
        });
        return parseFloat(result?.margin ?? '0');
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /** Convert "BTC-USD" or "BTC/USD" → "perp/btcusd" */
    private _toPairId(symbol: string): string {
        const base = symbol.split(/[-/]/)[0].toLowerCase();
        const quote = symbol.split(/[-/]/)[1]?.toLowerCase() ?? 'usd';
        return `perp/${base}${quote}`;
    }
}
