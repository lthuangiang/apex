import { reconnectDelay, type WebSocketFactory, type WebSocketLike } from "@drift/sodex";
import { z } from "zod";

import { hlFillsSchema, type HlFill } from "./schemas";

// WS `userFills` của Hyperliquid cho ví đang được copy (T0, DEC-163 mục 10). Một kết nối mang nhiều subscription;
// Hyperliquid cho tối đa 10 ví khác nhau / IP trên các kênh theo user, DeskLabs dùng ≤ 8 (+2 để đổi ví không rớt).
// Tin đầu tiên của mỗi subscription là snapshot (`isSnapshot: true`): fill cũ, không dùng để copy.

export const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";
export const HL_WS_MAX_USERS = 10;
const PING_MS = 30_000;
const OPEN = 1;

const pushSchema = z.object({
  channel: z.literal("userFills"),
  data: z.object({ user: z.string(), isSnapshot: z.boolean().optional(), fills: z.unknown() }),
});

export interface HlUserFillsCallbacks {
  /** Fill mới (không phải snapshot) của một ví. */
  onFills(user: string, fills: HlFill[]): void;
  /** Nối lại xong: người gọi đọc lại vị thế qua REST vì có thể đã lỡ fill. */
  onReconnect(): void;
  onError(error: Error): void;
}

export class HlUserFillsStream {
  readonly #url: string;
  readonly #cb: HlUserFillsCallbacks;
  readonly #create: WebSocketFactory;
  readonly #users = new Set<string>();
  #ws: WebSocketLike | null = null;
  #closed = false;
  #connected = false;
  #attempt = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: {
    callbacks: HlUserFillsCallbacks;
    url?: string;
    createSocket?: WebSocketFactory;
  }) {
    this.#url = options.url ?? HL_WS_URL;
    this.#cb = options.callbacks;
    this.#create = options.createSocket ?? ((url) => new WebSocket(url));
  }

  get users(): ReadonlySet<string> {
    return this.#users;
  }

  /** Đặt tập ví theo dõi: subscribe ví mới **trước**, rồi mới unsubscribe ví bỏ (đổi trader không rớt tín hiệu). */
  setUsers(users: readonly string[]): void {
    const next = new Set(users.map((u) => u.toLowerCase()));
    if (next.size > HL_WS_MAX_USERS)
      throw new RangeError("Too many Hyperliquid WS users for one IP");
    const added = [...next].filter((u) => !this.#users.has(u));
    const removed = [...this.#users].filter((u) => !next.has(u));
    for (const u of added) {
      this.#users.add(u);
      this.#send("subscribe", u);
    }
    for (const u of removed) {
      this.#users.delete(u);
      this.#send("unsubscribe", u);
    }
    if (this.#users.size > 0 && this.#ws === null && !this.#closed) this.#open();
  }

  close(): void {
    this.#closed = true;
    this.#clear();
    const ws = this.#ws;
    this.#ws = null;
    ws?.close();
  }

  #send(method: "subscribe" | "unsubscribe", user: string): void {
    const ws = this.#ws;
    if (ws?.readyState !== OPEN) return;
    ws.send(JSON.stringify({ method, subscription: { type: "userFills", user } }));
  }

  #open(): void {
    const ws = this.#create(this.#url);
    this.#ws = ws;
    ws.addEventListener("open", () => {
      if (this.#ws !== ws) return;
      const again = this.#connected;
      this.#connected = true;
      this.#attempt = 0;
      for (const u of this.#users) this.#send("subscribe", u);
      this.#arm(ws);
      if (again) this.#cb.onReconnect();
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
      body = JSON.parse(raw);
    } catch {
      this.#cb.onError(new Error("Hyperliquid WS sent invalid JSON"));
      return;
    }
    const push = pushSchema.safeParse(body);
    if (!push.success) return; // pong, subscriptionResponse…
    const { user, isSnapshot, fills } = push.data.data;
    if (isSnapshot === true) return;
    const parsed = hlFillsSchema.safeParse(fills);
    if (!parsed.success) {
      this.#cb.onError(new Error("Hyperliquid WS userFills did not match schema"));
      return;
    }
    const u = user.toLowerCase();
    if (this.#users.has(u) && parsed.data.length > 0) this.#cb.onFills(u, parsed.data);
  }

  #arm(ws: WebSocketLike): void {
    this.#clear();
    this.#timer = setTimeout(() => {
      if (this.#ws !== ws) return;
      if (ws.readyState === OPEN) ws.send(JSON.stringify({ method: "ping" }));
      this.#timer = setTimeout(() => {
        this.#drop(ws);
      }, PING_MS);
    }, PING_MS);
  }

  #drop(ws: WebSocketLike): void {
    if (this.#ws !== ws) return;
    this.#ws = null;
    this.#clear();
    ws.close();
    if (this.#closed || this.#users.size === 0) return;
    const delay = reconnectDelay(this.#attempt);
    this.#attempt += 1;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#open();
    }, delay);
  }

  #clear(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }
}
