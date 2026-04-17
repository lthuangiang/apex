import { IExchangeAdapter, Order, Position, RawTrade, OrderParams, Orderbook, ConnectionHealth } from '../types/core.js';
import axios from 'axios';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2.js';

// ─── Dango GraphQL Adapter ────────────────────────────────────────────────────
// Docs: https://docs.dango.exchange/perps/8-api.html
//
// Authentication (§2.4 Secp256k1):
//   1. Build SignDoc: { data, gas_limit, messages, sender } — fields sorted alphabetically
//   2. SHA-256 hash the canonical JSON
//   3. Sign with Secp256k1 → 64-byte compact signature (r+s)
//   4. key_hash = SHA-256(compressed public key) — hex uppercase
//
// Address format: sender is EVM-style 0x... hex address (NOT bech32)
// DANGO_PRIVATE_KEY: raw 32-byte hex (64 chars, no 0x prefix)
// DANGO_USER_ADDRESS: 0x... hex address matching the private key

const MAINNET_HTTP = 'https://api-mainnet.dango.zone/graphql';
const TESTNET_HTTP = 'https://api-testnet.dango.zone/graphql';
const PERPS_CONTRACT = '0x90bc84df68d1aa59a857e04ed529e9a26edbea4f';
const CHAIN_ID = 'dango-1';

export class DangoAdapter implements IExchangeAdapter {
    readonly exchangeName = 'dango';
    readonly supportedSymbols = ['BTC-USD', 'ETH-USD', 'SOL-USD'];

    private readonly endpoint: string;
    private readonly userAddress: string;   // bech32 dango1... address
    private readonly privateKeyHex: string; // 32-byte hex, no 0x prefix
    private cachedUserIndex: number | null = null;
    private lastNonce: number = 0;
    private connected = false;

    constructor(
        privateKey: string,
        userAddress: string,
        network: 'mainnet' | 'testnet' = 'mainnet'
    ) {
        // Normalize to raw 64-char hex (no 0x prefix) for hashing
        // ethers.SigningKey requires '0x' + 64 hex chars (32 bytes)
        const stripped = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
        if (stripped.length !== 64) {
            throw new Error(`[DangoAdapter] Invalid private key length: expected 64 hex chars, got ${stripped.length}`);
        }
        this.privateKeyHex = stripped;
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

    /** Query a contract via wasm_smart. Returns the inner wasm_smart result. */
    private async queryContract<T = any>(msg: Record<string, unknown>): Promise<T> {
        const data = await this.gql<{ queryApp: { wasm_smart: T } }>(`
            query QueryContract($msg: JSON!) {
                queryApp(request: { wasm_smart: { contract: "${PERPS_CONTRACT}", msg: $msg } })
            }
        `, { msg });
        // Response is wrapped: { queryApp: { wasm_smart: <actual data> } }
        const result = data.queryApp as any;
        return (result?.wasm_smart ?? result) as T;
    }

    // ── Signing ───────────────────────────────────────────────────────────────

    private async getUserIndex(): Promise<number> {
        if (this.cachedUserIndex !== null) return this.cachedUserIndex;

        // Doc §2.7: query account's user_index via accounts(address: ...)
        const data = await this.gql<{ accounts: { nodes: Array<{ users: Array<{ userIndex: number }> }> } }>(`
            query {
                accounts(address: "${this.userAddress}", first: 1) {
                    nodes { users { userIndex } }
                }
            }
        `);

        const userIndex = data.accounts?.nodes?.[0]?.users?.[0]?.userIndex;
        if (userIndex === undefined) {
            throw new Error(`[DangoAdapter] Could not find user index for address ${this.userAddress}. Make sure your wallet is registered on Dango.`);
        }
        this.cachedUserIndex = userIndex;
        console.log(`[DangoAdapter] Resolved userIndex: ${userIndex}`);
        return userIndex;
    }

    private getNextNonce(): number {
        // Doc §2.2: nonce is u32. Use incrementing counter seeded from timestamp.
        // Dango uses unordered nonces with sliding window of 20.
        const n = Date.now() % 0xFFFFFFFF; // keep within u32 range
        if (n <= this.lastNonce) { this.lastNonce += 1; return this.lastNonce; }
        this.lastNonce = n;
        return this.lastNonce;
    }

    private signTx(signDoc: Record<string, unknown>): string {
        // Doc §2.6: canonical JSON (fields sorted alphabetically) → SHA-256 → Secp256k1 sign
        const canonical = JSON.stringify(signDoc, Object.keys(signDoc).sort());
        const hash = sha256(Buffer.from(canonical));
        const privKeyBytes = Buffer.from(this.privateKeyHex, 'hex');
        // @noble/curves secp256k1 — compact 64-byte signature (r+s, no recovery byte)
        const sig = secp256k1.sign(hash, privKeyBytes, { lowS: true });
        return Buffer.from(sig.toCompactRawBytes()).toString('hex');
    }

    private getKeyHash(): string {
        // Doc §2.4: key_hash = SHA-256(compressed public key), hex uppercase
        const privKeyBytes = Buffer.from(this.privateKeyHex, 'hex');
        const pubKeyBytes = secp256k1.getPublicKey(privKeyBytes, true); // compressed 33 bytes
        return Buffer.from(sha256(pubKeyBytes)).toString('hex').toUpperCase();
    }

    private async broadcastTx(msgs: unknown[]): Promise<unknown> {
        const userIndex = await this.getUserIndex();
        const nonce = this.getNextNonce();

        // Doc §2.6: SignDoc structure
        const signDoc = {
            data: { chain_id: CHAIN_ID, expiry: null, nonce, user_index: userIndex },
            gas_limit: 1500000,
            messages: msgs,
            sender: this.userAddress,
        };

        const sig = this.signTx(signDoc);
        const keyHash = this.getKeyHash();

        // Doc §2.1: Tx structure
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

        // Check for contract-level errors in check_tx result
        const resultStr = JSON.stringify(result.broadcastTxSync);
        const checkTx = (result.broadcastTxSync as any)?.check_tx;
        if (checkTx?.result?.Err) {
            const errMsg = checkTx.result.Err.error ?? JSON.stringify(checkTx.result.Err);
            throw new Error(`[DangoAdapter] Contract error: ${errMsg}`);
        }

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
        // bucket_size must be a string decimal. Use "10.000000" for BTC (smallest standard bucket).
        // Response is wrapped: { wasm_smart: { bids: {...}, asks: {...} } }
        const result = await this.queryContract<{
            bids: Record<string, { size: string; notional: string }>;
            asks: Record<string, { size: string; notional: string }>;
        }>({
            liquidity_depth: { pair_id: pairId, bucket_size: '10.000000', limit },
        });

        const parseLevels = (levels: Record<string, { size: string; notional: string }>): [number, number][] =>
            Object.entries(levels ?? {})
                .map(([price, { size }]) => [parseFloat(price), parseFloat(size)] as [number, number])
                .sort((a, b) => b[0] - a[0]);

        return {
            bids: parseLevels(result?.bids ?? {}),
            asks: parseLevels(result?.asks ?? {}).reverse(),
        };
    }

    async get_recent_trades(symbol: string, limit: number): Promise<RawTrade[]> {
        // Dango has no perpsTrades field — use perpsCandles as a proxy.
        // Confirmed PerpsCandle fields: timeStart, open, close, high, low, volume
        const pairId = this._toPairId(symbol);
        const data = await this.gql<{
            perpsCandles: {
                nodes: Array<{
                    timeStart: string;
                    open: string;
                    close: string;
                    volume: string;
                }>;
            };
        }>(`
            query {
                perpsCandles(pairId: "${pairId}", interval: ONE_MINUTE, first: ${limit}) {
                    nodes { timeStart open close volume }
                }
            }
        `);

        const nodes = data.perpsCandles?.nodes ?? [];
        return nodes.map((c: any) => ({
            side: parseFloat(c.close ?? '0') >= parseFloat(c.open ?? c.close ?? '0') ? 'buy' : 'sell',
            price: parseFloat(c.close ?? '0'),
            size: parseFloat(c.volume ?? '0'),
            timestamp: new Date(c.timeStart).getTime(),
        }));
    }

    async place_limit_order(
        symbol: string,
        side: 'buy' | 'sell',
        price: number,
        size: number,
        reduceOnly = false,
        timeInForce = 4,
    ): Promise<string> {
        const pairId = this._toPairId(symbol);

        // Dango size = USD notional (positive = long, negative = short)
        const usdNotional = (size * price).toFixed(6);
        const dangoSize = side === 'buy' ? usdNotional : `-${usdNotional}`;

        const tifMap: Record<number, string> = { 4: 'POST', 3: 'IOC' };
        const tif = tifMap[timeInForce] ?? 'GTC';

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

        // Extract order_id from events in the result
        const resultStr = JSON.stringify(result);
        const match = resultStr.match(/"order_id"\s*:\s*"?(\d+)"?/);
        if (match) {
            console.log(`[DangoAdapter] Order placed: ${match[1]}`);
            return match[1];
        }
        // Fallback: use tx_hash as order reference
        const txHash = (result as any)?.tx_hash;
        if (txHash) return txHash;
        return `dango-${Date.now()}`;
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
        const result = await this.queryContract<Record<string, {
            pair_id: string;
            size: string;
            limit_price: string;
            reduce_only: boolean;
        }>>({
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
                status: 'pending' as const,
                timestamp: new Date(),
            }));
    }

    async get_position(symbol: string, _markPrice?: number): Promise<Position | null> {
        const pairId = this._toPairId(symbol);
        const result = await this.queryContract<{
            positions?: Record<string, { size: string; entry_price: string; unrealized_pnl?: string }>;
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

        const entryPrice = parseFloat(pos.entry_price);
        const btcSize = entryPrice > 0 ? Math.abs(size) / entryPrice : 0;
        const unrealizedPnl = parseFloat(pos.unrealized_pnl ?? '0');

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

    // ── IExchangeAdapter interface methods ────────────────────────────────────

    async getMarkPrice(symbol: string): Promise<number> { return this.get_mark_price(symbol); }

    async getOrderbook(symbol: string): Promise<Orderbook> {
        const result = await this.get_orderbook(symbol);
        return { bestBid: result.best_bid, bestAsk: result.best_ask, bids: [[result.best_bid, 0]], asks: [[result.best_ask, 0]] };
    }

    async getOrderbookDepth(symbol: string, limit: number) { return this.get_orderbook_depth(symbol, limit); }
    async getRecentTrades(symbol: string, limit: number) { return this.get_recent_trades(symbol, limit); }
    async getPosition(symbol: string, markPrice?: number) { return this.get_position(symbol, markPrice); }
    async getBalance() { return this.get_balance(); }

    async placeLimitOrder(params: OrderParams): Promise<string> {
        const tifMap: Record<string, number> = { 'post-only': 4, 'IOC': 3, 'GTC': 0, 'FOK': 1 };
        const tif = params.timeInForce ? (tifMap[params.timeInForce] ?? 4) : 4;
        return this.place_limit_order(params.symbol, params.side, params.price, params.size, params.reduceOnly, tif);
    }

    async cancelOrder(orderId: string, symbol: string) { return this.cancel_order(orderId, symbol); }
    async cancelAllOrders(symbol: string) { return this.cancel_all_orders(symbol); }
    async getOpenOrders(symbol: string) { return this.get_open_orders(symbol); }

    async connect(): Promise<void> {
        try {
            await this.getUserIndex();
            this.connected = true;
        } catch (error) {
            this.connected = false;
            throw new Error(`Failed to connect to Dango: ${error}`);
        }
    }

    async disconnect(): Promise<void> { this.connected = false; }
    isConnected(): boolean { return this.connected; }
    getHealthStatus(): ConnectionHealth { return { isHealthy: this.connected, lastPing: new Date(), latency: 0 }; }
}
