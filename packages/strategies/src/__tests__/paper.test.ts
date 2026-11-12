import { describe, expect, it } from "vitest";

import {
  newPaperBook,
  paperApplyFill,
  paperCheck,
  paperCrosses,
  paperEquity,
  paperFillPrice,
  paperFunding,
  type PaperOrder,
} from "../paper";

// Paper mode (DEC-105): luật khớp và số dư giả theo AI_DESK_RECOMMENDED.md mục 8.2.

const spotBuy = (price: string, quantity = "0.01"): PaperOrder => ({
  market: "vBTC_vUSDC",
  engine: "spot",
  side: "buy",
  type: "limit",
  price,
  quantity,
  timeInForce: "GTC",
  reduceOnly: false,
});
const engines = { vBTC_vUSDC: "spot", "BTC-USD": "perps" } as const;

describe("paper fill rules", () => {
  it("does not fill when the price only touches the order, fills when it goes through", () => {
    expect(paperCrosses(spotBuy("100000"), "100000")).toBe(false);
    expect(paperCrosses(spotBuy("100000"), "99999")).toBe(true);
    expect(paperCrosses({ side: "sell", type: "limit", price: "100000" }, "100000")).toBe(false);
    expect(paperCrosses({ side: "sell", type: "limit", price: "100000" }, "100001")).toBe(true);
  });

  it("fills market orders at the price plus slippage against the user, limit at its own price", () => {
    expect(paperFillPrice({ side: "buy", type: "market" }, "100000")).toBe("100050");
    expect(paperFillPrice({ side: "sell", type: "market" }, "100000")).toBe("99950");
    expect(paperFillPrice(spotBuy("99000"), "98000")).toBe("99000");
  });

  it("rejects an order the fake balance can't pay for, counting orders already resting", () => {
    const book = newPaperBook("1000");
    const check = (order: PaperOrder, open: PaperOrder[] = []) =>
      paperCheck({
        book,
        open,
        order,
        refPrice: "100000",
        leverage: 1,
        feeRate: "0.0005",
        engines,
        prices: {},
      });
    expect(check(spotBuy("99000", "0.01"))).toBeNull(); // 990 + phí ≤ 1000
    expect(check(spotBuy("99000", "0.011"))).toBe("INSUFFICIENT_BALANCE");
    // 499.75 + 499.75 + phí ≤ 1000: còn đủ; thêm một lệnh treo nữa thì không.
    expect(check(spotBuy("50000", "0.0099"), [spotBuy("50000", "0.0099")])).toBeNull();
    expect(
      check(spotBuy("50000", "0.01"), [spotBuy("50000", "0.01"), spotBuy("50000", "0.005")]),
    ).toBe("INSUFFICIENT_BALANCE");
    expect(check({ ...spotBuy("90000"), side: "sell" })).toBe("INSUFFICIENT_BALANCE");
    expect(check({ ...spotBuy("100001"), timeInForce: "GTX" })).toBe("POST_ONLY_WOULD_TRADE");
    expect(
      paperCheck({
        book,
        open: [],
        order: spotBuy("1"),
        refPrice: null,
        leverage: 1,
        feeRate: "0",
        engines,
        prices: {},
      }),
    ).toBe("NO_PRICE");
  });

  it("uses leverage for perps margin and rejects reduce-only without a position", () => {
    const book = newPaperBook("1000");
    const perp: PaperOrder = { ...spotBuy("100000", "0.02"), market: "BTC-USD", engine: "perps" };
    const check = (order: PaperOrder, leverage: number) =>
      paperCheck({
        book,
        open: [],
        order,
        refPrice: "100000",
        leverage,
        feeRate: "0.0005",
        engines,
        prices: {},
      });
    expect(check(perp, 1)).toBe("INSUFFICIENT_BALANCE"); // 2.000 USDC margin
    expect(check(perp, 3)).toBeNull(); // 667 USDC margin
    expect(check({ ...perp, reduceOnly: true, side: "sell" }, 3)).toBe("REDUCE_ONLY_NO_POSITION");
  });
});

describe("paper balance", () => {
  it("moves cash and coins on spot fills and counts fees", () => {
    let b = newPaperBook("1000");
    b = paperApplyFill(
      b,
      { market: "vBTC_vUSDC", engine: "spot", side: "buy" },
      "99000",
      "0.01",
      "0.4",
    );
    expect(b).toMatchObject({ cash: "9.6", fees: "0.4", fills: 1 });
    expect(b.positions.vBTC_vUSDC).toEqual({ qty: "0.01", avgCost: "99000" });
    expect(paperEquity(b, engines, { vBTC_vUSDC: "100000" }).toString()).toBe("1009.6");
    b = paperApplyFill(
      b,
      { market: "vBTC_vUSDC", engine: "spot", side: "sell" },
      "100000",
      "0.01",
      "0.4",
    );
    expect(b.cash).toBe("1009.2");
    expect(b.positions.vBTC_vUSDC).toBeUndefined();
  });

  it("books perps realized PnL and funding in cash", () => {
    let b = newPaperBook("1000");
    const perp = { market: "BTC-USD", engine: "perps" } as const;
    b = paperApplyFill(b, { ...perp, side: "sell" }, "100000", "0.01", "0.5");
    expect(paperEquity(b, engines, { "BTC-USD": "99000" }).toString()).toBe("1009.5");
    const f = paperFunding(b, "BTC-USD", "99000", "0.0001");
    expect(f.amount).toBe("-0.099"); // short nhận funding khi rate dương
    b = paperApplyFill(f.book, { ...perp, side: "buy" }, "99000", "0.01", "0.5");
    expect(b.cash).toBe("1009.099");
    expect(b.funding).toBe("-0.099");
  });
});
