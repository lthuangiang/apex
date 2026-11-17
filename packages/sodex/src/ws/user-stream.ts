import { randomBytes } from "node:crypto";

import type { Address } from "viem";

import { safeRecord, type SodexCallRecorderLike, type SodexWsEvent } from "../debug/capture";
import type { SodexCallContext } from "../debug/context";
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
  /**
   * SoDEX đã nhận cả hai subscribe (ack `success: true`) trên kết nối hiện tại; gọi một lần mỗi kết nối, kể cả lần đầu.
   * Tin trước lúc này (kể cả fill) không bao giờ tới: consumer đối soát qua REST.
   */
  onSubscribed?(): void;
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
  /**
   * SoDEX Debugger: vòng đời kết nối, subscribe ack và tin accountOrderUpdate / accountTrade (không ghi ping / pong).
   * Không chặn, không ném.
   */
  recorder?: SodexCallRecorderLike;
  /** Ngữ cảnh gắn vào mọi sự kiện của stream (account trong DB, bot nếu stream chỉ của một bot). */
  recordContext?: SodexCallContext;
}

/** Vì sao kết nối bị đóng (để ghi CLOSE đúng outcome). */
type DropReason = "server" | "idle" | "rejected" | "error";

const OPEN = 1;
/** accountOrderUpdate + accountTrade. */
const SUBSCRIPTIONS = 2;

export class WsUserStream {
  readonly #url: string;
  readonly #params: { user: Address; accountID?: number; symbols?: string[] };
  readonly #cb: WsUserStreamCallbacks;
  readonly #createSocket: WebSocketFactory;
  readonly #pingIntervalMs: number;
  readonly #engine: "spot" | "perps";
  readonly #recorder: SodexCallRecorderLike | undefined;
  readonly #recordContext: SodexCallContext | undefined;

  #ws: WebSocketLike | null = null;
  /** Id kết nối hiện tại cho debugger (`ws-perps-3f8a1c2d`). */
  #connId = "";
  #openedAt = 0;
  /** Lúc gửi subscribe theo `id` (để đo thời gian tới ack). */
  readonly #subSentAt = new Map<number, { at: number; t: number; text: string; channel: string }>();
  #closed = false;
  #started = false;
  #hasConnected = false;
  /** Số subscribe SoDEX đã nhận trên kết nối hiện tại (0 khi chưa kết nối / vừa đứt). */
  #acked = 0;
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
    this.#engine = options.engine;
    this.#recorder = options.recorder;
    this.#recordContext = options.recordContext;
  }

  #record(
    event: SodexWsEvent,
    fields: {
      channel?: string | null;
      outcome?: "ok" | "rejected" | "timeout" | "network" | "unreadable";
      request?: string | null;
      response?: string | null;
      detail?: string | null;
      startedAt?: number;
      latencyMs?: number;
    },
  ): void {
    if (this.#recorder === undefined) return;
    const connId = this.#connId;
    safeRecord(this.#recorder, () => ({
      kind: "ws",
      startedAt: fields.startedAt ?? Date.now(),
      latencyMs: fields.latencyMs ?? 0,
      event,
      url: this.#url,
      engine: this.#engine,
      channel: fields.channel ?? null,
      connId,
      accountAddress: this.#params.user,
      sodexAccountId: this.#params.accountID === undefined ? null : String(this.#params.accountID),
      request: fields.request ?? null,
      response: fields.response ?? null,
      outcome: fields.outcome ?? "ok",
      detail: fields.detail ?? null,
      context: this.#recordContext,
    }));
  }

  connect(): void {
    if (this.#started) return;
    this.#started = true;
    this.#open();
  }

  /** Cả `accountOrderUpdate` và `accountTrade` đã được SoDEX nhận trên kết nối đang mở. */
  get subscribed(): boolean {
    return this.#ws !== null && this.#acked >= SUBSCRIPTIONS;
  }

  close(): void {
    this.#closed = true;
    this.#clearTimer();
    const ws = this.#ws;
    this.#ws = null;
    if (ws !== null) this.#record("CLOSE", { detail: "closed by DeskLabs" });
    ws?.close();
  }

  #open(): void {
    if (this.#closed) return;
    const ws = this.#createSocket(this.#url);
    this.#ws = ws;
    this.#connId = `ws-${this.#engine}-${randomBytes(4).toString("hex")}`;
    this.#openedAt = Date.now();
    const t0 = performance.now();

    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      this.#record("OPEN", { startedAt: this.#openedAt, latencyMs: performance.now() - t0 });
      const reconnected = this.#hasConnected;
      this.#hasConnected = true;
      this.#acked = 0;
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
      this.#drop(ws, "server");
    });
    ws.addEventListener("error", () => {
      if (this.#ws === ws) this.#record("ERROR", { outcome: "network", detail: "WebSocket error" });
      this.#drop(ws, "error");
    });
  }

  #subscribe(ws: WebSocketLike): void {
    this.#subSentAt.clear();
    const send = (id: number, channel: string) => {
      const text = JSON.stringify({ op: "subscribe", id, params: { channel, ...this.#params } });
      if (this.#recorder !== undefined) {
        this.#subSentAt.set(id, { at: Date.now(), t: performance.now(), text, channel });
      }
      ws.send(text);
    };
    send(1, wsChannels.accountOrderUpdate);
    send(2, wsChannels.accountTrade);
  }

  /** Ghi ack subscribe với thời gian từ lúc gửi. */
  #recordAck(
    raw: string,
    id: number | null | undefined,
    success: boolean,
    error: string | null,
  ): void {
    const sent = id === null || id === undefined ? undefined : this.#subSentAt.get(id);
    this.#record("SUB", {
      channel: sent?.channel ?? null,
      outcome: success ? "ok" : "rejected",
      request: sent?.text ?? null,
      response: raw,
      detail: success ? null : error,
      ...(sent === undefined ? {} : { startedAt: sent.at, latencyMs: performance.now() - sent.t }),
    });
  }

  #handleMessage(raw: string): void {
    let body: unknown;
    try {
      body = parseSodexJson(raw);
    } catch {
      this.#record("MSG", { outcome: "unreadable", response: raw, detail: "invalid JSON" });
      this.#cb.onError(new Error("SoDEX WS sent invalid JSON"));
      return;
    }

    const ack = wsAckSchema.safeParse(body);
    if (ack.success) {
      if (ack.data.op === "subscribe") {
        this.#recordAck(raw, ack.data.id, ack.data.success, ack.data.error ?? null);
      }
      if (!ack.data.success) {
        this.#cb.onError(new Error(`SoDEX WS ${ack.data.op} rejected: ${ack.data.error ?? ""}`));
        // Subscribe bị từ chối: không ở lại nửa vời (kết nối sống nhờ ping nhưng thiếu kênh). Đóng và kết nối lại theo
        // backoff; backoff chỉ về 0 khi subscribe đủ, nên từ chối lặp lại không thành vòng lặp nhanh.
        if (ack.data.op === "subscribe" && this.#ws !== null) this.#drop(this.#ws, "rejected");
      } else if (ack.data.op === "subscribe" && this.#acked < SUBSCRIPTIONS) {
        this.#acked += 1;
        if (this.#acked === SUBSCRIPTIONS) {
          this.#attempt = 0;
          this.#cb.onSubscribed?.();
        }
      }
      return;
    }

    const push = wsPushSchema.safeParse(body);
    if (!push.success) return; // pong hoặc message khác: đã reset idle timer

    // Tin hỏng chỉ bỏ riêng tin đó; các tin còn lại trong lô vẫn được xử lý (DEC-118).
    const channel = push.data.channel;
    let bad: string | null = null;
    const invalid = (e: Error) => {
      bad ??= e.message;
      this.#cb.onError(new Error(`SoDEX WS ${channel} ${e.message}`));
    };
    const recordPush = () => {
      if (channel !== wsChannels.accountOrderUpdate && channel !== wsChannels.accountTrade) return;
      this.#record("MSG", {
        channel,
        response: raw,
        outcome: bad === null ? "ok" : "unreadable",
        detail: bad,
      });
    };
    try {
      if (channel === wsChannels.accountOrderUpdate) {
        const items = parseOrderUpdates(push.data.data, invalid);
        if (items.length > 0) this.#cb.onOrderUpdate(items);
      } else if (channel === wsChannels.accountTrade) {
        const items = parseTrades(push.data.data, invalid);
        if (items.length > 0) this.#cb.onTrade(items);
      }
    } catch {
      bad ??= "did not match schema";
      this.#cb.onError(new Error(`SoDEX WS ${channel} did not match schema`));
    }
    recordPush();
  }

  /** Không có message trong N ms → ping; thêm N ms không có gì → reconnect. */
  #armIdleTimer(ws: WebSocketLike): void {
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      if (this.#ws !== ws) return;
      if (ws.readyState === OPEN) ws.send(JSON.stringify({ op: "ping" }));
      this.#timer = setTimeout(() => {
        this.#drop(ws, "idle");
      }, this.#pingIntervalMs);
    }, this.#pingIntervalMs);
  }

  #drop(ws: WebSocketLike, reason: DropReason): void {
    if (this.#ws !== ws) return;
    if (reason === "idle") {
      this.#record("CLOSE", { outcome: "timeout", detail: "no pong from SoDEX: reconnecting" });
    } else if (reason === "server") {
      this.#record("CLOSE", { outcome: "network", detail: "closed by SoDEX" });
    } else if (reason === "rejected") {
      this.#record("CLOSE", { detail: "closed after a rejected subscribe: reconnecting" });
    }
    this.#ws = null;
    this.#acked = 0;
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
