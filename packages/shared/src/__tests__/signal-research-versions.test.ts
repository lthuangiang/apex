import { describe, expect, it } from "vitest";

import { Decimal } from "../money";
import { costCheck, planTrade, roundTripCost } from "../signal-research/logic";
import { NEWS_RULES, SIGNAL_CATALYSTS, TradeDirection } from "../signal-research/rules";
import {
  assetAllowed,
  availableBalance,
  baselineVersionConfig,
  botVersionConfigSchema,
  defaultMaxOpenTrades,
  levelAtLeast,
  limitBlock,
  oppositeDirection,
  versionHoldHours,
  type BotVersionConfig,
} from "../signal-research/versions";

const base = baselineVersionConfig();
const parse = (over: Partial<BotVersionConfig>) =>
  botVersionConfigSchema.safeParse({ ...base, ...over });

describe("News bot version config (#303, DEC-328)", () => {
  it("baseline = current NEWS_RULES decision parameters and parses", () => {
    expect(botVersionConfigSchema.parse(base)).toEqual(base);
    for (const c of SIGNAL_CATALYSTS)
      expect(versionHoldHours(base, c)).toBe(NEWS_RULES.catalysts[c].maxHoldHours);
    expect(base).toMatchObject({
      minLevel: "low",
      maxSourceDelayMinutes: NEWS_RULES.maxSourceDelayMinutes,
      sizeUsdc: NEWS_RULES.sizeUsdc,
      tpMultiple: NEWS_RULES.tpMultiple,
      slMultiple: NEWS_RULES.slMultiple,
      minTpCostMultiple: NEWS_RULES.minTpCostMultiple,
      maxOpenTrades: 20,
      maxNewTradesPerDay: null,
      onOppositeNews: "keep",
      assets: { mode: "all", markets: [], crypto: true, stocks: true },
    });
  });

  it("rejects bad values", () => {
    expect(parse({ minTpCostMultiple: "0.99" }).success).toBe(false);
    expect(parse({ minTpCostMultiple: "1" }).success).toBe(true);
    expect(parse({ sizeUsdc: "0" }).success).toBe(false);
    expect(parse({ sizeUsdc: "10001" }).success).toBe(false);
    expect(parse({ sizeUsdc: "1e3" }).success).toBe(false);
    expect(parse({ tpMultiple: "-1" }).success).toBe(false);
    expect(parse({ maxSourceDelayMinutes: NEWS_RULES.maxSourceDelayMinutes + 1 }).success).toBe(
      false,
    );
    expect(parse({ maxOpenTrades: 0 }).success).toBe(false);
    expect(parse({ maxNewTradesPerDay: 0 }).success).toBe(false);
    expect(
      parse({ assets: { mode: "only", markets: [], crypto: true, stocks: true } }).success,
    ).toBe(false);
    expect(
      parse({ assets: { mode: "all", markets: [], crypto: false, stocks: false } }).success,
    ).toBe(false);
    // Only these: checkbox bị ẩn nên được bỏ qua.
    expect(
      parse({ assets: { mode: "only", markets: ["BTC-USD"], crypto: false, stocks: false } })
        .success,
    ).toBe(true);
    expect(
      botVersionConfigSchema.safeParse({
        ...base,
        news: { not_a_type: { enabled: true, maxHoldHours: 1 } },
      }).success,
    ).toBe(false);
  });

  it("a news type missing from the config is off", () => {
    const cfg = { ...base, news: { listing: { enabled: true, maxHoldHours: 6 } } };
    expect(botVersionConfigSchema.safeParse(cfg).success).toBe(true);
    expect(versionHoldHours(cfg, "listing")).toBe(6);
    expect(versionHoldHours(cfg, "hack_exploit")).toBeNull();
    expect(
      versionHoldHours(
        { ...base, news: { listing: { enabled: false, maxHoldHours: 6 } } },
        "listing",
      ),
    ).toBeNull();
  });

  it("default max open trades = floor(10 000 ÷ size), at least 1", () => {
    expect(defaultMaxOpenTrades("500")).toBe(20);
    expect(defaultMaxOpenTrades("300")).toBe(33);
    expect(defaultMaxOpenTrades("10000")).toBe(1);
  });
});

describe("assets and level", () => {
  const assets = (a: Partial<BotVersionConfig["assets"]>) => ({ ...base.assets, ...a });
  it("All: kind checkboxes", () => {
    expect(assetAllowed(assets({}), "SOL-USD", "crypto")).toBe(true);
    expect(assetAllowed(assets({ crypto: false }), "SOL-USD", "crypto")).toBe(false);
    expect(assetAllowed(assets({ stocks: false }), "NVDA-USD", "stock")).toBe(false);
  });
  it("Only these: just the list, checkboxes ignored", () => {
    const a = assets({ mode: "only", markets: ["NVDA-USD"], crypto: false, stocks: false });
    expect(assetAllowed(a, "NVDA-USD", "stock")).toBe(true);
    expect(assetAllowed(a, "SOL-USD", "crypto")).toBe(false);
  });
  it("All except: kind checkboxes and the list", () => {
    const a = assets({ mode: "except", markets: ["SOL-USD"], stocks: false });
    expect(assetAllowed(a, "SOL-USD", "crypto")).toBe(false);
    expect(assetAllowed(a, "BTC-USD", "crypto")).toBe(true);
    expect(assetAllowed(a, "NVDA-USD", "stock")).toBe(false);
  });
  it("level at least", () => {
    expect(levelAtLeast("high", "medium")).toBe(true);
    expect(levelAtLeast("medium", "medium")).toBe(true);
    expect(levelAtLeast("low", "medium")).toBe(false);
    expect(oppositeDirection(TradeDirection.long)).toBe("short");
  });
});

describe("limits", () => {
  const cfg = { maxOpenTrades: 2, maxNewTradesPerDay: 3, sizeUsdc: "500" };
  const rich = new Decimal(10_000);
  it("checks open, then per day, then balance", () => {
    expect(limitBlock({ cfg, openTrades: 1, openedToday: 2, available: rich })).toBeNull();
    expect(limitBlock({ cfg, openTrades: 2, openedToday: 3, available: new Decimal(0) })).toBe(
      "LIMIT_OPEN",
    );
    expect(limitBlock({ cfg, openTrades: 1, openedToday: 3, available: new Decimal(0) })).toBe(
      "LIMIT_DAY",
    );
    expect(limitBlock({ cfg, openTrades: 1, openedToday: 0, available: new Decimal(499) })).toBe(
      "NO_BALANCE",
    );
    expect(
      limitBlock({
        cfg: { ...cfg, maxNewTradesPerDay: null },
        openTrades: 0,
        openedToday: 99,
        available: rich,
      }),
    ).toBeNull();
  });
  it("available balance = 10 000 + closed results − open size", () => {
    expect(
      availableBalance({
        closedResultUsdc: new Decimal("-12.5"),
        openSizeUsdc: new Decimal(1000),
      }).toFixed(),
    ).toBe("8987.5");
  });
});

describe("planTrade / costCheck with version multiples", () => {
  const quote = { bid: new Decimal("99.99"), ask: new Decimal("100.01") };
  it("TP / SL / size follow the version", () => {
    const p = planTrade({
      direction: TradeDirection.long,
      quote,
      typicalMovePct: new Decimal(2),
      oneWayFeePct: new Decimal("0.05"),
      sizeUsdc: "1000",
      tpMultiple: "2",
      slMultiple: "1",
    });
    expect(p.tpPct.toFixed()).toBe("4");
    expect(p.slPct.toFixed()).toBe("2");
    expect(p.sizeUsdc.toFixed()).toBe("1000");
    const d = planTrade({
      direction: TradeDirection.long,
      quote,
      typicalMovePct: new Decimal(2),
      oneWayFeePct: new Decimal("0.05"),
    });
    expect(d.tpPct.toFixed()).toBe("3");
  });
  it("min TP cost multiple from the version", () => {
    const cost = roundTripCost(new Decimal("0.05"), new Decimal("0.02"));
    // cost = 0.12 %; TP 0.2 % đạt bội số 1 nhưng không đạt 2.
    expect(costCheck(new Decimal("0.2"), cost)).not.toBeNull();
    expect(costCheck(new Decimal("0.2"), cost, "1")).toBeNull();
  });
});
