import type { Address } from "viem";

import { parseSodexJson } from "../rest/json";

import { WS_PING_INTERVAL_MS, reconnectDelay } from "./constants";
import {
  parseOrderUpdates,
  parseTrades,
  wsAckSchema,
  wsChannels,
  wsPushSchema,
  type WsOrderUpdate,
  type WsTrade,
} from "./schemas";

// User stream SoDEX (accountOrderUpdate + accountTrade) cho một account trên một engine.
// Engine sở hữu shard là nơi duy nhất tạo client này cho account thuộc shard (ARCHITECTURE.md 3.3.1).
//
// Theo websocket-v1.md: server cắt kết nối nếu 60 s không có dữ liệu. Sau N < 60 s không nhận
// message thì gửi {"op":"ping"}; không nhận {"op":"pong"} trong N s nữa thì reconnect.
// Sau mỗi lần reconnect, consumer phải đối soát open orders / history / trades qua REST.

/** Bề mặt tối thiểu của WebSocket mà client cần; WebSocket toàn cục của Node khớp interface này. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}
export type WebSocketFactory = (url: string) => WebSocketLike;

export interface WsUserStreamCallbacks {
  onOrderUpdate(updates: WsOrderUpdate[]): void;
  onTrade(trades: WsTrade[]): void;
  /** Gọi sau mỗi lần kết nối lại thành công. Consumer đối soát qua REST (ARCHITECTURE.md 3.4). */
  onReconnect(): void;
  /** Lỗi parse, subscribe bị từ chối… Không chứa payload (có thể là dữ liệu account). */
  onError(error: Error): void;
}

export interface WsUserStreamOptions {
  /** Base WS URL, ví dụ `wss://mainnet-gw.sodex.dev/ws`. Client nối thêm `/spot` hoặc `/perps`. */
  baseUrl: string;
  engine: "spot" | "perps";
  /** Địa chỉ master wallet của người dùng. */
  user: Address;
  /** Bỏ trống thì SoDEX dùng primary account. */
  accountID?: bigint;
  /** Bỏ trống thì nhận mọi symbol. */
  symbols?: readonly string[];
  callbacks: WsUserStreamCallbacks;
  createSocket?: WebSocketFactory;
  pingIntervalMs?: number;
}

const OPEN = 1;

export class WsUserStream {
  readonly #url: string;
  readonly #params: { user: Address; accountID?: number; symbols?: string[] };
  readonly #cb: WsUserStreamCallbacks;
  readonly #createSocket: WebSocketFactory;
  readonly #pingIntervalMs: number;

  #ws: WebSocketLike | null = null;
  #closed = false;
  #started = false;
  #hasConnected = false;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: WsUserStreamOptions) {
    this.#url = `${options.baseUrl.replace(/\/+$/, "")}/${options.engine}`;
    const params: { user: Address; accountID?: number; symbols?: string[] } = {
      user: options.user,
    };
    if (options.accountID !== undefined) {
      if (options.accountID > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new RangeError("accountID exceeds safe integer range");
      }
      params.accountID = Number(options.accountID);
    }
    if (options.symbols !== undefined && options.symbols.length > 0) {
      params.symbols = [...options.symbols];
    }
    this.#params = params;
    this.#cb = options.callbacks;
    this.#createSocket = options.createSocket ?? ((url) => new WebSocket(url));
    this.#pingIntervalMs = options.pingIntervalMs ?? WS_PING_INTERVAL_MS;
  }

  connect(): void {
    if (this.#started) return;
    this.#started = true;
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
      this.#subscribe(ws);
      this.#armIdleTimer(ws);
      if (reconnected) this.#cb.onReconnect();
    });
    ws.addEventListener("message", (event) => {
      if (this.#ws !== ws) return;
      this.#armIdleTimer(ws);
      if (typeof event.data === "string") this.#handleMessage(event.data);
    });
    ws.addEventListener("close", () => {
      this.#drop(ws);
    });
    ws.addEventListener("error", () => {
      this.#drop(ws);
    });
  }

  #subscribe(ws: WebSocketLike): void {
    ws.send(
      JSON.stringify({
        op: "subscribe",
        id: 1,
        params: { channel: wsChannels.accountOrderUpdate, ...this.#params },
      }),
    );
    ws.send(
      JSON.stringify({
        op: "subscribe",
        id: 2,
        params: { channel: wsChannels.accountTrade, ...this.#params },
      }),
    );
  }

  #handleMessage(raw: string): void {
    let body: unknown;
    try {
      body = parseSodexJson(raw);
    } catch {
      this.#cb.onError(new Error("SoDEX WS sent invalid JSON"));
      return;
    }

    const ack = wsAckSchema.safeParse(body);
    if (ack.success) {
      if (!ack.data.success) {
        this.#cb.onError(new Error(`SoDEX WS ${ack.data.op} rejected: ${ack.data.error ?? ""}`));
      }
      return;
    }

    const push = wsPushSchema.safeParse(body);
    if (!push.success) return; // pong hoặc message khác: đã reset idle timer

    try {
      if (push.data.channel === wsChannels.accountOrderUpdate) {
        this.#cb.onOrderUpdate(parseOrderUpdates(push.data.data));
      } else if (push.data.channel === wsChannels.accountTrade) {
        this.#cb.onTrade(parseTrades(push.data.data));
      }
    } catch {
      this.#cb.onError(new Error(`SoDEX WS ${push.data.channel} did not match schema`));
    }
  }

  /** Không có message trong N ms → ping; thêm N ms không có gì → reconnect. */
  #armIdleTimer(ws: WebSocketLike): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      if (this.#ws !== ws) return;
      if (ws.readyState === OPEN) ws.send(JSON.stringify({ op: "ping" }));
      this.#timer = setTimeout(() => {
        this.#drop(ws);
      }, this.#pingIntervalMs);
    }, this.#pingIntervalMs);
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
