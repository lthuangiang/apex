import { describe, expect, it } from "vitest";

import {
  funnelSteps,
  paperBalance,
  roundToTick,
  tagName,
  unrealizedUsdc,
  type ArticleStop,
} from "../signal-research/display";

const stop = (
  stage: ArticleStop["stage"],
  outcome: ArticleStop["outcome"],
  n: number,
  reason: ArticleStop["reason"] = null,
  mergeReason: ArticleStop["mergeReason"] = null,
): ArticleStop => ({ stage, outcome, reason, mergeReason, n });

// Gần với ảnh UI thật trong #297 (1 ngày): 63 không gắn coin, 37 không có trên SoDEX, 1 trùng, 55 không phải loại tin,
// 1 sự kiện cũ, 3 không có giá SoDEX, 1 gộp, 3 đang chờ, 2 mở lệnh.
const REAL: ArticleStop[] = [
  stop("collect", "dropped", 63, "noTaggedCurrency"),
  stop("collect", "waiting", 1),
  stop("normalize", "dropped", 37, "notOnSodex"),
  stop("normalize", "dropped", 1, "duplicate"),
  stop("normalize", "waiting", 2),
  stop("score", "dropped", 55, "notCatalyst"),
  stop("score", "dropped", 1, "eventTooOld"),
  stop("filter", "dropped", 3, "noPrice"),
  stop("filter", "merged", 1, null, "sameStory"),
  stop("decide", "traded", 2),
];

describe("funnelSteps (#297): one unit (articles in range), in − out = next", () => {
  it("every step's passed equals the next step's in, and in − dropped − merged − waiting = passed", () => {
    const steps = funnelSteps(REAL);
    expect(steps.map((s) => s.stage)).toEqual([
      "collect",
      "normalize",
      "score",
      "filter",
      "decide",
    ]);
    for (const [i, s] of steps.entries()) {
      expect(s.in - s.dropped - s.merged - s.waiting).toBe(s.passed);
      const next = steps[i + 1];
      if (next !== undefined) expect(next.in).toBe(s.passed);
    }
  });

  it("counts a day like the #297 screenshot: 166 → 102 out → 64 → 58 out → 6 → 4 out → 2 traded", () => {
    const steps = funnelSteps(REAL);
    const [collect, normalize, score, filter, decide] = steps;
    expect(collect).toMatchObject({ in: 166, dropped: 0, waiting: 0, passed: 166 });
    // "No coin tagged" is dropped by Normalize (event NO_SODEX_MARKET); an article waiting at Collect waits for Normalize.
    expect(normalize).toMatchObject({ in: 166, dropped: 101, waiting: 1, passed: 64 });
    expect(score).toMatchObject({ in: 64, dropped: 56, waiting: 2, passed: 6 });
    expect(filter).toMatchObject({ in: 6, dropped: 3, merged: 1, passed: 2 });
    expect(decide).toMatchObject({ in: 2, passed: 2 });
    // Every article sits in exactly one place: dropped, merged, waiting or traded.
    const parked = steps.reduce((s, x) => s + x.dropped + x.merged + x.waiting, 0);
    expect(parked + (decide?.passed ?? 0)).toBe(collect?.in);
  });

  it("traded articles pass every step", () => {
    const steps = funnelSteps([
      stop("decide", "traded", 2),
      stop("score", "dropped", 3, "promotional"),
    ]);
    expect(steps.map((s) => s.passed)).toEqual([5, 5, 2, 2, 2]);
    expect(steps[4]).toMatchObject({ in: 2, passed: 2 });
  });

  it("lists each step's drop reasons, biggest first, at the step that dropped them", () => {
    const [, normalize, score, filter] = funnelSteps(REAL);
    expect(normalize?.reasons).toEqual([
      { reason: "noTaggedCurrency", n: 63 },
      { reason: "notOnSodex", n: 37 },
      { reason: "duplicate", n: 1 },
    ]);
    expect(score?.reasons).toEqual([
      { reason: "notCatalyst", n: 55 },
      { reason: "eventTooOld", n: 1 },
    ]);
    expect(filter?.reasons).toEqual([{ reason: "noPrice", n: 3 }]);
  });

  it("is all zeros (never negative) with no articles", () => {
    for (const s of funnelSteps([])) expect(s).toMatchObject({ in: 0, passed: 0 });
  });
});

describe("funnelSteps fixture with traded articles", () => {
  it("passes the traded count through Filter into Decide", () => {
    const steps = funnelSteps([
      stop("normalize", "dropped", 10, "notOnSodex"),
      stop("score", "dropped", 4, "notCatalyst"),
      stop("filter", "dropped", 1, "tpUnderCost"),
      stop("decide", "traded", 3),
    ]);
    expect(steps.map((s) => [s.in, s.passed])).toEqual([
      [18, 18],
      [18, 8],
      [8, 4],
      [4, 3],
      [3, 3],
    ]);
  });
});

describe("roundToTick (#297)", () => {
  it("rounds TP / SL to the nearest tick and keeps the tick's decimals", () => {
    expect(roundToTick("61412.992618091707312574", "0.1").toFixed()).toBe("61413");
    expect(roundToTick("61412.992618091707312574", "0.1").toFixed(1)).toBe("61413.0");
    expect(roundToTick("64643.253690954146343713", "0.5").toFixed()).toBe("64643.5");
    expect(roundToTick("277.401007092434736281", "0.01").toFixed()).toBe("277.4");
    expect(roundToTick("289.946996453782631859", "0.001").toFixed()).toBe("289.947");
    expect(roundToTick("0.000123456", "0.0000001").toFixed()).toBe("0.0001235");
  });

  it("leaves the price as is when the tick is unknown or invalid", () => {
    expect(roundToTick("1.23456", null).toFixed()).toBe("1.23456");
    expect(roundToTick("1.23456", "0").toFixed()).toBe("1.23456");
    expect(roundToTick("1.23456", "abc").toFixed()).toBe("1.23456");
  });
});

describe("tagName (#297)", () => {
  it("reads EN from a SoSoValue stock name, whether a JSON string or an object", () => {
    expect(tagName('{"EN": "HYPERSCALE DATA INC"}')).toBe("HYPERSCALE DATA INC");
    expect(tagName({ EN: "NVIDIA CORPORATION" })).toBe("NVIDIA CORPORATION");
    expect(tagName({ en: "lower key" })).toBe("lower key");
  });

  it("falls back to the first string value, never raw JSON", () => {
    expect(tagName('{"ZH": "英伟达", "JA": "x"}')).toBe("英伟达");
    expect(tagName({ n: 1, ZH: "名" })).toBe("名");
    expect(tagName("{not json")).toBeNull();
    expect(tagName("{}")).toBeNull();
  });

  it("keeps plain names and drops empty ones", () => {
    expect(tagName("BITCOIN")).toBe("BITCOIN");
    expect(tagName("  ")).toBeNull();
    expect(tagName(null)).toBeNull();
    expect(tagName(12)).toBeNull();
  });
});

describe("paper bot balance (#297)", () => {
  it("is 10,000 plus the realized result of closed trades, in exact decimals", () => {
    expect(paperBalance([]).toFixed()).toBe("10000");
    expect(paperBalance(["12.5", "-3.01", "0.1", "0.2"]).toFixed()).toBe("10009.79");
  });

  it("marks an open trade at the SoDEX last price after entry and exit fees", () => {
    const t = {
      direction: "short" as const,
      entryPrice: "100",
      qty: "5",
      sizeUsdc: "500",
      entryFee: "0.25",
      feePct: "0.05",
    };
    // (100 − 98) × 5 = 10; exit fee 5 × 98 × 0.05% = 0.245; 10 − 0.25 − 0.245 = 9.505
    expect(unrealizedUsdc(t, "98")?.toFixed()).toBe("9.505");
    expect(unrealizedUsdc(t, null)).toBeNull();
    expect(unrealizedUsdc(t, "0")).toBeNull();
  });
});
