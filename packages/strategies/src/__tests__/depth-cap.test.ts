import { describe, expect, it } from "vitest";

import {
  capEntryOrder,
  depthCapApplies,
  depthCapLabel,
  depthReducedWhy,
  depthWaitWhy,
  isEntryCandidate,
  maxPositionsOf,
  positionDepthIssue,
  raisedPositions,
} from "../common/depth-cap";
import type { BookTop, OrderIntent } from "../core/types";

// DEC-402 mục 5 (#590): giới hạn theo sổ lệnh 10 mức.

const rules = { tickSize: "0.01", stepSize: "0.01", minQuantity: "0.01", minNotional: "5" };
const book = (bidNotional: string, askNotional: string, bid = "99", ask = "100"): BookTop => ({
  bid,
  ask,
  bidNotional,
  askNotional,
});
const order = (o: Partial<OrderIntent> = {}): OrderIntent => ({
  clOrdID: "x",
  market: "ANT-USD",
  engine: "perps",
  side: "buy",
  type: "market",
  quantity: "10",
  timeInForce: "IOC",
  reduceOnly: false,
  tag: "dca:1:base",
  ...o,
});

describe("depth label", () => {
  it("is deep, thin, very thin or empty by the thinner side of the top 10 levels", () => {
    expect(depthCapLabel(book("50000", "10000"))).toBe("deep");
    expect(depthCapLabel(book("50000", "9999.99"))).toBe("thin");
    expect(depthCapLabel(book("999", "50000"))).toBe("very_thin");
    expect(depthCapLabel(book("0", "50000"))).toBe("empty");
    expect(depthCapLabel(null)).toBe("empty");
  });

  it("applies the caps only to thin, very thin and empty books", () => {
    expect(depthCapApplies("deep")).toBe(false);
    expect(depthCapApplies("thin")).toBe(true);
    expect(depthCapApplies("very_thin")).toBe(true);
    expect(depthCapApplies("empty")).toBe(true);
  });
});

describe("which orders the 25% rule looks at", () => {
  it("market and IOC entries", () => {
    expect(isEntryCandidate(order())).toBe(true);
    expect(isEntryCandidate(order({ type: "limit", price: "100", timeInForce: "IOC" }))).toBe(true);
  });

  it("never a resting maker order (grid, DCA safety)", () => {
    expect(isEntryCandidate(order({ type: "limit", price: "95", timeInForce: "GTC" }))).toBe(false);
    expect(isEntryCandidate(order({ type: "limit", price: "95", timeInForce: "GTX" }))).toBe(false);
  });

  it("never a close: reduce-only, stop loss, engine close, Spot sell", () => {
    expect(isEntryCandidate(order({ reduceOnly: true }))).toBe(false);
    expect(
      isEntryCandidate(order({ reduceOnly: true, tag: "vf:1:sl", stop: { price: "90" } })),
    ).toBe(false);
    expect(isEntryCandidate(order({ tag: "close" }))).toBe(false);
    expect(isEntryCandidate(order({ tag: "close:3" }))).toBe(false);
    expect(isEntryCandidate(order({ engine: "spot", side: "sell" }))).toBe(false);
    // Perps sell can open a short: still an entry candidate (the engine drops it if it only reduces).
    expect(isEntryCandidate(order({ side: "sell" }))).toBe(true);
  });
});

describe("cap for an entry that fills at once", () => {
  it("passes when the order is at most 25% of the side it takes", () => {
    // 25% of 4000 = 1000; 10 × 100 = 1000.
    expect(capEntryOrder(order(), book("9000", "4000"), rules)).toEqual({ kind: "pass" });
  });

  it("cuts a buy to 25% of the ask side, rounded down to the lot", () => {
    // 25% of 3000 = 750 → 7.5 at 100.
    const r = capEntryOrder(order(), book("9000", "3000"), rules);
    expect(r).toEqual({
      kind: "reduce",
      quantity: "7.5",
      from: "10",
      sideNotional: "3000",
      capNotional: "750",
    });
  });

  it("measures a sell against the bid side at the best bid", () => {
    // 25% of 2000 = 500 → 5.05 at 99 (rounded down from 5.0505…).
    const r = capEntryOrder(order({ side: "sell" }), book("2000", "9000"), rules);
    expect(r).toMatchObject({ kind: "reduce", quantity: "5.05", capNotional: "500" });
  });

  it("waits when the side it takes is empty", () => {
    expect(capEntryOrder(order(), book("9000", "0"), rules)).toMatchObject({
      kind: "wait",
      reason: "empty",
    });
    expect(capEntryOrder(order(), null, rules)).toMatchObject({ kind: "wait", reason: "empty" });
  });

  it("waits when the cap is below SoDEX's minimum order", () => {
    // 25% of 16 = 4 USD < minNotional 5.
    expect(capEntryOrder(order(), book("9000", "16"), rules)).toEqual({
      kind: "wait",
      reason: "below_min",
      sideNotional: "16",
      capNotional: "4",
    });
  });

  it("writes Decisions with the market, the old and the new size", () => {
    const r = capEntryOrder(order(), book("9000", "3000"), rules);
    if (r.kind !== "reduce") throw new Error("expected reduce");
    expect(depthReducedWhy("ANT-USD", "buy", r)).toBe(
      "ANT-USD: buy size cut from 10 to 7.5. An order that fills at once can take at most 25% of the top 10 ask levels (750 of 3000 USD).",
    );
    const empty = capEntryOrder(order({ side: "sell" }), book("0", "9000"), rules);
    if (empty.kind !== "wait") throw new Error("expected wait");
    expect(depthWaitWhy("ANT-USD", "sell", empty)).toBe(
      "ANT-USD: no bid orders in the order book. The bot won't open or add until there are. Closing orders still go.",
    );
    const thin = capEntryOrder(order(), book("9000", "16"), rules);
    if (thin.kind !== "wait") throw new Error("expected wait");
    expect(depthWaitWhy("ANT-USD", "buy", thin)).toContain("is 4 USD, below SoDEX's minimum order");
  });
});

describe("max position of a new bot", () => {
  it("is investment × leverage, or the sum of every DCA buy", () => {
    expect(
      maxPositionsOf("futures_grid", { market: "ANT-USD", margin: "100", leverage: 3 }),
    ).toEqual([{ market: "ANT-USD", engine: "perps", notional: "300" }]);
    expect(
      maxPositionsOf("spot_dca", {
        market: "vANT_vUSDC",
        baseOrder: "100",
        safetyOrder: "50",
        sizeMultiplier: "2",
        maxSafetyOrders: 2,
      }),
    ).toEqual([{ market: "vANT_vUSDC", engine: "spot", notional: "250" }]);
    expect(
      maxPositionsOf("futures_dca", {
        market: "ANT-USD",
        baseOrder: "100",
        safetyOrder: "50",
        sizeMultiplier: "1",
        maxSafetyOrders: 2,
        leverage: 2,
      }),
    ).toEqual([{ market: "ANT-USD", engine: "perps", notional: "400" }]);
  });

  it("splits Rebalancing by weight and Funding Arb by leg, and checks every copy market", () => {
    expect(
      maxPositionsOf("rebalancing", {
        investment: "1000",
        assets: [
          { asset: "vANT", market: "vANT_vUSDC", weightPct: 30 },
          { asset: "vUSDC", weightPct: 70 },
        ],
      }),
    ).toEqual([{ market: "vANT_vUSDC", engine: "spot", notional: "300" }]);
    expect(
      maxPositionsOf("funding_arb", {
        spotMarket: "vANT_vUSDC",
        perpMarket: "ANT-USD",
        investment: "1000",
      }),
    ).toEqual([
      { market: "vANT_vUSDC", engine: "spot", notional: "500" },
      { market: "ANT-USD", engine: "perps", notional: "500" },
    ]);
    expect(
      maxPositionsOf("copy_trade", { markets: ["ANT-USD", "BTC-USD"], maxExposure: "800" }),
    ).toEqual([
      { market: "ANT-USD", engine: "perps", notional: "800" },
      { market: "BTC-USD", engine: "perps", notional: "800" },
    ]);
  });

  it("prices TWAP in quote, and has no fixed market for news_signal", () => {
    expect(
      maxPositionsOf("twap", { market: "ANT-USD", engine: "perps", totalSize: "3" }, "100"),
    ).toEqual([{ market: "ANT-USD", engine: "perps", notional: "300" }]);
    expect(maxPositionsOf("twap", { market: "ANT-USD", engine: "perps", totalSize: "3" })).toEqual(
      [],
    );
    expect(maxPositionsOf("news_signal", { sizeUsdc: "200" })).toEqual([]);
  });
});

describe("max position against the thinner side", () => {
  const p = { market: "ANT-USD", engine: "perps" as const, notional: "5000" };

  it("is not checked on a deep market", () => {
    expect(positionDepthIssue({ ...p, notional: "1000000" }, book("20000", "15000"))).toBeNull();
  });

  it("fails when larger than the thinner side of a thin market", () => {
    expect(positionDepthIssue(p, book("4200.7", "9000"))).toEqual({
      kind: "too_large",
      market: "ANT-USD",
      limit: "4200",
      notional: "5000",
    });
    expect(positionDepthIssue({ ...p, notional: "4200" }, book("4200.7", "9000"))).toBeNull();
  });

  it("fails on an empty book", () => {
    expect(positionDepthIssue(p, null)).toEqual({ kind: "empty", market: "ANT-USD" });
  });

  it("an edit is checked only where it raises the max position", () => {
    const before = [p];
    expect(raisedPositions(before, [{ ...p, notional: "5000" }])).toEqual([]);
    expect(raisedPositions(before, [{ ...p, notional: "4000" }])).toEqual([]);
    expect(raisedPositions(before, [{ ...p, notional: "5000.01" }])).toHaveLength(1);
    expect(raisedPositions(before, [{ ...p, market: "BTC-USD" }])).toHaveLength(1);
  });
});
