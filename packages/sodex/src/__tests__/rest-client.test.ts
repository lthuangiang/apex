import { describe, expect, it, vi } from "vitest";

import { readDriftApproval } from "../approvals";
import { MemoryRateLimitStore } from "../rate-limit/token-bucket";
import { SodexRestClient, type FetchLike } from "../rest/client";
import { parseSodexJson } from "../rest/json";

const ADDRESS = "0x1563915e194D8CfBA1943570603F7606A3115508";

function client(fetchImpl: FetchLike, rateLimit = new MemoryRateLimitStore()) {
  return new SodexRestClient({
    config: { restUrl: "https://mainnet-gw.sodex.dev" },
    rateLimit,
    egressKey: "test",
    fetch: fetchImpl,
  });
}

function respond(body: string, status = 200): FetchLike {
  return vi.fn(() => Promise.resolve(new Response(body, { status })));
}

describe("parseSodexJson", () => {
  it("keeps uint64 ids exact", () => {
    const parsed = parseSodexJson('{"a":18446744073709551615,"b":12,"c":"1.50"}');
    expect(parsed).toEqual({ a: 18446744073709551615n, b: 12, c: "1.50" });
  });
});

describe("SodexRestClient", () => {
  it("reads subaccounts from the success envelope", async () => {
    const fetchImpl = respond(
      '{"code":0,"timestamp":1,"data":{"userID":5,"primaryAccountID":1010,"subaccounts":[]}}',
    );
    const result = await client(fetchImpl).getSubaccounts(ADDRESS);
    expect(result.primaryAccountID).toBe(1010n);
    expect(fetchImpl).toHaveBeenCalledWith(
      `https://mainnet-gw.sodex.dev/api/v1/user/${ADDRESS}/subaccounts`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps SoDEX error envelopes to SODEX_UNAVAILABLE with the SoDEX code", async () => {
    const promise = client(
      respond('{"code":-1,"error":"nonce is invalid","timestamp":1}', 400),
    ).getSubaccounts(ADDRESS);
    await expect(promise).rejects.toMatchObject({
      code: "SODEX_UNAVAILABLE",
      details: { sodexCode: -1, sodexError: "nonce is invalid" },
    });
  });

  it("maps timeouts to SODEX_TIMEOUT", async () => {
    const fetchImpl: FetchLike = () =>
      Promise.reject(new DOMException("The operation timed out.", "TimeoutError"));
    await expect(client(fetchImpl).getSubaccounts(ADDRESS)).rejects.toMatchObject({
      code: "SODEX_TIMEOUT",
    });
  });

  it("rejects responses that do not match the schema instead of guessing", async () => {
    const promise = client(
      respond('{"code":0,"timestamp":1,"data":{"userID":"x"}}'),
    ).getSubaccounts(ADDRESS);
    await expect(promise).rejects.toMatchObject({ code: "SODEX_UNAVAILABLE" });
  });

  it("stops before calling SoDEX when the IP budget is spent", async () => {
    const fetchImpl = respond('{"code":0,"timestamp":1,"data":[]}');
    const store = new MemoryRateLimitStore(() => 0);
    const sodex = client(fetchImpl, store);
    await store.take("sodex:ip:test", { capacity: 1200, refill: 1200, intervalMs: 60_000 }, 1200);
    await expect(sodex.getApiKeys(ADDRESS, 1n)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads a CROSS position that has no `iw` field (mainnet shape)", async () => {
    const position = {
      i: 32065154,
      s: "BTC-USD",
      m: "CROSS",
      ps: "BOTH",
      sz: "-0.0012",
      ep: "80676",
      ur: "-0.02214",
      l: 40,
      lp: "100118.6825513646732629",
    };
    const fetchImpl = respond(
      JSON.stringify({
        code: 0,
        timestamp: 1,
        data: { av: "45", am: "40", im: "2.4", cm: "0", B: null, P: [position] },
      }),
    );
    const state = await client(fetchImpl).getPerpsAccountState(ADDRESS);
    expect(state.P[0]).toMatchObject({ s: "BTC-USD", m: "CROSS", iw: null, sz: "-0.0012" });
  });

  it("caches market info", async () => {
    const symbol = {
      id: 1,
      name: "BTC-USD",
      pricePrecision: 1,
      tickSize: "0.1",
      minPrice: "0",
      maxPrice: "0",
      quantityPrecision: 3,
      stepSize: "0.001",
      minQuantity: "0.001",
      maxQuantity: "0",
      marketMinQuantity: "0.001",
      marketMaxQuantity: "0",
      minNotional: "10",
      maxNotional: "0",
      status: "TRADING",
      maxLeverage: 50,
      fundingInterval: 28800,
    };
    const fetchImpl = respond(JSON.stringify({ code: 0, timestamp: 1, data: [symbol] }));
    const sodex = client(fetchImpl);
    const [first] = await sodex.getPerpsSymbols();
    await sodex.getPerpsSymbols();
    expect(first?.id).toBe(1n);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

describe("readDriftApproval", () => {
  it("is approved only when both engines are at 50 for the DRIFT builder", () => {
    const approvals = {
      spot: [{ builderID: 7n, feeRate: 50 }],
      perps: [
        { builderID: 7n, feeRate: 50 },
        { builderID: 8n, feeRate: 10 },
      ],
    };
    expect(readDriftApproval(approvals, 7n)).toEqual({ spot: 50, perps: 50, approved: true });
  });

  it("treats revoked (0) or missing approvals as not approved", () => {
    expect(readDriftApproval({ spot: [{ builderID: 7n, feeRate: 0 }], perps: [] }, 7n)).toEqual({
      spot: 0,
      perps: null,
      approved: false,
    });
  });
});
