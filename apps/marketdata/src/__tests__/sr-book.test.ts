import { describe, expect, it } from "vitest";

import { srBookResponder } from "../sr-book";

// #507: sổ REST một lần cho lane research qua NATS request (lane không gọi SoDEX, DEC-322).

const req = (market: string) => JSON.stringify({ market });

describe("sr.book.request responder", () => {
  it("answers the best bid / ask of a tradable perps market", async () => {
    const r = srBookResponder({
      orderbook: () =>
        Promise.resolve({
          bids: [
            ["100.1", "2"],
            ["100", "5"],
          ],
          asks: [
            ["100.3", "1"],
            ["100.5", "4"],
          ],
        }),
      tradable: (m) => m === "TRX-USD",
      now: () => 1_000,
    });
    expect(await r(req("TRX-USD"))).toEqual({
      ok: true,
      s: "TRX-USD",
      b: "100.1",
      a: "100.3",
      at: 1_000,
    });
  });

  it("never reads SoDEX for an unknown market or a bad request", async () => {
    let reads = 0;
    const r = srBookResponder({
      orderbook: () => {
        reads += 1;
        return Promise.resolve({ bids: [], asks: [] });
      },
      tradable: () => false,
      now: () => 1,
    });
    expect(await r(req("NOPE-USD"))).toEqual({ ok: false, reason: "unknown_market" });
    expect(await r("not json")).toEqual({ ok: false, reason: "unknown_market" });
    expect(await r(JSON.stringify({ market: "trx usd" }))).toEqual({
      ok: false,
      reason: "unknown_market",
    });
    expect(reads).toBe(0);
  });

  it("an empty side is empty, a SoDEX error is error and is not cached", async () => {
    let fail = true;
    let reads = 0;
    const r = srBookResponder({
      orderbook: () => {
        reads += 1;
        return fail
          ? Promise.reject(new Error("RATE_LIMITED"))
          : Promise.resolve({ bids: [["1", "1"]], asks: [] });
      },
      tradable: () => true,
      now: () => 5,
    });
    expect(await r(req("MON-USD"))).toEqual({ ok: false, reason: "error" });
    fail = false;
    expect(await r(req("MON-USD"))).toEqual({ ok: false, reason: "empty" });
    expect(reads).toBe(2);
  });

  it("requests within the cache window share one read", async () => {
    let reads = 0;
    let now = 0;
    const r = srBookResponder({
      orderbook: () => {
        reads += 1;
        return Promise.resolve({ bids: [["1", "1"]], asks: [["2", "1"]] });
      },
      tradable: () => true,
      now: () => now,
      cacheMs: 2_000,
    });
    await Promise.all([r(req("SPCX-USD")), r(req("SPCX-USD"))]);
    now = 1_999;
    await r(req("SPCX-USD"));
    expect(reads).toBe(1);
    now = 2_000;
    await r(req("SPCX-USD"));
    expect(reads).toBe(2);
  });
});
