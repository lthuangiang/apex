import { readdirSync, readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { MemoryRateLimitStore, type RateLimitStore } from "../rate-limit/token-bucket";
import * as clientModule from "../rewards/read-client";
import {
  REWARDS_READ_ENDPOINTS,
  RewardsReadClient,
  type RewardsFetch,
} from "../rewards/read-client";

// #558 PR2 (DEC-398): client chỉ đọc của Rewards API phía server. JWT rewards một mình đủ để claim, nên client chỉ có
// danh sách cho phép các đường dẫn đọc, luôn GET, không body. Token mẫu là chuỗi giả, không phải JWT thật.

const TOKEN = "aaaa.bbbb.cccc";
const ORIGIN = "https://mainnet-gw.sodex.dev";
const BUCKET = { capacity: 1200, refill: 1200, intervalMs: 60_000 };

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(respond: (url: URL) => Response = () => okJson({})) {
  const calls: Call[] = [];
  const fn: RewardsFetch = (input, init) => {
    calls.push({ url: input, init });
    return Promise.resolve(respond(new URL(input)));
  };
  return { fn, calls };
}

function okJson(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TREASURES = { total: 3, maxPerOpen: 100, lifetime: { granted: 10, opened: 7 } };
const LEDGER = {
  total: 1,
  items: [
    {
      kind: "transfer",
      tsMs: 1795600000000,
      tokenId: 202044,
      level: "Common",
      direction: "in",
      reason: "lottery_prize",
      round: 10,
    },
  ],
};
const DRAW = { round: 10, status: "distributed", wins: 1, tickets: 27, entries: [] };
const SUMMARY = { totalPoints: 10, walletAddress: "0x0000000000000000000000000000000000000001" };

function client(
  fetchFn: RewardsFetch,
  extra: { rateLimit?: RateLimitStore; maxWeightPerMinute?: number } = {},
) {
  return new RewardsReadClient({
    rateLimit: extra.rateLimit ?? new MemoryRateLimitStore(),
    egressKey: "test",
    ipBucket: BUCKET,
    maxWeightPerMinute: extra.maxWeightPerMinute,
    fetch: fetchFn,
  });
}

const FORBIDDEN = ["treasure/open", "box/open", "box/merge", "sign-params"];

describe("RewardsReadClient allowlist", () => {
  it("only lists read paths", () => {
    const paths = Object.values(REWARDS_READ_ENDPOINTS).map((e) => e.path);
    expect(paths).toEqual([
      "lottery/treasures",
      "lottery/ledger",
      "lottery/draw/entries",
      "sopoints/summary",
    ]);
    for (const p of paths) for (const f of FORBIDDEN) expect(p).not.toContain(f);
  });

  it("exports no generic request helper", () => {
    expect(Object.keys(clientModule).sort()).toEqual(
      [
        "REWARDS_IDLE_RESERVE",
        "REWARDS_READ_ENDPOINTS",
        "REWARDS_READ_MAX_BODY",
        "REWARDS_READ_TIMEOUT_MS",
        "RewardsReadClient",
        "rewardsLedgerReadSchema",
      ].sort(),
    );
    const methods = Object.getOwnPropertyNames(RewardsReadClient.prototype).filter(
      (m) => m !== "constructor",
    );
    expect(methods.sort()).toEqual(
      ["getDrawEntries", "getLedger", "getSopointsSummary", "getTreasures"].sort(),
    );
  });

  it("sends every call as GET without a body, to the fixed gateway, on an allowed path", async () => {
    const f = fakeFetch((url) =>
      okJson(
        url.pathname.endsWith("treasures")
          ? TREASURES
          : url.pathname.endsWith("ledger")
            ? LEDGER
            : url.pathname.endsWith("entries")
              ? DRAW
              : SUMMARY,
      ),
    );
    const c = client(f.fn);
    expect((await c.getTreasures(TOKEN)).kind).toBe("ok");
    expect((await c.getLedger(TOKEN, { limit: 100, offset: 0 })).kind).toBe("ok");
    expect((await c.getDrawEntries(TOKEN, { round: 10 })).kind).toBe("ok");
    expect((await c.getSopointsSummary(TOKEN)).kind).toBe("ok");
    expect(f.calls).toHaveLength(4);
    const allowed = Object.values(REWARDS_READ_ENDPOINTS).map((e) => `/api/v1/${e.path}`);
    for (const { url, init } of f.calls) {
      expect(init.method).toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe("error");
      const u = new URL(url);
      expect(u.origin).toBe(ORIGIN);
      expect(allowed).toContain(u.pathname);
      expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    }
    expect(new URL(f.calls[1]?.url ?? "").search).toBe("?limit=100&offset=0");
    expect(new URL(f.calls[2]?.url ?? "").search).toBe("?round=10");
  });

  it("has no write path anywhere in the module source", () => {
    const dir = new URL("../rewards/", import.meta.url);
    for (const file of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
      const src = readFileSync(new URL(file, dir), "utf8");
      for (const f of FORBIDDEN) expect(src, `${file} mentions ${f}`).not.toContain(f);
      expect(src).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/);
    }
  });

  it("rejects unknown query keys and out-of-range values before sending", () => {
    const f = fakeFetch();
    const c = client(f.fn);
    // @ts-expect-error: chỉ limit / offset
    expect(() => c.getLedger(TOKEN, { type: "open" })).toThrow();
    expect(() => c.getLedger(TOKEN, { limit: 101 })).toThrow();
    expect(f.calls).toHaveLength(0);
  });

  it("refuses non-https gateways", () => {
    expect(
      () =>
        new RewardsReadClient({
          gateway: "http://mainnet-gw.sodex.dev",
          rateLimit: new MemoryRateLimitStore(),
          egressKey: "t",
          ipBucket: BUCKET,
        }),
    ).toThrow();
  });
});

describe("RewardsReadClient results", () => {
  it("does not send a token that is not JWT-shaped (no header injection)", async () => {
    const f = fakeFetch();
    expect((await client(f.fn).getTreasures("a.b.c\r\nX-Evil: 1")).kind).toBe("invalid_token");
    expect(f.calls).toHaveLength(0);
  });

  it("maps 401, 429 with and without retryAfter, other statuses", async () => {
    const r401 = await client(fakeFetch(() => new Response("{}", { status: 401 })).fn).getTreasures(
      TOKEN,
    );
    expect(r401).toEqual({ kind: "unauthorized" });
    const r429 = await client(
      fakeFetch(() => new Response(JSON.stringify({ data: { retryAfter: 42 } }), { status: 429 }))
        .fn,
    ).getTreasures(TOKEN);
    expect(r429).toEqual({ kind: "rate_limited", retryAfterMs: 42_000 });
    const r429b = await client(
      fakeFetch(() => new Response("busy", { status: 429 })).fn,
    ).getTreasures(TOKEN);
    expect(r429b).toEqual({ kind: "rate_limited", retryAfterMs: null });
    const r503 = await client(fakeFetch(() => new Response("x", { status: 503 })).fn).getTreasures(
      TOKEN,
    );
    expect(r503).toEqual({ kind: "error", code: "http_status", status: 503 });
  });

  it("maps business errors, bad JSON, schema mismatch and oversized bodies", async () => {
    const biz = await client(
      fakeFetch(() => new Response(JSON.stringify({ code: -1, msg: "nope" }))).fn,
    ).getTreasures(TOKEN);
    expect(biz).toEqual({ kind: "error", code: "business", businessCode: -1 });
    const bad = await client(fakeFetch(() => new Response("<html>")).fn).getTreasures(TOKEN);
    expect(bad).toEqual({ kind: "error", code: "invalid_json" });
    const schema = await client(fakeFetch(() => okJson({ total: "x" })).fn).getTreasures(TOKEN);
    expect(schema).toEqual({ kind: "error", code: "schema" });
    const big = await client(
      fakeFetch(() => new Response("x".repeat(256 * 1024 + 1))).fn,
    ).getTreasures(TOKEN);
    expect(big).toEqual({ kind: "error", code: "too_large" });
  });

  it("maps network errors and timeouts", async () => {
    const net = await client(() => Promise.reject(new TypeError("fetch failed"))).getTreasures(
      TOKEN,
    );
    expect(net).toEqual({ kind: "error", code: "network" });
    const err = new Error("timed out");
    err.name = "TimeoutError";
    const to = await client(() => Promise.reject(err)).getTreasures(TOKEN);
    expect(to).toEqual({ kind: "error", code: "timeout" });
  });
});

describe("RewardsReadClient rate limit (idle priority + own cap)", () => {
  it("charges the documented weight to the shared IP bucket and the rewards cap", async () => {
    const take = vi.fn<RateLimitStore["take"]>(() =>
      Promise.resolve({ allowed: true, state: { tokens: 0, updatedAt: 0 }, retryAfterMs: 0 }),
    );
    const c = client(fakeFetch(() => okJson(LEDGER)).fn, {
      rateLimit: { take },
      maxWeightPerMinute: 120,
    });
    await c.getLedger(TOKEN);
    expect(take).toHaveBeenCalledWith(
      "sodex:rewards:test",
      { capacity: 120, refill: 120, intervalMs: 60_000 },
      5,
    );
    expect(take).toHaveBeenCalledWith("sodex:ip:test", { ...BUCKET, reserve: 600 }, 5);
  });

  it("does not call SoDEX when the shared bucket is at or below 50%", async () => {
    const store = new MemoryRateLimitStore(() => 0);
    // Rút bucket IP xuống còn 600 (50%).
    await store.take("sodex:ip:test", BUCKET, 600);
    const f = fakeFetch(() => okJson(TREASURES));
    const r = await client(f.fn, { rateLimit: store }).getTreasures(TOKEN);
    expect(r.kind).toBe("budget");
    expect(f.calls).toHaveLength(0);
  });

  it("stops at the rewards cap", async () => {
    const store = new MemoryRateLimitStore(() => 0);
    const f = fakeFetch(() => okJson(LEDGER));
    const c = client(f.fn, { rateLimit: store, maxWeightPerMinute: 10 });
    expect((await c.getLedger(TOKEN)).kind).toBe("ok");
    expect((await c.getLedger(TOKEN)).kind).toBe("ok");
    expect((await c.getLedger(TOKEN)).kind).toBe("budget");
    expect(f.calls).toHaveLength(2);
  });
});
