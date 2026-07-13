import { createHash, randomBytes } from 'crypto';
import { ed25519 } from '@noble/curves/ed25519';
import WebSocket from 'ws';
import { ExchangeAdapter, Position, RawTrade, Kline } from './ExchangeAdapter.js';
import {
  PerplConfig,
  PerplMarket,
  PerplOrderType,
  PerplOrderFlags,
  PerplContextResponse,
  PerplMarketRaw,
  PerplPosition,
  PerplOrder,
  PerplAccount,
} from './types/perpl.types.js';

const DEFAULT_BASE_URL = 'https://app.perpl.xyz/api';
const DEFAULT_WS_URL = 'wss://app.perpl.xyz/ws/v1/trading';
const DEFAULT_CHAIN_ID = 143;
const WS_PING_INTERVAL = 25_000;
const ORDER_TIMEOUT_MS = 15_000;
const DEFAULT_LEVERAGE = 1500; // 5x in hundredths

// Reconnect backoff schedule (ms), per Perpl API docs. Index advances per failed
// attempt and resets to 0 on a successful (re)auth.
const RETRY_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000];
// WS close code 1008 = rate-limited. Never reconnect sooner than this floor so we
// stop hammering the server (which is what triggers the connection storm).
const RATE_LIMIT_FLOOR_MS = 30_000;
// REST 429 backoff (ms), per Perpl API docs (1s, 2s, 4s).
const REST_RETRY_DELAYS = [1_000, 2_000, 4_000];
// Time to wait for the post-auth WalletSnapshot (account) + a fresh block before
// treating the trading WS as usable.
const ACCOUNT_WAIT_MS = 8_000;

export class PerplAdapter implements ExchangeAdapter {
  readonly exchangeName = 'perpl';
  readonly supportedSymbols: string[] = [];

  private apiKey: string;
  private privateKey: Uint8Array;
  private chainId: number;
  private baseUrl: string;
  private wsUrl: string;

  private ws: WebSocket | null = null;
  private wsAuthenticated = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  // Set by disconnect() so close handlers know a shutdown was requested and must
  // NOT schedule a reconnect. Reset at the top of openTradingWs().
  private intentionalClose = false;

  // Market-data WebSocket (orderbook + mark price, no auth)
  private mdWs: WebSocket | null = null;
  private mdPingTimer: ReturnType<typeof setInterval> | null = null;
  private mdReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private mdRetryCount = 0;
  private mdConnectingPromise: Promise<void> | null = null;
  // "Already-sent" dedup for subscribe frames; reset on close.
  private subscribedMarkets = new Set<number>();
  // Source of truth for which markets we want subscribed; survives reconnects so
  // the socket can re-subscribe everything on open. Cleared only in disconnect().
  private desiredMarkets = new Set<number>();
  // Maps a subscription id (from the mt:6 SubscriptionResponse) to its market id
  // so book updates route to the right orderbook instead of a closure-captured id.
  private mdSidToMarket = new Map<number, number>();
  private orderbooks = new Map<number, {
    bids: Map<number, { size: number; orders: number }>;
    asks: Map<number, { size: number; orders: number }>;
    markPrice: number;
  }>();

  private markets = new Map<number, PerplMarket>();
  private symbolToId = new Map<string, number>();
  private account: PerplAccount | null = null;
  private rqCounter = 0;
  private currentBlock = 0;
  // Last trading-heartbeat sequence number; a gap indicates lost messages.
  // Logged only for now (force-reconnect on gap is deferred).
  private lastHeartbeatSn: number | null = null;

  private lastMarketFetch = 0;
  private readonly MARKET_TTL_MS = 4_000;
  private wsConnectingPromise: Promise<void> | null = null;
  private positions = new Map<number, PerplPosition>();
  private openOrders = new Map<number, PerplOrder>();
  private pendingRequests = new Map<number, {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Maps cancel-request rq -> target oid so cancel confirms (oid=0) can remove the right order
  private cancelRqToOid = new Map<number, number>();

  constructor(config: PerplConfig) {
    this.apiKey = config.apiKey;
    this.privateKey = Buffer.from(config.apiKeySecret.replace(/^0x/, ''), 'hex');
    this.chainId = config.chainId ?? DEFAULT_CHAIN_ID;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.wsUrl = config.wsUrl || DEFAULT_WS_URL;
  }

  // ── REST signing ────────────────────────────────────────────────────────────

  private signRequest(method: string, target: string, body = ''): Record<string, string> {
    const timestamp = Date.now().toString();
    const nonce = randomBytes(16).toString('base64url');
    const bodyHash = createHash('sha256').update(body).digest('hex');
    const canonical = [this.chainId, method, target, timestamp, nonce, bodyHash].join('\n');
    const sig = ed25519.sign(Buffer.from(canonical), this.privateKey);
    return {
      'X-API-Key': this.apiKey,
      'X-API-Timestamp': timestamp,
      'X-API-Nonce': nonce,
      'X-API-Signature': Buffer.from(sig).toString('base64url'),
    };
  }

  // Fetch wrapper with 429 (rate-limit) backoff per Perpl API docs. Retries on
  // 429 with REST_RETRY_DELAYS, throws on any other non-ok status.
  private async fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
    for (let i = 0; ; i++) {
      const res = await fetch(url, init);
      if (res.status === 429 && i < REST_RETRY_DELAYS.length) {
        const delay = REST_RETRY_DELAYS[i];
        console.warn(`[Perpl] REST 429 on ${url} — backing off ${delay}ms (attempt ${i + 1})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok) throw new Error(`[Perpl] ${init?.method ?? 'GET'} ${url} → ${res.status}`);
      return res.json() as Promise<T>;
    }
  }

  private async restGet<T>(path: string): Promise<T> {
    const headers = this.signRequest('GET', path);
    return this.fetchJson<T>(`${this.baseUrl}${path}`, { headers });
  }

  // ── Context / markets ───────────────────────────────────────────────────────

  private parseMarket(raw: PerplMarketRaw): PerplMarket {
    return {
      id: raw.id,
      symbol: raw.symbol,
      name: raw.name,
      priceDecimals: raw.config.price_decimals,
      sizeDecimals: raw.config.size_decimals,
      minPostingAmount: parseFloat(raw.config.min_posting_amount),
      initialMargin: raw.config.initial_margin,
      makerFee: raw.config.maker_fee,
      takerFee: raw.config.taker_fee,
      isOpen: raw.config.is_open,
      state: raw.state,
    };
  }

  async fetchMarkets(): Promise<void> {
    // Serve from cache while fresh to stay under the REST public rate limit.
    if (this.symbolToId.size > 0 && Date.now() - this.lastMarketFetch < this.MARKET_TTL_MS) {
      return;
    }
    const ctx = await this.fetchJson<PerplContextResponse>(`${this.baseUrl}/v1/pub/context`);
    this.lastMarketFetch = Date.now();
    this.markets.clear();
    this.symbolToId.clear();
    this.supportedSymbols.length = 0;
    // Grab current block from instances
    if (ctx.instances?.length) {
      this.currentBlock = ctx.instances[0].block_number || 0;
    }
    for (const raw of ctx.markets) {
      const m = this.parseMarket(raw);
      this.markets.set(m.id, m);
      // Fallback to block from market config if instances missing
      if (!this.currentBlock && (raw.state as any)?.at?.b) {
        this.currentBlock = (raw.state as any).at.b;
      }
      const name = raw.name || raw.symbol || `MKT${raw.id}`;
      const driftSymbol = `${name}-PERP`;
      this.symbolToId.set(driftSymbol, m.id);
      if (m.isOpen) this.supportedSymbols.push(driftSymbol);
    }
  }

  private async ensureMarkets(): Promise<void> {
    if (this.symbolToId.size === 0) {
      await this.fetchMarkets();
    }
  }

  // True when the trading WS is fully usable: authed, socket open, account
  // snapshot received, and we have a live block. Callers that pass this check
  // can safely deref this.account and use this.currentBlock for order `lb`.
  private isTradingWsReady(): boolean {
    return this.wsAuthenticated
      && this.ws?.readyState === WebSocket.OPEN
      && this.account != null
      && this.currentBlock > 0;
  }

  // Wait for the post-auth WalletSnapshot (account) plus a block fresher than
  // `staleBlock`. Block freshness is best-effort within the timeout; a missing
  // account is fatal (order methods deref this.account!).
  private async awaitAccountAndBlock(staleBlock: number, timeoutMs: number): Promise<void> {
    const start = Date.now();
    while ((!this.account || this.currentBlock <= staleBlock) && Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 200));
    }
    if (!this.account) throw new Error('[Perpl] No account received after auth');
  }

  private rejectPendingRequests(reason: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  private async ensureWs(): Promise<void> {
    if (this.isTradingWsReady()) return;

    // A connect is already in flight — await it, then confirm account arrived.
    if (this.wsConnectingPromise) {
      await this.wsConnectingPromise;
      await this.awaitAccountAndBlock(this.currentBlock, ACCOUNT_WAIT_MS);
      return;
    }

    // Socket open & authed but the account snapshot hasn't landed yet — just
    // wait for it; do NOT open a second socket.
    if (this.wsAuthenticated && this.ws?.readyState === WebSocket.OPEN) {
      await this.awaitAccountAndBlock(this.currentBlock, ACCOUNT_WAIT_MS);
      return;
    }

    // A reconnect is scheduled (e.g. rate-limit cooldown after a 1008). Respect
    // it: poll for readiness instead of forcing a connect that would re-trigger
    // the rate limit and restart the storm.
    if (this.reconnectTimer) {
      const deadline = Date.now() + RATE_LIMIT_FLOOR_MS + ACCOUNT_WAIT_MS;
      while (Date.now() < deadline) {
        if (this.isTradingWsReady()) return;
        await new Promise(r => setTimeout(r, 250));
      }
      throw new Error('[Perpl] Trading WS not ready (reconnect cooldown in progress)');
    }

    // Cold connect.
    const staleBlock = this.currentBlock;
    await this.openTradingWs();
    await this.awaitAccountAndBlock(staleBlock, ACCOUNT_WAIT_MS);
  }

  private getMarketId(symbol: string): number {
    const id = this.symbolToId.get(symbol);
    if (id == null) throw new Error(`[Perpl] Unknown symbol: ${symbol}`);
    return id;
  }

  private getMarket(symbol: string): PerplMarket {
    const id = this.getMarketId(symbol);
    const m = this.markets.get(id);
    if (!m) throw new Error(`[Perpl] Market not found: ${symbol}`);
    return m;
  }

  private scalePrice(price: number, market: PerplMarket): number {
    return Math.round(price * Math.pow(10, market.priceDecimals));
  }

  private unscalePrice(scaled: number, market: PerplMarket): number {
    return scaled / Math.pow(10, market.priceDecimals);
  }

  private scaleSize(size: number, market: PerplMarket): number {
    return Math.round(size * Math.pow(10, market.sizeDecimals));
  }

  private unscaleSize(scaled: number, market: PerplMarket): number {
    return scaled / Math.pow(10, market.sizeDecimals);
  }

  // ── WebSocket ───────────────────────────────────────────────────────────────

  private async signWs(): Promise<object> {
    const ts = Date.now().toString();
    const nonce = randomBytes(16).toString('base64url');
    const canonical = [this.chainId, 'trading-ws-signin', ts, nonce].join('\n');
    const sig = ed25519.sign(Buffer.from(canonical), this.privateKey);
    return {
      mt: 29,
      chain_id: this.chainId,
      api_key: this.apiKey,
      timestamp: ts,
      nonce,
      signature: Buffer.from(sig).toString('base64url'),
    };
  }

  private setupPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ mt: 1, t: Date.now() }));
      }
    }, WS_PING_INTERVAL);
  }

  private clearTimers(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.mdPingTimer) { clearInterval(this.mdPingTimer); this.mdPingTimer = null; }
    if (this.mdReconnectTimer) { clearTimeout(this.mdReconnectTimer); this.mdReconnectTimer = null; }
  }

  private applyLevels(
    levels: Array<{ p: number; s: number; o: number }>,
    book: Map<number, { size: number; orders: number }>,
  ): void {
    for (const level of levels) {
      if (level.o === 0) book.delete(level.p);
      else book.set(level.p, { size: level.s, orders: level.o });
    }
  }

  private async ensureMdWs(marketId: number): Promise<void> {
    this.desiredMarkets.add(marketId);
    await this.openMdWs();
    const ob = this.orderbooks.get(marketId);
    if (ob && ob.bids.size > 0) return;
    // Wait for first snapshot (up to 5s)
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const data = this.orderbooks.get(marketId);
      if (data && data.bids.size > 0) return;
      await new Promise(r => setTimeout(r, 100));
    }
  }

  // Sole guarded entry point for the (public, no-auth) market-data WS. One socket,
  // subscribes to all desired markets on open, reconnects with tracked backoff.
  // Idempotent: if already open/connecting it just (re)subscribes pending markets.
  private openMdWs(): Promise<void> {
    if (this.mdConnectingPromise) return this.mdConnectingPromise;
    if (this.mdWs && (this.mdWs.readyState === WebSocket.OPEN || this.mdWs.readyState === WebSocket.CONNECTING)) {
      this.subscribeDesiredMarkets();
      return Promise.resolve();
    }

    this.intentionalClose = false;
    const mdWsUrl = this.wsUrl.replace('/ws/v1/trading', '/ws/v1/market-data');

    const promise = new Promise<void>((resolve) => {
      const ws = new WebSocket(mdWsUrl);
      this.mdWs = ws;

      ws.on('open', () => {
        this.mdRetryCount = 0; // successful connect resets backoff
        this.subscribedMarkets.clear(); // fresh socket → re-subscribe from scratch
        this.mdSidToMarket.clear();
        this.subscribeDesiredMarkets();
        this.mdPingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ mt: 1, t: Date.now() }));
        }, WS_PING_INTERVAL);
        resolve();
      });

      ws.on('message', (data) => this.handleMdMessage(data));

      ws.on('close', () => {
        if (ws !== this.mdWs) return; // ignore superseded socket
        this.mdWs = null;
        if (this.mdPingTimer) { clearInterval(this.mdPingTimer); this.mdPingTimer = null; }
        this.subscribedMarkets.clear();
        this.mdSidToMarket.clear();
        resolve(); // never leave a caller hanging on the connect promise
        if (this.intentionalClose || this.desiredMarkets.size === 0) return;
        this.scheduleMdReconnect();
      });

      ws.on('error', () => { /* surfaced via close */ });
    }).finally(() => { this.mdConnectingPromise = null; });

    this.mdConnectingPromise = promise;
    return promise;
  }

  private scheduleMdReconnect(): void {
    if (this.mdReconnectTimer || this.intentionalClose) return;
    const delay = RETRY_DELAYS[Math.min(this.mdRetryCount, RETRY_DELAYS.length - 1)];
    this.mdRetryCount++;
    console.log(`[Perpl] Scheduling MD WS reconnect in ${delay}ms (attempt ${this.mdRetryCount})`);
    this.mdReconnectTimer = setTimeout(() => {
      this.mdReconnectTimer = null;
      this.openMdWs().catch(() => this.scheduleMdReconnect());
    }, delay);
  }

  private subscribeDesiredMarkets(): void {
    if (!this.mdWs || this.mdWs.readyState !== WebSocket.OPEN) return;
    for (const marketId of this.desiredMarkets) {
      if (this.subscribedMarkets.has(marketId)) continue;
      this.subscribedMarkets.add(marketId);
      this.mdWs.send(JSON.stringify({
        mt: 5,
        subs: [
          { stream: `order-book@${marketId}`, subscribe: true },
          { stream: `market-state@${this.chainId}`, subscribe: true },
        ],
      }));
    }
  }

  private handleMdMessage(data: WebSocket.RawData): void {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // SubscriptionResponse: record subscription-id → market so book updates route.
    if (msg.mt === 6) {
      for (const sub of (msg.subs || [])) {
        const m = /order-book@(\d+)/.exec(sub.stream ?? '');
        if (m && sub.sid != null) this.mdSidToMarket.set(sub.sid, Number(m[1]));
      }
      return;
    }

    // Resolve which market a message belongs to. Book messages carry only `sid`;
    // fall back to the sole desired market (covers single-market use and the race
    // where a snapshot arrives before the mt:6 response).
    const routeMarket = (): number | undefined => {
      if (msg.sid != null && this.mdSidToMarket.has(msg.sid)) return this.mdSidToMarket.get(msg.sid);
      if (this.desiredMarkets.size === 1) return [...this.desiredMarkets][0];
      return undefined;
    };

    if (msg.mt === 15 || msg.mt === 16) { // L2 book snapshot / update
      const marketId = routeMarket();
      if (marketId == null) return;
      const ob = this.orderbooks.get(marketId) ?? { bids: new Map(), asks: new Map(), markPrice: 0 };
      if (msg.mt === 15) { ob.bids.clear(); ob.asks.clear(); }
      this.applyLevels(msg.bid || [], ob.bids);
      this.applyLevels(msg.ask || [], ob.asks);
      this.orderbooks.set(marketId, ob);
    } else if (msg.mt === 18 && msg.d) { // mark price (see deferred mt:9 note)
      const marketId = routeMarket();
      if (marketId == null) return;
      const market = this.markets.get(marketId);
      if (market && msg.d.mrk != null) {
        market.state.mrk = msg.d.mrk;
        market.state.bid = msg.d.bid ?? market.state.bid;
        market.state.ask = msg.d.ask ?? market.state.ask;
        const ob = this.orderbooks.get(marketId) ?? { bids: new Map(), asks: new Map(), markPrice: 0 };
        ob.markPrice = this.unscalePrice(msg.d.mrk, market);
        this.orderbooks.set(marketId, ob);
      }
    }
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    // Track block from any message with `at.b`
    if (msg.at?.b && msg.at.b > this.currentBlock) {
      this.currentBlock = msg.at.b;
    }

    // Debug: log non-trivial messages when we have pending orders
    if (this.pendingRequests.size > 0 && msg.mt !== 2 && msg.mt !== 100) {
      console.log('[Perpl] WS msg mt:', msg.mt, JSON.stringify(msg).slice(0, 200));
    }

    switch (msg.mt) {
      case 2: break; // pong

      case 3: { // StatusResponse
        const rq: number | undefined = msg.rq ?? msg.status?.rq;
        const errMsg = msg.status?.error || msg.em;
        const isError = msg.status?.code >= 400 || !!msg.er;

        if (rq != null) {
          const pending = this.pendingRequests.get(rq);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(rq);
            isError ? pending.reject(new Error(`[Perpl] Order error: ${errMsg}`)) : pending.resolve(msg);
          }
        } else if (isError && this.pendingRequests.size > 0) {
          // Global error with no rq — reject all pending (server rejected last order)
          for (const [prq, pending] of this.pendingRequests) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(prq);
            pending.reject(new Error(`[Perpl] Order error: ${errMsg}`));
          }
        }
        break;
      }

      case 19: { // WalletSnapshot
        for (const acct of (msg.as || [])) {
          this.account = {
            instanceId: acct.in,
            accountId: acct.id,
            frozen: acct.fr,
            lastForwardedRq: acct.lfr,
            balance: acct.b,
            lockedBalance: acct.lb,
          };
          if (this.rqCounter === 0) {
            this.rqCounter = Date.now();
          }
        }
        break;
      }

      case 21: { // AccountUpdate
        if (this.account) {
          this.account.balance = msg.b ?? this.account.balance;
          this.account.lockedBalance = msg.lb ?? this.account.lockedBalance;
          this.account.lastForwardedRq = msg.lfr ?? this.account.lastForwardedRq;
        }
        break;
      }

      case 26: // PositionsSnapshot
      case 27: { // PositionsUpdate
        for (const pos of (msg.d || [])) {
          if (pos.st === 1) { // Open
            this.positions.set(pos.pid, pos);
          } else {
            this.positions.delete(pos.pid);
          }
        }
        break;
      }

      case 23: // OrdersSnapshot
      case 24: { // OrdersUpdate
        for (const ord of (msg.d || [])) {
          console.log(`[Perpl] Order update: rq=${ord.rq} oid=${ord.oid} r=${ord.r} st=${ord.st}`);
          if (ord.r || ord.st === 4 || ord.st === 5 || ord.st === 7) { // removed/filled/cancelled/failed
            // Delete by oid when available (normal fills/cancels)
            if (ord.oid) {
              for (const [key, o] of this.openOrders) {
                if (o.oid === ord.oid) { this.openOrders.delete(key); break; }
              }
            }
            // Delete by rq (place rq stored in openOrders key)
            this.openOrders.delete(ord.rq);
            // Cancel confirms arrive with oid=0 but carry the cancel rq.
            // Use the cancelRqToOid map to find and remove the original order.
            if (!ord.oid && this.cancelRqToOid.has(ord.rq)) {
              const targetOid = this.cancelRqToOid.get(ord.rq)!;
              this.cancelRqToOid.delete(ord.rq);
              for (const [key, o] of this.openOrders) {
                if (o.oid === targetOid) { this.openOrders.delete(key); break; }
              }
              console.log(`[Perpl] Cancel confirm: removed oid=${targetOid} via cancelRq=${ord.rq}`);
            }
          } else {
            this.openOrders.set(ord.rq, ord);
          }
          const pending = this.pendingRequests.get(ord.rq);
          if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(ord.rq);
            pending.resolve(ord);
          }
        }
        break;
      }

      case 100: // Heartbeat
        if (msg.h && msg.h > this.currentBlock) this.currentBlock = msg.h;
        // Track heartbeat sequence; a gap means we may have missed updates.
        // Logged only for now — a force-reconnect on gap is deferred (adding a
        // second reconnect driver before the primary one is proven risks a new
        // storm; snapshots self-heal state on the next reconnect anyway).
        if (msg.sn != null) {
          if (this.lastHeartbeatSn != null && msg.sn !== this.lastHeartbeatSn + 1) {
            console.warn(`[Perpl] Heartbeat sequence gap: expected ${this.lastHeartbeatSn + 1}, got ${msg.sn}`);
          }
          this.lastHeartbeatSn = msg.sn;
        }
        break;
    }
  }

  // Sole guarded entry point for opening the trading WS. Concurrent callers
  // share one in-flight promise; any prior socket is torn down first so we never
  // leak an orphan connection (the root cause of the "ton of connections" storm).
  private openTradingWs(): Promise<void> {
    if (this.wsConnectingPromise) return this.wsConnectingPromise;

    this.intentionalClose = false;

    // Tear down any existing socket before opening a new one. Remove listeners
    // first so its close event does not trigger a spurious reconnect.
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.removeAllListeners();
      try { old.close(1000); } catch { /* ignore */ }
    }
    this.clearTimers();
    this.wsAuthenticated = false;

    const promise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;

      const authTimeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error('[Perpl] WS auth timeout'));
      }, 20_000);

      ws.on('open', async () => {
        console.log('[Perpl] WS opened, sending auth frame...');
        const authFrame = await this.signWs();
        ws.send(JSON.stringify(authFrame));
      });

      ws.on('message', (data) => {
        let msg: any;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        if (!this.wsAuthenticated) {
          console.log('[Perpl] WS pre-auth message mt:', msg.mt, msg.er != null ? `er=${msg.er}` : '');

          // Hard reject: auth error
          if (msg.mt === 3 && msg.er) {
            clearTimeout(authTimeout);
            reject(new Error(`[Perpl] WS auth failed (er=${msg.er}): ${msg.em || ''}`));
            return;
          }

          // Any other message means server accepted the connection — mark auth OK
          clearTimeout(authTimeout);
          this.wsAuthenticated = true;
          this.retryCount = 0; // successful (re)auth resets the backoff schedule
          console.log('[Perpl] WS authenticated (mt=' + msg.mt + ')');
          this.handleMessage(data);
          this.setupPing();
          resolve();
          return;
        }
        this.handleMessage(data);
      });

      ws.on('error', (err) => {
        clearTimeout(authTimeout);
        console.error('[Perpl] WS error:', err.message);
        if (!this.wsAuthenticated) reject(err);
      });

      ws.on('close', (code) => {
        // Ignore close events from a socket we've already superseded.
        if (ws !== this.ws) return;
        clearTimeout(authTimeout);
        this.clearTimers();
        const wasAuthenticated = this.wsAuthenticated;
        this.wsAuthenticated = false;
        this.ws = null;
        // In-flight orders can never complete on a dead socket — fail them fast
        // instead of hanging until ORDER_TIMEOUT_MS, and drop stale cancel maps.
        this.rejectPendingRequests(`[Perpl] WS closed (code ${code})`);
        this.cancelRqToOid.clear();
        this.lastHeartbeatSn = null; // per-connection; reset so reconnect doesn't log a false gap
        console.log('[Perpl] WS closed, code:', code, 'wasAuth:', wasAuthenticated);

        if (!wasAuthenticated) {
          reject(new Error(`[Perpl] WS closed before auth, code: ${code}`));
        }

        // Intentional shutdown or normal close: stop here. Otherwise schedule a
        // single backoff reconnect (code 1008 = rate-limit → longer cooldown).
        if (this.intentionalClose || code === 1000) return;
        this.scheduleReconnect(code);
      });
    }).finally(() => { this.wsConnectingPromise = null; });

    this.wsConnectingPromise = promise;
    return promise;
  }

  // Single reconnect driver: at most one timer outstanding, honours intentional
  // shutdown, and applies exponential backoff (rate-limit closes wait longer).
  private scheduleReconnect(code?: number): void {
    if (this.reconnectTimer || this.intentionalClose) return;

    const base = RETRY_DELAYS[Math.min(this.retryCount, RETRY_DELAYS.length - 1)];
    const delay = code === 1008 ? Math.max(RATE_LIMIT_FLOOR_MS, base) : base;
    this.retryCount++;
    console.log(`[Perpl] Scheduling WS reconnect in ${delay}ms (attempt ${this.retryCount}, close code ${code ?? 'n/a'})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openTradingWs().catch(err => {
        console.warn(`[Perpl] Reconnect attempt failed: ${err.message}`);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private sendOrder(req: object): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('[Perpl] WebSocket not connected'));
      }
      const rq = (req as any).rq as number;
      console.log('[Perpl] Sending order rq:', rq, 'type:', (req as any).t, 'mkt:', (req as any).mkt);
      const timer = setTimeout(() => {
        this.pendingRequests.delete(rq);
        console.warn('[Perpl] Order timed out rq:', rq);
        reject(new Error('[Perpl] Order request timed out'));
      }, ORDER_TIMEOUT_MS);
      this.pendingRequests.set(rq, { resolve, reject, timer });
      this.ws.send(JSON.stringify(req));
    });
  }

  private nextRq(): number {
    return ++this.rqCounter;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    await this.fetchMarkets();
    await this.ensureWs();
  }

  async disconnect(): Promise<void> {
    // Signal both close handlers that this is intentional so neither schedules a
    // reconnect after we tear down (previously the MD reconnect timer leaked and
    // revived the socket after shutdown).
    this.intentionalClose = true;
    this.clearTimers();
    this.rejectPendingRequests('[Perpl] Adapter disconnected');
    this.cancelRqToOid.clear();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.removeAllListeners();
      try { ws.close(1000); } catch { /* ignore */ }
    }
    if (this.mdWs) {
      const md = this.mdWs;
      this.mdWs = null;
      md.removeAllListeners();
      try { md.close(1000); } catch { /* ignore */ }
    }
    this.wsAuthenticated = false;
    this.subscribedMarkets.clear();
    this.desiredMarkets.clear();
    this.mdSidToMarket.clear();
  }

  isConnected(): boolean {
    return this.wsAuthenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  getConnectionHealth() {
    return { isConnected: this.isConnected(), latency: 0, lastHeartbeat: Date.now() };
  }

  // ── ExchangeAdapter interface ───────────────────────────────────────────────

  async get_mark_price(symbol: string): Promise<number> {
    await this.ensureMarkets();
    const market = this.getMarket(symbol);
    await this.ensureMdWs(market.id);
    const ob = this.orderbooks.get(market.id);
    if (ob?.markPrice) return ob.markPrice;
    return this.unscalePrice(market.state.mrk, market);
  }

  async get_orderbook(symbol: string): Promise<{ best_bid: number; best_ask: number }> {
    await this.ensureMarkets();
    const market = this.getMarket(symbol);
    await this.ensureMdWs(market.id);
    const ob = this.orderbooks.get(market.id);
    if (ob && ob.bids.size > 0 && ob.asks.size > 0) {
      const bestBid = Math.max(...ob.bids.keys()) / Math.pow(10, market.priceDecimals);
      const bestAsk = Math.min(...ob.asks.keys()) / Math.pow(10, market.priceDecimals);
      return { best_bid: bestBid, best_ask: bestAsk };
    }
    return {
      best_bid: this.unscalePrice(market.state.bid, market),
      best_ask: this.unscalePrice(market.state.ask, market),
    };
  }

  async get_orderbook_depth(symbol: string, limit: number): Promise<{ bids: [number, number][]; asks: [number, number][] }> {
    await this.ensureMarkets();
    const market = this.getMarket(symbol);
    await this.ensureMdWs(market.id);
    const ob = this.orderbooks.get(market.id);
    if (ob && ob.bids.size > 0 && ob.asks.size > 0) {
      const scale = Math.pow(10, market.priceDecimals);
      const sizeScale = Math.pow(10, market.sizeDecimals);
      const bids: [number, number][] = [...ob.bids.entries()]
        .sort((a, b) => b[0] - a[0])
        .slice(0, limit)
        .map(([p, v]) => [p / scale, v.size / sizeScale]);
      const asks: [number, number][] = [...ob.asks.entries()]
        .sort((a, b) => a[0] - b[0])
        .slice(0, limit)
        .map(([p, v]) => [p / scale, v.size / sizeScale]);
      return { bids, asks };
    }
    const bid = this.unscalePrice(market.state.bid, market);
    const ask = this.unscalePrice(market.state.ask, market);
    return { bids: [[bid, 0]], asks: [[ask, 0]] };
  }

  async place_limit_order(
    symbol: string,
    side: 'buy' | 'sell',
    price: number,
    size: number,
    reduceOnly = false,
    timeInForce = 0,
  ): Promise<string> {
    await this.ensureMarkets();
    await this.ensureWs();
    const market = this.getMarket(symbol);
    const rq = this.nextRq();

    // Determine order type
    // Open: buy=OpenLong, sell=OpenShort
    // Close: buy-to-close-short=CloseShort, sell-to-close-long=CloseLong
    const orderType = reduceOnly
      ? (side === 'buy' ? PerplOrderType.CloseShort : PerplOrderType.CloseLong)
      : (side === 'buy' ? PerplOrderType.OpenLong : PerplOrderType.OpenShort);

    // Find linked position for close orders
    let linkedPosition: number | undefined;
    if (reduceOnly) {
      const pos = [...this.positions.values()].find(p => p.mkt === market.id);
      if (pos) linkedPosition = pos.pid;
    }

    let flags = PerplOrderFlags.GoodTillCancel;
    if (timeInForce === 1) flags = PerplOrderFlags.ImmediateOrCancel;
    else if (timeInForce === 2) flags = PerplOrderFlags.FillOrKill;

    const req: any = {
      mt: 22,
      rq,
      mkt: market.id,
      acc: this.account!.accountId,
      t: orderType,
      p: this.scalePrice(price, market),
      s: this.scaleSize(size, market),
      fl: flags,
      lv: reduceOnly ? 0 : DEFAULT_LEVERAGE,
      lb: this.currentBlock > 0 ? this.currentBlock + 15 : 0,
    };
    if (linkedPosition != null) req.lp = linkedPosition;

    const result = await this.sendOrder(req);
    return (result?.oid ?? rq).toString();
  }

  async cancel_order(order_id: string, symbol: string): Promise<boolean> {
    await this.ensureMarkets();
    await this.ensureWs();
    const market = this.getMarket(symbol);
    const rq = this.nextRq();
    const targetOid = parseInt(order_id);
    const req = {
      mt: 22, rq,
      mkt: market.id,
      acc: this.account!.accountId,
      oid: targetOid,
      t: PerplOrderType.Cancel,
      p: 0, s: 0, fl: 0, lv: 0,
      lb: this.currentBlock + 15,
    };
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('[Perpl] WS not connected');
      console.log(`[Perpl] Sending cancel rq:${rq} oid:${targetOid}`);
      // Register mapping so cancel confirms with oid=0 can remove the right order
      this.cancelRqToOid.set(rq, targetOid);
      this.ws.send(JSON.stringify(req));
      // Poll until order disappears from local state (updated by mt:24)
      const deadline = Date.now() + ORDER_TIMEOUT_MS;
      while (Date.now() < deadline) {
        const stillOpen = [...this.openOrders.values()].some(o => o.oid === targetOid);
        if (!stillOpen) { console.log(`[Perpl] Cancel confirmed oid:${targetOid}`); return true; }
        await new Promise(r => setTimeout(r, 300));
      }
      const stillOpenFinal = [...this.openOrders.values()].some(o => o.oid === targetOid);
      console.log(`[Perpl] Cancel poll ended oid:${targetOid} stillOpen:${stillOpenFinal} openOrders:`, [...this.openOrders.values()].map(o => o.oid));
      // The exchange already confirmed this cancel (st=7 / r=true) but the WS update
      // arrived with oid=0 and the mapping may have already been consumed. If the order
      // is still in our local map, force-remove it — the exchange-side cancel is final.
      if (stillOpenFinal) {
        for (const [key, o] of this.openOrders) {
          if (o.oid === targetOid) { this.openOrders.delete(key); break; }
        }
        this.cancelRqToOid.delete(rq);
        console.log(`[Perpl] Force-removed oid:${targetOid} from local openOrders after exchange confirmed cancel`);
      }
      return true; // exchange confirmed cancel even if local map was stale
    } catch {
      this.cancelRqToOid.delete(rq);
      return false;
    }
  }


  async cancel_all_orders(symbol: string): Promise<boolean> {
    await this.ensureMarkets();
    const marketId = this.getMarketId(symbol);
    const symbolOrders = [...this.openOrders.values()].filter(o => o.mkt === marketId);
    if (symbolOrders.length === 0) return true;
    const results = await Promise.allSettled(
      symbolOrders.map(o => this.cancel_order(o.oid.toString(), symbol))
    );
    return results.every(r => r.status === 'fulfilled' && r.value);
  }

  async get_open_orders(symbol: string): Promise<any[]> {
    await this.ensureMarkets();
    await this.ensureWs();
    const marketId = this.getMarketId(symbol);
    const market = this.getMarket(symbol);
    return [...this.openOrders.values()]
      .filter(o => o.mkt === marketId)
      .map(o => ({
        id: o.oid.toString(),
        symbol,
        side: (o.t === PerplOrderType.OpenLong || o.t === PerplOrderType.CloseLong) ? 'buy' : 'sell',
        price: this.unscalePrice(o.p, market),
        size: this.unscaleSize(o.os, market),
        status: 'open',
      }));
  }

  async get_position(symbol: string, markPrice?: number): Promise<Position | null> {
    await this.ensureMarkets();
    await this.ensureWs();
    const marketId = this.getMarketId(symbol);
    const market = this.getMarket(symbol);
    const pos = [...this.positions.values()].find(p => p.mkt === marketId);
    if (!pos) return null;

    const ep = this.unscalePrice(pos.ep, market);
    const size = this.unscaleSize(pos.s, market);
    const side: 'long' | 'short' = pos.sd === 1 ? 'long' : 'short';
    const mp = markPrice ?? this.unscalePrice(market.state.mrk, market);

    const unrealizedPnl = side === 'long'
      ? (mp - ep) * size
      : (ep - mp) * size;

    return { symbol, side, size, entryPrice: ep, unrealizedPnl };
  }

  async get_balance(): Promise<number> {
    await this.ensureWs();
    if (!this.account) return 0;
    const available = parseFloat(this.account.balance);
    const lockedOrders = parseFloat(this.account.lockedBalance) || 0;
    // Position collateral is deducted from b and tracked in position.c
    const positionCollateral = [...this.positions.values()]
      .reduce((sum, p) => sum + parseFloat((p as any).c || '0'), 0);
    const totalNative = available + lockedOrders + positionCollateral;
    // Perpl balance is in micro-USDC (6 decimals) — convert to USD
    return totalNative / 1_000_000;
  }

  async get_recent_trades(symbol: string, limit: number): Promise<RawTrade[]> {
    return [];
  }

  async get_klines(symbol: string, interval: string, limit: number): Promise<Kline[]> {
    await this.ensureMarkets();
    const market = this.getMarket(symbol);
    const resolutionMap: Record<string, number> = {
      '1m': 60, '5m': 300, '15m': 900, '30m': 1800,
      '1h': 3600, '2h': 7200, '4h': 14400, '8h': 28800, '12h': 43200, '1d': 86400,
    };
    const resolution = resolutionMap[interval] ?? 3600;
    const to = Date.now();
    const from = to - resolution * limit * 1000;
    const path = `/v1/market-data/${market.id}/candles/${resolution}/${from}-${to}`;
    const raw = await this.fetchJson<{ d: any[] }>(`${this.baseUrl}${path}`);
    return (raw.d || []).map((c: any) => ({
      t: c.t,
      o: this.unscalePrice(c.o, market),
      h: this.unscalePrice(c.h, market),
      l: this.unscalePrice(c.l, market),
      c: this.unscalePrice(c.c, market),
      v: this.unscaleSize(parseFloat(c.v), market),
    }));
  }

  async get_markets(): Promise<string[]> {
    await this.fetchMarkets();
    return [...this.supportedSymbols];
  }

  async get_price_decimals(symbol: string): Promise<number> {
    await this.ensureMarkets();
    return this.getMarket(symbol).priceDecimals;
  }
}
