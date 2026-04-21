import { ExchangeAdapter, Position, RawTrade } from './ExchangeAdapter.js';
import { Orderbook, OrderParams, ConnectionHealth, Order, OrderStatus } from '../types/core.js';
import { ethers } from 'ethers';

// ─── SodexAdapter ─────────────────────────────────────────────────────────────
export class SodexAdapter implements ExchangeAdapter {
    /** Exchange name identifier */
    readonly exchangeName: string = 'sodex';
    
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
        'CRV-USD',
        'DOT-USD',
        'ADA-USD',
        'ATOM-USD',
        'NEAR-USD',
        'FTM-USD'
    ];

    private readonly baseUrl = 'https://mainnet-gw.sodex.dev/api/v1/perps';
    private apiKey: string;
    private apiSecret: string;
    public userAddress: string;
    private cachedAccountId: number | null = null;
    private cachedSymbolId: Record<string, number> = {};
    private cachedTickSize: Record<string, number> = {};
    private cachedLotSize: Record<string, number> = {};
    private lastNonce: number = 0;
    private wallet: ethers.Wallet;
    private connected: boolean = false;
    /** Timestamp (ms) until which all requests should be paused due to rate limiting */
    private _rateLimitUntil: number = 0;

    constructor(apiKey: string, apiSecret: string, userAddress: string) {
        this.apiKey = apiKey;
        this.apiSecret = apiSecret;
        this.userAddress = userAddress;
        this.wallet = new ethers.Wallet(apiSecret);
    }

    private async getSignature(nonce: number, method: string, paramsStr: string): Promise<string> {
        const actionType = method === 'DELETE' ? 'cancelOrder' : 'newOrder';

        // Canonical JSON for ActionPayload {type, params}
        // Important: Go json.Marshal uses struct field order: Type then Params
        // We must build the JSON string manually to guarantee field order
        const payloadStr = `{"type":"${actionType}","params":${paramsStr}}`;
        const payloadHash = ethers.keccak256(ethers.toUtf8Bytes(payloadStr));

        console.log(`[SoDEX SIGN] Payload  : ${payloadStr}`);
        console.log(`[SoDEX SIGN] Hash     : ${payloadHash}`);
        console.log(`[SoDEX SIGN] Nonce    : ${nonce}`);

        const domain = {
            name: "futures",
            version: "1",
            chainId: 286623,
            verifyingContract: "0x0000000000000000000000000000000000000000"
        };

        const types = {
            ExchangeAction: [
                { name: 'payloadHash', type: 'bytes32' },
                { name: 'nonce', type: 'uint64' }
            ]
        };

        const message = {
            payloadHash: payloadHash,
            nonce: BigInt(nonce)
        };

        const signature = await this.wallet.signTypedData(domain, types, message);

        // Normalize v: Go backends (SigToPub) expect 0/1, ethers returns 27/28
        let sig = signature.slice(2);
        let r = sig.slice(0, 64);
        let s = sig.slice(64, 128);
        let v = sig.slice(128, 130);
        let vInt = parseInt(v, 16);
        if (vInt >= 27) vInt -= 27;
        const normalizedV = vInt.toString(16).padStart(2, '0');

        const finalSig = "0x01" + r + s + normalizedV;
        console.log(`[SoDEX SIGN] Signature: ${finalSig}`);

        return finalSig;
    }

    private async request(method: string, endpoint: string, data?: any): Promise<any> {
        const url = `${this.baseUrl}${endpoint}`;

        let nonceVal = Date.now();
        if (nonceVal <= this.lastNonce) nonceVal = this.lastNonce + 1;
        this.lastNonce = nonceVal;

        let paramsStr = '';

        if (data) {
            if (typeof data === 'string') {
                paramsStr = data;
            } else if (method === 'POST' && endpoint === '/trade/orders') {
                const ord = data.orders?.[0];
                if (ord) {
                    // Strict Field order from Go RawOrder struct:
                    // clOrdID, modifier, side, type, timeInForce, price, quantity, reduceOnly, positionSide
                    const orderItemStr = `{"clOrdID":"${ord.clOrdID}","modifier":${ord.modifier},"side":${ord.side},"type":${ord.type},"timeInForce":${ord.timeInForce},"price":"${ord.price}","quantity":"${ord.quantity}","reduceOnly":${ord.reduceOnly},"positionSide":${ord.positionSide}}`;
                    paramsStr = `{"accountID":${data.accountID},"symbolID":${data.symbolID},"orders":[${orderItemStr}]}`;
                } else {
                    paramsStr = JSON.stringify(data);
                }
            } else if (method === 'DELETE' && endpoint === '/trade/orders') {
                const accountID = await this.getAccountId();
                const cancels = await Promise.all(data.map(async (o: any) => {
                    const symId = await this.getSymbolId(o.symbol);
                    // orderID is always numeric from SoDex API (uint64)
                    const orderID = (o.orderID ?? o.orderId ?? '').toString();
                    const isClientId = orderID.startsWith('ext-') || isNaN(Number(orderID));
                    if (isClientId) {
                        return `{"symbolID":${symId},"clOrdID":"${orderID}"}`;
                    } else {
                        return `{"symbolID":${symId},"orderID":${orderID}}`;
                    }
                }));
                const cancelsStr = '[' + cancels.join(',') + ']';
                // Strict Field order for PerpsCancelOrderRequest: accountID, cancels
                paramsStr = `{"accountID":${accountID},"cancels":${cancelsStr}}`;
            } else {
                paramsStr = JSON.stringify(data);
            }
        }

        let signature = '';
        if (method !== 'GET') {
            signature = await this.getSignature(nonceVal, method, paramsStr);
        }

        const config: RequestInit = {
            method,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-API-Key': this.apiKey,
                'X-API-Nonce': nonceVal.toString(),
                'X-API-Sign': signature,
            },
        };

        if (paramsStr) config.body = paramsStr;

        console.log(`\n[SoDEX DEBUG] ---> ${method} ${url} | Payload: ${paramsStr}`);

        try {
            // Respect rate limit backoff
            const now = Date.now();
            if (this._rateLimitUntil > now) {
                const waitMs = this._rateLimitUntil - now;
                console.warn(`[SoDEX] Rate limit active — waiting ${waitMs}ms before request`);
                await new Promise(resolve => setTimeout(resolve, waitMs));
            }

            const res = await fetch(url, config);
            const textResponse = await res.text();

            console.log(`[SoDEX DEBUG] <--- ${method} ${endpoint} (Status: ${res.status})`);
            console.log(`             Body: ${textResponse.substring(0, 300)}`);

            let json: any;
            try {
                json = JSON.parse(textResponse);
            } catch {
                throw new Error(
                    res.ok
                        ? `Sodex JSON Parse Error: ${textResponse.substring(0, 200)}`
                        : `Sodex HTTP ${res.status}: ${textResponse.substring(0, 500)}`
                );
            }

            if (json.code !== 0 && json.code !== '0' && json.error) {
                // Handle rate limit — set backoff and throw so caller can retry
                if (json.code === 429) {
                    const retryAfterSecs = json.data?.retryAfter ?? 5;
                    this._rateLimitUntil = Date.now() + retryAfterSecs * 1000;
                    console.warn(`[SoDEX] Rate limited — backing off ${retryAfterSecs}s`);
                }
                throw new Error(`Sodex API Error: ${JSON.stringify(json)}`);
            }
            return json.data;
        } catch (e: any) {
            console.error(`Sodex request failed: ${method} ${endpoint}`, e.message);
            throw e;
        }
    }

    async get_mark_price(symbol: string): Promise<number> {
        const data = await this.request('GET', `/markets/mark-prices?symbol=${symbol}`);
        return data && data.length > 0 ? parseFloat(data[0].markPrice) : 0;
    }

    async get_orderbook(symbol: string): Promise<{ best_bid: number; best_ask: number }> {
        const data = await this.get_orderbook_depth(symbol, 1);
        return {
            best_bid: data.bids[0][0],
            best_ask: data.asks[0][0],
        };
    }

    async get_orderbook_depth(symbol: string, limit: number): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
        const data = await this.request('GET', `/markets/${symbol}/orderbook?limit=${limit}`);
        return {
            bids: data.bids.map((b: any) => [parseFloat(b[0]), parseFloat(b[1])]),
            asks: data.asks.map((a: any) => [parseFloat(a[0]), parseFloat(a[1])]),
        };
    }

    async get_recent_trades(symbol: string, limit: number): Promise<RawTrade[]> {
        const data = await this.request('GET', `/markets/${symbol}/trades?limit=${limit}`);
        const arr = Array.isArray(data) ? data : (data?.trades || data?.data || []);
        return arr.map((t: any) => ({
            side: (t.side || t.type || t.S || '').toLowerCase() === 'buy' ? 'buy' : 'sell',
            price: parseFloat(t.price || t.p),
            size: parseFloat(t.size || t.quantity || t.q || 0),
            // SoDEX uses uppercase T for timestamp (milliseconds)
            timestamp: t.T || t.timestamp || t.time || Date.now(),
        }));
    }

    async getAccountId(): Promise<number> {
        if (this.cachedAccountId) return this.cachedAccountId;
        try {
            const data = await this.request('GET', `/accounts/${this.userAddress}/state`);
            console.log('[SodexAdapter] Raw account state response:', JSON.stringify(data, null, 2));
            if (data?.aid) { this.cachedAccountId = data.aid; return data.aid; }
            if (data?.data?.aid) { this.cachedAccountId = data.data.aid; return data.data.aid; }
        } catch (e) {
            console.error('[SoDEX] Failed to fetch account ID:', e);
        }
        return 0;
    }

    async getSymbolId(symbol: string): Promise<number> {
        if (this.cachedSymbolId[symbol]) return this.cachedSymbolId[symbol];
        try {
            const data = await this.request('GET', '/markets/symbols');
            const arr = Array.isArray(data) ? data : (data?.data || []);
            // Cache symbolId, tickSize, and lotSize for all symbols in one pass
            for (const s of arr) {
                const name: string = s.symbol || s.name;
                if (name && s.id !== undefined) {
                    this.cachedSymbolId[name] = s.id;
                }
                if (name && s.tickSize !== undefined) {
                    this.cachedTickSize[name] = parseFloat(s.tickSize);
                }
                // lotSize / stepSize / quantityStep — try common field names
                const lotRaw = s.lotSize ?? s.stepSize ?? s.quantityStep ?? s.minQty;
                if (name && lotRaw !== undefined) {
                    this.cachedLotSize[name] = parseFloat(lotRaw);
                    console.log(`[SoDEX] ${name}: tickSize=${s.tickSize} lotSize=${lotRaw}`);
                }
                // Debug: log all fields for first symbol to detect field names
                if (name === 'BTC-USD') {
                    console.log(`[SoDEX] BTC-USD raw symbol fields:`, JSON.stringify(s));
                }
            }
            if (this.cachedSymbolId[symbol] !== undefined) {
                return this.cachedSymbolId[symbol];
            }
        } catch (e) {
            console.error('[SoDEX] Failed to fetch symbol ID:', e);
        }
        return 1;
    }

    /**
     * Returns the tick size for a symbol (e.g. 1 for BTC-USD, 0.1 for ETH-USD).
     * Falls back to 1 if not cached yet.
     */
    private getTickSize(symbol: string): number {
        return this.cachedTickSize[symbol] ?? 1;
    }

    /**
     * Returns the lot size (quantity step) for a symbol.
     * Falls back to 0.001 for BTC-USD and 0.0001 for others.
     */
    private getLotSize(symbol: string): number {
        if (this.cachedLotSize[symbol] !== undefined) return this.cachedLotSize[symbol];
        return symbol === 'BTC-USD' ? 0.001 : 0.0001;
    }

    /**
     * Round a price to the nearest valid tick for the given symbol.
     * Uses parseFloat to strip unnecessary trailing zeros (e.g. "2281.0" → "2281").
     */
    private roundToTick(price: number, symbol: string): string {
        const tick = this.getTickSize(symbol);
        const rounded = Math.round(price / tick) * tick;
        // Determine decimal places from tick size (e.g. 0.1 → 1, 0.01 → 2, 1 → 0)
        const decimals = tick < 1 ? Math.round(-Math.log10(tick)) : 0;
        // parseFloat strips trailing zeros: "2281.0" → "2281", "2281.1" → "2281.1"
        return String(parseFloat(rounded.toFixed(decimals)));
    }

    /**
     * Round a quantity down to the nearest valid lot size for the given symbol.
     * Always floors (never rounds up) to avoid over-ordering.
     * Always uses absolute value — sign is determined by the order side, not quantity.
     */
    private roundToLot(qty: number, symbol: string): string {
        const lot = this.getLotSize(symbol);
        const absQty = Math.abs(qty);
        const floored = Math.floor(absQty / lot) * lot;
        const decimals = lot < 1 ? Math.round(-Math.log10(lot)) : 0;
        // Use parseFloat to strip trailing zeros — SoDEX rejects "0.00200", needs "0.002"
        const result = String(parseFloat(floored.toFixed(decimals)));
        console.log(`[SoDEX] roundToLot: qty=${qty} lot=${lot} decimals=${decimals} floored=${floored} result=${result}`);
        return result;
    }

    async place_limit_order(
        symbol: string,
        side: 'buy' | 'sell',
        price: number,
        size: number,
        reduceOnly = false,
        timeInForce = 4, // Default: Post-Only (maker, fee discount)
    ): Promise<string> {
        const accId = await this.getAccountId();
        const symId = await this.getSymbolId(symbol);

        // Round price to the symbol's tick size (fetched from /markets/symbols)
        const formattedPrice = this.roundToTick(price, symbol);

        // Round quantity down to the symbol's lot size (fetched from /markets/symbols)
        const formattedSize = this.roundToLot(size, symbol);

        const uniqueId = 'ext-' + Date.now().toString() + '-' + Math.floor(Math.random() * 1000);

        const modifier = 1;

        const ord = {
            modifier,
            side: side.toLowerCase() === 'buy' ? 1 : 2,
            type: 1,
            timeInForce,
            quantity: formattedSize,
            reduceOnly,
            positionSide: 1,
            clOrdID: uniqueId,
            price: formattedPrice,
        };

        // Strict Field order from Go RawOrder struct:
        // clOrdID, modifier, side, type, timeInForce, price, quantity, reduceOnly, positionSide
        const orderItemStr = `{"clOrdID":"${ord.clOrdID}","modifier":${ord.modifier},"side":${ord.side},"type":${ord.type},"timeInForce":${ord.timeInForce},"price":"${ord.price}","quantity":"${ord.quantity}","reduceOnly":${ord.reduceOnly},"positionSide":${ord.positionSide}}`;
        const paramsStr = `{"accountID":${accId},"symbolID":${symId},"orders":[${orderItemStr}]}`;

        console.log(`[SoDEX] Preparing order: ${side} ${formattedSize} @ ${formattedPrice} (accId: ${accId}, symId: ${symId})`);
        const res = await this.request('POST', '/trade/orders', paramsStr);
        return res?.[0]?.orderId || ord.clOrdID;
    }

    async cancel_order(order_id: string, symbol: string): Promise<boolean> {
        try {
            await this.request('DELETE', '/trade/orders', [{ orderId: order_id, symbol }]);
            return true;
        } catch { return false; }
    }

    async cancel_all_orders(symbol: string): Promise<boolean> {
        try {
            const openOrders = await this.get_open_orders(symbol);
            if (openOrders.length > 0) {
                console.log(`[SodexAdapter] Cancelling ${openOrders.length} open orders:`, openOrders.map(o => o.id));
                // Pass orderID (exact field name from API) so DELETE handler uses numeric path
                const payload = openOrders.map(o => ({ orderID: o.id, symbol: o.symbol }));
                await this.request('DELETE', '/trade/orders', payload);
                console.log(`[SodexAdapter] Cancel request sent.`);
            } else {
                console.log(`[SodexAdapter] No open orders to cancel.`);
            }
            return true;
        } catch (e) {
            console.error(`[SodexAdapter] cancel_all_orders failed:`, e);
            return false;
        }
    }

    async get_open_orders(symbol: string): Promise<Order[]> {
        const data = await this.request('GET', `/accounts/${this.userAddress}/orders?symbol=${symbol}`);
        // Response: json.data = { blockTime, blockHeight, orders: [...] }
        const arr = Array.isArray(data) ? data : (data?.orders || data?.data || []);
        if (arr.length > 0) {
            console.log(`[SodexAdapter] Raw open order sample:`, JSON.stringify(arr[0]));
        }
        return arr.map((o: any) => ({
            // API returns orderID (numeric exchange ID) and clOrdID (client string)
            id: (o.orderID ?? o.orderId ?? o.clOrdID ?? '').toString(),
            symbol: o.symbol,
            side: (o.side || '').toLowerCase(),
            price: parseFloat(o.price),
            size: parseFloat(o.origQty ?? o.quantity ?? o.size ?? 0),
            status: 'pending' as OrderStatus,
            timestamp: new Date() // Add required timestamp field
        })).filter((o: Order) => o.id !== '');
    }

    async get_position(symbol: string, markPrice?: number): Promise<Position | null> {
        const data = await this.request('GET', `/accounts/${this.userAddress}/positions?symbol=${symbol}`);
        const arr = Array.isArray(data) ? data : (data?.positions || data?.data || (data && Object.keys(data).length > 0 ? [data] : []));
        if (!arr || arr.length === 0) return null;

        // SoDEX API may return all positions regardless of query symbol — filter explicitly
        const matchingPositions = arr.filter((p: any) => {
            const posSymbol = p.symbol || '';
            return posSymbol === symbol || posSymbol === '';
        });

        if (matchingPositions.length === 0) {
            console.log(`[SodexAdapter] No position found for ${symbol} (API returned ${arr.length} positions for other symbols)`);
            return null;
        }

        const pos = matchingPositions[0];
        const rawSize = parseFloat(pos.size || 0);
        if (rawSize === 0) return null;

        // Normalize: size is always positive, side is derived from sign
        // SoDEX returns negative size for short positions
        const side = rawSize >= 0 ? 'long' : 'short';
        const size = Math.abs(rawSize);

        const entryPrice = parseFloat(pos.avgEntryPrice || pos.entryPrice || 0);
        let unrealizedPnl = parseFloat(pos.unrealizedPnl || pos.upl || pos.unrealizedProfit || 0);

        // If API didn't return PnL, compute from markPrice provided by caller
        if (unrealizedPnl === 0 && entryPrice > 0 && markPrice && markPrice > 0) {
            // For long: pnl = (mark - entry) * size
            // For short: pnl = (entry - mark) * size  (size is positive)
            unrealizedPnl = side === 'long'
                ? (markPrice - entryPrice) * size
                : (entryPrice - markPrice) * size;
        }

        return {
            symbol: pos.symbol || symbol,
            side,
            size,
            entryPrice,
            unrealizedPnl,
        };
    }

    async get_balance(): Promise<number> {
        const data = await this.request('GET', `/accounts/${this.userAddress}/balances`);
        console.log('[SodexAdapter] Raw balance response:', JSON.stringify(data, null, 2));
        const arr = Array.isArray(data) ? data : (data?.balances || data?.data || (data && Object.keys(data).length > 0 ? [data] : []));
        const usdt = arr.find((b: any) => b.asset === 'USDT' || b.currency === 'USDT' || b.coin === 'USDT' || b.coin === 'vUSDC');

        if (usdt) {
            const equity = usdt.equity || usdt.balance || usdt.walletBalance || usdt.availableBalance || usdt.total;
            return equity ? parseFloat(equity) : 0;
        }
        return 0;
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