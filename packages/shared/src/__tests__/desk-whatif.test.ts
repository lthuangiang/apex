import { describe, expect, it } from "vitest";

import {
  applyPatch,
  lowerLeverageOption,
  optionsFor,
  pickOption,
  tighterStopOption,
  type MarginTier,
  type RiskInput,
  type WhatIfOptionResult,
} from "../desk";

// AI Desk B+ M2 (DEC-166): phương án sửa và "My pick".

const TIERS: MarginTier[] = [
  {
    maxNotionalValue: "4000000",
    maintenanceMarginRate: "0.0125",
    maxLeverage: 40,
    maintenanceDeduction: "0",
  },
];
/** Volume Farm 40×, SL 100% margin = 2.5% giá (thanh lý ~1.23%): rủi ro quy tắc 1. */
const farm: RiskInput = {
  strategy: "volume_farm",
  leverage: 40,
  stopDistance: "0.025",
  side: "both",
  notional: "200",
  tiers: TIERS,
  stopField: "slMarginPct",
  slMarginPct: "100",
};
/** Futures DCA 20×, stop 6% (thanh lý ~3.7%). */
const dca: RiskInput = {
  strategy: "futures_dca",
  leverage: 20,
  stopDistance: "0.06",
  side: "long",
  notional: "1000",
  tiers: TIERS,
  stopField: "stopLossPct",
  slMarginPct: null,
};

describe("rule 1 options", () => {
  it("lowers Volume Farm leverage until its %-of-margin stop sits inside 80% of the liquidation distance", () => {
    // SL = 100%/L margin; thanh lý ≈ (1/L − 1.25%)/(1 + 1.25%). An toàn khi 1/L ≤ 0.8·(1/L − 0.0125)/1.0125 → không bao giờ:
    // stop 100% margin luôn ở xa hơn thanh lý, nên chỉ có phương án siết stop.
    expect(lowerLeverageOption(farm)).toBeNull();
    const tight = tighterStopOption(farm);
    expect(tight?.patch).toEqual({ slMarginPct: "39.5", slPct: null });
  });

  it("lowers leverage for a price stop and tightens the stop as a second option", () => {
    // 12×: thanh lý 7.17%, 80% = 5.74% < 6% (chưa an toàn); 11×: 7.94%, 80% = 6.35%.
    expect(lowerLeverageOption(dca)?.patch).toEqual({ leverage: 11 });
    // 20×: thanh lý 3.80%, 80% = 3.04% → làm tròn xuống 3.0%.
    expect(tighterStopOption(dca)?.patch).toEqual({ stopLossPct: "3" });
  });

  it("always offers keep, and nothing else without a concrete fix", () => {
    expect(
      optionsFor({ rule: "taker_costly", risk: null, reviewBest: null }).map((o) => o.key),
    ).toEqual(["keep"]);
    expect(
      optionsFor({ rule: "max_loss_hit", risk: null, reviewBest: null }).map((o) => o.key),
    ).toEqual(["keep"]);
    const best = {
      earlyProfitFees: 3,
      earlyExitSecs: 60,
      minHoldSecs: 180,
      maxHoldSecs: 300,
      slMarginPct: 50,
    };
    expect(
      optionsFor({ rule: "better_review", risk: null, reviewBest: best }).map((o) => o.key),
    ).toEqual(["keep", "review_settings"]);
  });

  it("applies a patch and deletes fields set to null", () => {
    expect(
      applyPatch({ leverage: 40, slPct: "2.5", maxLoss: "10" }, { slMarginPct: "40", slPct: null }),
    ).toEqual({
      leverage: 40,
      maxLoss: "10",
      slMarginPct: "40",
    });
  });
});

describe("pickOption", () => {
  const r = (key: WhatIfOptionResult["key"], net: string | null): WhatIfOptionResult => ({
    key,
    patch: {},
    outcome:
      net === null
        ? null
        : { trades: 50, net, closedBySodex: 0, worstTrade: null, marginPerTrade: null },
    unavailable: net === null ? "not_enough_trades" : null,
  });

  it("picks the best fix for a safety risk even when keeping did slightly better", () => {
    expect(
      pickOption("liquidation_before_stop", [
        r("keep", "-3"),
        r("lower_leverage", "-3.4"),
        r("tighter_stop", "-5"),
      ]),
    ).toEqual({
      key: "lower_leverage",
      reason: "safer_best_result",
    });
  });

  it("picks a review fix only when it beats keeping by at least 0.50 USDC", () => {
    expect(pickOption("better_review", [r("keep", "-4"), r("review_settings", "-3.4")])).toEqual({
      key: "review_settings",
      reason: "better_result",
    });
    expect(pickOption("better_review", [r("keep", "-4"), r("review_settings", "-3.7")])).toEqual({
      key: "keep",
      reason: "keep_is_better",
    });
  });

  it("does not pick anything without results", () => {
    expect(
      pickOption("liquidation_before_stop", [r("keep", null), r("lower_leverage", null)]),
    ).toEqual({
      key: null,
      reason: "not_enough_trades",
    });
  });
});
