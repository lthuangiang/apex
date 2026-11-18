import { sodexWsCloseInfoSchema } from "@drift/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SodexCallCapture, SodexWsCapture } from "../debug/capture";
import { parseOrderUpdates, parseTrades } from "../ws/schemas";
import { WsUserStream, type WebSocketLike, type WsUserStreamCallbacks } from "../ws/user-stream";

const USER = "0xed3e79ef16a7890e6eaef2aa6373b6bec5d59d5c";

// Ví dụ lấy nguyên văn từ account-order-updates.md và account-trades.md.
const ORDER_UPDATE_EXAMPLE = `{"channel":"accountOrderUpdate","type":"update","data":[
{"E":1766849004730,"s":"vBTC_vUSDC","c":"MAKER-ADJUST-0-70399739516726","i":58119,"S":"SELL","o":"LIMIT","f":"GTC","p":"102650","q":"0.36734","X":"NEW","z":"0","v":"0","M":"0.36734","T":1766848473207,"x":"REPLACED"},
{"E":1766849004730,"s":"vBTC_vUSDC","c":"MAKER-ADJUST-0-34207928167487","i":58117,"S":"SELL","o":"LIMIT","f":"GTC","p":"102514","q":"0.69346","X":"PARTIALLY_FILLED","z":"0.00043","v":"44.08102","M":"0.69303","T":1766848473207,"t":6860,"l":"0.00021","L":"102514","n":"0","m":true,"x":"PARTIALLY_FILLED"}]}`;

const TRADE_EXAMPLE = `{"channel":"accountTrade","type":"update","data":[
{"E":1766848149693,"T":1766847863273,"t":6275,"s":"vETH_vUSDC","i":51101,"c":"MAKER-ADJUST-1-51126829939055","S":"BUY","p":"3511.6","q":"0.0268","f":"0","m":true}]}`;

interface FakeEvent {
  data: unknown;
  code?: unknown;
  reason?: unknown;
  wasClean?: unknown;
}

class FakeSocket implements WebSocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  closed = false;
  readonly #listeners = new Map<string, ((event: FakeEvent) => void)[]>();

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  addEventListener(type: string, listener: (event: FakeEvent) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(listener);
    this.#listeners.set(type, list);
  }
  emit(type: string, data?: unknown): void {
    if (type === "open") this.readyState = 1;
    for (const listener of this.#listeners.get(type) ?? []) listener({ data });
  }
  /** Close event như WebSocket thật (code / reason / wasClean). */
  emitClose(code: number, reason: string, wasClean: boolean): void {
    this.readyState = 3;
    for (const listener of this.#listeners.get("close") ?? [])
      listener({ data: undefined, code, reason, wasClean });
  }
}

function setup(
  options: {
    accountID?: bigint;
    symbols?: string[];
    recorder?: { record(c: SodexCallCapture): void };
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const callbacks = {
    onOrderUpdate: vi.fn<WsUserStreamCallbacks["onOrderUpdate"]>(),
    onTrade: vi.fn<WsUserStreamCallbacks["onTrade"]>(),
    onReconnect: vi.fn<WsUserStreamCallbacks["onReconnect"]>(),
    onError: vi.fn<WsUserStreamCallbacks["onError"]>(),
    onSubscribed: vi.fn<NonNullable<WsUserStreamCallbacks["onSubscribed"]>>(),
  };
  const stream = new WsUserStream({
    baseUrl: "wss://mainnet-gw.sodex.dev/ws/",
    engine: "perps",
    user: USER,
    ...options,
    callbacks,
    pingIntervalMs: 1000,
    createSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
  });
  return { stream, sockets, callbacks };
}

describe("WS schemas", () => {
  it("parses the documented order update example", () => {
    const body = JSON.parse(ORDER_UPDATE_EXAMPLE) as { data: unknown };
    const updates = parseOrderUpdates(body.data);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      i: 58117n,
      S: "SELL",
      X: "PARTIALLY_FILLED",
      t: 6860n,
      l: "0.00021",
    });
  });

  it("parses the documented trade example", () => {
    const body = JSON.parse(TRADE_EXAMPLE) as { data: unknown };
    expect(parseTrades(body.data)[0]).toMatchObject({
      t: 6275n,
      i: 51101n,
      S: "BUY",
      f: "0",
      m: true,
    });
  });

  it("accepts a single object as order update data", () => {
    const body = JSON.parse(ORDER_UPDATE_EXAMPLE) as { data: unknown[] };
    expect(parseOrderUpdates(body.data[0])).toHaveLength(1);
  });
});

describe("WsUserStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("subscribes to both account channels on open", () => {
    const { stream, sockets } = setup({ accountID: 1001n, symbols: ["vBTC_vUSDC"] });
    stream.connect();
    const socket = sockets[0];
    expect(socket?.url).toBe("wss://mainnet-gw.sodex.dev/ws/perps");
    socket?.emit("open");
    expect(socket?.sent.map((s) => JSON.parse(s) as unknown)).toEqual([
      {
        op: "subscribe",
        id: 1,
        params: {
          channel: "accountOrderUpdate",
          user: USER,
          accountID: 1001,
          symbols: ["vBTC_vUSDC"],
        },
      },
      {
        op: "subscribe",
        id: 2,
        params: { channel: "accountTrade", user: USER, accountID: 1001, symbols: ["vBTC_vUSDC"] },
      },
    ]);
  });

  it("routes pushes to callbacks", () => {
    const { stream, sockets, callbacks } = setup();
    stream.connect();
    sockets[0]?.emit("open");
    sockets[0]?.emit("message", ORDER_UPDATE_EXAMPLE);
    sockets[0]?.emit("message", TRADE_EXAMPLE);
    expect(callbacks.onOrderUpdate).toHaveBeenCalledTimes(1);
    expect(callbacks.onTrade).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("keeps the fill when another update in the same batch does not parse (DEC-118)", () => {
    const { stream, sockets, callbacks } = setup();
    stream.connect();
    sockets[0]?.emit("open");
    // Lệnh stop của cả vị thế: không có price / quantity, loại lệnh lạ. Lệnh thoát khớp nằm cùng lô.
    sockets[0]?.emit(
      "message",
      `{"channel":"accountOrderUpdate","type":"update","data":[
{"E":1,"s":"BTC-USD","c":"stop-1","i":1,"S":"SELL","o":"STOP_MARKET","f":"IOC","p":"","q":"","X":"CANCELED","z":"0","v":"0"},
{"E":2,"s":"BTC-USD","c":"exit-1","i":2,"S":"SELL","o":"LIMIT","f":"GTX","p":"80462","q":"0.00014","X":"FILLED","z":"0.00014","v":"11.26468","T":2},
{"E":3,"s":"BTC-USD","i":"not-a-number","S":"SELL"}]}`,
    );
    const updates = callbacks.onOrderUpdate.mock.calls[0]?.[0] ?? [];
    expect(updates.map((u) => u.c)).toEqual(["stop-1", "exit-1"]);
    expect(updates[0]).toMatchObject({ p: "0", q: "0" });
    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(String(callbacks.onError.mock.calls[0]?.[0].message)).toMatch(
      /accountOrderUpdate did not match schema \(.*c:invalid_type/,
    );
  });

  it("reports a rejected subscription and a malformed push", () => {
    const { stream, sockets, callbacks } = setup();
    stream.connect();
    sockets[0]?.emit("open");
    sockets[0]?.emit("message", '{"channel":"accountTrade","type":"update","data":[{"S":"BUY"}]}');
    sockets[0]?.emit(
      "message",
      '{"op":"subscribe","id":1,"success":false,"error":"bad user","connID":"x"}',
    );
    expect(callbacks.onError).toHaveBeenCalledTimes(2);
    // Subscribe bị từ chối thì socket bị đóng để kết nối lại (tin sau đó trên socket cũ bị bỏ).
    expect(sockets[0]?.closed).toBe(true);
  });

  it("pings after idle and reconnects when no pong arrives", () => {
    const { stream, sockets, callbacks } = setup();
    stream.connect();
    const first = sockets[0];
    first?.emit("open");
    vi.advanceTimersByTime(1000);
    expect(first?.sent.at(-1)).toBe('{"op":"ping"}');
    vi.advanceTimersByTime(1000);
    expect(first?.closed).toBe(true);

    vi.advanceTimersByTime(2000); // backoff lần đầu: 1 s + jitter ≤ 25%
    const second = sockets[1];
    expect(second).toBeDefined();
    expect(callbacks.onReconnect).not.toHaveBeenCalled();
    second?.emit("open");
    expect(callbacks.onReconnect).toHaveBeenCalledTimes(1);
    expect(second?.sent).toHaveLength(2);
  });

  it("keeps the connection when a pong arrives", () => {
    const { stream, sockets } = setup();
    stream.connect();
    sockets[0]?.emit("open");
    vi.advanceTimersByTime(1000);
    sockets[0]?.emit("message", '{"op":"pong"}');
    vi.advanceTimersByTime(1500);
    expect(sockets[0]?.closed).toBe(false);
    expect(sockets).toHaveLength(1);
  });

  it("is subscribed only after SoDEX acks both channels, on the first connect too, and not after a drop", () => {
    const { stream, sockets, callbacks } = setup();
    stream.connect();
    const first = sockets[0];
    first?.emit("open");
    expect(stream.subscribed).toBe(false);
    first?.emit("message", '{"op":"subscribe","id":1,"success":true}');
    expect(stream.subscribed).toBe(false);
    expect(callbacks.onSubscribed).not.toHaveBeenCalled();
    first?.emit("message", '{"op":"subscribe","id":2,"success":true}');
    expect(stream.subscribed).toBe(true);
    expect(callbacks.onSubscribed).toHaveBeenCalledTimes(1);
    expect(callbacks.onReconnect).not.toHaveBeenCalled();

    first?.emit("close");
    expect(stream.subscribed).toBe(false);
    vi.advanceTimersByTime(2000);
    const second = sockets[1];
    second?.emit("open");
    second?.emit("message", '{"op":"subscribe","id":1,"success":false,"error":"user not found"}');
    // Subscribe bị từ chối: không ở lại nửa vời, đóng và kết nối lại theo backoff (B1).
    expect(second?.closed).toBe(true);
    expect(callbacks.onError).toHaveBeenCalled();
    expect(stream.subscribed).toBe(false);
    expect(callbacks.onSubscribed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(sockets).toHaveLength(2); // backoff tăng dần (không về 0 khi chỉ mới mở socket)
    vi.advanceTimersByTime(2000);
    const third = sockets[2];
    expect(third).toBeDefined();
    third?.emit("open");
    third?.emit("message", '{"op":"subscribe","id":1,"success":true}');
    third?.emit("message", '{"op":"subscribe","id":2,"success":true}');
    expect(stream.subscribed).toBe(true);
    expect(callbacks.onSubscribed).toHaveBeenCalledTimes(2);
  });

  it("does not reconnect after close()", () => {
    const { stream, sockets } = setup();
    stream.connect();
    sockets[0]?.emit("open");
    stream.close();
    sockets[0]?.emit("close");
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});

describe("WsUserStream · SoDEX Debugger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("records open, subscribe acks, account pushes and closes, but not pong", () => {
    const captures: SodexWsCapture[] = [];
    const { stream, sockets } = setup({
      accountID: 20417n,
      recorder: {
        record: (c) => {
          if (c.kind === "ws") captures.push(c);
        },
      },
    });
    stream.connect();
    const ws = sockets[0];
    if (ws === undefined) throw new Error("no socket");
    ws.emit("open");
    vi.advanceTimersByTime(40);
    ws.emit("message", '{"op":"subscribe","id":1,"success":true}');
    ws.emit("message", '{"op":"subscribe","id":2,"success":false,"error":"user not found"}');
    ws.emit("message", '{"op":"pong"}');
    ws.emit("message", ORDER_UPDATE_EXAMPLE);
    stream.close();

    expect(captures.map((c) => [c.event, c.channel, c.outcome])).toEqual([
      ["OPEN", null, "ok"],
      ["SUB", "accountOrderUpdate", "ok"],
      ["SUB", "accountTrade", "rejected"],
      ["CLOSE", null, "ok"],
      // Kết nối mới sau subscribe bị từ chối chưa mở; tin push của kết nối cũ không còn được xử lý.
    ]);
    const sub = captures[1];
    expect(sub?.latencyMs).toBeGreaterThanOrEqual(40);
    expect(sub?.request).toContain('"channel":"accountOrderUpdate"');
    expect(captures[2]?.detail).toBe("user not found");
    expect(new Set(captures.map((c) => c.connId)).size).toBe(1);
    expect(captures[0]?.connId).toMatch(/^ws-perps-[0-9a-f]{8}$/);
    expect(captures[0]?.sodexAccountId).toBe("20417");
  });

  it("records pushes and marks unreadable messages", () => {
    const captures: SodexWsCapture[] = [];
    const { stream, sockets } = setup({
      recorder: {
        record: (c) => {
          if (c.kind === "ws") captures.push(c);
        },
      },
    });
    stream.connect();
    const ws = sockets[0];
    if (ws === undefined) throw new Error("no socket");
    ws.emit("open");
    ws.emit("message", ORDER_UPDATE_EXAMPLE);
    ws.emit("message", TRADE_EXAMPLE);
    ws.emit("message", "not json");
    vi.advanceTimersByTime(2001); // không có pong → đóng vì idle
    expect(captures.map((c) => [c.event, c.channel, c.outcome])).toEqual([
      ["OPEN", null, "ok"],
      ["MSG", "accountOrderUpdate", "ok"],
      ["MSG", "accountTrade", "ok"],
      ["MSG", null, "unreadable"],
      ["CLOSE", null, "timeout"],
    ]);
    stream.close();
  });

  it("records the close code, reason, who closed and the reconnect delay (#240)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const captures: SodexWsCapture[] = [];
    const { stream, sockets } = setup({
      accountID: 47125n,
      recorder: {
        record: (c) => {
          if (c.kind === "ws") captures.push(c);
        },
      },
    });
    stream.connect();
    const first = sockets[0];
    if (first === undefined) throw new Error("no socket");
    first.emit("open");
    vi.advanceTimersByTime(300);
    first.emit("message", '{"op":"subscribe","id":1,"success":true}');
    vi.advanceTimersByTime(200);
    first.emitClose(1001, "going away", true);

    const close = captures.at(-1);
    expect(close?.event).toBe("CLOSE");
    expect(close?.outcome).toBe("network");
    expect(close?.detail).toBe(
      'closed by SoDEX (code 1001, reason "going away"): reconnecting in 1000 ms (attempt 1)',
    );
    expect(sodexWsCloseInfoSchema.parse(JSON.parse(close?.response ?? "null"))).toEqual({
      closedBy: "server",
      code: 1001,
      reason: "going away",
      wasClean: true,
      openForMs: 500,
      lastMessageAgoMs: 200,
      reconnectInMs: 1000,
      reconnectAttempt: 1,
    });

    // Kết nối kế tiếp mở đúng sau khoảng chờ đã ghi; đứt không có close frame (1006) → "network".
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    const second = sockets[1];
    if (second === undefined) throw new Error("no second socket");
    second.emit("open");
    second.emitClose(1006, "", false);
    const dropped = sodexWsCloseInfoSchema.parse(JSON.parse(captures.at(-1)?.response ?? "null"));
    expect(dropped).toMatchObject({
      closedBy: "network",
      code: 1006,
      reason: null,
      wasClean: false,
      lastMessageAgoMs: null,
      reconnectInMs: 2000,
      reconnectAttempt: 2,
    });
    expect(captures.at(-1)?.detail).toBe(
      "connection dropped without a close frame (code 1006): reconnecting in 2000 ms (attempt 2)",
    );
    expect(captures.at(-1)?.connId).toBe(
      captures.find((c) => c.event === "OPEN" && c.connId !== close?.connId)?.connId,
    );
    stream.close();
  });

  it("records a pong timeout, an error and DeskLabs' own close with who closed (#240)", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const captures: SodexWsCapture[] = [];
    const { stream, sockets } = setup({
      recorder: {
        record: (c) => {
          if (c.kind === "ws") captures.push(c);
        },
      },
    });
    const closeInfo = (c: SodexWsCapture | undefined) =>
      sodexWsCloseInfoSchema.parse(JSON.parse(c?.response ?? "null"));
    stream.connect();
    sockets[0]?.emit("open");
    vi.advanceTimersByTime(2001); // ping không có pong
    expect(captures.at(-1)?.outcome).toBe("timeout");
    expect(closeInfo(captures.at(-1))).toMatchObject({
      closedBy: "timeout",
      code: null,
      reconnectInMs: 1000,
      reconnectAttempt: 1,
    });
    expect(captures.at(-1)?.detail).toBe("no pong from SoDEX: reconnecting in 1000 ms (attempt 1)");

    vi.advanceTimersByTime(1000);
    sockets[1]?.emit("open");
    sockets[1]?.emit("error");
    expect(captures.slice(-2).map((c) => [c.event, c.outcome])).toEqual([
      ["ERROR", "network"],
      ["CLOSE", "network"],
    ]);
    expect(closeInfo(captures.at(-1))).toMatchObject({ closedBy: "network", reconnectAttempt: 2 });

    vi.advanceTimersByTime(2000);
    sockets[2]?.emit("open");
    stream.close();
    expect(captures.at(-1)?.event).toBe("CLOSE");
    expect(captures.at(-1)?.detail).toBe("closed by DeskLabs");
    expect(closeInfo(captures.at(-1))).toMatchObject({
      closedBy: "client",
      code: null,
      reconnectInMs: null,
      reconnectAttempt: null,
    });
  });

  it("keeps a long close reason short and never fails the stream when it is odd (#240)", () => {
    const captures: SodexWsCapture[] = [];
    const { stream, sockets } = setup({
      recorder: {
        record: (c) => {
          if (c.kind === "ws") captures.push(c);
        },
      },
    });
    stream.connect();
    sockets[0]?.emit("open");
    sockets[0]?.emitClose(4000, "x".repeat(1000), true);
    expect(closeInfo(captures.at(-1)).reason).toHaveLength(256);
    // Socket không đưa code (kiểu lạ): vẫn ghi, code null.
    vi.advanceTimersByTime(2000);
    sockets[1]?.emit("open");
    sockets[1]?.emit("close");
    expect(closeInfo(captures.at(-1))).toMatchObject({ closedBy: "server", code: null });
    expect(sockets).toHaveLength(2);
    stream.close();

    function closeInfo(c: SodexWsCapture | undefined) {
      return sodexWsCloseInfoSchema.parse(JSON.parse(c?.response ?? "null"));
    }
  });
});
