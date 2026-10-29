import { decimalStringSchema } from "@drift/shared";
import { z } from "zod";

import { parseSodexJson } from "../rest/json";

import { WS_PING_INTERVAL_MS, reconnectDelay } from "./constants";
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

export interface MarketStreamCallbacks {
  onCandle(candle: WsCandle): void;
  onMarkPrices?(marks: WsMarkPrice[]): void;
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
}

export class MarketStream {
  readonly #url: string;
  readonly #options: MarketStreamOptions;
  readonly #createSocket: WebSocketFactory;
  readonly #ping: number;
  #ws: WebSocketLike | null = null;
  #closed = false;
  #hasConnected = false;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MarketStreamOptions) {
    this.#url = `${options.baseUrl.replace(/\/+$/, "")}/${options.engine}`;
    this.#options = options;
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#ping = options.pingIntervalMs ?? WS_PING_INTERVAL_MS;
  }

  connect(): void {
    this.#open();
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
    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      const reconnected = this.#hasConnected;
      this.#hasConnected = true;
      this.#attempt = 0;
      let id = 1;
      for (const symbol of this.#options.symbols) {
        ws.send(
          JSON.stringify({
            op: "subscribe",
            id: id++,
            params: { channel: "candle", symbol, interval: this.#options.interval ?? "1m" },
          }),
        );
      }
      if (this.#options.markPrices === true) {
        ws.send(JSON.stringify({ op: "subscribe", id: id++, params: { channel: "allMarkPrice" } }));
      }
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
      if (candle.success) this.#options.callbacks.onCandle(candle.data);
      else this.#options.callbacks.onError(new Error("SoDEX WS candle did not match schema"));
    } else if (push.data.channel === "allMarkPrice") {
      const marks = z.array(wsMarkPriceSchema).safeParse(push.data.data);
      if (marks.success) this.#options.callbacks.onMarkPrices?.(marks.data);
      else this.#options.callbacks.onError(new Error("SoDEX WS allMarkPrice did not match schema"));
    }
  }

  #arm(ws: WebSocketLike): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      if (this.#ws !== ws) return;
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
