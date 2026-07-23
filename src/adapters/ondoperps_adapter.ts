import { createHmac } from 'node:crypto';
import { ExchangeAdapter, Order, Position, RawTrade, Kline } from './ExchangeAdapter.js';
import {
  OndoPerpsConfig,
  OndoPerpsApiResponse,
  OndoPerpsOrderRequest,
  OndoPerpsOrderResponse,
  OndoPerpsPosition,
  OndoPerpsBalance,
  OndoPerpsDepth,
  OndoPerpsMarkPrice,
  MarketInfo,
} from './types/ondoperps.types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://api.ondoperps.xyz';
const MARKET_CACHE_TTL_MS = 60_000; // 1 minute

// ── Adapter ───────────────────────────────────────────────────────────────────

/**
 * OndoPerps exchange adapter implementing the DRIFT ExchangeAdapter interface.
 *
 * Authentication uses HMAC-SHA256 per the OndoPerps API docs:
 *   - ONDO-KEY-ID: the API key ID (includes "ondoKeyId_" prefix)
 *   - ONDO-TIMESTAMP: milliseconds since Unix epoch (must be within 30s)
 *   - ONDO-SIGN: hex(HMAC-SHA256(secret, timestamp + method + path + body))
 *
 * Reference: https://docs.ondoperps.xyz/api-reference/api_key_authentication
 */
export class OndoPerpsAdapter implements ExchangeAdapter {
  readonly exchangeName = 'ondoperps';
  readonly supportedSymbols: string[] = [];

  private readonly apiKeyId: string;
  private readonly apiKeySecret: string;
  private readonly baseUrl: string;

  private marketCache = new Map<string, MarketInfo>();
  private lastMarketFetch = 0;

  constructor(config: OndoPerpsConfig) {
    if (!config.apiKeyId) throw new Error('[OndoPerps] apiKeyId is required');
    if (!config.apiKeySecret) throw new Error('[OndoPerps] apiKeySecret is required');

    this.apiKeyId = config.apiKeyId;
    this.apiKeySecret = config.apiKeySecret;
    this.baseUrl = (config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  // ── HMAC-SHA256 signing ───────────────────────────────────────────────────

  /**
   * Generate authentication headers per Ondo Perps API Key Authentication spec.
   * Signature = hex(HMAC-SHA256(apiKeySecret, timestamp + METHOD + path + body))
   */
  private sign(method: string, path: string, body = ''): Record<string, string> {
    const timestamp = Date.now().toString();
    const message = timestamp + method.toUpperCase() + path + body;
    const signature = createHmac('sha256', this.apiKeySecret)
      .update(message)
      .digest('hex');

    return {
      'ONDO-KEY-ID': this.apiKeyId,
      'ONDO-TIMESTAMP': timestamp,
      'ONDO-SIGN': signature,
      'Content-Type': 'application/json',
    };
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = this.sign(method.toUpperCase(), path, bodyStr);
    const url = `${this.baseUrl}${path}`;

    const init: RequestInit = {
      method: method.toUpperCase(),
      headers,
    };
    if (bodyStr && method.toUpperCase() !== 'GET') {
      init.body = bodyStr;
    }

    const res = await fetch(url, init);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let errorCode = '';
      let errorMsg = text;
      try {
        const parsed = JSON.parse(text);
        errorCode = parsed.error_code || '';
        errorMsg = parsed.message || text;
      } catch {}
      throw new Error(
        `[OndoPerps] ${method} ${path} → ${res.status}: ${errorCode ? `[${errorCode}] ` : ''}${errorMsg}`
      );
    }

    const json = (await res.json()) as OndoPerpsApiResponse<T>;
    if (!json.success) {
      throw new Error(
        `[OndoPerps] ${method} ${path}: API error ${json.error_code ?? ''} — ${json.message ?? 'unknown'}`
      );
    }
    return json.result;
  }

  private async publicRequest<T>(method: string, path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[OndoPerps] public ${method} ${path} → ${res.status}: ${text}`);
    }
    const json = (await res.json()) as OndoPerpsApiResponse<T>;
    if (!json.success) {
      throw new Error(
        `[OndoPerps] public ${method} ${path}: ${json.error_code ?? ''} — ${json.message ?? 'unknown'}`
      );
    }
    return json.result;
  }

  // ── Symbol mapping ────────────────────────────────────────────────────────

  /**
   * DRIFT internal format: "NVDA-PERP", "XAU-PERP"
   * OndoPerps format: "NVDA-USD.P", "XAU-USD.P"
   */
  private toOndoSymbol(driftSymbol: string): string {
    // Already in Ondo format
    if (driftSymbol.endsWith('-USD.P')) return driftSymbol;
    // NVDA-PERP → NVDA-USD.P
    return driftSymbol.replace(/-PERP$/, '-USD.P');
  }

  private toDriftSymbol(ondoSymbol: string): string {
    // Already in DRIFT format
    if (ondoSymbol.endsWith('-PERP')) return ondoSymbol;
    // NVDA-USD.P → NVDA-PERP
    return ondoSymbol.replace(/-USD\.P$/, '-PERP');
  }

  // ── Market data caching ───────────────────────────────────────────────────

  private async ensureMarkets(): Promise<void> {
    if (this.marketCache.size > 0 && Date.now() - this.lastMarketFetch < MARKET_CACHE_TTL_MS) {
      return;
    }
    await this.fetchMarkets();
  }

  private async fetchMarkets(): Promise<void> {
    // /v1/markets returns full market specs including baseIncrement (step size) and quoteIncrement (tick size)
    const marketsResp = await this.publicRequest<{
      perps: { tradingPairs: any[] | null };
    }>('GET', '/v1/markets');

    this.marketCache.clear();
    this.supportedSymbols.length = 0;

    const pairs = marketsResp?.perps?.tradingPairs ?? [];
    for (const p of pairs) {
      const market = p.market as string;
      if (!market) continue;

      const tickSize = parseFloat(p.quoteIncrement || '0.01');
      const stepSize = parseFloat(p.baseIncrement || '0.001');
      const maxLev = p.marginInfo?.[0]?.maxLeverage
        ? parseInt(p.marginInfo[0].maxLeverage)
        : (p.defaultLeverage ? parseInt(p.defaultLeverage) : 10);

      this.marketCache.set(market, {
        market,
        tickSize,
        stepSize,
        minOrderSize: stepSize, // min order = 1 step
        maxLeverage: maxLev,
        priceDecimals: this.countDecimals(tickSize),
        sizeDecimals: this.countDecimals(stepSize),
      });

      this.supportedSymbols.push(this.toDriftSymbol(market));
    }
    this.lastMarketFetch = Date.now();
  }

  private getMarketInfo(ondoSymbol: string): MarketInfo | undefined {
    return this.marketCache.get(ondoSymbol);
  }

  private countDecimals(value: number): number {
    const str = value.toString();
    if (!str.includes('.')) return 0;
    return str.split('.')[1].length;
  }

  private roundToStep(value: number, step: number): number {
    return Math.round(value / step) * step;
  }

  // ── ExchangeAdapter interface implementation ──────────────────────────────

  async get_mark_price(symbol: string): Promise<number> {
    const ondoSymbol = this.toOndoSymbol(symbol);
    // API returns an object keyed by market name, e.g. { "NVDA-USD.P": { markPrice: "..." } }
    const markPrices = await this.publicRequest<Record<string, OndoPerpsMarkPrice>>(
      'GET',
      '/v1/perps/mark_prices'
    );
    const entry = markPrices[ondoSymbol];
    if (!entry) {
      throw new Error(`[OndoPerps] No mark price found for ${ondoSymbol}`);
    }
    return parseFloat(entry.markPrice);
  }

  async get_orderbook(symbol: string): Promise<{ best_bid: number; best_ask: number }> {
    const ondoSymbol = this.toOndoSymbol(symbol);
    const depth = await this.publicRequest<OndoPerpsDepth>(
      'GET',
      `/v1/perps/depth?market=${encodeURIComponent(ondoSymbol)}&limit=1`
    );

    const best_bid = depth.bids?.length > 0 ? parseFloat(depth.bids[0][0]) : 0;
    const best_ask = depth.asks?.length > 0 ? parseFloat(depth.asks[0][0]) : 0;

    if (best_bid <= 0 || best_ask <= 0) {
      throw new Error(`[OndoPerps] Empty orderbook for ${ondoSymbol}`);
    }

    return { best_bid, best_ask };
  }

  async get_orderbook_depth(
    symbol: string,
    limit: number
  ): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    const ondoSymbol = this.toOndoSymbol(symbol);
    const depth = await this.publicRequest<OndoPerpsDepth>(
      'GET',
      `/v1/perps/depth?market=${encodeURIComponent(ondoSymbol)}&limit=${limit}`
    );

    const bids: [number, number][] = (depth.bids || []).map(([p, s]) => [
      parseFloat(p),
      parseFloat(s),
    ]);
    const asks: [number, number][] = (depth.asks || []).map(([p, s]) => [
      parseFloat(p),
      parseFloat(s),
    ]);

    return { bids, asks };
  }

  async place_limit_order(
    symbol: string,
    side: 'buy' | 'sell',
    price: number,
    size: number,
    reduceOnly = false,
    timeInForce?: number
  ): Promise<string> {
    await this.ensureMarkets();
    const ondoSymbol = this.toOndoSymbol(symbol);
    const info = this.getMarketInfo(ondoSymbol);

    // Round to valid increments
    const roundedPrice = info ? this.roundToStep(price, info.tickSize) : price;
    const roundedSize = info ? this.roundToStep(size, info.stepSize) : size;

    // Reject if rounded size is zero or below minimum
    if (roundedSize <= 0) {
      const minSize = info?.minOrderSize ?? info?.stepSize ?? 0;
      throw new Error(
        `[OndoPerps] Order size too small for ${ondoSymbol}: requested ${size}, ` +
        `rounded to ${roundedSize} (stepSize=${info?.stepSize ?? '?'}, minOrderSize=${minSize})`
      );
    }

    const priceStr = info
      ? roundedPrice.toFixed(info.priceDecimals)
      : roundedPrice.toString();
    const sizeStr = info
      ? roundedSize.toFixed(info.sizeDecimals)
      : roundedSize.toString();

    // Determine order type:
    // - reduceOnly → market (OndoPerps requires IOC for reduce-only)
    // - timeInForce=1 (IOC/taker) → market for immediate fill
    // - otherwise → limit (maker/PostOnly)
    const useMarket = reduceOnly || timeInForce === 1;

    const orderReq: OndoPerpsOrderRequest = {
      market: ondoSymbol,
      type: useMarket ? 'market' : 'limit',
      side,
      size: sizeStr,
      reduceOnly: reduceOnly || undefined,
      clientOrderId: `drift_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    };

    // Only include price for limit orders
    if (!useMarket) {
      orderReq.price = priceStr;
    }

    const response = await this.request<OndoPerpsOrderResponse>(
      'POST',
      '/v1/perps/orders',
      orderReq
    );
    return response.orderId;
  }

  async cancel_order(order_id: string, _symbol: string): Promise<boolean> {
    try {
      await this.request<void>('DELETE', `/v1/perps/orders/${order_id}`);
      return true;
    } catch (err: any) {
      // Order already cancelled/filled is still a successful cancel from caller's perspective
      if (
        err.message?.includes('order_already_cancelled') ||
        err.message?.includes('order_already_filled') ||
        err.message?.includes('order_not_in_cancellable_state')
      ) {
        return true;
      }
      console.error(`[OndoPerps] cancel_order failed: ${err.message}`);
      return false;
    }
  }

  async cancel_all_orders(symbol: string): Promise<boolean> {
    const ondoSymbol = this.toOndoSymbol(symbol);
    try {
      await this.request<void>(
        'DELETE',
        `/v1/perps/orders?market=${encodeURIComponent(ondoSymbol)}`
      );
      return true;
    } catch (err: any) {
      console.error(`[OndoPerps] cancel_all_orders failed: ${err.message}`);
      return false;
    }
  }

  async get_open_orders(symbol: string): Promise<Order[]> {
    const ondoSymbol = this.toOndoSymbol(symbol);
    const orders = await this.request<OndoPerpsOrderResponse[]>(
      'GET',
      `/v1/perps/orders?market=${encodeURIComponent(ondoSymbol)}&status=open`
    );

    return (orders || []).map(o => ({
      id: o.orderId,
      symbol: this.toDriftSymbol(o.market),
      side: o.side,
      price: parseFloat(o.price),
      size: parseFloat(o.size),
      status: o.status,
    }));
  }

  async get_position(symbol: string, markPrice?: number): Promise<Position | null> {
    const ondoSymbol = this.toOndoSymbol(symbol);
    const raw = await this.request<any>('GET', '/v1/perps/positions');

    // API may return array or object keyed by market — handle both
    let positions: any[];
    if (Array.isArray(raw)) {
      positions = raw;
    } else if (raw && typeof raw === 'object') {
      positions = Object.values(raw);
    } else {
      positions = [];
    }

    // Log raw positions for debugging
    if (positions.length > 0) {
      console.log(`[OndoPerps] get_position raw: ${JSON.stringify(positions[0])}`);
    }

    // Flexible match: try market field first
    let pos = positions.find((p: any) => p?.market === ondoSymbol);

    // If not found by market field, try matching in the raw object by key
    if (!pos && raw && typeof raw === 'object' && !Array.isArray(raw) && raw[ondoSymbol]) {
      pos = raw[ondoSymbol];
    }

    if (!pos) return null;

    // Flexible field extraction — OndoPerps uses: direction, netQuantity, averageEntryPrice
    const sizeRaw = parseFloat(
      pos.netQuantity ?? pos.size ?? pos.quantity ?? pos.positionSize ?? pos.netSize ??
      pos.base_size ?? pos.baseSize ?? pos.contracts ?? pos.amount ?? 'NaN'
    );

    // Side detection: OndoPerps uses "direction" field
    const sideField = (pos.direction ?? pos.side ?? '').toLowerCase();
    const hasValidSide = ['long', 'short', 'buy', 'sell'].includes(sideField);

    // If no size AND no valid side, truly no position
    if ((isNaN(sizeRaw) || sizeRaw === 0) && !hasValidSide) return null;

    // Determine side
    let side: 'long' | 'short';
    if (sideField === 'long' || sideField === 'buy') {
      side = 'long';
    } else if (sideField === 'short' || sideField === 'sell') {
      side = 'short';
    } else {
      side = sizeRaw > 0 ? 'long' : 'short';
    }

    // Determine absolute size
    let absSize: number;
    if (!isNaN(sizeRaw) && sizeRaw !== 0) {
      absSize = Math.abs(sizeRaw);
    } else {
      // Size field missing — try to derive from notional/value
      const notional = parseFloat(pos.notionalValue ?? pos.notional ?? pos.value ?? pos.positionValue ?? '0');
      if (notional > 0 && markPrice && markPrice > 0) {
        absSize = notional / markPrice;
      } else {
        // Position exists (has side) but size unknown — use placeholder so bot knows it exists
        absSize = 0.0001;
        console.warn(`[OndoPerps] Position ${ondoSymbol} has side="${sideField}" but no size field. Raw: ${JSON.stringify(pos)}`);
      }
    }

    const entryPrice = parseFloat(
      pos.averageEntryPrice ?? pos.entryPrice ?? pos.entry_price ?? pos.avgEntryPrice ?? '0'
    );

    let unrealizedPnl = parseFloat(
      pos.unrealizedPnl ?? pos.unrealized_pnl ?? pos.uPnl ?? pos.pnl ?? '0'
    );
    if (unrealizedPnl === 0 && markPrice && markPrice > 0 && entryPrice > 0) {
      unrealizedPnl = side === 'long'
        ? (markPrice - entryPrice) * absSize
        : (entryPrice - markPrice) * absSize;
    }

    return {
      symbol: this.toDriftSymbol(ondoSymbol),
      side,
      size: absSize,
      entryPrice,
      unrealizedPnl,
      funding: parseFloat(pos.netFundingSinceNeutral ?? pos.net_funding ?? '0'),
    };
  }

  async get_balance(): Promise<number> {
    const raw = await this.request<any>('GET', '/v1/perps/balance');
    // Return marginBalance (total equity) NOT availableMargin.
    // availableMargin drops when margin is held for orders/positions,
    // which causes false max-loss triggers. marginBalance reflects true account value.
    const marginBalance = parseFloat(raw.marginBalance ?? raw.margin_balance ?? '0');
    if (marginBalance > 0) return marginBalance;
    // Fallback: try walletBalance or total
    const walletBalance = parseFloat(raw.walletBalance ?? raw.wallet_balance ?? '0');
    if (walletBalance > 0) return walletBalance;
    // Last resort: available
    return parseFloat(raw.availableMargin ?? raw.available_margin ?? raw.balance ?? '0');
  }

  async get_recent_trades(symbol: string, limit: number): Promise<RawTrade[]> {
    const ondoSymbol = this.toOndoSymbol(symbol);
    const trades = await this.publicRequest<any[]>(
      'GET',
      `/v1/perps/trades?market=${encodeURIComponent(ondoSymbol)}&limit=${limit}`
    );

    return (trades || []).map((t: any) => ({
      side: (t.aggressor_side || t.side) as 'buy' | 'sell',
      price: parseFloat(t.price),
      size: parseFloat(t.size),
      timestamp: new Date(t.time || t.createdAt).getTime(),
    }));
  }

  async get_klines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    const ondoSymbol = this.toOndoSymbol(symbol);
    // TradingView UDF endpoint is public — symbol format: "XAUUSD.P" (no dash)
    const tvSymbol = ondoSymbol.replace('-', '');

    // Map DRIFT interval strings to TradingView resolution values
    const resolutionMap: Record<string, string> = {
      '1m': '1', '5m': '5', '15m': '15', '30m': '30',
      '1h': '60', '4h': '240', '1d': '1D', '1w': '1W',
    };
    const resolution = resolutionMap[interval] || '60';

    const to = Math.floor(Date.now() / 1000);

    // TradingView UDF history endpoint — returns raw {s,t,o,h,l,c,v} without the
    // standard {success, result} wrapper, so we fetch directly instead of publicRequest.
    const url = `${this.baseUrl}/v1/perps/history?symbol=${encodeURIComponent(tvSymbol)}&resolution=${resolution}&to=${to}&countback=${limit}`;

    try {
      const res = await fetch(url, {
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json() as {
        s: string;
        t: number[];
        o: number[];
        h: number[];
        l: number[];
        c: number[];
        v: number[];
      };

      if (data.s !== 'ok' || !data.t?.length) return [];

      return data.t.map((timestamp, i) => ({
        t: timestamp * 1000, // convert to ms
        o: data.o[i],
        h: data.h[i],
        l: data.l[i],
        c: data.c[i],
        v: data.v[i],
      }));
    } catch (err) {
      // Some symbols may not have history data yet — return empty gracefully
      console.warn(`[OndoPerps] get_klines failed for ${symbol}: ${(err as Error).message}`);
      return [];
    }
  }

  async get_markets(): Promise<string[]> {
    await this.ensureMarkets();
    return [...this.supportedSymbols];
  }

  async get_price_decimals(symbol: string): Promise<number> {
    await this.ensureMarkets();
    const ondoSymbol = this.toOndoSymbol(symbol);
    const info = this.getMarketInfo(ondoSymbol);
    return info?.priceDecimals ?? 2;
  }

  async get_funding_rate(symbol: string): Promise<number | null> {
    const ondoSymbol = this.toOndoSymbol(symbol);

    // Strategy 1: Try the dedicated funding rate endpoint
    try {
      const result = await this.publicRequest<any>(
        'GET',
        `/v1/perps/funding_rate?market=${encodeURIComponent(ondoSymbol)}`
      );
      const rate = result?.fundingRate ?? result?.funding_rate ?? result?.rate;
      if (rate != null) {
        return parseFloat(rate);
      }
    } catch {
      // Endpoint may not exist — fall through to alternatives
    }

    // Strategy 2: Try the positions response which may include per-market funding info
    try {
      const raw = await this.request<any>('GET', '/v1/perps/positions');
      let positions: any[];
      if (Array.isArray(raw)) {
        positions = raw;
      } else if (raw && typeof raw === 'object') {
        positions = Object.values(raw);
      } else {
        positions = [];
      }

      // Look for the position matching our market and check for funding rate fields
      const pos = positions.find((p: any) => p?.market === ondoSymbol);
      if (pos) {
        const rate = pos.fundingRate ?? pos.funding_rate ?? pos.currentFundingRate ?? pos.hourlyFundingRate;
        if (rate != null) {
          return parseFloat(rate);
        }
      }
    } catch {
      // Positions endpoint failed — fall through
    }

    // Strategy 3: Check mark prices endpoint (sometimes includes funding rate)
    try {
      const markPrices = await this.publicRequest<Record<string, any>>(
        'GET',
        '/v1/perps/mark_prices'
      );
      const entry = markPrices[ondoSymbol];
      if (entry) {
        const rate = entry.fundingRate ?? entry.funding_rate ?? entry.nextFundingRate;
        if (rate != null) {
          return parseFloat(rate);
        }
      }
    } catch {
      // Mark prices endpoint failed — fall through
    }

    return null;
  }
}
