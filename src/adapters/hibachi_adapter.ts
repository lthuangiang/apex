import { createHmac } from 'node:crypto';
import { ethers } from 'ethers';
import { ExchangeAdapter, Position, RawTrade } from './ExchangeAdapter.js';
import { Orderbook, OrderParams, ConnectionHealth, IExchangeAdapter, Order } from '../types/core.js';

// ── Configuration ─────────────────────────────────────────────────────────────

export interface HibachiAdapterConfig {
    /** Authorization header value — required for all authenticated endpoints */
    apiKey: string;
    /** Numeric account ID — required for all account/trade endpoints */
    accountId: number | string;
    /** Account type determines signing mode */
    accountType: 'trustless' | 'exchange_managed';
    /** ECDSA private key — required when accountType === 'trustless'. Must be 0x-prefixed 32-byte hex (66 chars). */
    privateKey?: string;
    /** HMAC-SHA256 secret — required when accountType === 'exchange_managed'. */
    secretKey?: string;
    /** Optional subaccount identifier */
    subaccountId?: string;
    /** Override base URL for testing; defaults to https://api.hibachi.xyz */
    baseUrl?: string;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface ContractInfo {
    contractId: number;
    symbol: string;
    underlyingDecimals: number;
    settlementDecimals: number;
    settlementAsset: string;
    minQuantity: number;
    tickSize: number;
}

interface OrderSignPayload {
    nonce: bigint;
    contractId: number;
    quantity: bigint;
    side: number;       // 0 = BID (buy), 1 = ASK (sell)
    price: bigint;
    maxFeesPercent: bigint;
}

// ── Adapter ───────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL      = 'https://api.hibachi.xyz';       // trading & account endpoints
const DEFAULT_DATA_BASE_URL = 'https://data-api.hibachi.xyz';  // public market data endpoints
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class HibachiAdapter implements ExchangeAdapter, IExchangeAdapter {
    // ── Public identity ──────────────────────────────────────────────────────
    readonly exchangeName = 'hibachi';
    readonly supportedSymbols: string[] = [];

    // ── Private fields ───────────────────────────────────────────────────────
    private readonly _baseUrl: string;       // trading & account API
    private readonly _dataBaseUrl: string;   // public market data API
    private readonly _apiKey: string;
    private readonly _accountId: number;
    private _lastNonce: bigint = 0n;

    /** Exchange info cache: symbol → ContractInfo */
    private readonly _infoCache: Map<string, ContractInfo> = new Map();
    /** Cache expiry timestamps: symbol → expiry epoch ms */
    private readonly _infoCacheExpiry: Map<string, number> = new Map();

    /** Orderbook best bid/ask cache with 2-second TTL (Req 7.2) */
    private readonly _obCache: Map<string, { best_bid: number; best_ask: number; ts: number }> = new Map();

    // Signing — exactly one of these is set depending on accountType
    private _wallet: ethers.Wallet | null = null;
    private _secretKeyBuf: Buffer | null = null;

    // Connection state
    private _connected: boolean = false;
    private _rateLimitUntil: number = 0;

    // ── Constructor ──────────────────────────────────────────────────────────

    constructor(config: HibachiAdapterConfig) {
        // Debug logging
        console.log('[HibachiAdapter] Constructor called with:', {
            apiKey: config.apiKey?.substring(0, 10) + '...',
            accountId: config.accountId,
            accountType: config.accountType,
            hasPrivateKey: !!config.privateKey,
            hasSecretKey: !!config.secretKey,
            secretKeyLength: config.secretKey?.length,
        });

        // Validate apiKey
        if (!config.apiKey || config.apiKey.trim() === '') {
            throw new Error('[HibachiAdapter] apiKey is required and must not be empty');
        }

        // Validate accountId
        const accountIdNum = Number(config.accountId);
        if (!config.accountId || isNaN(accountIdNum)) {
            throw new Error('[HibachiAdapter] accountId is required and must be a valid number');
        }
        this._accountId = accountIdNum;

        // Validate accountType-specific credentials
        if (config.accountType === 'trustless') {
            if (!config.privateKey || config.privateKey.trim() === '') {
                throw new Error(
                    '[HibachiAdapter] privateKey is required for trustless account type'
                );
            }
            if (!/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) {
                throw new Error(
                    '[HibachiAdapter] privateKey must be a 0x-prefixed 64-character hex string (32 bytes)'
                );
            }
            // Wrap immediately — do NOT retain the raw string as a field (Req 9.1)
            this._wallet = new ethers.Wallet(config.privateKey);
        } else if (config.accountType === 'exchange_managed') {
            if (!config.secretKey || config.secretKey.trim() === '') {
                throw new Error(
                    '[HibachiAdapter] secretKey is required for exchange_managed account type'
                );
            }
            // Secret key is used as UTF-8 string for HMAC signing (Req 9.2)
            this._secretKeyBuf = Buffer.from(config.secretKey.trim(), 'utf8');
        } else {
            throw new Error(
                `[HibachiAdapter] accountType must be 'trustless' or 'exchange_managed', got: ${(config as any).accountType}`
            );
        }

        this._apiKey = config.apiKey;
        this._baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
        this._dataBaseUrl = DEFAULT_DATA_BASE_URL;

        // Note: privateKey and secretKey strings are NOT stored as class fields (Req 9.1, 9.2)
    }

    // ── Nonce generation ─────────────────────────────────────────────────────

    /**
     * Returns a monotonically increasing millisecond-precision nonce.
     * Ensures uniqueness even if called multiple times in the same millisecond.
     * Req 3.1, 3.2, 3.3
     */
    private _buildNonce(): bigint {
        const candidate = BigInt(Date.now());
        const nonce = candidate > this._lastNonce ? candidate : this._lastNonce + 1n;
        this._lastNonce = nonce;
        return nonce;
    }

    // ── Numeric encoding helpers ─────────────────────────────────────────────

    /**
     * Encode a float quantity to the exchange's integer representation.
     * Req 4.1
     */
    private _encodeQuantity(floatSize: number, underlyingDecimals: number): bigint {
        return BigInt(Math.round(floatSize * Math.pow(10, underlyingDecimals)));
    }

    /**
     * Encode a float price to the exchange's fixed-point representation.
     * Req 4.2
     */
    private _encodePrice(
        floatPrice: number,
        underlyingDecimals: number,
        settlementDecimals: number
    ): bigint {
        const factor = Math.pow(2, 32) * Math.pow(10, settlementDecimals - underlyingDecimals);
        return BigInt(Math.floor(floatPrice * factor));
    }

    /**
     * Decode an integer quantity back to a float.
     * Req 4.3
     */
    private _decodeQuantity(encoded: bigint, underlyingDecimals: number): number {
        return Number(encoded) / Math.pow(10, underlyingDecimals);
    }

    /**
     * Decode a fixed-point price back to a float.
     * Req 4.3
     */
    private _decodePrice(
        encoded: bigint,
        underlyingDecimals: number,
        settlementDecimals: number
    ): number {
        const factor = Math.pow(2, 32) * Math.pow(10, settlementDecimals - underlyingDecimals);
        return Number(encoded) / factor;
    }

    /**
     * Round a value to the nearest multiple of `step`.
     * Uses integer arithmetic to avoid floating-point drift (e.g. 77424.99 → 77425.0 for step 0.1).
     */
    private _snapToStep(value: number, step: number): number {
        if (!step || step <= 0) return value;
        const inv = Math.round(1 / step); // e.g. step=0.1 → inv=10
        return Math.round(value * inv) / inv;
    }

    // ── Signing ──────────────────────────────────────────────────────────────

    /**
     * Build the 40-byte signing buffer for a place-order payload.
     * Req 5.1
     */
    private _buildOrderBuffer(payload: OrderSignPayload): Buffer {
        const buf = Buffer.alloc(40);
        buf.writeBigUInt64BE(payload.nonce, 0);           // 0-7: nonce (uint64)
        buf.writeUInt32BE(payload.contractId, 8);         // 8-11: contractId (uint32)
        buf.writeBigUInt64BE(payload.quantity, 12);       // 12-19: quantity (uint64)
        buf.writeUInt32BE(payload.side, 20);              // 20-23: side (uint32) - ASK=0, BID=1
        buf.writeBigUInt64BE(payload.price, 24);          // 24-31: price (uint64)
        buf.writeBigUInt64BE(payload.maxFeesPercent, 32); // 32-39: maxFeesPercent (uint64)

        console.log('[HibachiAdapter] Buffer payload:', {
            nonce: payload.nonce.toString(),
            bufferHex: buf.toString('hex'),
            bufferBytes: Array.from(buf.slice(0, 8))
        });

        return buf;
    }

    /**
     * Sign an order payload.
     * Returns a 65-byte ECDSA hex string (0x-prefixed) for trustless accounts,
     * or a 32-byte HMAC-SHA256 hex string for exchange_managed accounts.
     * Req 2.2, 2.3, 5.1
     */
    private _signOrderPayload(payload: OrderSignPayload): string {
        const buf = this._buildOrderBuffer(payload);
        return this._sign(buf);
    }

    /**
     * Sign a cancel-single-order payload (8-byte orderId big-endian).
     * Req 5.2
     */
    private _signCancelOrder(orderId: bigint): string {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64BE(orderId, 0);
        return this._sign(buf);
    }

    /**
     * Sign a cancel-all-orders payload (8-byte nonce big-endian).
     * Req 5.3
     */
    private _signCancelAll(nonce: bigint): string {
        const buf = Buffer.alloc(8);
        buf.writeBigUInt64BE(nonce, 0);
        return this._sign(buf);
    }

    /**
     * Core signing dispatcher — routes to ECDSA or HMAC based on account type.
     */
    private _sign(buf: Buffer): string {
        if (this._wallet !== null) {
            return this._signECDSA(buf, this._wallet);
        }
        if (this._secretKeyBuf !== null) {
            return this._signHMAC(buf, this._secretKeyBuf);
        }
        throw new Error('[HibachiAdapter] No signing key configured');
    }

    /**
     * ECDSA signing via ethers.Wallet.
     * Returns 0x-prefixed 65-byte hex: r(32) + s(32) + recoveryId(1).
     * Req 2.2, 9.1
     */
    private _signECDSA(buf: Buffer, wallet: ethers.Wallet): string {
        const hash = ethers.keccak256(buf);
        const sig = wallet.signingKey.sign(hash);
        // Normalize recovery ID from Ethereum's 27/28 to 0/1
        const recoveryId = sig.v - 27;
        const recoveryHex = recoveryId.toString(16).padStart(2, '0');
        // r and s are already 0x-prefixed 32-byte hex strings
        return sig.r + sig.s.slice(2) + recoveryHex;
    }

    /**
     * HMAC-SHA256 signing.
     * Returns 32-byte hex digest (no 0x prefix).
     * Req 2.3, 9.2
     */
    private _signHMAC(buf: Buffer, secretKeyBuf: Buffer): string {
        return createHmac('sha256', secretKeyBuf).update(buf).digest('hex');
    }

    // ── Exchange info cache ──────────────────────────────────────────────────

    /**
     * Fetch exchange info from the API and populate the cache.
     * Req 6.1, 6.2
     */
    private async _fetchExchangeInfo(): Promise<void> {
        const data: any = await this._request('GET', '/market/exchange-info', undefined, false, this._dataBaseUrl);
        if (data === null) {
            throw new Error('[HibachiAdapter] _fetchExchangeInfo failed: endpoint returned 404');
        }

        // The API returns contracts under `futureContracts`
        const contracts: any[] =
            data?.futureContracts ??
            data?.contracts ??
            data?.data?.contracts ??
            data?.markets ??
            data?.data ??
            (Array.isArray(data) ? data : []);

        const expiry = Date.now() + CACHE_TTL_MS;
        const symbols: string[] = [];

        for (const c of contracts) {
            // Normalise field names — the API may use camelCase or snake_case
            const symbol: string =
                c.symbol ?? c.name ?? c.market ?? c.contractName ?? '';
            if (!symbol) continue;

            const info: ContractInfo = {
                contractId:         Number(c.contractId   ?? c.contract_id   ?? c.id ?? 0),
                symbol,
                underlyingDecimals: Number(c.underlyingDecimals ?? c.underlying_decimals ?? 8),
                settlementDecimals: Number(c.settlementDecimals ?? c.settlement_decimals ?? 6),
                settlementAsset:    String(c.settlementAsset    ?? c.settlement_asset    ?? 'USDT'),
                minQuantity:        Number(c.minQuantity        ?? c.minOrderSize ?? c.min_quantity ?? c.minQty ?? 0),
                tickSize:           Number(c.tickSize           ?? c.tick_size           ?? 0),
            };

            this._infoCache.set(symbol, info);
            this._infoCacheExpiry.set(symbol, expiry);
            symbols.push(symbol);
        }

        // Populate supportedSymbols (cast to mutable — readonly only prevents external mutation)
        (this as any).supportedSymbols = symbols;
    }

    /**
     * Return cached ContractInfo for a symbol, refreshing if expired.
     * Req 6.1, 6.2, 6.3
     */
    private async _getContractInfo(symbol: string): Promise<ContractInfo> {
        const expiry = this._infoCacheExpiry.get(symbol);
        if (expiry && Date.now() < expiry && this._infoCache.has(symbol)) {
            return this._infoCache.get(symbol)!;
        }
        await this._fetchExchangeInfo();
        const info = this._infoCache.get(symbol);
        if (!info) {
            throw new Error(`Symbol not found: ${symbol}`);
        }
        return info;
    }

    // ── HTTP helper ──────────────────────────────────────────────────────────

    /**
     * Make an authenticated HTTP request to the Hibachi API.
     * Req 2.1, 10.2, 10.3, 10.4
     */
    private async _request<T = any>(
        method: 'GET' | 'POST' | 'DELETE',
        path: string,
        body?: Record<string, unknown>,
        requiresAuth: boolean = true,
        baseUrlOverride?: string
    ): Promise<T | null> {
        // Check rate limit before making the request (Req 10.2)
        if (Date.now() < this._rateLimitUntil) {
            const waitMs = this._rateLimitUntil - Date.now();
            throw new Error(`[HibachiAdapter] Rate limit active — retry after ${waitMs}ms`);
        }

        const url = `${baseUrlOverride ?? this._baseUrl}${path}`;

        // Build headers — always include Content-Type
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
        };

        // Add Authorization header for authenticated endpoints (Req 2.1)
        if (requiresAuth) {
            headers['Authorization'] = this._apiKey;
        }

        // Build fetch options
        const options: RequestInit = {
            method,
            headers,
        };

        // Attach body for POST/DELETE when provided
        if (body !== undefined) {
            options.body = JSON.stringify(body);
        }

        const res = await fetch(url, options);

        // Handle 404 — return null so callers can decide (Req 10.3)
        if (res.status === 404) {
            return null;
        }

        // Handle 429 — set backoff timestamp, log warning (no API key in log), throw (Req 10.2)
        if (res.status === 429) {
            this._rateLimitUntil = Date.now() + 60_000;
            console.warn(
                `[HibachiAdapter] HTTP 429 rate limit hit on ${method} ${path} — backing off for 60s`
            );
            throw new Error(`[HibachiAdapter] HTTP 429: rate limited — retry after 60s`);
        }

        // Handle other non-2xx responses (Req 10.4)
        if (!res.ok) {
            const bodyText = await res.text().catch(() => '');
            throw new Error(`[HibachiAdapter] HTTP ${res.status}: ${bodyText}`);
        }

        // Parse and return JSON response
        return res.json() as Promise<T>;
    }

    // ── ExchangeAdapter interface (snake_case) ───────────────────────────────

    /** Req 7.1 */
    async get_mark_price(symbol: string): Promise<number> {
        const { contractId } = await this._getContractInfo(symbol);

        const data: any = await this._request(
            'GET',
            `/market/data/prices?symbol=${encodeURIComponent(symbol)}`,
            undefined,
            false,
            this._dataBaseUrl
        );

        if (data !== null) {
            const price =
                data?.markPrice ??
                data?.mark_price ??
                data?.price ??
                data?.tradePrice ??
                data?.bidPrice ??
                data?.data?.markPrice ??
                data?.data?.mark_price ??
                data?.data?.price;
            if (typeof price === 'number' && price > 0) return price;
            if (typeof price === 'string') {
                const parsed = parseFloat(price);
                if (parsed > 0) return parsed;
            }
        }

        const ob = await this.get_orderbook(symbol);
        if (ob.best_bid > 0 && ob.best_ask > 0) {
            return (ob.best_bid + ob.best_ask) / 2;
        }

        throw new Error(
            `[HibachiAdapter] get_mark_price: unable to determine mark price for ${symbol} (contractId=${contractId})`
        );
    }

    /** Req 7.2 */
    async get_orderbook(symbol: string): Promise<{ best_bid: number; best_ask: number }> {
        // Return cached value if fresh (< 2 seconds old)
        const cached = this._obCache.get(symbol);
        if (cached && Date.now() - cached.ts < 2000) {
            return { best_bid: cached.best_bid, best_ask: cached.best_ask };
        }

        // Fetch from REST (with REST-based 2-second cache acting as the "lazy init" pattern)
        const info = await this._getContractInfo(symbol);
        const data: any = await this._request(
            'GET',
            `/market/data/orderbook?symbol=${encodeURIComponent(symbol)}&depth=1&granularity=${encodeURIComponent(String(info.tickSize || 0.01))}`,
            undefined,
            false,
            this._dataBaseUrl
        );

        if (data === null) {
            throw new Error(
                `[HibachiAdapter] get_orderbook: no orderbook data for ${symbol}`
            );
        }

        // Hibachi orderbook shape: { bid: { levels: [{price, quantity},...] }, ask: { levels: [...] } }
        const bidLevels: any[] = data?.bid?.levels ?? data?.bids ?? data?.b ?? data?.data?.bids ?? data?.data?.b ?? [];
        const askLevels: any[] = data?.ask?.levels ?? data?.asks ?? data?.a ?? data?.data?.asks ?? data?.data?.a ?? [];

        if (!bidLevels.length || !askLevels.length) {
            throw new Error(
                `[HibachiAdapter] get_orderbook: empty bids or asks for ${symbol}`
            );
        }

        const parseLevel = (level: any): number => {
            if (Array.isArray(level)) return parseFloat(level[0]);
            return parseFloat(level?.price ?? level?.px ?? level?.p ?? level);
        };

        const best_bid = parseLevel(bidLevels[0]);
        const best_ask = parseLevel(askLevels[0]);

        if (!(best_bid > 0) || !(best_ask > 0)) {
            throw new Error(
                `[HibachiAdapter] get_orderbook: invalid bid/ask prices for ${symbol}: bid=${best_bid} ask=${best_ask}`
            );
        }

        // Cache the result with current timestamp
        this._obCache.set(symbol, { best_bid, best_ask, ts: Date.now() });

        return { best_bid, best_ask };
    }

    /** Req 7.6 */
    async place_limit_order(
        symbol: string,
        side: 'buy' | 'sell',
        price: number,
        size: number,
        reduceOnly?: boolean,
        timeInForce?: number
    ): Promise<string> {
        // Step 1: Resolve ContractInfo for symbol (Req 6.1, 6.3)
        const { contractId, underlyingDecimals, settlementDecimals, tickSize, minQuantity } =
            await this._getContractInfo(symbol);

        const normalizedPrice = this._snapToStep(price, tickSize);
        const normalizedSize = this._snapToStep(size, minQuantity);

        // Step 2: Generate unique monotonic nonce in milliseconds
        const nonceMs = Number(this._buildNonce());
        console.log(`[HibachiAdapter] Generated nonce: ${nonceMs} (current time: ${Date.now()})`);

        // Step 3: Encode quantity and price for signing (Req 4.1, 4.2)
        const quantityEncoded = this._encodeQuantity(normalizedSize, underlyingDecimals);
        const priceEncoded = this._encodePrice(normalizedPrice, underlyingDecimals, settlementDecimals);

        // Step 4: Signing convention per Postman docs: ASK/sell=0, BID/buy=1
        const hibachSide: 'ASK' | 'BID' = side === 'sell' ? 'ASK' : 'BID';
        const sideInt = hibachSide === 'ASK' ? 0 : 1;

        // Step 5: maxFeesPercent — Hibachi API uses decimal fee rate string
        // 0.00015 = 1.5 bps (maker fee) — prevents taker fills
        const maxFeesPercentStr = '0.00045';
        const maxFeesForSigning = BigInt(Math.round(parseFloat(maxFeesPercentStr) * 1e8));

        // Step 6: Build and sign the order payload (Req 5.1) — uses millisecond nonce
        const signPayload: OrderSignPayload = {
            nonce: BigInt(nonceMs),
            contractId,
            quantity: quantityEncoded,
            side: sideInt,
            price: priceEncoded,
            maxFeesPercent: maxFeesForSigning,
        };
        const signature = this._signOrderPayload(signPayload);

        // Step 7: POST to /trade/order (singular) — REST body uses millisecond nonce
        const body: Record<string, unknown> = {
            accountId: this._accountId,
            symbol,
            side: hibachSide,
            orderType: 'LIMIT',
            quantity: normalizedSize.toString(),
            price: normalizedPrice.toString(),
            maxFeesPercent: maxFeesPercentStr,
            nonce: nonceMs,
            signature,
        };

        const response: any = await this._request('POST', '/trade/order', body);

        if (response === null) {
            throw new Error(
                `[HibachiAdapter] place_limit_order: API returned null response for ${symbol}`
            );
        }

        // Extract orderId — SDK response is { data: orderId } or { orderId } or { order_id }
        const orderId =
            response?.data ??
            response?.orderId ??
            response?.order_id ??
            response?.data?.orderId ??
            response?.data?.order_id ??
            response?.id;

        if (orderId === undefined || orderId === null) {
            throw new Error(
                `[HibachiAdapter] place_limit_order: orderId not found in response for ${symbol}. Response: ${JSON.stringify(response)}`
            );
        }

        return String(orderId);
    }

    async cancel_order(order_id: string, _symbol: string): Promise<boolean> {
        try {
            // Sign the orderId as 8-byte big-endian (no nonce for single cancel)
            const orderIdBigInt = BigInt(order_id);
            const signature = this._signCancelOrder(orderIdBigInt);

            // DELETE /trade/order with accountId, orderId, signature — no nonce
            await this._request('DELETE', '/trade/order', {
                orderId: order_id,
                accountId: this._accountId,
                signature,
            });

            // null = 404 = already gone = success
            return true;
        } catch (err) {
            console.error(
                '[HibachiAdapter] cancel_order failed:',
                err instanceof Error ? err.message : err
            );
            return false;
        }
    }

    /** Req 7.8 */
    async cancel_all_orders(_symbol: string): Promise<boolean> {
        try {
            const nonce = Date.now();
            const signature = this._signCancelAll(BigInt(nonce));
            await this._request('DELETE', '/trade/orders', {
                accountId: this._accountId,
                nonce,
                signature,
            });
            return true;
        } catch (err) {
            console.error(
                '[HibachiAdapter] cancel_all_orders failed:',
                err instanceof Error ? err.message : err
            );
            return false;
        }
    }

    /** Req 7.3 */
    async get_open_orders(symbol: string): Promise<Order[]> {
        const { contractId, underlyingDecimals, settlementDecimals } =
            await this._getContractInfo(symbol);

        // Correct endpoint: /trade/orders?accountId=<id>
        const result: any = await this._request(
            'GET',
            `/trade/orders?accountId=${this._accountId}`
        );

        // 404 → no orders (Req 10.3)
        if (result === null) {
            return [];
        }

        // Normalise the response — handle multiple possible shapes:
        //   { data: [...] }  |  { data: { orders: [...] } }  |  { data: { data: [...] } }  |  bare array
        let rawOrders: any[];
        if (Array.isArray(result)) {
            rawOrders = result;
        } else if (Array.isArray(result?.data)) {
            rawOrders = result.data;
        } else if (Array.isArray(result?.data?.orders)) {
            rawOrders = result.data.orders;
        } else if (Array.isArray(result?.data?.data)) {
            rawOrders = result.data.data;
        } else if (Array.isArray(result?.orders)) {
            rawOrders = result.orders;
        } else {
            rawOrders = [];
        }

        // Filter by contractId (support both camelCase and snake_case field names)
        const filtered = rawOrders.filter(
            (o: any) =>
                Number(o?.contractId ?? o?.contract_id) === contractId
        );

        // Map to Order[]
        return filtered.map((o: any): Order => {
            // ── id ──────────────────────────────────────────────────────────
            const id = String(o.orderId ?? o.order_id ?? o.id ?? '');

            // ── side ────────────────────────────────────────────────────────
            // Hibachi returns 'ASK' (sell) or 'BID' (buy)
            const side: 'buy' | 'sell' =
                o.side === 'BID' || o.side === 1 || o.side === 'buy' ? 'buy' : 'sell';

            // ── price ───────────────────────────────────────────────────────
            // The API may return an encoded integer string or an already-decoded float.
            let price: number;
            try {
                price = this._decodePrice(
                    BigInt(o.price),
                    underlyingDecimals,
                    settlementDecimals
                );
                // Sanity check: if the decoded value looks unreasonably small (< 0.000001)
                // the field was probably already a float string — fall back to parseFloat.
                if (price < 0.000001 && parseFloat(o.price) > price) {
                    price = parseFloat(o.price);
                }
            } catch {
                price = parseFloat(o.price ?? '0');
            }

            // ── size ────────────────────────────────────────────────────────
            const rawSize = o.quantity ?? o.size;
            let size: number;
            try {
                size = this._decodeQuantity(BigInt(rawSize), underlyingDecimals);
                if (size < 0.000001 && parseFloat(rawSize) > size) {
                    size = parseFloat(rawSize);
                }
            } catch {
                size = parseFloat(rawSize ?? '0');
            }

            // ── status ──────────────────────────────────────────────────────
            // Map known status strings; default to 'pending' for open orders
            const rawStatus = o.status;
            let status: Order['status'] = 'pending';
            if (rawStatus === 'filled' || rawStatus === 2) {
                status = 'filled';
            } else if (rawStatus === 'cancelled' || rawStatus === 'canceled' || rawStatus === 3) {
                status = 'cancelled';
            } else if (rawStatus === 'rejected' || rawStatus === 4) {
                status = 'rejected';
            } else if (rawStatus === 'partially_filled' || rawStatus === 5) {
                status = 'partially_filled';
            }

            return {
                id,
                symbol,
                side,
                price,
                size,
                status,
                timestamp: new Date(),
            };
        });
    }

    /** Req 7.4 */
    async get_position(symbol: string, markPrice?: number): Promise<Position | null> {
        const { contractId, underlyingDecimals, settlementDecimals } =
            await this._getContractInfo(symbol);

        // Fetch all positions for the account (requiresAuth = true by default)
        const result: any = await this._request(
            'GET',
            `/trade/account/info?accountId=${this._accountId}`
        );


        // 404 → no positions (Req 10.3)
        if (result === null) {
            console.log('[HibachiAdapter] get_position: API returned null');
            return null;
        }

        // Account info response: { equity, positions: [...], ... } or nested under .data
        const accountData = result?.data ?? result;
        let rawPositions: any[];
        if (Array.isArray(accountData?.positions)) {
            rawPositions = accountData.positions;
        } else if (Array.isArray(result?.positions)) {
            rawPositions = result.positions;
        } else {
            rawPositions = [];
        }

        // Find the position matching our symbol (Hibachi returns symbol, not contractId)
        const pos = rawPositions.find(
            (p: any) => p?.symbol === symbol
        );

        if (!pos) {
            console.log('[HibachiAdapter] get_position: no position found for contractId', contractId);
            return null;
        }

        // ── Decode raw size ──────────────────────────────────────────────────
        let rawSize: number;
        try {
            rawSize = this._decodeQuantity(BigInt(pos.quantity), underlyingDecimals);
        } catch {
            rawSize = parseFloat(pos.quantity);
        }

        // Zero-size position → flat
        if (rawSize === 0) {
            return null;
        }

        // ── Derive side and absolute size ────────────────────────────────────
        const side: 'long' | 'short' = pos.direction === 'Long' ? 'long' : 'short';
        const size = Math.abs(rawSize);

        // ── Decode entry price ───────────────────────────────────────────────
        const rawEntryPrice = pos.openPrice ?? pos.entryPrice ?? pos.entry_price;
        let entryPrice: number;
        try {
            entryPrice = this._decodePrice(
                BigInt(rawEntryPrice),
                underlyingDecimals,
                settlementDecimals
            );
        } catch {
            entryPrice = parseFloat(rawEntryPrice ?? '0');
        }

        // ── Compute unrealized PnL ───────────────────────────────────────────
        const apiPnl = parseFloat(
            pos.unrealizedTradingPnl ?? pos.unrealizedPnl ?? pos.unrealized_pnl ?? pos.pnl ?? 'NaN'
        );

        let unrealizedPnl: number;
        if (!isNaN(apiPnl)) {
            // API returned a PnL value — use it directly
            unrealizedPnl = apiPnl;
        } else if (markPrice !== undefined) {
            // Compute locally from mark price
            unrealizedPnl =
                side === 'long'
                    ? (markPrice - entryPrice) * size
                    : (entryPrice - markPrice) * size;
        } else {
            unrealizedPnl = 0;
        }

        return {
            symbol,
            side,
            size,
            entryPrice,
            unrealizedPnl,
        };
    }

    /** Req 7.5 */
    async get_balance(): Promise<number> {
        // Correct endpoint: /trade/account/info?accountId=<id>
        const result: any = await this._request(
            'GET',
            `/trade/account/info?accountId=${this._accountId}`
        );

        // 404 → unfunded account, return 0 (Req 10.3)
        if (result === null) {
            return 0;
        }

        // Account info response shape from SDK: { equity, positions, ... } or nested under .data
        const accountData = result?.data ?? result;
        const raw =
            accountData?.equity ??
            accountData?.balance ??
            accountData?.availableBalance ??
            accountData?.available_balance ??
            result?.equity ??
            result?.balance;

        if (raw === undefined || raw === null) {
            return 0;
        }

        const parsed = parseFloat(raw);
        return isNaN(parsed) ? 0 : parsed;
    }

    /** Req 7.2 (depth variant) */
    async get_orderbook_depth(
        symbol: string,
        limit: number
    ): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
        try {
            const info = await this._getContractInfo(symbol);
            const data: any = await this._request(
                'GET',
                `/market/data/orderbook?symbol=${encodeURIComponent(symbol)}&depth=${limit}&granularity=${encodeURIComponent(String(info.tickSize || 0.01))}`,
                undefined,
                false,
                this._dataBaseUrl
            );

            if (data === null) {
                return { bids: [], asks: [] };
            }

            // Normalise response — handle nested `data` wrapper
            const raw = data?.data ?? data;

            const rawBids: any[] = raw?.bid?.levels ?? raw?.bids ?? raw?.b ?? [];
            const rawAsks: any[] = raw?.ask?.levels ?? raw?.asks ?? raw?.a ?? [];

            const parseLevel = (level: any): [number, number] => {
                if (Array.isArray(level)) {
                    return [parseFloat(level[0]), parseFloat(level[1])];
                }
                return [
                    parseFloat(level?.price ?? level?.px ?? level?.p ?? 0),
                    parseFloat(level?.quantity ?? level?.size  ?? level?.qty ?? level?.q ?? 0),
                ];
            };

            const bids: [number, number][] = rawBids.map(parseLevel);
            const asks: [number, number][] = rawAsks.map(parseLevel);

            return { bids, asks };
        } catch {
            return { bids: [], asks: [] };
        }
    }

    /** Req 1.1 */
    async get_recent_trades(symbol: string, limit: number): Promise<RawTrade[]> {
        try {
            const { contractId } = await this._getContractInfo(symbol);

            const data: any = await this._request(
                'GET',
                `/market/data/trades?symbol=${encodeURIComponent(symbol)}`,
                undefined,
                false,
                this._dataBaseUrl
            );

            if (data === null) {
                return [];
            }

            // Normalise response — handle bare array, data[], data.trades[]
            let rawTrades: any[];
            if (Array.isArray(data)) {
                rawTrades = data;
            } else if (Array.isArray(data?.data)) {
                rawTrades = data.data;
            } else if (Array.isArray(data?.data?.trades)) {
                rawTrades = data.data.trades;
            } else if (Array.isArray(data?.trades)) {
                rawTrades = data.trades;
            } else {
                rawTrades = [];
            }

            return rawTrades.slice(0, limit).map((trade: any): RawTrade => {
                const ts = Number(trade.timestamp ?? trade.time ?? trade.ts ?? Date.now());
                return {
                    side: trade.takerSide === 'Buy' || trade.side === 0 || trade.side === 'buy' ? 'buy' : 'sell',
                    price: parseFloat(trade.price ?? trade.px ?? 0),
                    size: parseFloat(trade.quantity ?? trade.size ?? trade.qty ?? 0),
                    timestamp: ts < 10_000_000_000 ? ts * 1000 : ts,
                };
            });
        } catch {
            return [];
        }
    }

    /** Req 7.9 */
    async get_markets(): Promise<string[]> {
        try {
            await this._fetchExchangeInfo();
            return [...(this as any).supportedSymbols].sort();
        } catch {
            return [...(this as any).supportedSymbols].sort();
        }
    }

    // ── IExchangeAdapter interface (camelCase aliases) ───────────────────────

    async getMarkPrice(symbol: string): Promise<number> {
        return this.get_mark_price(symbol);
    }

    async getOrderbook(symbol: string): Promise<Orderbook> {
        const ob = await this.get_orderbook(symbol);
        return {
            bestBid: ob.best_bid,
            bestAsk: ob.best_ask,
            bids: [[ob.best_bid, 0]],
            asks: [[ob.best_ask, 0]],
            timestamp: new Date(),
        };
    }

    async getOrderbookDepth(
        symbol: string,
        limit: number
    ): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
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
        return this.place_limit_order(
            params.symbol,
            params.side,
            params.price,
            params.size,
            params.reduceOnly
        );
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

    // ── Connection lifecycle (Req 1.2, 4.1) ─────────────────────────────────

    async connect(): Promise<void> {
        this._connected = true;
        // Optionally pre-warm the exchange info cache
        try {
            await this._fetchExchangeInfo();
        } catch {
            // Non-fatal — cache will be populated on first use
        }
    }

    async disconnect(): Promise<void> {
        this._connected = false;
        // Close any WebSocket subscriptions (to be implemented in task 3.3)
    }

    isConnected(): boolean {
        return this._connected;
    }

    getHealthStatus(): ConnectionHealth {
        return {
            isHealthy: this._connected,
            lastPing: new Date(),
            latency: 0,
        };
    }
}
