import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseOrderUpdates, parseTrades } from "../ws/schemas";
import { WsUserStream, type WebSocketLike, type WsUserStreamCallbacks } from "../ws/user-stream";

const USER = "0xed3e79ef16a7890e6eaef2aa6373b6bec5d59d5c";

// Ví dụ lấy nguyên văn từ account-order-updates.md và account-trades.md.
const ORDER_UPDATE_EXAMPLE = `{"channel":"accountOrderUpdate","type":"update","data":[
{"E":1766849004730,"s":"vBTC_vUSDC","c":"MAKER-ADJUST-0-70399739516726","i":58119,"S":"SELL","o":"LIMIT","f":"GTC","p":"102650","q":"0.36734","X":"NEW","z":"0","v":"0","M":"0.36734","T":1766848473207,"x":"REPLACED"},
{"E":1766849004730,"s":"vBTC_vUSDC","c":"MAKER-ADJUST-0-34207928167487","i":58117,"S":"SELL","o":"LIMIT","f":"GTC","p":"102514","q":"0.69346","X":"PARTIALLY_FILLED","z":"0.00043","v":"44.08102","M":"0.69303","T":1766848473207,"t":6860,"l":"0.00021","L":"102514","n":"0","m":true,"x":"PARTIALLY_FILLED"}]}`;

const TRADE_EXAMPLE = `{"channel":"accountTrade","type":"update","data":[
{"E":1766848149693,"T":1766847863273,"t":6275,"s":"vETH_vUSDC","i":51101,"c":"MAKER-ADJUST-1-51126829939055","S":"BUY","p":"3511.6","q":"0.0268","f":"0","m":true}]}`;

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

function setup(options: { accountID?: bigint; symbols?: string[] } = {}) {
  const sockets: FakeSocket[] = [];
  const callbacks = {
    onOrderUpdate: vi.fn<WsUserStreamCallbacks["onOrderUpdate"]>(),
    onTrade: vi.fn<WsUserStreamCallbacks["onTrade"]>(),
    onReconnect: vi.fn<WsUserStreamCallbacks["onReconnect"]>(),
    onError: vi.fn<WsUserStreamCallbacks["onError"]>(),
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

  it("reports a rejected subscription and a malformed push", () => {
    const { stream, sockets, callbacks } = setup();
    stream.connect();
    sockets[0]?.emit("open");
    sockets[0]?.emit(
      "message",
      '{"op":"subscribe","id":1,"success":false,"error":"bad user","connID":"x"}',
    );
    sockets[0]?.emit("message", '{"channel":"accountTrade","type":"update","data":[{"S":"BUY"}]}');
    expect(callbacks.onError).toHaveBeenCalledTimes(2);
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
