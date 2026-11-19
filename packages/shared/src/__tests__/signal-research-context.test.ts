import { describe, expect, it } from "vitest";

import { dec } from "../money";
import {
  compareContext,
  contextGroupOf,
  h1Of,
  h2Of,
  h2ThresholdOf,
  h3Of,
  midRankPercentile,
  rangeBreakoutOf,
  SIGNAL_CONTEXT_RULES,
  volumeVs24h,
  type ContextFundingPoint,
} from "../signal-research/context";
import { TradeDirection } from "../signal-research/rules";
import type { DayObs } from "../stats/day-bootstrap";

const T = Date.parse("2026-11-19T10:20:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("H1 whales agree", () => {
  const long = TradeDirection.long;
  const move = (address: string, after: string, notional = "1000", at = T - 30 * MIN) => ({
    address,
    positionAfter: after,
    notional,
    at,
  });

  it("is yes with one agreeing wallet, counting distinct wallets and summing notional", () => {
    const r = h1Of({
      direction: long,
      walletsChecked: 214,
      assetHasWhaleData: true,
      moves: [
        move("0xA", "2", "900000", T - 39 * MIN),
        move("0xa", "3", "500000", T - 20 * MIN),
        move("0xB", "-1"),
      ],
    });
    expect(r.status).toBe("yes");
    expect(r.walletsChecked).toBe(214);
    expect(r.agreeingWallets).toBe(1);
    expect(r.opposingWallets).toBe(1);
    expect(r.agreeingUsdc?.toFixed()).toBe("1400000");
    expect(r.firstAt).toBe(T - 39 * MIN);
  });

  it("is against when only opposite wallets moved, and no when nothing moved", () => {
    expect(
      h1Of({
        direction: TradeDirection.short,
        walletsChecked: 5,
        assetHasWhaleData: true,
        moves: [move("0xA", "2")],
      }).status,
    ).toBe("against");
    const quiet = h1Of({
      direction: long,
      walletsChecked: 214,
      assetHasWhaleData: true,
      moves: [],
    });
    expect(quiet).toMatchObject({ status: "no", walletsChecked: 214, agreeingWallets: 0 });
    expect(quiet.agreeingUsdc).toBeNull();
  });

  it("is na (never no) when the asset has no whale data or no wallet was on the leaderboard before", () => {
    expect(
      h1Of({ direction: long, walletsChecked: 214, assetHasWhaleData: false, moves: [] }).status,
    ).toBe("na");
    const none = h1Of({
      direction: long,
      walletsChecked: 0,
      assetHasWhaleData: true,
      moves: [move("0xA", "2")],
    });
    expect(none).toMatchObject({ status: "na", agreeingWallets: 0, agreeingUsdc: null });
  });

  it("ignores a move that ends flat", () => {
    expect(
      h1Of({
        direction: long,
        walletsChecked: 3,
        assetHasWhaleData: true,
        moves: [move("0xA", "0")],
      }).status,
    ).toBe("no");
  });
});

describe("H2 funding against the crowd", () => {
  /** n kỳ mỗi 8 giờ kết thúc ngay trước T, kỳ cuối có `last`. */
  const series = (n: number, last: string, base = (i: number) => (i % 10) * 0.00001) => {
    const pts: ContextFundingPoint[] = [];
    for (let i = 0; i < n; i++)
      pts.push({ at: T - (n - i) * 8 * HOUR, rate: i === n - 1 ? last : base(i).toFixed(6) });
    return pts;
  };

  it("uses the mid-rank percentile so ties are not pushed to one side", () => {
    expect(midRankPercentile("1", ["1", "1", "1", "1"])).toBe(50);
    expect(midRankPercentile("0", ["0", "1", "2", "3"])).toBe(12.5);
    expect(midRankPercentile("3", ["0", "1", "2", "3"])).toBe(87.5);
    expect(midRankPercentile("1", [])).toBeNull();
  });

  it("Long is yes when funding is at or below the 20th percentile; Short needs the 80th or above", () => {
    const low = series(90, "-0.0001");
    const l = h2Of({ direction: TradeDirection.long, decidedAt: T, points: low });
    expect(l.status).toBe("yes");
    expect(l.percentile).toBeLessThanOrEqual(20);
    expect(l.payer).toBe("short");
    expect(l.intervalHours).toBe(8);
    expect(l.samples).toBe(90);
    expect(h2Of({ direction: TradeDirection.short, decidedAt: T, points: low }).status).toBe("no");
    const high = series(90, "0.001");
    expect(h2Of({ direction: TradeDirection.short, decidedAt: T, points: high })).toMatchObject({
      status: "yes",
      payer: "long",
    });
    expect(h2Of({ direction: TradeDirection.long, decidedAt: T, points: high }).status).toBe("no");
  });

  it("treats exactly the 20th / 80th percentile as yes and just past it as no", () => {
    const mk = (vals: number[]) =>
      vals.map((v, i) => ({ at: T - (vals.length - i) * HOUR, rate: v.toFixed(2) }));
    const min = SIGNAL_CONTEXT_RULES.h2MinSamples;
    // 30 kỳ, kỳ cuối = 1: 5 kỳ nhỏ hơn, 2 kỳ bằng (gồm chính nó) → (5 + 1) / 30 = 20%.
    const at20 = [...Array<number>(5).fill(0), 1, ...Array<number>(min - 7).fill(2), 1];
    expect(
      midRankPercentile(
        "1",
        at20.map((v) => v.toFixed(2)),
      ),
    ).toBe(20);
    expect(h2Of({ direction: TradeDirection.long, decidedAt: T, points: mk(at20) })).toMatchObject({
      status: "yes",
      percentile: 20,
    });
    const past20 = [...Array<number>(6).fill(0), ...Array<number>(min - 7).fill(2), 1];
    const p = h2Of({ direction: TradeDirection.long, decidedAt: T, points: mk(past20) });
    expect(p.percentile).toBeCloseTo(21.6667, 3);
    expect(p.status).toBe("no");
    const at80 = [...Array<number>(min - 7).fill(0), 1, ...Array<number>(5).fill(2), 1];
    expect(h2Of({ direction: TradeDirection.short, decidedAt: T, points: mk(at80) })).toMatchObject(
      {
        status: "yes",
        percentile: 80,
      },
    );
    expect(h2ThresholdOf(TradeDirection.long)).toBe(20);
    expect(h2ThresholdOf(TradeDirection.short)).toBe(80);
  });

  it("is na with fewer than the minimum samples or a stale latest funding", () => {
    const few = series(SIGNAL_CONTEXT_RULES.h2MinSamples - 1, "-0.001");
    expect(h2Of({ direction: TradeDirection.long, decidedAt: T, points: few })).toMatchObject({
      status: "na",
      percentile: null,
      samples: SIGNAL_CONTEXT_RULES.h2MinSamples - 1,
    });
    const stale = series(90, "-0.001").map((p) => ({ ...p, at: p.at - 2 * DAY }));
    expect(h2Of({ direction: TradeDirection.long, decidedAt: T, points: stale }).status).toBe("na");
    expect(h2Of({ direction: TradeDirection.long, decidedAt: T, points: [] })).toMatchObject({
      status: "na",
      rate: null,
      payer: null,
    });
  });

  it("never looks ahead: points at or after the decision time are ignored", () => {
    const pts = series(90, "-0.0001");
    const before = h2Of({ direction: TradeDirection.long, decidedAt: T, points: pts });
    const withFuture = h2Of({
      direction: TradeDirection.long,
      decidedAt: T,
      points: [...pts, { at: T, rate: "-1" }, { at: T + HOUR, rate: "5" }],
    });
    expect(withFuture).toEqual(before);
  });
});

describe("H3 price already moved", () => {
  const h3 = (direction: TradeDirection, moved: string | null, typical: string | null) =>
    h3Of({
      direction,
      movedPct: moved === null ? null : dec(moved),
      typicalMovePct: typical === null ? null : dec(typical),
    });

  it("is yes at exactly 1 × the typical 1 h move in the signal's direction", () => {
    expect(h3(TradeDirection.long, "0.6", "0.6").status).toBe("yes");
    expect(h3(TradeDirection.long, "0.59", "0.6").status).toBe("no");
    expect(h3(TradeDirection.short, "-0.6", "0.6").status).toBe("yes");
    // Chạy ngược chiều tín hiệu không phải "vào muộn".
    expect(h3(TradeDirection.long, "-2", "0.6").status).toBe("no");
    expect(h3(TradeDirection.short, "2", "0.6").status).toBe("no");
    expect(h3(TradeDirection.long, "0.2", "0.6").thresholdPct?.toFixed()).toBe("0.6");
  });

  it("is na when the price before or the typical move is missing", () => {
    expect(h3(TradeDirection.long, null, "0.6").status).toBe("na");
    expect(h3(TradeDirection.long, "1", null).status).toBe("na");
    expect(h3(TradeDirection.long, "1", "0").status).toBe("na");
  });
});

describe("exploratory measures", () => {
  it("volume vs 24 h average and range breakout, null without data", () => {
    expect(volumeVs24h("180", "2400")?.toFixed()).toBe("1.8");
    expect(volumeVs24h(null, "2400")).toBeNull();
    expect(volumeVs24h("1", "0")).toBeNull();
    expect(rangeBreakoutOf({ last: "105", high: "104", low: "100" })).toBe("up");
    expect(rangeBreakoutOf({ last: "99", high: "104", low: "100" })).toBe("down");
    expect(rangeBreakoutOf({ last: "102", high: "104", low: "100" })).toBe("none");
    expect(rangeBreakoutOf({ last: null, high: "104", low: "100" })).toBeNull();
  });
});

describe("with / without comparison", () => {
  const obs = (n: number, v: string, day0 = 0): DayObs[] =>
    Array.from({ length: n }, (_, i) => ({ v: dec(v), at: T + (day0 + (i % 10)) * DAY + i }));
  const noisy = (n: number, centre: number): DayObs[] =>
    Array.from({ length: n }, (_, i) => ({
      v: dec((centre + ((i % 5) - 2) * 0.1).toFixed(4)),
      at: T + (i % 12) * DAY + i,
    }));

  it("stays collecting until each group has 30 closed trades and hides the numbers", () => {
    const c = compareContext(obs(29, "1"), obs(40, "0"));
    expect(c).toMatchObject({
      status: "collecting",
      withClosed: 29,
      withoutClosed: 40,
      needWith: 1,
      needWithout: 0,
      withMean: null,
      diff: null,
      ciLow: null,
    });
    expect(compareContext(obs(30, "1"), obs(12, "0"))).toMatchObject({
      status: "collecting",
      needWith: 0,
      needWithout: 18,
    });
  });

  it("says better / worse only when the whole 95% day-block range is on one side of 0", () => {
    const better = compareContext(noisy(30, 0.5), noisy(30, -0.5));
    expect(better.status).toBe("better_with");
    expect(better.diff?.toNumber()).toBeCloseTo(1, 6);
    expect(better.ciLow?.gt(0)).toBe(true);
    expect(compareContext(noisy(30, -0.5), noisy(30, 0.5)).status).toBe("worse_with");
    const same = compareContext(noisy(30, 0.1), noisy(31, 0.1));
    expect(same.status).toBe("no_clear_difference");
    expect(same.ciLow?.lte(0)).toBe(true);
    expect(same.ciHigh?.gte(0)).toBe(true);
  });

  it("puts yes in the with group, no / against in without, and leaves na out of both", () => {
    expect(contextGroupOf("yes")).toBe("with");
    expect(contextGroupOf("no")).toBe("without");
    expect(contextGroupOf("against")).toBe("without");
    expect(contextGroupOf("na")).toBeNull();
  });
});
