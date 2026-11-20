import { describe, expect, it } from "vitest";

import { researchVersionCreateBodySchema } from "../api/signal-research";
import { dec } from "../money";
import {
  changedThings,
  cleanTest,
  EXPERIMENT_PAIRS,
  experimentResult,
  hypothesisSchema,
  pairWithBaseline,
  type ExperimentPair,
  type PairTrade,
} from "../signal-research/experiments";
import { baselineVersionConfig, diffVersionConfig } from "../signal-research/versions";

// Sổ thí nghiệm (#377): giả thuyết, "một thay đổi" so với Baseline cố định, ghép cặp, kết luận theo khoảng tin cậy.

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 21);

function t(o: Partial<PairTrade> & { story: string; pct: string | null; at: number }): PairTrade {
  return {
    storyId: o.story,
    articleId: null,
    market: o.market ?? "ETH-USD",
    status: o.status ?? (o.pct === null ? "open" : "closed"),
    resultPct: o.pct,
    openedAt: new Date(o.at),
    exitedAt: o.pct === null ? null : new Date(o.at + 30 * 60_000),
  };
}

/** `n` cặp, mỗi 6 giờ một cặp từ T0 (trải nhiều ngày), chênh lệch `diff(i)`. */
const pairs = (n: number, diff: (i: number) => string): ExperimentPair[] =>
  Array.from({ length: n }, (_, i) => ({
    key: `k${String(i).padStart(4, "0")}`,
    diff: dec(diff(i)),
    at: T0 + i * 6 * 3_600_000,
    completeAt: T0 + i * 6 * 3_600_000 + 1,
  }));

describe("hypothesis", () => {
  it("is required, one line, 1–200 characters after trimming", () => {
    expect(hypothesisSchema.parse("  Fewer late articles give a better result.  ")).toBe(
      "Fewer late articles give a better result.",
    );
    for (const bad of ["", "   ", "One.\nTwo.", "One.\r\nTwo.", "x".repeat(201)])
      expect(hypothesisSchema.safeParse(bad).success).toBe(false);
    expect(hypothesisSchema.safeParse("x".repeat(200)).success).toBe(true);
    const body = { name: "v", config: baselineVersionConfig(), start: false };
    expect(researchVersionCreateBodySchema.safeParse(body).success).toBe(false);
    expect(
      researchVersionCreateBodySchema.safeParse({ ...body, hypothesis: "A test." }).success,
    ).toBe(true);
  });
});

describe("one change against the fixed Baseline", () => {
  const base = baselineVersionConfig();
  it("each news type is its own thing; Assets (mode, kinds, list) is one thing", () => {
    const majors = diffVersionConfig(base, {
      ...base,
      assets: { mode: "only", markets: ["BTC-USD", "ETH-USD"], crypto: true, stocks: false },
    });
    expect(majors.map((c) => c.field)).toEqual(["assetMode", "assetKinds", "assets"]);
    expect(changedThings(majors)).toEqual(["assets"]);
    expect(cleanTest(majors)).toBe(true);
    const twoTypes = diffVersionConfig(base, {
      ...base,
      news: Object.fromEntries(
        Object.entries(base.news).filter(([k]) => k !== "treasury_buy" && k !== "treasury_sell"),
      ),
    });
    expect(changedThings(twoTypes)).toEqual(["newsType:treasury_buy", "newsType:treasury_sell"]);
    expect(cleanTest(twoTypes)).toBe(false);
  });

  it("a version copied from another version is still compared with Baseline", () => {
    const parent = { ...base, minLevel: "medium" as const };
    const child = { ...parent, slMultiple: "1.0" };
    expect(changedThings(diffVersionConfig(parent, child))).toEqual(["slMultiple"]);
    expect(changedThings(diffVersionConfig(base, child))).toEqual(["minLevel", "slMultiple"]);
    expect(cleanTest(diffVersionConfig(base, child))).toBe(false);
    expect(cleanTest(diffVersionConfig(base, base))).toBe(false);
  });
});

describe("pairWithBaseline", () => {
  it("pairs closed trades on the same story and market, opened since the version was saved", () => {
    const since = new Date(T0);
    const exp = [
      t({ story: "s1", pct: "1.5", at: T0 + 1_000 }),
      t({ story: "s2", pct: "0.5", at: T0 + 2_000 }),
      t({ story: "s3", pct: null, at: T0 + 3_000 }), // đang mở
      t({ story: "s4", pct: "2", at: T0 - 1_000 }), // mở trước khi lưu version
      t({ story: "s1", pct: "3", at: T0 + 1_000, market: "BTC-USD" }), // market khác
      t({ story: "s5", pct: "1", at: T0 + 5_000 }), // Baseline không có
    ];
    const base = [
      t({ story: "s1", pct: "1.0", at: T0 + 1_000 }),
      t({ story: "s2", pct: "1.5", at: T0 + 2_000 }),
      t({ story: "s3", pct: "1", at: T0 + 3_000 }),
      t({ story: "s4", pct: "1", at: T0 - 1_000 }),
      t({ story: "s1", pct: "9", at: T0 + 9_000 }), // cùng khoá, mở sau: không dùng
    ];
    const p = pairWithBaseline(exp, base, since);
    expect(p.map((x) => [x.key, x.diff.toFixed()])).toEqual([
      ["s:s1|ETH-USD", "0.5"],
      ["s:s2|ETH-USD", "-1"],
    ]);
  });

  it("falls back to the article when there is no story; a trade with neither never pairs", () => {
    const a = (articleId: string | null, pct: string): PairTrade => ({
      ...t({ story: "x", pct, at: T0 }),
      storyId: null,
      articleId,
    });
    const p = pairWithBaseline(
      [a("a1", "2"), a(null, "5")],
      [a("a1", "1"), a(null, "1")],
      new Date(T0),
    );
    expect(p.map((x) => [x.key, x.diff.toFixed()])).toEqual([["a:a1|ETH-USD", "1"]]);
  });
});

describe("experimentResult", () => {
  it("is Collecting below 100 pairs", () => {
    const r = experimentResult(pairs(EXPERIMENT_PAIRS - 1, () => "1"));
    expect(r).toMatchObject({ pairs: 99, needed: 100, verdict: "collecting", meanDiffPct: "1" });
    expect(experimentResult([])).toMatchObject({
      pairs: 0,
      meanDiffPct: null,
      ciLow: null,
      verdict: "collecting",
    });
  });

  it("Better when the whole range is above 0, Worse when below, No clear difference when it crosses", () => {
    expect(experimentResult(pairs(100, (i) => (i % 2 === 0 ? "0.4" : "0.6"))).verdict).toBe(
      "better",
    );
    expect(experimentResult(pairs(100, (i) => (i % 2 === 0 ? "-0.4" : "-0.6"))).verdict).toBe(
      "worse",
    );
    // Ngày âm, ngày dương xen kẽ (4 cặp một ngày): khoảng theo ngày cắt qua 0.
    const cross = experimentResult(pairs(100, (i) => (Math.floor(i / 4) % 2 === 0 ? "-1" : "1.1")));
    expect(cross.verdict).toBe("no_clear_difference");
    expect(dec(cross.ciLow ?? "0").lt(0)).toBe(true);
    expect(dec(cross.ciHigh ?? "0").gt(0)).toBe(true);
  });

  it("edges: a range that touches 0 is not Better or Worse; one day only gives no range", () => {
    const zero = experimentResult(pairs(100, () => "0"));
    expect([zero.ciLow, zero.ciHigh, zero.verdict]).toEqual(["0", "0", "no_clear_difference"]);
    const tiny = experimentResult(pairs(100, () => "0.000001"));
    expect(tiny.verdict).toBe("better");
    const oneDay = experimentResult(pairs(100, () => "1").map((p) => ({ ...p, at: T0 + 1_000 })));
    expect(oneDay.clusters).toBe(1);
    expect(oneDay.ciLow).toBeNull();
    expect(oneDay.verdict).toBe("no_clear_difference");
  });

  it("uses exactly the first 100 pairs: later pairs never change the result", () => {
    const first = pairs(100, () => "0.5");
    const later = pairs(30, () => "-50").map((p, i) => ({
      ...p,
      key: `z${String(i)}`,
      at: p.at + 200 * DAY,
      completeAt: p.completeAt + 200 * DAY,
    }));
    const r = experimentResult([...first, ...later]);
    expect(r).toMatchObject({ pairs: 100, meanDiffPct: "0.5", verdict: "better" });
  });
});
