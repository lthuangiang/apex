import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MarketStream, type MarketStreamCallbacks } from "../ws/market-stream";
import type { WebSocketLike } from "../ws/user-stream";

// Stream giá tự nối lại khi chết im lặng (2026-11-08): còn trả pong nhưng hết nến, hoặc kết nối treo không mở.

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  readonly #listeners = new Map<string, ((event: { data: unknown }) => void)[]>();

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }
  emit(type: string, data?: unknown): void {
    if (type === "open") this.readyState = 1;
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
}

const CANDLE = JSON.stringify({
  channel: "candle",
  type: "update",
  data: {
    t: 1,
    T: 2,
    s: "BTC-USD",
    i: "1m",
    o: "1",
    c: "1",
    h: "1",
    l: "1",
    v: "1",
    q: "1",
    n: 1,
    x: false,
  },
});

function setup() {
  const sockets: FakeSocket[] = [];
  const callbacks = {
    onCandle: vi.fn<MarketStreamCallbacks["onCandle"]>(),
    onReconnect: vi.fn<MarketStreamCallbacks["onReconnect"]>(),
    onError: vi.fn<MarketStreamCallbacks["onError"]>(),
  };
  const stream = new MarketStream({
    baseUrl: "wss://mainnet-gw.sodex.dev/ws/",
    engine: "perps",
    symbols: ["BTC-USD"],
    callbacks,
    pingIntervalMs: 1000,
    staleMs: 3000,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  return { stream, sockets, callbacks };
}

describe("MarketStream watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reconnects when SoDEX keeps answering pings but stops sending prices", () => {
    const { stream, sockets, callbacks } = setup();
    stream.connect();
    const first = sockets[0];
    first?.emit("open");
    first?.emit("message", CANDLE);
    expect(callbacks.onCandle).toHaveBeenCalledTimes(1);
    // Chỉ còn pong mỗi giây, không có nến.
    for (let i = 0; i < 6; i += 1) {
      vi.advanceTimersByTime(1000);
      first?.emit("message", JSON.stringify({ op: "pong" }));
    }
    expect(first?.closed).toBe(true);
    expect(callbacks.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("no prices") as unknown }),
    );
    // Socket mới đã tạo sau backoff (1–1.25 s) và chưa tới hạn chờ kết nối (2 lần chu kỳ ping).
    expect(sockets).toHaveLength(2);
    sockets[1]?.emit("open");
    expect(callbacks.onReconnect).toHaveBeenCalledTimes(1);
    stream.close();
  });

  it("keeps the connection while prices keep arriving", () => {
    const { stream, sockets } = setup();
    stream.connect();
    sockets[0]?.emit("open");
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(800);
      sockets[0]?.emit("message", CANDLE);
    }
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.closed).toBe(false);
    stream.close();
  });

  it("gives up on a connection that never opens and tries again", () => {
    const { stream, sockets } = setup();
    stream.connect();
    // Không open, không error: trước đây đứng im mãi.
    vi.advanceTimersByTime(2000);
    expect(sockets[0]?.closed).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(2);
    stream.close();
  });
});

// DEC-TBD-mm-cost: bookTicker + trade cho một số market, trên CHÍNH kết nối giá hiện có (không mở kết nối mới).
describe("MarketStream micro data", () => {
  const subs = (s: FakeSocket) =>
    s.sent
      .map(
        (m) => JSON.parse(m) as { op: string; params?: { channel?: string; symbols?: string[] } },
      )
      .filter((m) => m.params?.channel === "bookTicker" || m.params?.channel === "trade")
      .map((m) => [m.op, m.params?.channel, m.params?.symbols]);

  it("subscribes, diffs and resubscribes on the same socket", () => {
    vi.useFakeTimers();
    const { stream, sockets } = setup();
    stream.watchMicro(["BTC-USD", "ETH-USD"]);
    stream.connect();
    const s = sockets[0];
    if (s === undefined) throw new Error("no socket");
    s.emit("open");
    expect(subs(s)).toEqual([
      ["subscribe", "bookTicker", ["BTC-USD", "ETH-USD"]],
      ["subscribe", "trade", ["BTC-USD", "ETH-USD"]],
    ]);
    s.sent.length = 0;
    stream.watchMicro(["ETH-USD", "SOL-USD"]);
    expect(subs(s)).toEqual([
      ["unsubscribe", "bookTicker", ["BTC-USD"]],
      ["unsubscribe", "trade", ["BTC-USD"]],
      ["subscribe", "bookTicker", ["SOL-USD"]],
      ["subscribe", "trade", ["SOL-USD"]],
    ]);
    // Một kết nối duy nhất.
    expect(sockets).toHaveLength(1);
    stream.close();
    vi.useRealTimers();
  });

  it("routes book tickers and public trades, as object or array", () => {
    const sockets: FakeSocket[] = [];
    const onBookTickers = vi.fn();
    const onTrades = vi.fn();
    const onError = vi.fn();
    const stream = new MarketStream({
      baseUrl: "wss://x/ws/",
      engine: "perps",
      symbols: [],
      callbacks: { onCandle: vi.fn(), onReconnect: vi.fn(), onError, onBookTickers, onTrades },
      createSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
    });
    stream.connect();
    const s = sockets[0];
    if (s === undefined) throw new Error("no socket");
    s.emit("open");
    s.emit(
      "message",
      JSON.stringify({
        channel: "bookTicker",
        type: "update",
        data: { E: 1, s: "ETH-USD", u: 9, a: "3000.5", A: "1", b: "3000", B: "2" },
      }),
    );
    s.emit(
      "message",
      JSON.stringify({
        channel: "trade",
        type: "update",
        data: [{ E: 1, T: 2, t: 7, s: "ETH-USD", S: "BUY", p: "3000.5", q: "0.1", bi: 1, si: 2 }],
      }),
    );
    expect(onBookTickers).toHaveBeenCalledWith([
      { E: 1, s: "ETH-USD", a: "3000.5", A: "1", b: "3000", B: "2" },
    ]);
    expect(onTrades).toHaveBeenCalledWith([
      { T: 2, s: "ETH-USD", S: "BUY", p: "3000.5", q: "0.1" },
    ]);
    expect(onError).not.toHaveBeenCalled();
    stream.close();
  });
});
