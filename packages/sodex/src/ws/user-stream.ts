import { randomBytes } from "node:crypto";

import { SodexWsClosedBy, type SodexWsCloseInfo } from "@drift/shared";
import type { Address } from "viem";

import {
  capBody,
  safeRecord,
  type SodexCallRecorderLike,
  type SodexWsEvent,
} from "../debug/capture";
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
  addEventListener(type: "open" | "error", listener: () => void): void;
  /** `event` là `CloseEvent` (code / reason / wasClean); đọc phòng thủ vì socket khác có thể không đưa. */
  addEventListener(type: "close", listener: (event: unknown) => void): void;
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

/** Close reason dài hơn mức này bị cắt (theo giao thức tối đa 123 byte; phòng server gửi sai). */
const CLOSE_REASON_MAX = 256;
/** Close code 1006: kết nối đứt mà không có close frame. */
const ABNORMAL_CLOSURE = 1006;

/** Close code / reason / wasClean đọc từ close event (#240). */
function closeFrameOf(event: unknown): {
  code: number | null;
  reason: string | null;
  wasClean: boolean | null;
} {
  const e: Partial<Record<"code" | "reason" | "wasClean", unknown>> =
    typeof event === "object" && event !== null ? event : {};
  const { code, reason, wasClean } = e;
  return {
    code: typeof code === "number" && Number.isInteger(code) ? code : null,
    reason:
      typeof reason === "string" && reason.length > 0 ? reason.slice(0, CLOSE_REASON_MAX) : null,
    wasClean: typeof wasClean === "boolean" ? wasClean : null,
  };
}

/** Câu `detail` của dòng CLOSE (hiện ở Debugger và trong báo cáo cho SoDEX). */
export function wsCloseDetail(info: SodexWsCloseInfo, cause: DropReason | "client"): string {
  let head: string;
  if (cause === "server") {
    const code = info.code === null ? "no code" : `code ${String(info.code)}`;
    head =
      info.code === ABNORMAL_CLOSURE
        ? `connection dropped without a close frame (${code})`
        : `closed by SoDEX (${code}, ${info.reason === null ? "no reason" : `reason ${JSON.stringify(info.reason)}`})`;
  } else if (cause === "idle") {
    head = "no pong from SoDEX";
  } else if (cause === "rejected") {
    head = "closed after a rejected subscribe";
  } else if (cause === "error") {
    head = "WebSocket error";
  } else {
    head = "closed by DeskLabs";
  }
  return info.reconnectInMs === null
    ? head
    : `${head}: reconnecting in ${String(info.reconnectInMs)} ms (attempt ${String(info.reconnectAttempt ?? 1)})`;
}

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
  /** `Date.now()` của tin cuối trên kết nối hiện tại (0 = chưa có tin). */
  #lastMessageAt = 0;
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
      items?: readonly unknown[] | null;
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
      response: capBody(fields.response ?? null),
      items: fields.items ?? null,
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
    if (ws !== null) this.#recordClose("client", null);
    ws?.close();
  }

  #open(): void {
    if (this.#closed) return;
    const ws = this.#createSocket(this.#url);
    this.#ws = ws;
    this.#connId = `ws-${this.#engine}-${randomBytes(4).toString("hex")}`;
    this.#openedAt = Date.now();
    this.#lastMessageAt = 0;
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
      if (this.#recorder !== undefined) this.#lastMessageAt = Date.now();
      this.#armIdleTimer(ws);
      if (typeof event.data === "string") this.#handleMessage(event.data);
    });
    ws.addEventListener("close", (event) => {
      this.#drop(ws, "server", event);
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
      const data: unknown = push.data.data;
      this.#record("MSG", {
        channel,
        response: raw,
        items: Array.isArray(data) ? data : [data],
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

  /**
   * Ghi CLOSE với close code / reason, ai đóng và thời gian kết nối lại (#240). Chi tiết nằm ở `response` dạng JSON
   * (schema `sodexWsCloseInfoSchema`); không bao giờ chứa secret.
   */
  #recordClose(
    cause: DropReason | "client",
    reconnect: { inMs: number; attempt: number } | null,
    event?: unknown,
  ): void {
    if (this.#recorder === undefined) return;
    const now = Date.now();
    const frame = closeFrameOf(event);
    const closedBy =
      cause === "server"
        ? frame.code === ABNORMAL_CLOSURE
          ? SodexWsClosedBy.network
          : SodexWsClosedBy.server
        : cause === "idle"
          ? SodexWsClosedBy.timeout
          : cause === "error"
            ? SodexWsClosedBy.network
            : SodexWsClosedBy.client;
    const info: SodexWsCloseInfo = {
      closedBy,
      ...frame,
      openForMs: this.#openedAt === 0 ? null : Math.max(0, now - this.#openedAt),
      lastMessageAgoMs: this.#lastMessageAt === 0 ? null : Math.max(0, now - this.#lastMessageAt),
      reconnectInMs: reconnect?.inMs ?? null,
      reconnectAttempt: reconnect?.attempt ?? null,
    };
    this.#record("CLOSE", {
      startedAt: now,
      outcome:
        cause === "idle" ? "timeout" : cause === "server" || cause === "error" ? "network" : "ok",
      response: JSON.stringify(info),
      detail: wsCloseDetail(info, cause),
    });
  }

  #drop(ws: WebSocketLike, reason: DropReason, event?: unknown): void {
    if (this.#ws !== ws) return;
    const reconnect = this.#closed
      ? null
      : { inMs: reconnectDelay(this.#attempt), attempt: this.#attempt + 1 };
    this.#recordClose(reason, reconnect, event);
    this.#ws = null;
    this.#acked = 0;
    this.#clearTimer();
    ws.close();
    if (reconnect === null) return;
    const delay = reconnect.inMs;
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
