import { decimalStringSchema } from "@drift/shared";
import { z } from "zod";

import { parseSodexJson } from "../rest/json";

import { WS_MARKET_STALE_MS, WS_PING_INTERVAL_MS, reconnectDelay } from "./constants";
import { wsAckSchema, wsPushSchema } from "./schemas";
import type { WebSocketFactory, WebSocketLike } from "./user-stream";

// Stream thị trường (candles.md, all-mark-prices.md; tra ngày 2026-10-27). Chỉ `marketdata` mở
// stream này (CODING_STANDARDS mục 12). Ping/pong và reconnect như user stream.

export const wsCandleSchema = z.object({
  t: z.number().int(), // open time ms
  T: z.number().int(), // event time ms
  s: z.string(),
  i: z.string(),
  o: decimalStringSchema,
  h: decimalStringSchema,
  l: decimalStringSchema,
  c: decimalStringSchema,
  v: decimalStringSchema,
  q: decimalStringSchema,
  n: z.number().int(),
  /** Nến đã đóng. */
  x: z.boolean(),
});
export type WsCandle = z.infer<typeof wsCandleSchema>;

export const wsMarkPriceSchema = z.object({
  E: z.number().int(),
  s: z.string(),
  p: decimalStringSchema, // mark price
  i: decimalStringSchema, // index price
  r: decimalStringSchema, // funding rate hiện tại
  T: z.number().int(), // next funding time
});
export type WsMarkPrice = z.infer<typeof wsMarkPriceSchema>;

/** Best bid / ask của một symbol (book-ticker.md, "pushed on each block"). */
export const wsBookTickerSchema = z.object({
  E: z.number().int(),
  s: z.string(),
  a: decimalStringSchema,
  A: decimalStringSchema,
  b: decimalStringSchema,
  B: decimalStringSchema,
});
export type WsBookTicker = z.infer<typeof wsBookTickerSchema>;

/** Giao dịch công khai (market-trade.md). `S` là phía chủ động (taker). */
export const wsMarketTradeSchema = z.object({
  T: z.number().int(), // giờ khớp ms
  /** Trade id của SoDEX; dùng để loại fill của chính bot khi mô phỏng (DEC-TBD-mm-cost-v1). */
  t: z.union([z.number().int(), z.string()]).optional(),
  s: z.string(),
  S: z.enum(["BUY", "SELL"]),
  p: decimalStringSchema,
  q: decimalStringSchema,
});
export type WsMarketTrade = z.infer<typeof wsMarketTradeSchema>;

/** Push có thể là một object hoặc mảng; chuẩn hoá thành mảng, bỏ phần tử sai schema. */
function itemsOf<T>(schema: z.ZodType<T>, data: unknown): { ok: T[]; bad: number } {
  const list = Array.isArray(data) ? data : [data];
  const ok: T[] = [];
  let bad = 0;
  for (const item of list) {
    const r = schema.safeParse(item);
    if (r.success) ok.push(r.data);
    else bad += 1;
  }
  return { ok, bad };
}

export interface MarketStreamCallbacks {
  onCandle(candle: WsCandle): void;
  onMarkPrices?(marks: WsMarkPrice[]): void;
  /** Best bid / ask của các symbol trong `watchMicro` (DEC-227). */
  onBookTickers?(tickers: WsBookTicker[]): void;
  /** Giao dịch công khai của các symbol trong `watchMicro` (DEC-227). */
  onTrades?(trades: WsMarketTrade[]): void;
  /** Sau mỗi lần kết nối lại: consumer backfill qua REST. */
  onReconnect(): void;
  onError(error: Error): void;
}

export interface MarketStreamOptions {
  baseUrl: string;
  engine: "spot" | "perps";
  symbols: readonly string[];
  interval?: string;
  markPrices?: boolean;
  callbacks: MarketStreamCallbacks;
  createSocket?: WebSocketFactory;
  pingIntervalMs?: number;
  /** Không có dữ liệu giá trong ngần này (ms) thì nối lại; mặc định `WS_MARKET_STALE_MS`. */
  staleMs?: number;
}

export class MarketStream {
  readonly #url: string;
  readonly #options: MarketStreamOptions;
  readonly #createSocket: WebSocketFactory;
  readonly #ping: number;
  readonly #stale: number;
  /** Lần cuối nhận nến / mark price (hoặc lúc mở socket). Pong và ack không tính. */
  #lastData = 0;
  #ws: WebSocketLike | null = null;
  #closed = false;
  #hasConnected = false;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** Symbol nghe `bookTicker` + `trade` (giới hạn số market, DEC-227). Dùng chung kết nối này. */
  #micro = new Set<string>();
  #id = 1;

  constructor(options: MarketStreamOptions) {
    this.#url = `${options.baseUrl.replace(/\/+$/, "")}/${options.engine}`;
    this.#options = options;
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#ping = options.pingIntervalMs ?? WS_PING_INTERVAL_MS;
    this.#stale = options.staleMs ?? WS_MARKET_STALE_MS;
  }

  connect(): void {
    this.#open();
  }

  /**
   * Đặt danh sách symbol nghe `bookTicker` và `trade` trên CHÍNH kết nối này (không mở kết nối mới). Đang mở thì
   * subscribe phần thêm, unsubscribe phần bỏ; kết nối lại thì subscribe lại toàn bộ.
   */
  watchMicro(symbols: readonly string[]): void {
    const next = new Set(symbols);
    const added = [...next].filter((s) => !this.#micro.has(s));
    const removed = [...this.#micro].filter((s) => !next.has(s));
    this.#micro = next;
    const ws = this.#ws;
    if (ws?.readyState !== 1) return;
    if (removed.length > 0) this.#sendMicro(ws, "unsubscribe", removed);
    if (added.length > 0) this.#sendMicro(ws, "subscribe", added);
  }

  #sendMicro(ws: WebSocketLike, op: "subscribe" | "unsubscribe", symbols: readonly string[]): void {
    for (const channel of ["bookTicker", "trade"] as const)
      ws.send(JSON.stringify({ op, id: this.#id++, params: { channel, symbols } }));
  }

  close(): void {
    this.#closed = true;
    this.#clearTimer();
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
  }

  #open(): void {
    if (this.#closed) return;
    const ws = this.#createSocket(this.#url);
    this.#ws = ws;
    this.#lastData = Date.now();
    // Hẹn giờ ngay từ lúc tạo socket: kết nối treo (không open, không error) cũng bị bỏ và nối lại.
    this.#arm(ws);
    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      this.#lastData = Date.now();
      const reconnected = this.#hasConnected;
      this.#hasConnected = true;
      this.#attempt = 0;
      for (const symbol of this.#options.symbols) {
        ws.send(
          JSON.stringify({
            op: "subscribe",
            id: this.#id++,
            params: { channel: "candle", symbol, interval: this.#options.interval ?? "1m" },
          }),
        );
      }
      if (this.#options.markPrices === true) {
        ws.send(
          JSON.stringify({ op: "subscribe", id: this.#id++, params: { channel: "allMarkPrice" } }),
        );
      }
      if (this.#micro.size > 0) this.#sendMicro(ws, "subscribe", [...this.#micro]);
      this.#arm(ws);
      if (reconnected) this.#options.callbacks.onReconnect();
    });
    ws.addEventListener("message", (event) => {
      if (this.#ws !== ws) return;
      this.#arm(ws);
      if (typeof event.data === "string") this.#handle(event.data);
    });
    ws.addEventListener("close", () => {
      this.#drop(ws);
    });
    ws.addEventListener("error", () => {
      this.#drop(ws);
    });
  }

  #handle(raw: string): void {
    let body: unknown;
    try {
      body = parseSodexJson(raw);
    } catch {
      return;
    }
    const ack = wsAckSchema.safeParse(body);
    if (ack.success) {
      if (!ack.data.success)
        this.#options.callbacks.onError(
          new Error(`SoDEX WS subscribe rejected: ${ack.data.error ?? ""}`),
        );
      return;
    }
    const push = wsPushSchema.safeParse(body);
    if (!push.success) return;
    if (push.data.channel === "candle") {
      const candle = wsCandleSchema.safeParse(push.data.data);
      if (candle.success) {
        this.#lastData = Date.now();
        this.#options.callbacks.onCandle(candle.data);
      } else this.#options.callbacks.onError(new Error("SoDEX WS candle did not match schema"));
    } else if (push.data.channel === "bookTicker") {
      const { ok, bad } = itemsOf(wsBookTickerSchema, push.data.data);
      if (ok.length > 0) this.#options.callbacks.onBookTickers?.(ok);
      if (bad > 0)
        this.#options.callbacks.onError(new Error("SoDEX WS bookTicker did not match schema"));
    } else if (push.data.channel === "trade") {
      const { ok, bad } = itemsOf(wsMarketTradeSchema, push.data.data);
      if (ok.length > 0) this.#options.callbacks.onTrades?.(ok);
      if (bad > 0)
        this.#options.callbacks.onError(new Error("SoDEX WS trade did not match schema"));
    } else if (push.data.channel === "allMarkPrice") {
      const marks = z.array(wsMarkPriceSchema).safeParse(push.data.data);
      if (marks.success) {
        this.#lastData = Date.now();
        this.#options.callbacks.onMarkPrices?.(marks.data);
      } else
        this.#options.callbacks.onError(new Error("SoDEX WS allMarkPrice did not match schema"));
    }
  }

  #arm(ws: WebSocketLike): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      if (this.#ws !== ws) return;
      // Còn trả pong nhưng không còn đẩy giá (mất subscription phía SoDEX): nối lại để subscribe lại.
      if (Date.now() - this.#lastData > this.#stale) {
        this.#options.callbacks.onError(
          new Error(
            `SoDEX market WS sent no prices for ${String(Math.round(this.#stale / 1000))} s; reconnecting`,
          ),
        );
        this.#drop(ws);
        return;
      }
      if (ws.readyState === 1) ws.send(JSON.stringify({ op: "ping" }));
      this.#timer = setTimeout(() => {
        this.#drop(ws);
      }, this.#ping);
    }, this.#ping);
  }

  #drop(ws: WebSocketLike): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#clearTimer();
    ws.close();
    if (this.#closed) return;
    const delay = reconnectDelay(this.#attempt);
    this.#attempt += 1;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#open();
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
