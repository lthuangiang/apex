import { describe, expect, it } from "vitest";

import { researchLabelBodySchema, RESEARCH_DROP_REASONS } from "../api/signal-research";
import {
  articleVerdict,
  CLASSIFICATION_LABEL_SOURCES,
  CLASSIFIER_GATE,
  classifierGate,
  commonMistakes,
  LABEL_NOTE_MAX,
  wilsonInterval,
} from "../signal-research/labels";

// Nhãn phân loại và cổng precision của classifier (#304, DEC-328 mục 2).

describe("articleVerdict (several people label one article)", () => {
  it("majority wins; a tie counts as wrong; no label → null", () => {
    expect(articleVerdict({ right: 2, wrong: 1 })).toBe("right");
    expect(articleVerdict({ right: 1, wrong: 2 })).toBe("wrong");
    expect(articleVerdict({ right: 1, wrong: 1 })).toBe("wrong");
    expect(articleVerdict({ right: 1, wrong: 0 })).toBe("right");
    expect(articleVerdict({ right: 0, wrong: 0 })).toBeNull();
  });
});

describe("wilsonInterval", () => {
  it("40 / 50 is about 67% to 89% (the design's ±11% floor at 50 labels)", () => {
    expect(wilsonInterval(40, 50)).toEqual({ lo: 66.96, hi: 88.76 });
  });

  it("stays inside 0–100 at the edges and is null without labels or with bad input", () => {
    expect(wilsonInterval(0, 10)).toEqual({ lo: 0, hi: 27.75 });
    expect(wilsonInterval(10, 10)).toEqual({ lo: 72.25, hi: 100 });
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(5, 4)).toBeNull();
    expect(wilsonInterval(-1, 4)).toBeNull();
    expect(wilsonInterval(1.5, 4)).toBeNull();
  });

  it("narrows as labels grow", () => {
    const at50 = wilsonInterval(40, 50);
    const at500 = wilsonInterval(400, 500);
    expect(at50 !== null && at500 !== null).toBe(true);
    if (at50 === null || at500 === null) return;
    expect(at500.hi - at500.lo).toBeLessThan(at50.hi - at50.lo);
  });
});

describe("classifierGate (≥ 50 labels and ≥ 80%)", () => {
  it("is 50 labels and 80%", () => {
    expect(CLASSIFIER_GATE).toEqual({ minLabels: 50, minPrecisionPct: 80 });
  });

  it("49 labels all right still needs one more label; 50 passes", () => {
    expect(classifierGate({ labeled: 49, right: 49 })).toMatchObject({
      passes: false,
      status: "needsLabels",
      labelsToGo: 1,
      precisionPct: 100,
    });
    expect(classifierGate({ labeled: 50, right: 50 })).toMatchObject({
      passes: true,
      status: "passed",
      labelsToGo: 0,
    });
  });

  it("79.9% fails and 80% passes (no rounding up)", () => {
    expect(classifierGate({ labeled: 1000, right: 799 })).toMatchObject({
      passes: false,
      status: "underPrecision",
      precisionPct: 79.9,
    });
    expect(classifierGate({ labeled: 1000, right: 800 }).passes).toBe(true);
    expect(classifierGate({ labeled: 50, right: 39 }).passes).toBe(false);
    expect(classifierGate({ labeled: 50, right: 40 })).toMatchObject({
      passes: true,
      precisionPct: 80,
      interval: { lo: 66.96, hi: 88.76 },
    });
  });

  it("under 80% with few labels is already 'under 80%'; no labels waits for labels", () => {
    expect(classifierGate({ labeled: 24, right: 12 })).toMatchObject({
      status: "underPrecision",
      labelsToGo: 26,
    });
    expect(classifierGate({ labeled: 37, right: 31 })).toMatchObject({
      status: "needsLabels",
      labelsToGo: 13,
      precisionPct: 83.78,
    });
    expect(classifierGate({ labeled: 0, right: 0 })).toEqual({
      labeled: 0,
      right: 0,
      precisionPct: null,
      interval: null,
      passes: false,
      status: "needsLabels",
      labelsToGo: 50,
    });
  });
});

describe("commonMistakes", () => {
  it("most first, ties in design order, zeros dropped", () => {
    expect(
      commonMistakes(
        new Map([
          ["other", 1],
          ["wrong_asset", 2],
          ["person_not_company", 3],
          ["passing_mention", 1],
          ["promotional", 0],
        ]),
      ),
    ).toEqual([
      { reason: "person_not_company", n: 3 },
      { reason: "wrong_asset", n: 2 },
      { reason: "passing_mention", n: 1 },
      { reason: "other", n: 1 },
    ]);
  });
});

describe("researchLabelBodySchema", () => {
  it("Wrong needs a reason, Right must not have one, note is trimmed and capped", () => {
    expect(researchLabelBodySchema.safeParse({ verdict: "right" }).success).toBe(true);
    expect(
      researchLabelBodySchema.safeParse({ verdict: "wrong", reason: "wrong_type" }).success,
    ).toBe(true);
    expect(researchLabelBodySchema.safeParse({ verdict: "wrong" }).success).toBe(false);
    expect(researchLabelBodySchema.safeParse({ verdict: "right", reason: "other" }).success).toBe(
      false,
    );
    expect(
      researchLabelBodySchema.parse({ verdict: "right", note: `  ${"x".repeat(LABEL_NOTE_MAX)}  ` })
        .note,
    ).toHaveLength(LABEL_NOTE_MAX);
    expect(
      researchLabelBodySchema.safeParse({ verdict: "right", note: "x".repeat(LABEL_NOTE_MAX + 1) })
        .success,
    ).toBe(false);
    expect(researchLabelBodySchema.safeParse({ verdict: "right", extra: 1 }).success).toBe(false);
  });
});

describe("label source (#348)", () => {
  it("the body takes an optional labels/next token, never a source the client picks", () => {
    const token = "a".repeat(43);
    expect(researchLabelBodySchema.parse({ verdict: "right", labelToken: token }).labelToken).toBe(
      token,
    );
    expect(researchLabelBodySchema.safeParse({ verdict: "right", labelToken: null }).success).toBe(
      true,
    );
    for (const bad of ["", "short", "a".repeat(44), `${"a".repeat(42)}=`])
      expect(researchLabelBodySchema.safeParse({ verdict: "right", labelToken: bad }).success).toBe(
        false,
      );
    expect(researchLabelBodySchema.safeParse({ verdict: "right", source: "random" }).success).toBe(
      false,
    );
    expect(CLASSIFICATION_LABEL_SOURCES).toEqual(["random", "trace"]);
  });
});

describe("API reasons for News bot version filter codes (#303)", () => {
  it("are part of the drop reasons", () => {
    expect(RESEARCH_DROP_REASONS).toEqual(
      expect.arrayContaining([
        "newsTypeOff",
        "assetNotInVersion",
        "levelTooLow",
        "limitOpen",
        "limitDay",
        "noBalance",
        "oppositeNews",
      ]),
    );
  });
});
