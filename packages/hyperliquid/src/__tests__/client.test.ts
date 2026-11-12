import { MemoryRateLimitStore, type WebSocketLike } from "@drift/sodex";
import { describe, expect, it } from "vitest";

import {
  HL_PAGE,
  HlUserFillsStream,
  HyperliquidClient,
  HyperliquidError,
  toLeaderFill,
  type HlFill,
} from "..";

const fillRow = (time: number, extra: Partial<Record<string, unknown>> = {}) => ({
  coin: "BTC",
  px: "100.0",
  sz: "1.0",
  side: "B",
  time,
  startPosition: "-0.0",
  dir: "Open Long",
  closedPnl: "0.0",
  hash: "0x1",
  oid: 1,
  crossed: true,
  fee: "0.1",
  feeToken: "USDC",
  tid: time,
  ...extra,
});

/** Fetch giả: trả theo `type` của body; ghi lại body đã gửi. */
function fakeFetch(handler: (body: Record<string, unknown>) => unknown, status = 200) {
  const sent: Record<string, unknown>[] = [];
  const f = ((_url: string | URL | Request, init?: RequestInit) => {
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body = JSON.parse(raw) as Record<string, unknown>;
    sent.push(body);
    return Promise.resolve(new Response(JSON.stringify(handler(body)), { status }));
  }) as typeof fetch;
  return { f, sent };
}

function client(handler: (body: Record<string, unknown>) => unknown, status = 200) {
  let now = 0;
  const slept: number[] = [];
  const limiter = new MemoryRateLimitStore(() => now);
  const { f, sent } = fakeFetch(handler, status);
  const c = new HyperliquidClient({
    limiter,
    bucketKey: "hl:ip:test",
    fetch: f,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  });
  return { c, sent, slept, limiter, advance: (ms: number) => (now += ms) };
}

describe("HyperliquidClient", () => {
  it("pages fills from startTime until a short page, normalising -0.0", async () => {
    const pages = [
      Array.from({ length: HL_PAGE.fills }, (_, i) => fillRow(1000 + i)),
      [fillRow(5000)],
    ];
    const { c, sent } = client(() => pages.shift() ?? []);
    const r = await c.fillsSince("0xabc", 1000, 10_000, "background");
    expect(r.capped).toBe(false);
    expect(r.fills).toHaveLength(HL_PAGE.fills + 1);
    expect(r.fills[0]?.startPosition).toBe("0");
    expect(sent.map((b) => b.startTime)).toEqual([1000, 1000 + HL_PAGE.fills]);
  });

  it("stops at the fill cap and reports capped history", async () => {
    let t = 0;
    const { c } = client(() => Array.from({ length: HL_PAGE.fills }, () => fillRow((t += 1))));
    const r = await c.fillsSince("0xabc", 0, 3000, "background");
    expect(r).toMatchObject({ capped: true });
    expect(r.fills).toHaveLength(3000);
  });

  it("charges the per-item weight and waits when the shared bucket is empty", async () => {
    // Một trang 2.000 dòng = 20 + 100 weight; 11 trang = 1.320 > 1.200 → phải chờ.
    const { c, slept } = client(() => Array.from({ length: HL_PAGE.fills }, (_, i) => fillRow(i)));
    for (let i = 0; i < 11; i += 1) await c.userFillsByTime("0xabc", 0, "realtime");
    expect(slept.length).toBeGreaterThan(0);
  });

  it("keeps a reserve for realtime calls when running in the background", async () => {
    const { c, slept } = client(() => ({ role: "user" }));
    // 12 × 60 = 720 > 1.200 − 500 dự trữ → job nền phải chờ.
    for (let i = 0; i < 12; i += 1) await c.isVault("0xabc", "background");
    expect(slept.length).toBeGreaterThan(0);
  });

  it("detects vaults from userRole", async () => {
    const { c } = client(() => ({ role: "vault" }));
    expect(await c.isVault("0xabc", "realtime")).toBe(true);
  });

  it("throws a typed error on HTTP errors and schema mismatches", async () => {
    await expect(
      client(() => ({}), 429).c.clearinghouseState("0xabc", "realtime"),
    ).rejects.toMatchObject({
      status: 429,
    });
    await expect(
      client(() => ({ nope: 1 })).c.clearinghouseState("0xabc", "realtime"),
    ).rejects.toBeInstanceOf(HyperliquidError);
  });

  it("skips leaderboard rows that don't match instead of failing the list", async () => {
    const { c } = client(() => ({
      leaderboardRows: [
        {
          ethAddress: "0x1",
          accountValue: "10",
          displayName: null,
          windowPerformances: [["month", { pnl: "5", roi: "0.1", vlm: "9" }]],
        },
        { ethAddress: "0x2" },
      ],
    }));
    const rows = await c.leaderboard();
    expect(rows.map((r) => r.ethAddress)).toEqual(["0x1"]);
  });
});

describe("toLeaderFill", () => {
  const base = fillRow(1) as unknown as HlFill;
  it("flags only the wallet's own liquidation", () => {
    const own = { ...base, liquidation: { liquidatedUser: "0xABC" } };
    const other = { ...base, liquidation: { liquidatedUser: "0xdef" } };
    expect(toLeaderFill(own, "0xabc").liquidatedSelf).toBe(true);
    expect(toLeaderFill(other, "0xabc").liquidatedSelf).toBe(false);
  });
  it("does not count non-USDC fees as USD", () => {
    expect(toLeaderFill({ ...base, feeToken: "HYPE" }, "0xabc").fee).toBe("0");
  });
});

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: unknown[] = [];
  #l = new Map<string, ((e: { data: unknown }) => void)[]>();
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
  }
  addEventListener(type: string, listener: (e: { data: unknown }) => void): void {
    this.#l.set(type, [...(this.#l.get(type) ?? []), listener]);
  }
  emit(type: string, data?: unknown): void {
    if (type === "open") this.readyState = 1;
    for (const l of this.#l.get(type) ?? []) l({ data });
  }
}

describe("HlUserFillsStream", () => {
  function stream() {
    const sockets: FakeSocket[] = [];
    const got: [string, number][] = [];
    const s = new HlUserFillsStream({
      callbacks: {
        onFills: (u, f) => got.push([u, f.length]),
        onReconnect: () => undefined,
        onError: () => undefined,
      },
      createSocket: () => {
        const ws = new FakeSocket();
        sockets.push(ws);
        return ws;
      },
    });
    return { s, sockets, got };
  }

  it("subscribes new wallets before unsubscribing removed ones", () => {
    const { s, sockets } = stream();
    s.setUsers(["0xA"]);
    const ws = sockets[0];
    ws?.emit("open");
    s.setUsers(["0xb"]);
    expect(ws?.sent).toEqual([
      { method: "subscribe", subscription: { type: "userFills", user: "0xa" } },
      { method: "subscribe", subscription: { type: "userFills", user: "0xb" } },
      { method: "unsubscribe", subscription: { type: "userFills", user: "0xa" } },
    ]);
    s.close();
  });

  it("ignores the snapshot and delivers new fills", () => {
    const { s, sockets, got } = stream();
    s.setUsers(["0xa"]);
    sockets[0]?.emit("open");
    const msg = (isSnapshot: boolean) =>
      JSON.stringify({
        channel: "userFills",
        data: { user: "0xA", isSnapshot, fills: [fillRow(1)] },
      });
    sockets[0]?.emit("message", msg(true));
    sockets[0]?.emit("message", msg(false));
    expect(got).toEqual([["0xa", 1]]);
    s.close();
  });

  it("refuses more wallets than one IP may watch", () => {
    const { s } = stream();
    expect(() => {
      s.setUsers(Array.from({ length: 11 }, (_, i) => `0x${String(i)}`));
    }).toThrow(RangeError);
  });
});
