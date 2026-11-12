import type { LeaderFillMessage } from "@drift/shared";
import { describe, expect, it } from "vitest";

import { CopyAllocator, type AllocatorBot } from "../copy-allocator";

const A = "0xaaa0000000000000000000000000000000000001";
const bot = (botId: string, extra: Record<string, unknown> = {}): AllocatorBot => ({
  botId,
  source: "hyperliquid",
  address: A,
  config: {
    markets: ["BTC-USD"],
    sizing: "fixed",
    fixedNotional: "1000",
    maxNotionalPerTrade: "1000",
    maxSlippagePct: "0.3",
    ...extra,
  },
});
const msg = (
  positionAfter: string,
  side: "buy" | "sell" = "buy",
  quantity = "1",
): LeaderFillMessage => ({
  source: "hyperliquid",
  address: A,
  market: "BTC-USD",
  side,
  price: "100",
  quantity,
  positionAfter,
  at: 0,
});
// Mid 100; asks 1.000 USD trong 0,3% → trần 500. Bids 10.000 USD.
const book = {
  bids: [["99.9", "100"]] as [string, string][],
  asks: [["100.1", "10"]] as [string, string][],
};

async function allocator(
  bots: AllocatorBot[],
  holds = new Map<string, number | null>(),
  fail = false,
) {
  const a = new CopyAllocator({
    bots: () => Promise.resolve(bots),
    holds: () => Promise.resolve(holds),
    orderbook: () => (fail ? Promise.reject(new Error("down")) : Promise.resolve(book)),
    warn: () => undefined,
  });
  await a.refresh();
  return a;
}

describe("CopyAllocator", () => {
  it("leaves cuts and closes untouched", async () => {
    const a = await allocator([bot("x")]);
    expect(await a.enrich(msg("0", "sell"))).toEqual(msg("0", "sell"));
  });

  it("splits half the opposite-side depth between bots that would take it", async () => {
    const a = await allocator([bot("x"), bot("y")]);
    const r = await a.enrich(msg("1"));
    expect(r.allowanceReason).toBe("liquidity");
    expect(r.allowances).toEqual({ x: "250.25", y: "250.25" });
  });

  it("allocates inverse bots against the other side of the book", async () => {
    const a = await allocator([bot("x"), bot("inv", { direction: "inverse" })]);
    const r = await a.enrich(msg("1"));
    // Follow ăn asks (trần 500); inverse bán vào bids (đủ sâu, không cắt).
    expect(r.allowances).toEqual({ x: "500.5", inv: "1000" });
  });

  it("adds no allowances when every copy fits", async () => {
    const a = await allocator([bot("x", { fixedNotional: "100", maxNotionalPerTrade: "100" })]);
    expect((await a.enrich(msg("1"))).allowances).toBeUndefined();
  });

  it("blocks opens for a trader whose typical hold fell under 15 minutes", async () => {
    const a = await allocator([bot("x")], new Map([[A, 5 * 60_000]]));
    expect(await a.enrich(msg("1"))).toMatchObject({
      allowances: { x: "0" },
      allowanceReason: "min_hold",
    });
  });

  it("gives zero when the order book can't be read", async () => {
    const a = await allocator([bot("x")], new Map(), true);
    expect((await a.enrich(msg("1"))).allowances).toEqual({ x: "0" });
  });
});
