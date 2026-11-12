import { describe, expect, it } from "vitest";

import {
  botHealth,
  evaluateBot,
  isSnoozed,
  liquidationDistance,
  NEEDS_YOU_CONFIG,
  pickNeedsYou,
  ruleLiquidation,
  ruleMaxLoss,
  ruleReview,
  ruleTaker,
  type DeskBotFacts,
  type MarginTier,
} from "../desk";

// AI Desk B+ (DEC-164, DEC-166): 4 quy tắc Needs you, sức khoẻ bot, hoãn 7 ngày.

const NOW = Date.parse("2026-11-12T08:00:00Z");
const DAY = 86_400_000;
/** marginTiers của BTC-USD trên SoDEX, đọc 2026-11-12. */
const BTC_TIERS: MarginTier[] = [
  {
    maxNotionalValue: "4000000",
    maintenanceMarginRate: "0.0125",
    maxLeverage: 40,
    maintenanceDeduction: "0",
  },
  {
    maxNotionalValue: "100000000",
    maintenanceMarginRate: "0.02",
    maxLeverage: 25,
    maintenanceDeduction: "30000",
  },
  {
    maxNotionalValue: "200000000000",
    maintenanceMarginRate: "0.5",
    maxLeverage: 1,
    maintenanceDeduction: "48030000",
  },
];

const bot = (over: Partial<DeskBotFacts> = {}): DeskBotFacts => ({
  botId: "b1",
  name: "BTC Volume Farm",
  strategy: "volume_farm",
  market: "BTC-USD",
  state: "running",
  reasonCode: null,
  net: "-4.95",
  maxLoss: "10",
  fees: "3.2",
  stoppedAt: null,
  stop: null,
  taker: null,
  review: null,
  analyst: "fine",
  ...over,
});

const stop = (
  leverage: number,
  stopDistance: string,
  marginMode: "isolated" | "cross" = "isolated",
) => ({
  stopDistance,
  leverage,
  marginMode,
  side: "both" as const,
  notional: "1000",
  tiers: BTC_TIERS,
  stopLabel: "test",
});

describe("liquidationDistance", () => {
  it("follows the maintenance-margin formula on SoDEX tiers", () => {
    // 40×, MMR 1.25%: long (2.5% − 1.25%) / 98.75%, short / 101.25%.
    expect(
      liquidationDistance({
        tiers: BTC_TIERS,
        leverage: 40,
        notional: "1000",
        side: "long",
      })?.toFixed(6),
    ).toBe("0.012658");
    expect(
      liquidationDistance({
        tiers: BTC_TIERS,
        leverage: 40,
        notional: "1000",
        side: "short",
      })?.toFixed(6),
    ).toBe("0.012346");
    expect(
      liquidationDistance({
        tiers: BTC_TIERS,
        leverage: 10,
        notional: "1000",
        side: "long",
      })?.toFixed(6),
    ).toBe("0.088608");
  });

  it("picks the tier by notional, including the deduction, and returns null past the last tier", () => {
    const big = liquidationDistance({
      tiers: BTC_TIERS,
      leverage: 20,
      notional: "5000000",
      side: "long",
    });
    // (5% − 2% + 30000/5M) / 98% = 3.6% / 98%.
    expect(big?.toFixed(6)).toBe("0.036735");
    expect(
      liquidationDistance({
        tiers: BTC_TIERS,
        leverage: 2,
        notional: "999999999999",
        side: "long",
      }),
    ).toBeNull();
  });
});

describe("rule 1 · liquidation before stop loss", () => {
  it("flags an isolated bot whose stop is further away than the estimated liquidation", () => {
    const c = ruleLiquidation(bot({ stop: stop(40, "0.025") }));
    expect(c?.rule).toBe("liquidation_before_stop");
    expect(c?.facts.find((f) => f.name === "liquidationDistancePct")).toMatchObject({
      value: "1.234568",
      source: "estimate",
    });
  });

  it("stays quiet when the stop comes first, for cross margin, and for stopped bots", () => {
    expect(ruleLiquidation(bot({ stop: stop(10, "0.025") }))).toBeNull();
    expect(ruleLiquidation(bot({ stop: stop(40, "0.025", "cross") }))).toBeNull();
    expect(ruleLiquidation(bot({ state: "stopped", stop: stop(40, "0.025") }))).toBeNull();
  });
});

describe("rule 2 · max loss hit", () => {
  it("raises a review item when the engine paused the bot at its max loss", () => {
    const c = ruleMaxLoss(
      bot({ state: "paused", reasonCode: "BOT_MAX_LOSS", net: "-10.09", stoppedAt: NOW - DAY }),
    );
    expect(c).toMatchObject({
      rule: "max_loss_hit",
      badness: "10.09",
      fingerprint: String(NOW - DAY),
    });
    expect(c?.facts.map((f) => f.name)).toEqual(["reasonCode", "maxLoss", "net", "fees"]);
  });

  it("ignores other stop reasons and running bots", () => {
    expect(ruleMaxLoss(bot({ state: "paused", reasonCode: "STOP_LOSS" }))).toBeNull();
    expect(ruleMaxLoss(bot({ state: "running", reasonCode: "BOT_MAX_LOSS" }))).toBeNull();
  });
});

describe("rule 3 · costly taker orders", () => {
  const taker = (trades: number, takerTrades: number, takerCpm: number, makerCpm: number) => ({
    trades,
    takerTrades,
    takerCostPerMillion: takerCpm,
    makerCostPerMillion: makerCpm,
  });
  it("flags many, clearly more expensive taker turns", () => {
    const c = ruleTaker(bot({ taker: taker(100, 40, 360, 213) }));
    expect(c?.facts.find((f) => f.name === "takerSharePct")?.value).toBe("40");
    expect(c?.badness).toBe("147");
  });

  it("needs enough trades, a big enough share and a real cost gap", () => {
    expect(
      ruleTaker(bot({ taker: taker(NEEDS_YOU_CONFIG.takerMinTrades - 1, 10, 400, 200) })),
    ).toBeNull();
    expect(ruleTaker(bot({ taker: taker(100, 10, 400, 200) }))).toBeNull();
    expect(ruleTaker(bot({ taker: taker(100, 40, 225, 213) }))).toBeNull();
  });
});

describe("rule 4 · Review this run found a better set", () => {
  const review = (over: Partial<NonNullable<DeskBotFacts["review"]>> = {}) => ({
    id: "r1",
    status: "done",
    suggestion: "strong" as const,
    appliedVersion: null,
    createdAt: NOW - DAY,
    activeVersionAppliedAt: NOW - 3 * DAY,
    currentCostPerMillion: 320,
    bestCostPerMillion: 250,
    ...over,
  });
  it("suggests only a strong, unapplied, recent review of the running version", () => {
    expect(ruleReview(bot({ review: review() }), NOW)?.rule).toBe("better_review");
    expect(ruleReview(bot({ review: review({ suggestion: "weak" }) }), NOW)).toBeNull();
    expect(ruleReview(bot({ review: review({ appliedVersion: 3 }) }), NOW)).toBeNull();
    expect(ruleReview(bot({ review: review({ createdAt: NOW - 8 * DAY }) }), NOW)).toBeNull();
    expect(ruleReview(bot({ review: review({ activeVersionAppliedAt: NOW }) }), NOW)).toBeNull();
  });
});

describe("health, ordering and snooze", () => {
  it("maps items and analyst notes to Healthy / Watch / Needs you", () => {
    const risky = bot({ stop: stop(40, "0.025") });
    const c = evaluateBot(risky, NOW);
    expect(botHealth(risky, c)).toBe("needs_you");
    expect(botHealth(bot({ botId: "b2", analyst: "fees" }), c)).toBe("watch");
    expect(botHealth(bot({ botId: "b3" }), c)).toBe("healthy");
  });

  it("keeps at most 3 items, most severe first", () => {
    const all = [
      ...evaluateBot(
        bot({
          botId: "a",
          review: {
            id: "r",
            status: "done",
            suggestion: "strong",
            appliedVersion: null,
            createdAt: NOW,
            activeVersionAppliedAt: null,
            currentCostPerMillion: null,
            bestCostPerMillion: null,
          },
        }),
        NOW,
      ),
      ...evaluateBot(
        bot({
          botId: "b",
          taker: {
            trades: 50,
            takerTrades: 20,
            takerCostPerMillion: 400,
            makerCostPerMillion: 200,
          },
        }),
        NOW,
      ),
      ...evaluateBot(bot({ botId: "c", state: "paused", reasonCode: "BOT_MAX_LOSS" }), NOW),
      ...evaluateBot(bot({ botId: "d", stop: stop(40, "0.025") }), NOW),
    ];
    expect(pickNeedsYou(all, [], NOW).map((c) => [c.botId, c.rule])).toEqual([
      ["d", "liquidation_before_stop"],
      ["c", "max_loss_hit"],
      ["b", "taker_costly"],
    ]);
  });

  it("hides a snoozed item for 7 days unless the data got worse", () => {
    const c = ruleTaker(
      bot({
        taker: { trades: 100, takerTrades: 40, takerCostPerMillion: 360, makerCostPerMillion: 213 },
      }),
    );
    if (c === null) throw new Error("expected an item");
    const stored = {
      botId: "b1",
      rule: c.rule,
      fingerprint: c.fingerprint,
      badness: "147",
      snoozedAt: NOW - DAY,
    };
    expect(isSnoozed(c, stored, NOW)).toBe(true);
    expect(isSnoozed(c, { ...stored, snoozedAt: NOW - 8 * DAY }, NOW)).toBe(false);
    expect(isSnoozed({ ...c, badness: "200" }, stored, NOW)).toBe(false);
    expect(isSnoozed({ ...c, fingerprint: "new" }, stored, NOW)).toBe(false);
    expect(pickNeedsYou([c], [stored], NOW)).toEqual([]);
  });
});
