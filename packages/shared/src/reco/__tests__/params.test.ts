import { describe, expect, it } from "vitest";

import { dec, roundToStep, RoundMode } from "../../money";
import { aiParameters } from "../engine";
import type { RecoMarket } from "../types";

import { MARKETS } from "./fixtures";

// Lỗi tìm thấy khi rà màn tạo bot trên dev (UI_REVIEW N2): số liệu gần với BTC / ETH thật ngày 2026-10-29.

const btcRules = {
  tickSize: "1",
  stepSize: "0.0001",
  minQuantity: "0.0001",
  minNotional: "10",
};
const closes = (base: number) =>
  Array.from({ length: 31 }, (_, i) => (base * (1 + 0.03 * Math.sin(i / 2))).toFixed(2));

const btcSpot: RecoMarket = {
  market: "vBTC_vUSDC",
  engine: "spot",
  asset: "BTC",
  quote: "vUSDC",
  lastPrice: "80112",
  sigma30: 0.0131,
  p5: "80391",
  p95: "85676.35",
  trend: 0,
  rangeScore: 0.7,
  fundingAvg7d: null,
  fundingPos21: null,
  closes: closes(83000),
  rules: btcRules,
  maxLeverage: null,
};
const btcPerp: RecoMarket = {
  ...btcSpot,
  market: "BTC-USD",
  engine: "perps",
  lastPrice: "81308",
  p5: "80443.05",
  p95: "85623.05",
  fundingAvg7d: "0.0011",
  fundingPos21: null,
  maxLeverage: 20,
};

const run = (strategy: Parameters<typeof aiParameters>[0], market: RecoMarket, capital: string) =>
  aiParameters(
    strategy,
    market,
    {
      account: null,
      accountLeverageCap: null,
      now: Date.parse("2026-10-29T00:00:00Z"),
      capital,
      maxDrop: "10",
      markets: [btcSpot, btcPerp, ...MARKETS.filter((m) => m.asset !== "BTC")],
    },
    "UTC",
  );

/** Như `meetsMinSize` (packages/strategies): cùng khối lượng ở mọi mức, làm tròn xuống theo lot. */
function gridOk(v: Record<string, unknown>, notional: string, m: RecoMarket): boolean {
  const lo = dec(String(v.lowerPrice));
  const hi = dec(String(v.upperPrice));
  const n = Number(v.gridLevels);
  const prices = Array.from({ length: n }, (_, i) =>
    roundToStep(
      v.spacing === "arithmetic"
        ? lo.add(
            hi
              .sub(lo)
              .mul(i)
              .div(n - 1),
          )
        : lo.mul(hi.div(lo).pow(dec(String(i)).div(n - 1))),
      m.rules.tickSize,
      RoundMode.nearest,
    ),
  );
  const avg = prices.reduce((a, b) => a.add(b), dec("0")).div(n);
  const qty = roundToStep(dec(notional).div(n).div(avg), m.rules.stepSize, RoundMode.down);
  return prices.every((p) => p.mul(qty).gte(m.rules.minNotional));
}

describe("aiParameters", () => {
  it("widens the grid range so it contains the current price", () => {
    const s = run("spot_grid", btcSpot, "60");
    expect(s).not.toBeNull();
    const v = s?.values ?? {};
    expect(dec(String(v.lowerPrice)).lt(btcSpot.lastPrice)).toBe(true);
    expect(dec(String(v.upperPrice)).gt(btcSpot.lastPrice)).toBe(true);
    expect(s?.reasons[0]).toContain("widened to include the current price");
    expect(gridOk(v, "60", btcSpot)).toBe(true);
  });

  it("keeps every futures grid order above the SoDEX minimum after lot rounding", () => {
    const s = run("futures_grid", btcPerp, "25");
    expect(s).not.toBeNull();
    const v = s?.values ?? {};
    expect(gridOk(v, dec("25").mul(Number(v.leverage)).toString(), btcPerp)).toBe(true);
  });

  it("picks the smallest DCA ladder when the form has no capital", () => {
    const s = run("spot_dca", btcSpot, "");
    expect(s).not.toBeNull();
    const v = s?.values ?? {};
    // Lệnh base ở giá hiện tại đạt min notional sau khi làm tròn lot.
    const qty = roundToStep(
      dec(String(v.baseOrder)).div(btcSpot.lastPrice),
      btcRules.stepSize,
      RoundMode.down,
    );
    expect(qty.mul(btcSpot.lastPrice).gte(btcRules.minNotional)).toBe(true);
    expect(dec(s?.capital ?? "0").gt(0)).toBe(true);
  });

  it("drops safety orders instead of giving up when DCA capital is small", () => {
    const s = run("futures_dca", btcPerp, "60");
    expect(s).not.toBeNull();
    expect(Number(s?.values.maxSafetyOrders)).toBeGreaterThanOrEqual(1);
  });

  it("returns funding arb parameters without 21 periods of funding history", () => {
    const s = run("funding_arb", btcPerp, "40");
    expect(s).not.toBeNull();
    expect(s?.values.investment).toBe("40");
  });

  it("suggests Funding Arb only when funding covers the fees within 72 hours (DEC-160)", () => {
    const steady = { ...btcPerp, fundingAvg7d: "0.0038", fundingPos21: 1, fundingIntervalHours: 1 };
    const s = run("funding_arb", steady, "4000");
    // Ngưỡng vào lệnh = phí khứ hồi 0.124% / 72 kỳ, làm tròn lên.
    expect(s?.values.enterFundingPct).toBe("0.0018");
    expect(s?.reasons[0]).toBe(
      "Funding averaged 0.0038% per period over 7 days; at that rate it covers the round-trip fees in about 33 hours.",
    );
    expect(s?.reasons[1]).toBe("Funding was positive in 100% of the last 21 periods.");
  });

  it("still needs a capital for strategies with a capital field", () => {
    expect(run("spot_grid", btcSpot, "")).toBeNull();
    expect(run("recurring_buy", btcSpot, "")).toBeNull();
  });
});

describe("aiParameters recurring buy", () => {
  it("uses fewer buys when an even split would fall below the SoDEX minimum", () => {
    // 100 / 20 = 5 USDC → 0.0000616 BTC, làm tròn lot 0.00001 còn 0.00006 ≈ 4.87 < 5.
    const m: RecoMarket = {
      ...btcSpot,
      lastPrice: "81153",
      rules: { ...btcRules, stepSize: "0.00001", minQuantity: "0.00001", minNotional: "5" },
    };
    const s = run("recurring_buy", m, "100");
    expect(s).not.toBeNull();
    const amount = dec(String(s?.values.amountPerBuy));
    const qty = roundToStep(amount.div(m.lastPrice), "0.00001", RoundMode.down);
    expect(qty.mul(m.lastPrice).gte("5")).toBe(true);
    expect(Number(s?.values.buyCount)).toBeLessThan(20);
  });
});
