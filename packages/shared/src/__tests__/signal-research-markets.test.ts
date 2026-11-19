import { describe, expect, it } from "vitest";

import {
  parseSrMarkets,
  SR_MARKETS_STALE_MS,
  srMarketsSnapshot,
  srMarketsStale,
} from "../signal-research/markets";

// Bản chụp danh sách market SoDEX của Signal research (Redis `sr:markets`, #305 phương án (a)).

describe("sr:markets snapshot", () => {
  const at = new Date("2026-11-19T10:00:00Z");
  const snap = srMarketsSnapshot(
    [
      { name: "BTC-USD", status: "TRADING", baseCoin: "BTC" },
      { name: "KIOXIA-USD", status: "HALT", displayName: "Kioxia" },
    ],
    at,
  );

  it("round-trips and keeps the status", () => {
    expect(parseSrMarkets(JSON.stringify(snap))).toEqual({
      updatedAt: at.toISOString(),
      markets: [
        { name: "BTC-USD", baseCoin: "BTC", displayName: null, status: "TRADING" },
        { name: "KIOXIA-USD", baseCoin: null, displayName: "Kioxia", status: "HALT" },
      ],
    });
  });

  it("missing or broken values are null, never an empty list", () => {
    expect(parseSrMarkets(null)).toBeNull();
    expect(parseSrMarkets(undefined)).toBeNull();
    expect(parseSrMarkets("{oops")).toBeNull();
    expect(parseSrMarkets(JSON.stringify({ markets: [] }))).toBeNull();
  });

  it("is stale only when older than 15 minutes", () => {
    expect(SR_MARKETS_STALE_MS).toBe(15 * 60_000);
    expect(srMarketsStale(snap, new Date(at.getTime() + SR_MARKETS_STALE_MS))).toBe(false);
    expect(srMarketsStale(snap, new Date(at.getTime() + SR_MARKETS_STALE_MS + 1))).toBe(true);
  });
});
