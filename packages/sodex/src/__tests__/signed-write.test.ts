import { AppError } from "@drift/shared";
import { describe, expect, it, vi } from "vitest";

import { MemoryRateLimitStore } from "../rate-limit/token-bucket";
import type { FetchLike } from "../rest/client";
import {
  parseOrderResults,
  SignedWriteClient,
  type SignedWriteRequest,
} from "../rest/signed-write";

const REQUEST: SignedWriteRequest = {
  path: "/perps/trade/orders",
  method: "DELETE",
  body: '{"accountID":12345,"cancels":[{"clOrdID":"a1"}]}',
  signature: "0x01aa",
  nonce: 1760373925001n,
  apiKeyName: "DRIFT",
  orderCount: 1,
};

function client(fetchImpl: FetchLike, rateLimit = new MemoryRateLimitStore()) {
  return new SignedWriteClient({
    config: { restUrl: "https://mainnet-gw.sodex.dev" },
    rateLimit,
    egressKey: "test",
    fetch: fetchImpl,
  });
}

function respond(body: string, status = 200): FetchLike {
  return vi.fn(() => Promise.resolve(new Response(body, { status })));
}

describe("SignedWriteClient", () => {
  it("sends headers and the body, also for DELETE", async () => {
    const fetchImpl = respond(
      '{"code":0,"timestamp":1,"data":[{"code":0,"clOrdID":"a1","orderID":7}]}',
    );
    const result = await client(fetchImpl).write(REQUEST);
    expect(result.outcome).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://mainnet-gw.sodex.dev/api/v1/perps/trade/orders",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "X-API-Sign": "0x01aa",
          "X-API-Nonce": "1760373925001",
          "X-API-Key": "DRIFT",
        },
        body: REQUEST.body,
        signal: expect.any(AbortSignal) as AbortSignal,
      },
    );
  });

  it("omits X-API-Key for master-wallet writes and adds X-API-Chain for universal actions", async () => {
    const fetchImpl = respond('{"code":0,"timestamp":1,"data":null}');
    const { path, body, signature, nonce } = REQUEST;
    await client(fetchImpl).write({
      path,
      body,
      signature,
      nonce,
      method: "POST",
      chainId: 286623n,
    });
    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect(init?.headers).not.toHaveProperty("X-API-Key");
    expect(init?.headers).toHaveProperty("X-API-Chain", "286623");
  });

  it("returns rejected for a SoDEX error envelope", async () => {
    const result = await client(
      respond('{"code":-1,"error":"invalid nonce","timestamp":1}', 400),
    ).write(REQUEST);
    expect(result).toEqual({
      outcome: "rejected",
      status: 400,
      sodexCode: -1,
      sodexError: "invalid nonce",
    });
  });

  it.each([
    ["network error", vi.fn(() => Promise.reject(new TypeError("fetch failed")))],
    ["timeout", vi.fn(() => Promise.reject(new DOMException("timeout", "TimeoutError")))],
    ["HTTP 502", respond('{"code":-1,"error":"bad gateway"}', 502)],
    ["non-JSON body", respond("<html>", 200)],
    ["4xx without envelope", respond("<html>", 403)],
  ] as [string, FetchLike][])(
    "returns unknown on %s and never retries",
    async (_name, fetchImpl) => {
      const result = await client(fetchImpl).write(REQUEST);
      expect(result).toEqual({ outcome: "unknown" });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("throws RATE_LIMITED before sending when the key bucket is empty", async () => {
    const fetchImpl = respond('{"code":0,"timestamp":1,"data":[]}');
    const sodex = client(fetchImpl, new MemoryRateLimitStore(() => 0));
    await sodex.write({ ...REQUEST, orderCount: 20 });
    await expect(sodex.write(REQUEST)).rejects.toBeInstanceOf(AppError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a batch larger than the per-second key limit (engine must split it)", async () => {
    await expect(
      client(respond("{}")).write({ ...REQUEST, orderCount: 21 }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("parseOrderResults", () => {
  it("keeps uint64 order ids and per-order errors", () => {
    expect(
      parseOrderResults([
        { code: 0, clOrdID: "a1", orderID: 18446744073709551615n },
        { code: -3, clOrdID: "a2", error: "insufficient margin" },
      ]),
    ).toEqual([
      { code: 0, clOrdID: "a1", orderID: 18446744073709551615n },
      { code: -3, clOrdID: "a2", error: "insufficient margin" },
    ]);
  });
});
