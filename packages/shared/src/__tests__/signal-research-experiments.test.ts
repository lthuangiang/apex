import { describe, expect, it } from "vitest";

import { researchVersionCreateBodySchema } from "../api/signal-research";
import { dec } from "../money";
import {
  changedThings,
  cleanTest,
  EXPERIMENT_PAIRS,
  experimentResult,
  experimentStartedAt,
  hypothesisSchema,
  nextRunPeriods,
  pairWithBaseline,
  runPeriodsOf,
  type ExperimentPair,
  type PairTrade,
  type RunPeriod,
} from "../signal-research/experiments";
import { baselineVersionConfig, diffVersionConfig } from "../signal-research/versions";

// Sổ thí nghiệm (#377): giả thuyết, "một thay đổi" so với Baseline cố định, ghép cặp, kết luận theo khoảng tin cậy.

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 21);

const storyTime = new Map<string, number>();
/** Một tín hiệu = một giờ đăng bài đầu (độc lập version); cùng tên `story` = cùng tín hiệu. */
function eventOf(story: string): Date {
  if (!storyTime.has(story)) storyTime.set(story, T0 - 3_600_000 + storyTime.size);
  return new Date(storyTime.get(story) ?? 0);
}

function t(o: {
  story: string;
  pct: string | null;
  at: number;
  market?: string;
  status?: string;
}): PairTrade {
  return {
    market: o.market ?? "ETH-USD",
    catalyst: "etf_approved",
    eventAt: eventOf(o.story),
    status: o.status ?? (o.pct === null ? "open" : "closed"),
    resultPct: o.pct,
    openedAt: new Date(o.at),
    exitedAt: o.pct === null ? null : new Date(o.at + 30 * 60_000),
  };
}

const ALWAYS: RunPeriod[] = [{ from: new Date(0), to: null }];
/** Thí nghiệm chạy từ `since`, Baseline chạy suốt. */
const pair = (exp: PairTrade[], base: PairTrade[], since: Date, running?: RunPeriod[]) =>
  pairWithBaseline(
    { trades: exp, running: running ?? [{ from: since, to: null }] },
    { trades: base, running: ALWAYS },
  );
const keyOf = (story: string, market = "ETH-USD") =>
  `${market}|etf_approved|${String(eventOf(story).getTime())}`;

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
  it("pairs on the union of signals since the version was saved; a side that didn't enter counts 0", () => {
    const since = new Date(T0);
    const exp = [
      t({ story: "s1", pct: "1.5", at: T0 + 1_000 }), // cả hai vào: 1.5 − 1.0
      t({ story: "s5", pct: "1", at: T0 + 5_000 }), // Baseline không vào: 1 − 0
      t({ story: "s4", pct: "2", at: T0 - 1_000 }), // mở trước khi lưu version: không tính
      t({ story: "s1", pct: "3", at: T0 + 1_000, market: "BTC-USD" }), // market khác: tín hiệu riêng
    ];
    const base = [
      t({ story: "s1", pct: "1.0", at: T0 + 1_000 }),
      t({ story: "s2", pct: "-1.5", at: T0 + 2_000 }), // version bỏ qua: 0 − (−1.5)
      t({ story: "s4", pct: "1", at: T0 - 1_000 }), // trước khi lưu version
      t({ story: "s1", pct: "9", at: T0 + 9_000 }), // cùng khoá, mở sau: không dùng
    ];
    const p = pair(exp, base, since);
    expect(Object.fromEntries(p.map((x) => [x.key, x.diff.toFixed()]))).toEqual({
      [keyOf("s1")]: "0.5",
      [keyOf("s1", "BTC-USD")]: "3",
      [keyOf("s2")]: "1.5",
      [keyOf("s5")]: "1",
    });
  });

  it("a pair counts only when every entered trade in it has closed", () => {
    const since = new Date(T0);
    const exp = [
      t({ story: "s1", pct: null, at: T0 + 1_000 }),
      t({ story: "s3", pct: null, at: T0 }),
    ];
    const base = [
      t({ story: "s1", pct: "1", at: T0 + 1_000 }),
      t({ story: "s2", pct: "1", at: T0 }),
    ];
    // s1: lệnh thí nghiệm còn mở → chưa đếm; s3: chỉ thí nghiệm vào và còn mở → chưa đếm; s2: chỉ Baseline, đã đóng.
    expect(pair(exp, base, since).map((x) => [x.key, x.diff.toFixed()])).toEqual([
      [keyOf("s2"), "-1"],
    ]);
  });

  it("blocked by a limit (only a shadow trade, never passed in) counts 0 for the version", () => {
    const base = [t({ story: "s1", pct: "-2", at: T0 }), t({ story: "s2", pct: "0.8", at: T0 })];
    const exp = [t({ story: "s2", pct: "0.8", at: T0 })]; // s1 bị giới hạn chặn: chỉ có shadow, không có lệnh thật
    const p = pair(exp, base, new Date(T0));
    expect(p.map((x) => [x.key, x.diff.toFixed()])).toEqual([
      [keyOf("s1"), "2"],
      [keyOf("s2"), "0"],
    ]);
  });

  it("a filtering experiment that skips Baseline's losing trades comes out Better", () => {
    // Baseline: 100 tín hiệu, xen kẽ lời 1 % / lỗ 1 %, 4 tín hiệu mỗi ngày. Version chỉ vào các lệnh lời.
    const base: PairTrade[] = [];
    const exp: PairTrade[] = [];
    for (let i = 0; i < 100; i++) {
      const at = T0 + i * 6 * 3_600_000;
      const win = i % 2 === 0;
      base.push(t({ story: `f${String(i)}`, pct: win ? "1" : "-1", at }));
      if (win) exp.push(t({ story: `f${String(i)}`, pct: "1", at }));
    }
    const r = experimentResult(pair(exp, base, new Date(T0)));
    expect(r).toMatchObject({ pairs: 100, meanDiffPct: "0.5", verdict: "better" });
    // Ghép kiểu giao (chỉ tín hiệu cả hai cùng vào) sẽ ra 0 và bỏ mất giá trị của bộ lọc.
  });

  it("a retry (later article of the same story) still pairs: the key is the story's first publish time", () => {
    const base = [t({ story: "r1", pct: "1", at: T0 })];
    const exp = [t({ story: "r1", pct: "2", at: T0 + 2 * 3_600_000 })]; // vào ở bài sau của cùng câu chuyện
    expect(pair(exp, base, new Date(T0)).map((x) => x.diff.toFixed())).toEqual(["1"]);
  });

  it("only while both versions run: an experiment trade while Baseline was paused does not count", () => {
    // Baseline tạm dừng từ T0 + 10 s tới T0 + 20 s; thí nghiệm chạy suốt.
    const baseRunning: RunPeriod[] = [
      { from: new Date(0), to: new Date(T0 + 10_000) },
      { from: new Date(T0 + 20_000), to: null },
    ];
    const exp = [
      t({ story: "b1", pct: "2", at: T0 + 5_000 }), // cả hai chạy: 2 − 0
      t({ story: "b2", pct: "2", at: T0 + 15_000 }), // Baseline tạm dừng: không tính
      t({ story: "b3", pct: "2", at: T0 + 25_000 }), // Baseline chạy lại: 2 − 0
    ];
    const p = pairWithBaseline(
      { trades: exp, running: [{ from: new Date(T0), to: null }] },
      { trades: [], running: baseRunning },
    );
    expect(p.map((x) => x.key)).toEqual([keyOf("b1"), keyOf("b3")]);
  });

  it("only while both versions run: a Baseline trade while the version was paused is not a 0 for it", () => {
    const running: RunPeriod[] = [
      { from: new Date(T0), to: new Date(T0 + 10_000) },
      { from: new Date(T0 + 20_000), to: null },
    ];
    const base = [
      t({ story: "p1", pct: "-1", at: T0 + 5_000 }), // đang chạy: 0 − (−1)
      t({ story: "p2", pct: "-1", at: T0 + 15_000 }), // version tạm dừng: không tính
      t({ story: "p3", pct: "-1", at: T0 + 25_000 }), // chạy lại: 0 − (−1)
    ];
    expect(pair([], base, new Date(T0), running).map((x) => x.key)).toEqual([
      keyOf("p1"),
      keyOf("p3"),
    ]);
  });
});

describe("run periods", () => {
  it("open on running, close on pause / stop, and fall back to the status for rows saved before #377", () => {
    const a = new Date(T0);
    const b = new Date(T0 + DAY);
    const c = new Date(T0 + 2 * DAY);
    let p = nextRunPeriods([], "running", a);
    expect(p).toEqual([{ from: a, to: null }]);
    p = nextRunPeriods(p, "running", b); // đã chạy: không mở thêm
    p = nextRunPeriods(p, "paused", b);
    expect(p).toEqual([{ from: a, to: b }]);
    p = nextRunPeriods(nextRunPeriods(p, "running", c), "stopped", c);
    expect(p).toEqual([
      { from: a, to: b },
      { from: c, to: c },
    ]);
    const base = { createdAt: a, statusChangedAt: b, runningPeriods: null };
    expect(runPeriodsOf({ ...base, status: "running" })).toEqual([{ from: a, to: null }]);
    expect(runPeriodsOf({ ...base, status: "paused" })).toEqual([{ from: a, to: b }]);
    expect(
      runPeriodsOf({
        ...base,
        status: "paused",
        runningPeriods: [{ from: c.toISOString(), to: null }],
      }),
    ).toEqual([{ from: c, to: null }]);
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

describe("experimentStartedAt (#385)", () => {
  const createdAt = new Date("2026-11-01T00:00:00.000Z");
  it("is the earliest running period, whatever the order", () => {
    expect(
      experimentStartedAt({
        createdAt,
        runningPeriods: [
          { from: "2026-11-05T00:00:00.000Z", to: null },
          { from: "2026-11-02T00:00:00.000Z", to: "2026-11-03T00:00:00.000Z" },
        ],
      })?.toISOString(),
    ).toBe("2026-11-02T00:00:00.000Z");
  });
  it("is null for a version saved but never run", () => {
    expect(experimentStartedAt({ createdAt, runningPeriods: [] })).toBeNull();
  });
  it("falls back to the saved time when there are no running periods (old version) or they don't parse", () => {
    expect(experimentStartedAt({ createdAt, runningPeriods: null })).toEqual(createdAt);
    expect(experimentStartedAt({ createdAt, runningPeriods: [{ from: "x" }] })).toEqual(createdAt);
  });
});
