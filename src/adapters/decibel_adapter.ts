import { ExchangeAdapter, Position, RawTrade } from './ExchangeAdapter.js';
import { Orderbook, OrderParams, ConnectionHealth, Order } from '../types/core.js';
// @ts-ignore - SDK type declarations are broken; use namespace import for CJS interop
import * as decibelSdk from '@decibeltrade/sdk';
const { DecibelReadDex, DecibelWriteDex, MAINNET_CONFIG, GasPriceManager, TimeInForce } = decibelSdk as any;
import { Ed25519Account, Ed25519PrivateKey } from '@aptos-labs/ts-sdk';

// Use NETNA_CONFIG if available (newer SDK), fall back to MAINNET_CONFIG
const NET_CONFIG = MAINNET_CONFIG ?? MAINNET_CONFIG;

// ── Debug fetch interceptor ───────────────────────────────────────────────────
// Set DECIBEL_DEBUG=true in .env to log all HTTP requests/responses made by the SDK
if (process.env.DECIBEL_DEBUG === 'true') {
    const _origFetch = globalThis.fetch;
    (globalThis as any).fetch = async function debugFetch(input: RequestInfo | URL, init?: RequestInit) {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const body = init?.body;

        console.log(`\n[Decibel ▶] ${method} ${url}`);
        if (body) {
            try { console.log('[Decibel ▶] body:', JSON.stringify(JSON.parse(body as string), null, 2)); }
            catch { console.log('[Decibel ▶] body:', body); }
        }

        const res = await _origFetch(input, init);
        const clone = res.clone();
        clone.text().then(text => {
            try { console.log(`[Decibel ◀] ${res.status} ${url}\n`, JSON.stringify(JSON.parse(text), null, 2)); }
            catch { console.log(`[Decibel ◀] ${res.status} ${url}\n`, text.slice(0, 500)); }
        }).catch(() => {});
        return res;
    };
    console.log('[DecibelAdapter] Debug mode ON — logging all HTTP requests');
}

export class DecibelAdapter implements ExchangeAdapter {
    /** Exchange name identifier */
    readonly exchangeName: string = 'decibel';
    
    /** List of supported trading symbols */
    readonly supportedSymbols: string[] = [
        'BTC-USD',
        'ETH-USD', 
        'SOL-USD',
        'AVAX-USD',
        'MATIC-USD',
        'LINK-USD',
        'UNI-USD',
        'AAVE-USD',
        'SUSHI-USD',
        'CRV-USD'
    ];

    private read: any;
    private write: any;
    private subaccountAddr: string;
    private builderAddr: string;
    private builderFeeBps: number;
    private connected: boolean = false;
    private _obCache: Map<string, { best_bid: number; best_ask: number; ts: number }> = new Map();
    private _obUnsubs: Map<string, () => void> = new Map();
    // Cache market config (sz_decimals, px_decimals) per symbol
    private _marketConfig: Map<string, { sz_decimals: number; px_decimals: number; tick_size: number; min_size: number; market_addr: string }> = new Map();

    constructor(privateKey: string, nodeApiKey: string, subaccountAddr: string, builderAddr: string, builderFeeBps: number = 10, gasStationApiKey?: string) {
        this.subaccountAddr = subaccountAddr;
        // Empty builderAddr = no builder fee mode
        this.builderAddr = builderAddr ? this.padAddress(builderAddr) : '';
        this.builderFeeBps = builderFeeBps;

        const cleanKey = (val: string) => {
            let res = val.trim();
            while (res.startsWith('ed25519-priv-') || res.startsWith('0x')) {
                res = res.replace(/^ed25519-priv-/, '').replace(/^0x/, '');
            }
            return res;
        };

        const sanitizedKey = cleanKey(privateKey);
        const sanitizedNodeKey = cleanKey(nodeApiKey);

        const account = new Ed25519Account({
            privateKey: new Ed25519PrivateKey(sanitizedKey),
        });

        this.read = new DecibelReadDex(NET_CONFIG, {
            nodeApiKey: sanitizedNodeKey,
            onWsError: (e: any) => console.warn("Decibel WS error:", e),
        });

        const effectiveGasKey = gasStationApiKey ?? process.env.DECIBELS_GAS_STATION_API_KEY;

        // SDK reads gasStationApiKey from the config object (arg 1), NOT from opts (arg 3).
        // See base.js: this.useGasStation = !!config.gasStationApiKey
        // So we must spread it into the network config, not into writeOpts.
        const writeConfig = effectiveGasKey
            ? { ...NET_CONFIG, gasStationApiKey: effectiveGasKey }
            : NET_CONFIG;

        if (effectiveGasKey) {
            console.log('[DecibelAdapter] Gas Station enabled — APT gas fees will be sponsored');
        } else {
            console.warn('[DecibelAdapter] No gas station key — self-pay mode (requires APT in wallet)');
        }

        // Initialize GasPriceManager for faster tx building (cached gas price)
        // then wire up write client asynchronously
        const writeOpts: Record<string, any> = {
            nodeApiKey: sanitizedNodeKey,
            skipSimulate: false,
        };

        // Create write client immediately (without gasPriceManager) so it's usable right away
        this.write = new DecibelWriteDex(writeConfig, account, writeOpts);

        // Log both wallet address and subaccount address for debugging
        console.log(`[DecibelAdapter] Wallet address (from private key): ${account.accountAddress.toString()}`);
        console.log(`[DecibelAdapter] Subaccount address (DECIBELS_SUBACCOUNT): ${subaccountAddr || '(empty — using wallet address)'}`);
        if (!subaccountAddr) {
            // If no subaccount set, use wallet address as subaccount
            this.subaccountAddr = account.accountAddress.toString();
            console.log(`[DecibelAdapter] No subaccount set — defaulting subaccountAddr to wallet: ${this.subaccountAddr}`);
        }

        // Upgrade with GasPriceManager in background if available
        if (typeof GasPriceManager === 'function') {
            const gas = new GasPriceManager(writeConfig);
            gas.initialize().then(() => {
                this.write = new DecibelWriteDex(writeConfig, account, {
                    ...writeOpts,
                    gasPriceManager: gas,
                });
                console.log('[DecibelAdapter] GasPriceManager initialized');
            }).catch((e: any) => {
                console.warn('[DecibelAdapter] GasPriceManager init failed, using default gas:', e?.message ?? e);
            });
        }
    }

    private padAddress(addr: string): string {
        // Remove 0x prefix if present
        let hex = addr.startsWith('0x') ? addr.slice(2) : addr;
        
        // Validate hex string length
        if (hex.length > 64) {
            throw new Error(`Address too long: ${hex.length} hex characters (max 64)`);
        }
        
        // Pad with leading zeros to 64 characters
        hex = hex.padStart(64, '0');
        
        // Return with 0x prefix
        return '0x' + hex;
    }

    private async getMarketConfig(symbol: string): Promise<{ sz_decimals: number; px_decimals: number; tick_size: number; min_size: number; market_addr: string }> {
        if (this._marketConfig.has(symbol)) return this._marketConfig.get(symbol)!;
        const markets = await this.read.markets.getAll();
        const m = markets?.find((m: any) => m.market_name === symbol);
        if (!m) throw new Error(`Market "${symbol}" not found`);
        const cfg = {
            sz_decimals: m.sz_decimals ?? 8,
            px_decimals: m.px_decimals ?? 6,
            tick_size: m.tick_size ?? 100000,
            min_size: m.min_size ?? 2000,
            market_addr: m.market_addr ?? '',
        };
        this._marketConfig.set(symbol, cfg);
        console.log(`[Decibel] Market config for ${symbol}:`, cfg);
        return cfg;
    }

    private toChainPrice(price: number, px_decimals: number, tick_size: number): number {
        // Convert price to chain units, then round DOWN to nearest tick_size multiple
        // tick_size is already in chain units (e.g. 100 means $0.000001 * 100 = $0.0001 per tick)
        const raw = price * Math.pow(10, px_decimals);
        return Math.floor(raw / tick_size) * tick_size;
    }

    private toChainSize(size: number, sz_decimals: number): number {
        return Math.floor(size * Math.pow(10, sz_decimals));
    }

    async approveBuilderFee(maxFeeBps: number = 10): Promise<void> {
        await this.write.approveMaxBuilderFee({
            builderAddr: this.builderAddr,
            maxFee: maxFeeBps,
        });
    }

    async get_mark_price(symbol: string): Promise<number> {
        // marketPrices.getAll() returns items keyed by market address, not name
        // Use markets.getAll() to resolve name → address first
        const markets = await this.read.markets.getAll();
        const marketInfo = markets?.find((m: any) => m.market_name === symbol);
        if (!marketInfo) {
            const names = (markets ?? []).map((m: any) => m.market_name).join(', ');
            throw new Error(`Market "${symbol}" not found. Available: ${names}`);
        }
        const allPrices = await this.read.marketPrices.getAll();
        const priceEntry = allPrices?.find((p: any) =>
            p.market === marketInfo.market_addr || p.market === symbol
        );
        if (!priceEntry) throw new Error(`No price data for ${symbol}`);
        return priceEntry.mid_px ?? priceEntry.mark_px;
    }

    async get_orderbook(symbol: string): Promise<{ best_bid: number, best_ask: number }> {
        // Check cache first (valid for 2s)
        const cached = this._obCache.get(symbol);
        if (cached && Date.now() - cached.ts < 2000) return cached;

        // Subscribe if not already subscribed
        if (!this._obUnsubs.has(symbol)) {
            const unsub = this.read.marketDepth.subscribeByName(symbol, 1, (depth: any) => {
                const bids: any[] = depth.bids ?? depth.b ?? [];
                const asks: any[] = depth.asks ?? depth.a ?? [];
                if (!bids.length || !asks.length) return;
                const normalize = (p: number) => p > 1e6 ? p / 1e8 : p;
                this._obCache.set(symbol, {
                    best_bid: normalize(bids[0].price ?? bids[0].px ?? bids[0][0]),
                    best_ask: normalize(asks[0].price ?? asks[0].px ?? asks[0][0]),
                    ts: Date.now(),
                });
            });
            this._obUnsubs.set(symbol, unsub);
        }

        // Wait up to 5s for first WS message
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
            const c = this._obCache.get(symbol);
            if (c) return c;
            await new Promise(r => setTimeout(r, 50));
        }

        // Fallback: use mid_px from REST
        const mid = await this.get_mark_price(symbol);
        return { best_bid: mid, best_ask: mid };
    }

    async place_limit_order(symbol: string, side: 'buy' | 'sell', price: number, size: number, reduceOnly?: boolean, _timeInForce?: number): Promise<string> {
        const cfg = await this.getMarketConfig(symbol);
        // Only attach builder fields if a builder address is configured.
        // When omitted, SDK uses primary subaccount and no builder fee.
        const builderFields = this.builderAddr
            ? { builderAddr: this.builderAddr, builderFee: this.builderFeeBps }
            : {};
        const orderParams = {
            marketName: symbol,
            price: this.toChainPrice(price, cfg.px_decimals, cfg.tick_size),
            size: this.toChainSize(size, cfg.sz_decimals),
            isBuy: side === 'buy',
            skipSimulate: true,
            timeInForce: TimeInForce.PostOnly,
            isReduceOnly: reduceOnly ?? false,
            subaccountAddr: this.subaccountAddr,
            // subaccountAddr omitted → SDK auto-resolves primary subaccount from API wallet
            ...builderFields,
        };
        console.log('[Decibel] place_limit_order params:', JSON.stringify(orderParams, null, 2));
        try {
            const result = await this.write.placeOrder(orderParams);
            console.log('[Decibel] place_limit_order result:', JSON.stringify(result, null, 2));
            
            // Extract real order ID from response
            const orderId = result.orderId ?? result.order_id ?? result.hash;
            if (!orderId) {
                throw new Error('No order ID in response: ' + JSON.stringify(result));
            }
            return orderId;
        } catch (err: any) {
            console.error('[Decibel] place_limit_order error:', JSON.stringify(err?.response?.data ?? err?.message ?? err, null, 2));
            throw err;
        }
    }

    async cancel_order(order_id: string, symbol: string): Promise<boolean> {
        try {
            await this.write.cancelOrder({
                orderId: order_id,
                marketName: symbol,
                subaccountAddr: this.subaccountAddr,
            });
            console.log(`[Decibel] cancel_order OK: ${order_id}`);
            return true;
        } catch (e: any) {
            console.error(`[Decibel] cancel_order FAILED (${order_id}):`, e?.message ?? e);
            return false;
        }
    }

    async cancel_all_orders(symbol: string): Promise<boolean> {
        try {
            // First check if there are actually open orders
            const openOrders = await this.get_open_orders(symbol);
            if (openOrders.length === 0) {
                console.log(`[Decibel] cancel_all_orders: no open orders for ${symbol}`);
                return true;
            }

            console.log(`[Decibel] cancel_all_orders: cancelling ${openOrders.length} order(s) by ID for ${symbol}`);

            // Cancel each order individually by ID — cancelBulkOrder without IDs
            // calls cancel_bulk_order_to_subaccount which fails with EORDER_NOT_FOUND
            const results = await Promise.allSettled(
                openOrders.map(order =>
                    this.write.cancelOrder({
                        orderId: order.id,
                        marketName: symbol,
                        subaccountAddr: this.subaccountAddr,
                    }).then(() => {
                        console.log(`[Decibel] cancel_all_orders: cancelled order ${order.id}`);
                        return true;
                    })
                )
            );

            const failed = results.filter(r => r.status === 'rejected');
            if (failed.length > 0) {
                failed.forEach(r => {
                    if (r.status === 'rejected') {
                        console.error(`[Decibel] cancel_all_orders: one order failed:`, r.reason?.message ?? r.reason);
                    }
                });
                // Return false only if ALL failed; partial cancel is still progress
                if (failed.length === openOrders.length) return false;
            }

            console.log(`[Decibel] cancel_all_orders OK for ${symbol} (${openOrders.length - failed.length}/${openOrders.length} cancelled)`);
            return true;
        } catch (e: any) {
            const msg = e?.message ?? String(e);
            console.error(`[Decibel] cancel_all_orders FAILED for ${symbol}:`, msg);
            return false;
        }
    }

    async get_open_orders(symbol: string): Promise<Order[]> {
        try {
            // Resolve market address for correct filtering (API returns market address, not name)
            const cfg = await this.getMarketConfig(symbol);
            const orderArgs: any = { subAddr: this.subaccountAddr };
            
            console.log(`[Decibel] get_open_orders query: subAddr=${this.subaccountAddr}, market=${cfg.market_addr}`);
            
            const openOrders: any = await this.read.userOpenOrders.getByAddr(orderArgs);
            // Handle all known response formats from Decibel API:
            //   { items: [...], total_count: N }  ← confirmed format
            //   [...] direct array
            //   { data: [...] }
            //   { open_orders: [...] }
            const allOrders: any[] = Array.isArray(openOrders)
                ? openOrders
                : (openOrders?.items ?? openOrders?.data ?? openOrders?.open_orders ?? []);
            
            // DEBUG: log full raw response structure to detect field name issues
            console.log(`[Decibel] get_open_orders raw response type: ${typeof openOrders}, isArray: ${Array.isArray(openOrders)}`);
            if (Array.isArray(openOrders)) {
                console.log(`[Decibel] get_open_orders raw response: ${openOrders.length} total orders (direct array)`);
                if (openOrders.length > 0) {
                    console.log(`[Decibel] get_open_orders sample keys:`, Object.keys(openOrders[0]));
                    console.log(`[Decibel] get_open_orders raw orders:`, JSON.stringify(openOrders.map((o: any) => ({
                        order_id: o.order_id, market: o.market, is_buy: o.is_buy, remaining_size: o.remaining_size,
                    })), null, 2));
                }
            } else {
                console.log(`[Decibel] get_open_orders raw response keys: ${Object.keys(openOrders || {}).join(', ')}`);
                console.log(`[Decibel] get_open_orders raw response: ${allOrders.length} total orders`);
                if (allOrders.length > 0) {
                    console.log(`[Decibel] get_open_orders raw orders:`, JSON.stringify(allOrders.map((o: any) => ({
                        order_id: o.order_id, market: o.market, is_buy: o.is_buy, remaining_size: o.remaining_size,
                    })), null, 2));
                }
            }
            
            // Filter by market address
            const filtered = allOrders.filter((o: any) => o.market === cfg.market_addr);
            
            console.log(`[Decibel] get_open_orders filtered: ${filtered.length} orders for ${symbol} (market: ${cfg.market_addr})`);
            
            return filtered.map((o: any) => ({
                id: o.order_id,
                symbol,
                side: o.is_buy ? 'buy' : 'sell',
                price: o.price ?? 0,
                size: o.remaining_size ?? o.orig_size ?? 0,
                status: 'pending' as const,
                timestamp: new Date() // Add required timestamp field
            }));
        } catch (e: any) {
            if (e?.status === 404) return [];
            throw e;
        }
    }

    async get_position(symbol: string, markPrice?: number): Promise<Position | null> {
        try {
            const cfg = await this.getMarketConfig(symbol);
            const positions: any[] = await this.read.userPositions.getByAddr({ subAddr: this.subaccountAddr });
            const pos = (Array.isArray(positions) ? positions : []).find(
                (p: any) => p.market === cfg.market_addr
            );
            if (!pos) return null;

            // API confirmed fields: size (negative = short), entry_price, unrealized_funding
            // No unrealized PnL field — compute from markPrice passed by caller
            const size: number = pos.size ?? 0;
            if (size === 0) return null;

            const entryPrice: number = pos.entry_price ?? 0;
            const side: 'long' | 'short' = size > 0 ? 'long' : 'short';
            const absSize = Math.abs(size);

            // Compute PnL from markPrice if provided, otherwise 0
            const unrealizedPnl = markPrice && markPrice > 0 && entryPrice > 0
                ? side === 'long'
                    ? (markPrice - entryPrice) * absSize
                    : (entryPrice - markPrice) * absSize
                : 0;

            return {
                symbol,
                side,
                size: absSize,
                entryPrice,
                unrealizedPnl,
            };
        } catch (e: any) {
            if (e?.status === 404) return null;
            throw e;
        }
    }

    async get_balance(): Promise<number> {
        try {
            const overviewArgs: any = { subAddr: this.subaccountAddr };
            const overview: any = await this.read.accountOverview.getByAddr(overviewArgs);
            return overview && overview.perp_equity_balance ? overview.perp_equity_balance : 0;
        } catch (e: any) {
            if (e?.status === 404) {
                // Subaccount not yet created on-chain — needs deposit via Decibel UI first
                console.warn('[DecibelAdapter] Subaccount not found (404) — deposit USDC via app.decibel.trade to create it');
                return 0;
            }
            throw e;
        }
    }

    async get_orderbook_depth(_symbol: string, _limit: number): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
        return { bids: [], asks: [] }; // Stub — use get_orderbook for best bid/ask
    }

    async get_recent_trades(_symbol: string, _limit: number): Promise<RawTrade[]> {
        return []; // Stub
    }

    // IExchangeAdapter interface methods (camelCase aliases)
    async getMarkPrice(symbol: string): Promise<number> {
        return this.get_mark_price(symbol);
    }

    async getOrderbook(symbol: string): Promise<Orderbook> {
        const ob = await this.get_orderbook(symbol);
        return {
            bestBid: ob.best_bid,
            bestAsk: ob.best_ask,
            bids: [[ob.best_bid, 0]], // Size not available from current implementation
            asks: [[ob.best_ask, 0]], // Size not available from current implementation
            timestamp: new Date()
        };
    }

    async getOrderbookDepth(symbol: string, limit: number): Promise<{ bids: [number, number][], asks: [number, number][] }> {
        return this.get_orderbook_depth(symbol, limit);
    }

    async getRecentTrades(symbol: string, limit: number): Promise<RawTrade[]> {
        return this.get_recent_trades(symbol, limit);
    }

    async getPosition(symbol: string, markPrice?: number): Promise<Position | null> {
        return this.get_position(symbol, markPrice);
    }

    async getBalance(): Promise<number> {
        return this.get_balance();
    }

    async placeLimitOrder(params: OrderParams): Promise<string> {
        return this.place_limit_order(params.symbol, params.side, params.price, params.size, params.reduceOnly);
    }

    async cancelOrder(orderId: string, symbol: string): Promise<boolean> {
        return this.cancel_order(orderId, symbol);
    }

    async cancelAllOrders(symbol: string): Promise<boolean> {
        return this.cancel_all_orders(symbol);
    }

    async getOpenOrders(symbol: string): Promise<Order[]> {
        return this.get_open_orders(symbol);
    }

    // Connection management methods
    async connect(): Promise<void> {
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        this.connected = false;
    }

    isConnected(): boolean {
        return this.connected;
    }

    getHealthStatus(): ConnectionHealth {
        return {
            isHealthy: this.connected,
            lastPing: new Date(),
            latency: 0
        };
    }
}
