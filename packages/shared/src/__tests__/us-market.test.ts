import { describe, expect, it } from "vitest";

import { featuresSchema } from "../api/bots";
import {
  bookStatusOf,
  DEPTH_LEVELS,
  depthLabelOf,
  LAST_TRADE_STALE_MS,
  marketDepthOf,
  sideNotional,
  tickerVolumeOf,
  usMarketsResponseSchema,
  wealthMeResponseSchema,
  type DepthBookLevel,
} from "../api/us-market";
import {
  wealthEnvelopeSchema,
  wealthFundDetailsSchema,
  wealthFundInfoSchema,
  wealthFundsSchema,
  wealthInFlightSchema,
  wealthPnlHistorySchema,
  wealthPnlSchema,
  wealthPositionsSchema,
  wealthRecurringBuysSchema,
  wealthRecurringExecutionsSchema,
  wealthTradingStatusSchema,
  wealthTvlSchema,
} from "../sodex-wealth";

import {
  emptyUser,
  fundInfoFixture,
  fundsFixture,
  heldUser,
  tradingStatusFixtures,
} from "./wealth-fixtures";

const data = (envelope: unknown) => wealthEnvelopeSchema.parse(envelope).data;

describe("SoDEX Wealth schemas (#589)", () => {
  it("parses the real public fund list: nav / aum missing → null, spot pair kept", () => {
    const funds = wealthFundsSchema.parse(data(fundsFixture));
    expect(funds).toHaveLength(3);
    expect(funds[0]).toMatchObject({ fundId: "antb", fundType: "ssi-v2", aum: null });
    expect(funds[0]?.spot ?? null).toBeNull();
    expect(funds[1]?.aum).toBe("18066.980495");
    expect(funds[2]).toMatchObject({ nav: null, spot: { symbol: "vVOO_vUSDC" } });
  });

  it("parses fund info and trading status", () => {
    const info = wealthFundInfoSchema.parse(data(fundInfoFixture));
    expect(info.chainConfig?.minDeposit).toBe("1");
    expect(info.subscription?.totalSubscribed).toBe("181692.07");
    const ts = wealthTradingStatusSchema.parse(data(tradingStatusFixtures.antb));
    expect(ts).toMatchObject({ channel: "ssi-v2-rfq", nextChannelAt: null, closedReason: null });
    expect(ts.rfq?.quotable).toBe(true);
    const closed = wealthTradingStatusSchema.parse(data(tradingStatusFixtures.CXMT));
    expect(closed.nextChannelAt).toBe(1795998600);
  });

  it("parses the real empty-wallet responses", () => {
    expect(wealthPositionsSchema.parse(data(emptyUser.positions)).positions).toEqual([]);
    const pnl = wealthPnlSchema.parse(data(emptyUser.pnl));
    expect(pnl).toMatchObject({ totalValue: "0", complete: true, positions: [] });
    expect(wealthInFlightSchema.parse(data(emptyUser.inFlight)).funds).toEqual([]);
    expect(wealthFundDetailsSchema.parse(data(emptyUser.fundDetails)).entries).toEqual([]);
    expect(wealthPnlHistorySchema.parse(data(emptyUser.pnlHistory)).points).toHaveLength(1);
    // "" = chưa có snapshot → null, không bao giờ "0".
    expect(wealthTvlSchema.parse(data(emptyUser.tvl)).settledValue).toBeNull();
    const rb = wealthEnvelopeSchema.parse(emptyUser.recurringBuys);
    expect(rb).toMatchObject({ code: -1, error: "internal error" });
    expect(rb.data).toBeUndefined();
  });

  it("parses a wallet with holdings; unpriced row has null price fields", () => {
    const pnl = wealthPnlSchema.parse(data(heldUser.pnl));
    expect(pnl.positions[2]).toMatchObject({ fundId: "NEWFUND", price: null, priced: false });
    expect(wealthPositionsSchema.parse(data(heldUser.positions)).positions[0]).toMatchObject({
      pendingRedeemShares: "10",
    });
    expect(wealthInFlightSchema.parse(data(heldUser.inFlight)).funds[0]?.inFlight[0]).toMatchObject(
      { kind: "redeem", amount: "10", count: 1 },
    );
    const plans = wealthRecurringBuysSchema.parse(data(heldUser.recurringBuys));
    expect(plans.plans[0]).toMatchObject({ planIndex: "0", planType: "WEEKLY", amount: "25" });
    const ex = wealthRecurringExecutionsSchema.parse(data(heldUser.executions));
    expect(ex.executions[1]).toMatchObject({ status: "skipped", reasonCode: "non_trading_day" });
  });

  it("tolerates missing optional fields; rejects a non-decimal amount", () => {
    expect(wealthPnlSchema.parse({}).totalValue).toBeNull();
    expect(
      wealthFundsSchema.parse([
        { fundId: "x", name: "X", fundType: "clob", fundStatus: "live" },
      ])[0],
    ).toMatchObject({ nav: null, asOf: null });
    expect(wealthPnlSchema.safeParse({ totalValue: "abc" }).success).toBe(false);
    expect(wealthFundsSchema.safeParse([{ fundId: "", name: "X" }]).success).toBe(false);
  });
});

const lv = (p: string, s: string): DepthBookLevel => [p, s];

describe("order-book depth (DEC-402 mục 4)", () => {
  it("sums notional of the first 10 levels only", () => {
    const levels = Array.from({ length: 12 }, () => lv("100", "1"));
    expect(sideNotional(levels)).toBe(String(100 * DEPTH_LEVELS));
    expect(sideNotional([lv("91.73", "0.239"), lv("91.65", "19.089")])).toBe("1771.43032");
    expect(sideNotional([])).toBe("0");
  });

  it("labels by the thinner side: < 1,000 very thin, < 10,000 thin", () => {
    expect(depthLabelOf("50000", "10000")).toBe("ok");
    expect(depthLabelOf("50000", "9999.99")).toBe("thin");
    expect(depthLabelOf("1000", "20000")).toBe("thin");
    expect(depthLabelOf("999.99", "20000")).toBe("very_thin");
    expect(depthLabelOf("0", "0")).toBe("very_thin");
  });

  it("marketDepthOf: cap = thinner side only when thin / very thin", () => {
    const thin = marketDepthOf({ bids: [lv("90", "27.2")], asks: [lv("91", "21.5")] });
    expect(thin).toMatchObject({
      bidsNotional: "2448",
      asksNotional: "1956.5",
      label: "thin",
      maxPositionUsd: "1956.5",
      bidLevels: 1,
      askLevels: 1,
    });
    const deep = marketDepthOf({ bids: [lv("100", "200")], asks: [lv("101", "200")] });
    expect(deep).toMatchObject({ label: "ok", maxPositionUsd: null });
  });

  it("book status: halted wins; one side empty = empty", () => {
    expect(bookStatusOf({ halted: true, bids: 10, asks: 10 })).toBe("halted");
    expect(bookStatusOf({ halted: false, bids: 0, asks: 3 })).toBe("empty");
    expect(bookStatusOf({ halted: false, bids: 3, asks: 0 })).toBe("empty");
    expect(bookStatusOf({ halted: false, bids: 1, asks: 1 })).toBe("trading");
  });

  it("volume is null when the last trade is older than 24 hours", () => {
    const now = Date.parse("2026-11-28T04:00:00Z");
    const fresh = tickerVolumeOf({ quoteVolume: "6542.39", closeTime: now - 60_000 }, now);
    expect(fresh).toEqual({
      volume24h: "6542.39",
      lastTradeAt: new Date(now - 60_000).toISOString(),
    });
    const edge = tickerVolumeOf({ quoteVolume: "1", closeTime: now - LAST_TRADE_STALE_MS }, now);
    expect(edge.volume24h).toBe("1");
    const stale = tickerVolumeOf(
      { quoteVolume: "9.93", closeTime: now - LAST_TRADE_STALE_MS - 1 },
      now,
    );
    expect(stale.volume24h).toBeNull();
    expect(stale.lastTradeAt).not.toBeNull();
    expect(tickerVolumeOf({ quoteVolume: null, closeTime: null }, now)).toEqual({
      volume24h: null,
      lastTradeAt: null,
    });
  });
});

describe("api response schemas", () => {
  it("features: usMarket defaults to false when missing", () => {
    expect(featuresSchema.parse({ volumeMaker: false, volumeFarm: false }).usMarket).toBe(false);
  });

  it("markets/us and wealth/me accept not_provided sections", () => {
    expect(
      usMarketsResponseSchema.parse({
        readAt: "2026-11-28T04:00:00Z",
        anthropic: [],
        fundTokens: { status: "not_provided" },
        funds: { status: "not_provided" },
      }).funds.status,
    ).toBe("not_provided");
    expect(wealthMeResponseSchema.parse({ status: "not_connected" }).status).toBe("not_connected");
  });
});
