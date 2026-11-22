import { describe, expect, it } from "vitest";

import { Strategy } from "../enums";
import { builderFeeRateFor, builderFeeRateOf, DRIFT_BUILDER_FEE_RATE } from "../fees";
import {
  isNewsEntryBlock,
  NEWS_SIGNAL_FALLBACK_MMR,
  NEWS_SIGNAL_LEVERAGES,
  newsLiquidationCheck,
  NewsEntryBlock,
  narrowsVersion,
  NEWS_SIGNAL_ENTRY_SLIPPAGE_PCT,
  NEWS_SIGNAL_LEVERAGE,
  NEWS_SIGNAL_LIVE_MAX_USDC,
  NEWS_SIGNAL_TTL_MS,
  newsEntryLimitPrice,
  newsSignalConfigSchema,
  newsSignalStale,
} from "../signal-research/news-signal";
import { AssetKind, SignalLevel, SignalReason, TradeDirection } from "../signal-research/rules";
import {
  AssetMode,
  baselineVersionConfig,
  type BotVersionConfig,
} from "../signal-research/versions";

// Bot `news_signal` mainnet (#419, DEC-360): phần dùng chung, không I/O.

const bot = (o: Record<string, unknown> = {}) => ({
  ...baselineVersionConfig(),
  sizeUsdc: "200",
  leverage: 1,
  maxOpenTrades: 3,
  maxNewTradesPerDay: 5,
  ...o,
});

describe("news_signal constants", () => {
  it("pins the decided values: 120 s TTL, 0.2% extra slippage, 200 USDC cap, 1× leverage", () => {
    expect(Strategy.newsSignal).toBe("news_signal");
    expect(NEWS_SIGNAL_TTL_MS).toBe(120_000);
    expect(NEWS_SIGNAL_ENTRY_SLIPPAGE_PCT).toBe("0.2");
    expect(NEWS_SIGNAL_LIVE_MAX_USDC).toBe("200");
    expect(NEWS_SIGNAL_LEVERAGE).toBe(1);
  });

  it("has a reason code for every new per-bot outcome", () => {
    expect([
      SignalReason.assetNotInBot,
      SignalReason.signalStale,
      SignalReason.botPaused,
      SignalReason.missedWhilePaused,
      SignalReason.accountMarketBusy,
      SignalReason.newsCapExceeded,
      SignalReason.entryNotFilled,
      SignalReason.leverageNotSet,
      SignalReason.accessOff,
    ]).toEqual([
      "ASSET_NOT_IN_BOT",
      "SIGNAL_STALE",
      "BOT_PAUSED",
      "MISSED_WHILE_PAUSED",
      "ACCOUNT_MARKET_BUSY",
      "NEWS_CAP_EXCEEDED",
      "ENTRY_NOT_FILLED",
      "LEVERAGE_NOT_SET",
      "ACCESS_OFF",
    ]);
    // Không trùng mã cũ.
    const all = Object.values(SignalReason);
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("NewsEntryBlock (#419 engine B1)", () => {
  it("has a separate code for a wrong order type and for the 200 USDC cap", () => {
    expect(NewsEntryBlock.orderInvalid).toBe("NEWS_ORDER_INVALID");
    expect(NewsEntryBlock.capExceeded).toBe("NEWS_CAP_EXCEEDED");
    expect(NewsEntryBlock.accessOff).toBe("NEWS_ACCESS_OFF");
    expect(isNewsEntryBlock("NEWS_ORDER_INVALID")).toBe(true);
    expect(isNewsEntryBlock("BOT_NOT_RUNNING")).toBe(true);
    expect(isNewsEntryBlock("-1")).toBe(false);
  });
});

describe("newsSignalConfigSchema (mainnet)", () => {
  it("accepts a full version config plus the bot fields, at the 200 USDC cap", () => {
    const r = newsSignalConfigSchema.safeParse(bot());
    expect(r.success).toBe(true);
    expect(newsSignalConfigSchema.safeParse(bot({ sizeUsdc: "0.5" })).success).toBe(true);
  });

  it("rejects a size above 200 USDC, zero or negative", () => {
    for (const sizeUsdc of ["200.01", "500", "0", "-1"])
      expect(newsSignalConfigSchema.safeParse(bot({ sizeUsdc })).success).toBe(false);
    const r = newsSignalConfigSchema.safeParse(bot({ sizeUsdc: "201" }));
    expect(r.error?.issues.map((i) => i.message)).toContain("Above the 200 USDC cap");
  });

  it("rejects leverage outside 1 / 5 / 10 / 20 (#458, replaces the old 1× only rule)", () => {
    for (const leverage of [2, 0, 1.5, "1"])
      expect(newsSignalConfigSchema.safeParse(bot({ leverage })).success).toBe(false);
  });

  it("keeps the version rules: max open ≥ 1, max per day Off or ≥ 1", () => {
    expect(newsSignalConfigSchema.safeParse(bot({ maxOpenTrades: 0 })).success).toBe(false);
    expect(newsSignalConfigSchema.safeParse(bot({ maxNewTradesPerDay: null })).success).toBe(true);
    expect(newsSignalConfigSchema.safeParse(bot({ maxNewTradesPerDay: 0 })).success).toBe(false);
  });
});

describe("narrowsVersion", () => {
  const assets = (o: Partial<BotVersionConfig["assets"]>): BotVersionConfig["assets"] => ({
    mode: AssetMode.all,
    markets: [],
    crypto: true,
    stocks: true,
    ...o,
  });
  const cfg = (
    a: Partial<BotVersionConfig["assets"]>,
    minLevel: SignalLevel = SignalLevel.low,
  ) => ({
    assets: assets(a),
    minLevel,
  });
  const kindOf = (m: string) =>
    m === "AAPL-USD" || m === "TSLA-USD"
      ? AssetKind.stock
      : m === "UNKNOWN-USD"
        ? null
        : AssetKind.crypto;

  it("accepts the same config (equal is narrowing)", () => {
    for (const a of [
      cfg({}),
      cfg({ mode: AssetMode.only, markets: ["SOL-USD"] }),
      cfg({ mode: AssetMode.except, markets: ["DOGE-USD"], stocks: false }),
    ])
      expect(narrowsVersion(a, a, kindOf)).toBe(true);
  });

  it("Min level can only go up", () => {
    const v = cfg({}, SignalLevel.medium);
    expect(narrowsVersion(v, cfg({}, SignalLevel.high))).toBe(true);
    expect(narrowsVersion(v, cfg({}, SignalLevel.medium))).toBe(true);
    expect(narrowsVersion(v, cfg({}, SignalLevel.low))).toBe(false);
  });

  it("Only these: the bot list must be a subset of the version list", () => {
    const v = cfg({ mode: AssetMode.only, markets: ["SOL-USD", "ETH-USD"] });
    expect(narrowsVersion(v, cfg({ mode: AssetMode.only, markets: ["SOL-USD"] }))).toBe(true);
    expect(narrowsVersion(v, cfg({ mode: AssetMode.only, markets: ["SOL-USD", "BTC-USD"] }))).toBe(
      false,
    );
    // All / All except are open sets: always wider than a fixed list.
    expect(narrowsVersion(v, cfg({}))).toBe(false);
    expect(narrowsVersion(v, cfg({ mode: AssetMode.except, markets: ["SOL-USD"] }))).toBe(false);
  });

  it("All: the bot may drop a kind, exclude markets or pick a list, never add a kind", () => {
    const v = cfg({ stocks: false });
    expect(narrowsVersion(v, cfg({ stocks: false }), kindOf)).toBe(true);
    expect(
      narrowsVersion(
        v,
        cfg({ mode: AssetMode.except, markets: ["SOL-USD"], stocks: false }),
        kindOf,
      ),
    ).toBe(true);
    expect(narrowsVersion(v, cfg({ mode: AssetMode.only, markets: ["SOL-USD"] }), kindOf)).toBe(
      true,
    );
    expect(narrowsVersion(v, cfg({}), kindOf)).toBe(false);
    expect(narrowsVersion(v, cfg({ mode: AssetMode.only, markets: ["AAPL-USD"] }), kindOf)).toBe(
      false,
    );
  });

  it("All except: the bot must keep every excluded market it could otherwise trade", () => {
    const v = cfg({ mode: AssetMode.except, markets: ["DOGE-USD", "TSLA-USD"] });
    expect(
      narrowsVersion(
        v,
        cfg({ mode: AssetMode.except, markets: ["DOGE-USD", "TSLA-USD", "PEPE-USD"] }),
        kindOf,
      ),
    ).toBe(true);
    // TSLA is a stock and the bot turns stocks off: it no longer needs to exclude it.
    expect(
      narrowsVersion(
        v,
        cfg({ mode: AssetMode.except, markets: ["DOGE-USD"], stocks: false }),
        kindOf,
      ),
    ).toBe(true);
    expect(narrowsVersion(v, cfg({ mode: AssetMode.except, markets: ["DOGE-USD"] }), kindOf)).toBe(
      false,
    );
    expect(narrowsVersion(v, cfg({}), kindOf)).toBe(false);
    expect(narrowsVersion(v, cfg({ mode: AssetMode.only, markets: ["SOL-USD"] }), kindOf)).toBe(
      true,
    );
    expect(narrowsVersion(v, cfg({ mode: AssetMode.only, markets: ["DOGE-USD"] }), kindOf)).toBe(
      false,
    );
  });

  it("an unknown asset kind counts as both (stricter)", () => {
    expect(
      narrowsVersion(
        cfg({ stocks: false }),
        cfg({ mode: AssetMode.only, markets: ["UNKNOWN-USD"] }),
        kindOf,
      ),
    ).toBe(false);
    expect(
      narrowsVersion(cfg({}), cfg({ mode: AssetMode.only, markets: ["UNKNOWN-USD"] }), kindOf),
    ).toBe(true);
    const v = cfg({ mode: AssetMode.except, markets: ["UNKNOWN-USD"] });
    expect(narrowsVersion(v, cfg({ stocks: false }), kindOf)).toBe(false);
  });
});

describe("newsEntryLimitPrice", () => {
  // bid 99, ask 101: mid 100, nửa spread 1, 0.2% mid = 0.2 → mua tối đa 101.2, bán tối thiểu 98.8.
  it("buys at most ask + 0.2% of mid and sells at least bid − 0.2% of mid", () => {
    const at = (direction: TradeDirection, tickSize = "0.1") =>
      newsEntryLimitPrice({ direction, bid: "99", ask: "101", tickSize })?.toString();
    expect(at(TradeDirection.long)).toBe("101.2");
    expect(at(TradeDirection.short)).toBe("98.8");
    // Tick 1: làm tròn về phía ít trượt hơn (mua xuống, bán lên).
    expect(at(TradeDirection.long, "1")).toBe("101");
    expect(at(TradeDirection.short, "1")).toBe("99");
  });

  it("works with a zero spread, in exact decimals", () => {
    expect(
      newsEntryLimitPrice({
        direction: TradeDirection.long,
        bid: "0.1",
        ask: "0.1",
        tickSize: "0.00001",
      })?.toString(),
    ).toBe("0.1002");
  });

  it("returns null when the book is missing or makes no sense", () => {
    const p = (bid: string | null, ask: string | null) =>
      newsEntryLimitPrice({ direction: TradeDirection.long, bid, ask, tickSize: "0.1" });
    expect(p(null, "101")).toBeNull();
    expect(p("99", null)).toBeNull();
    expect(p("0", "1")).toBeNull();
    expect(p("101", "99")).toBeNull();
  });
});

describe("newsSignalStale", () => {
  it("is fresh up to exactly 120 s, stale after", () => {
    const t = new Date("2026-11-22T00:00:00Z");
    expect(newsSignalStale(t, new Date(t.getTime() + 120_000))).toBe(false);
    expect(newsSignalStale(t, new Date(t.getTime() + 120_001))).toBe(true);
  });
});

describe("news_signal builder fee (DEC-94, DEC-159)", () => {
  it("defaults to 10 (0.01%) without a row of its own", () => {
    expect(builderFeeRateOf(Strategy.newsSignal)).toBe(10);
    expect(builderFeeRateFor(Strategy.newsSignal)).toBe(DRIFT_BUILDER_FEE_RATE);
    expect(builderFeeRateFor(Strategy.newsSignal, {})).toBe(10);
  });

  it("uses a team override, but never above 10", () => {
    expect(builderFeeRateFor(Strategy.newsSignal, { news_signal: 3 })).toBe(3);
    expect(builderFeeRateFor(Strategy.newsSignal, { news_signal: 0 })).toBe(0);
    expect(builderFeeRateFor(Strategy.newsSignal, { news_signal: 50 })).toBe(10);
    // Mức riêng của chiến lược khác không áp vào.
    expect(builderFeeRateFor(Strategy.newsSignal, { volume_farm: 2 })).toBe(10);
  });
});

describe("leverage and the liquidation check (#458)", () => {
  const tier = (mmr: string) => [
    {
      maxNotionalValue: "4000000",
      maintenanceMarginRate: mmr,
      maxLeverage: 40,
      maintenanceDeduction: "0",
    },
  ];
  it("accepts 1 / 5 / 10 / 20, rejects other levels, and reads a missing field as 1", () => {
    expect(NEWS_SIGNAL_LEVERAGES).toEqual([1, 5, 10, 20]);
    for (const leverage of [1, 5, 10, 20])
      expect(newsSignalConfigSchema.safeParse(bot({ leverage })).success).toBe(true);
    for (const leverage of [2, 3, 25, 0, 1.5])
      expect(newsSignalConfigSchema.safeParse(bot({ leverage })).success).toBe(false);
    const raw: Record<string, unknown> = { ...bot() };
    delete raw.leverage;
    expect(newsSignalConfigSchema.parse(raw).leverage).toBe(1);
  });

  it("20× long, MMR 0.5%: liquidation ≈ 4.52% away, so a stop loss up to ≈ 3.01% passes", () => {
    const at = (slPct: string) =>
      newsLiquidationCheck({
        side: "long",
        leverage: 20,
        slPct,
        notional: "199",
        tiers: tier("0.005"),
      });
    expect(at("3").ok).toBe(true);
    expect(at("3.1").ok).toBe(false);
    expect(at("3").distance?.toDecimalPlaces(5).toString()).toBe("0.04523");
  });

  it("10× short, MMR 0.5%: liquidation ≈ 9.45% away, so a stop loss up to ≈ 6.30% passes", () => {
    const at = (slPct: string) =>
      newsLiquidationCheck({
        side: "short",
        leverage: 10,
        slPct,
        notional: "199",
        tiers: tier("0.005"),
      });
    expect(at("6.3").ok).toBe(true);
    expect(at("6.31").ok).toBe(false);
  });

  it("5× long, MMR 1.25%; exactly 1.5 × the stop loss distance still passes", () => {
    const d = newsLiquidationCheck({
      side: "long",
      leverage: 5,
      slPct: "1",
      notional: "100",
      tiers: tier("0.0125"),
    }).distance;
    expect(d?.toDecimalPlaces(4).toString()).toBe("0.1899");
    const edge = d?.div("1.5").mul(100).toString() ?? "0";
    expect(
      newsLiquidationCheck({
        side: "long",
        leverage: 5,
        slPct: edge,
        notional: "100",
        tiers: tier("0.0125"),
      }).ok,
    ).toBe(true);
  });

  it("without SoDEX margin tiers uses the conservative fallback MMR (5%); 1× always passes", () => {
    expect(NEWS_SIGNAL_FALLBACK_MMR).toBe("0.05");
    // 20× long: (1/20 − 5%) / (1 − 5%) = 0 → no stop loss can pass.
    const twenty = newsLiquidationCheck({
      side: "long",
      leverage: 20,
      slPct: "0.1",
      notional: "199",
      tiers: undefined,
    });
    expect(twenty).toMatchObject({ ok: false, fallback: true });
    // 10× short: (0.1 − 0.05) / 1.05 ≈ 4.76% → a stop loss up to ≈ 3.17%.
    expect(
      newsLiquidationCheck({
        side: "short",
        leverage: 10,
        slPct: "3.1",
        notional: "199",
        tiers: [],
      }).ok,
    ).toBe(true);
    expect(
      newsLiquidationCheck({
        side: "short",
        leverage: 10,
        slPct: "3.2",
        notional: "199",
        tiers: [],
      }).ok,
    ).toBe(false);
    expect(
      newsLiquidationCheck({
        side: "long",
        leverage: 1,
        slPct: "50",
        notional: "199",
        tiers: undefined,
      }),
    ).toMatchObject({
      ok: true,
      fallback: false,
    });
  });
});
