import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { MemoryRateLimitStore, type RateLimitStore } from "../rate-limit/token-bucket";
import * as clientModule from "../wealth/read-client";
import {
  WEALTH_READ_ENDPOINTS,
  WEALTH_READ_MAX_BODY,
  WEALTH_READ_WEIGHT,
  WealthReadClient,
  type WealthFetch,
} from "../wealth/read-client";

// #589 (DEC-402 mục 2): client chỉ đọc của SoDEX Wealth API công khai. Chỉ GET các route trong danh sách, không token,
// không body. Địa chỉ dưới đây là địa chỉ giả.

const WALLET = "0x1111111111111111111111111111111111111111";
const BUCKET = { capacity: 1200, refill: 1200, intervalMs: 60_000 };

interface Call {
  url: string;
  init: RequestInit;
}

function okJson(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, timestamp: 1, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(respond: (url: URL) => Response | Promise<Response> = () => okJson({})) {
  const calls: Call[] = [];
  const fn: WealthFetch = async (input, init) => {
    calls.push({ url: input, init });
    return respond(new URL(input));
  };
  return { fn, calls };
}

function client(
  fetchFn: WealthFetch,
  extra: { rateLimit?: RateLimitStore; maxWeightPerMinute?: number; timeoutMs?: number } = {},
) {
  return new WealthReadClient({
    rateLimit: extra.rateLimit ?? new MemoryRateLimitStore(),
    egressKey: "test",
    ipBucket: BUCKET,
    maxWeightPerMinute: extra.maxWeightPerMinute,
    fetch: fetchFn,
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
  });
}

const FUNDS = [
  { fundId: "CXMT", name: "CXMT", fundType: "escrow_vault", fundStatus: "live", nav: "4.93" },
];
const PNL = {
  address: WALLET,
  currency: "USD",
  settledValue: "0",
  totalCost: "0",
  totalPnl: "0",
  totalRealizedPnl: "0",
  totalUnrealizedPnl: "0",
  totalPnl24h: "0",
  inFlightValue: "0",
  totalValue: "0",
  complete: true,
  positions: [],
};

describe("WealthReadClient allowlist", () => {
  it("only lists read routes under /api/v1/wealth", () => {
    const paths = Object.values(WEALTH_READ_ENDPOINTS);
    expect(paths).toEqual([
      "funds",
      "funds/{f}",
      "funds/{f}/trading-status",
      "users/{a}/positions",
      "users/{a}/pnl",
      "users/{a}/in-flight",
      "users/{a}/fund-details",
      "users/{a}/recurring-buys",
      "users/{a}/recurring-buys/{p}/executions",
      "users/{a}/pnl-history",
      "users/{a}/tvl",
    ]);
    for (const p of paths) expect(p).not.toMatch(/rfq|quote|deposit|redeem|claim|withdraw/);
  });

  it("exposes no generic request method", () => {
    const proto = Object.getOwnPropertyNames(WealthReadClient.prototype);
    expect(proto.filter((n) => /request|post|put|delete|call|raw/i.test(n))).toEqual([]);
    expect(Object.keys(clientModule).sort()).toEqual(
      [
        "WEALTH_IDLE_RESERVE",
        "WEALTH_READ_ENDPOINTS",
        "WEALTH_READ_MAX_BODY",
        "WEALTH_READ_TIMEOUT_MS",
        "WEALTH_READ_WEIGHT",
        "WealthReadClient",
      ].sort(),
    );
    const src = readFileSync(new URL("../wealth/read-client.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
    expect(src).not.toMatch(/Authorization:|Bearer/);
  });

  it("every call is a GET with no body and no auth header, to the fixed host", async () => {
    const f = fakeFetch((url) => okJson(url.pathname.endsWith("/funds") ? FUNDS : PNL));
    const c = client(f.fn);
    await c.getFunds();
    await c.getPnl(WALLET.toUpperCase().replace("0X", "0x"));
    await c.getTradingStatus("CXMT");
    await c.getRecurringBuyExecutions(WALLET, "0");
    await c.getPnlHistory(WALLET, { interval: "1d", range: "1M" });
    for (const call of f.calls) {
      expect(call.init.method).toBe("GET");
      expect(call.init.body).toBeUndefined();
      expect(call.init.redirect).toBe("error");
      expect(JSON.stringify(call.init.headers)).not.toMatch(/authorization|cookie/i);
      expect(new URL(call.url).origin).toBe("https://mainnet-gw.sodex.dev");
      expect(new URL(call.url).pathname.startsWith("/api/v1/wealth/")).toBe(true);
    }
    expect(f.calls.map((x) => new URL(x.url).pathname + new URL(x.url).search)).toEqual([
      "/api/v1/wealth/funds",
      `/api/v1/wealth/users/${WALLET}/pnl`,
      "/api/v1/wealth/funds/CXMT/trading-status",
      `/api/v1/wealth/users/${WALLET}/recurring-buys/0/executions`,
      `/api/v1/wealth/users/${WALLET}/pnl-history?interval=1d&range=1M`,
    ]);
  });

  it("rejects path injection and bad params without sending anything", async () => {
    const f = fakeFetch();
    const c = client(f.fn);
    expect(await c.getPnl("0x123")).toEqual({ kind: "not_provided", reason: "invalid_param" });
    expect(await c.getFund("../rfq")).toMatchObject({ reason: "invalid_param" });
    expect(await c.getTradingStatus("CXMT/../../x")).toMatchObject({ reason: "invalid_param" });
    expect(await c.getRecurringBuyExecutions(WALLET, "0/../x")).toMatchObject({
      reason: "invalid_param",
    });
    expect(await c.getRecurringBuyExecutions(WALLET, "0", "nope")).toMatchObject({
      reason: "invalid_param",
    });
    expect(await c.getPnlHistory(WALLET, { range: "1D" as unknown as "1M" })).toMatchObject({
      reason: "invalid_param",
    });
    expect(f.calls).toHaveLength(0);
  });

  it("refuses a non-https gateway", () => {
    expect(
      () =>
        new WealthReadClient({
          gateway: "http://mainnet-gw.sodex.dev",
          rateLimit: new MemoryRateLimitStore(),
          egressKey: "t",
          ipBucket: BUCKET,
        }),
    ).toThrow(/https/);
  });
});

describe("WealthReadClient failures → not_provided", () => {
  it("parses ok data", async () => {
    const r = await client(fakeFetch(() => okJson(FUNDS)).fn).getFunds();
    expect(r).toMatchObject({ kind: "ok", data: [{ fundId: "CXMT", aum: null }] });
  });

  it("business error envelope (recurring-buys internal error)", async () => {
    const f = fakeFetch(
      () => new Response(JSON.stringify({ code: -1, timestamp: 1, error: "internal error" })),
    );
    expect(await client(f.fn).getRecurringBuys(WALLET)).toEqual({
      kind: "not_provided",
      reason: "business",
    });
    expect(new URL(f.calls[0]?.url ?? "").searchParams.get("status")).toBe("active");
  });

  it("HTTP status, invalid JSON, wrong shape", async () => {
    expect(
      await client(fakeFetch(() => new Response("404 page not found", { status: 404 })).fn).getTvl(
        WALLET,
      ),
    ).toEqual({ kind: "not_provided", reason: "http_status", status: 404 });
    expect(await client(fakeFetch(() => new Response("<html>")).fn).getFunds()).toMatchObject({
      reason: "invalid_json",
    });
    expect(
      await client(fakeFetch(() => okJson({ totalValue: "abc" })).fn).getPnl(WALLET),
    ).toMatchObject({ reason: "schema" });
    expect(await client(fakeFetch(() => okJson({ nope: 1 })).fn).getFunds()).toMatchObject({
      reason: "schema",
    });
  });

  it("network error and timeout", async () => {
    const boom = client(() => Promise.reject(new TypeError("fetch failed")));
    expect(await boom.getFunds()).toMatchObject({ reason: "network" });
    const slow = client(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason as Error);
          });
        }),
      { timeoutMs: 20 },
    );
    expect(await slow.getFunds()).toMatchObject({ reason: "timeout" });
  });

  it("body too large (declared or actual)", async () => {
    const big = "x".repeat(WEALTH_READ_MAX_BODY + 1);
    expect(await client(fakeFetch(() => new Response(big)).fn).getFunds()).toMatchObject({
      reason: "too_large",
    });
    const declared = fakeFetch(
      () => new Response("{}", { headers: { "content-length": String(WEALTH_READ_MAX_BODY + 1) } }),
    );
    expect(await client(declared.fn).getFunds()).toMatchObject({ reason: "too_large" });
  });

  it("shares the IP bucket with an idle reserve; own cap; nothing sent when out of budget", async () => {
    const store = new MemoryRateLimitStore();
    // Bucket IP chỉ còn đúng phần dự trữ 50%: Wealth không được lấy.
    await store.take("sodex:ip:test", BUCKET, 600);
    const f = fakeFetch(() => okJson(FUNDS));
    const out = await client(f.fn, { rateLimit: store }).getFunds();
    expect(out).toMatchObject({ kind: "not_provided", reason: "budget" });
    // Báo lại bao lâu nữa đủ token (api trả 429 kèm `retryAfterMs`, #592).
    expect(out.kind === "not_provided" ? out.retryAfterMs : undefined).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(0);

    const capped = client(f.fn, { maxWeightPerMinute: WEALTH_READ_WEIGHT });
    expect((await capped.getFunds()).kind).toBe("ok");
    const second = await capped.getFunds();
    expect(second).toMatchObject({ reason: "budget" });
    expect(second.kind === "not_provided" ? second.retryAfterMs : undefined).toBeGreaterThan(0);
    expect(f.calls).toHaveLength(1);
  });
});
