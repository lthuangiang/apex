import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { reasonText, type Tr } from "../research/text";
import { readerBadgeShown, retiredReader, rulesBadgeShown } from "../research/version-text";

import { CLASSIFIERS } from "./versions-fixtures";

// #395: nhãn "New in v4" ẩn sau 14 ngày tính từ started_at của reader v4 (API); thẻ reader cũ "Retired"; lý do ETF_MAJOR_ASSET.

const DAY = 86_400_000;
const NOW = Date.parse("2026-12-01T00:00:00Z");
const v4 = (startedAt: string | null) => [{ classifierVersion: "news-classifier-v4", startedAt }];

describe("New in vN labels (#399)", () => {
  it("the reader label follows reader v5, the Rules label stays on v4", () => {
    const rows = [
      { classifierVersion: "news-classifier-v5", startedAt: new Date(NOW - 1 * DAY).toISOString() },
      {
        classifierVersion: "news-classifier-v4",
        startedAt: new Date(NOW - 20 * DAY).toISOString(),
      },
    ];
    expect(readerBadgeShown(rows, NOW)).toBe(true);
    expect(rulesBadgeShown(rows, NOW)).toBe(false);
    expect(readerBadgeShown(v4(new Date(NOW - DAY).toISOString()), NOW)).toBe(false);
    expect(rulesBadgeShown(v4(new Date(NOW - DAY).toISOString()), NOW)).toBe(true);
  });

  it("v5 copy is PM-approved (not pending); the box title uses the reader name", () => {
    const pending = (messages as { _pendingReview?: string[] })._pendingReview ?? [];
    expect(pending).not.toEqual(
      expect.arrayContaining([
        "signalAnalysis.research.rules.reader.title",
        "signalAnalysis.research.rules.reader.titleAny",
        "signalAnalysis.research.rules.reader.stocks",
        "signalAnalysis.research.rules.newIn",
      ]),
    );
    const t = createTranslator({
      locale: "en",
      messages,
      namespace: "signalAnalysis.research.rules" as never,
    }) as unknown as (k: string, v?: Record<string, unknown>) => string;
    expect(t("reader.title", { name: "v5" })).toBe("What Claude reader v5 reads differently");
    expect(t("newIn", { name: "v5" })).toBe("New in v5");
  });
});

describe("New in v4 label (Rules v4)", () => {
  it("shows while v4 is under 14 days old, hides from day 14", () => {
    expect(rulesBadgeShown(v4(new Date(NOW - 13 * DAY).toISOString()), NOW)).toBe(true);
    expect(rulesBadgeShown(v4(new Date(NOW - 14 * DAY + 1).toISOString()), NOW)).toBe(true);
    expect(rulesBadgeShown(v4(new Date(NOW - 14 * DAY).toISOString()), NOW)).toBe(false);
    expect(rulesBadgeShown(v4(new Date(NOW - 30 * DAY).toISOString()), NOW)).toBe(false);
  });

  it("v4 that has not run yet is still new; no list or no v4 row shows nothing", () => {
    expect(rulesBadgeShown(v4(null), NOW)).toBe(true);
    expect(rulesBadgeShown(undefined, NOW)).toBe(false);
    expect(
      rulesBadgeShown([{ classifierVersion: "news-classifier-v3", startedAt: null }], NOW),
    ).toBe(false);
  });
});

describe("retired reader", () => {
  it("is the reader just before the current one, retired when the current one started", () => {
    const r = retiredReader(CLASSIFIERS.items);
    expect(r?.row.classifierVersion).toBe("news-classifier-v1");
    expect(r?.retiredAt).toBe("2026-11-19T06:00:00.000Z");
  });

  it("is null without an older reader or without the current start time (never a guessed date)", () => {
    const [cur, old] = CLASSIFIERS.items;
    if (cur === undefined || old === undefined) throw new Error("fixture");
    expect(retiredReader([cur])).toBeNull();
    expect(retiredReader([{ ...cur, startedAt: null }, old])).toBeNull();
    expect(retiredReader(undefined)).toBeNull();
  });
});

describe("ETF_MAJOR_ASSET copy", () => {
  const t = createTranslator({
    locale: "en",
    messages,
    namespace: "signalAnalysis.research" as never,
  }) as unknown as Tr;
  const tr = createTranslator({
    locale: "en",
    messages,
    namespace: "signalAnalysis.research.trace" as never,
  }) as unknown as (k: string) => string;

  it("funnel, trace label and Why it stopped", () => {
    expect(reasonText(t, "etfMajorAsset", null)).toBe("ETF on BTC or ETH");
    expect(tr("reasonLabels.etfMajorAsset")).toBe("ETF on BTC or ETH");
    expect(tr("noteReasons.etfMajorAsset")).toBe("ETF on BTC / ETH");
    expect(tr("why.etfMajorAsset")).toBe(
      "BTC and ETH already have many ETFs, so one more rarely moves the price. Rules v4 skip ETF news on these two coins.",
    );
  });
});

describe("copy approved in PM review #398", () => {
  const t = createTranslator({
    locale: "en",
    messages,
    namespace: "signalAnalysis.research" as never,
  }) as unknown as (k: string, v?: Record<string, unknown>) => string;

  it("fourth line of the reader box, the count-restart line and the Collecting pill", () => {
    expect(t("rules.reader.laundering", { b: (c: unknown) => c })).toBe(
      "Moving or laundering funds from an earlier hack is not a new hack.",
    );
    expect(t("judge.closedShortRestart", { n: "0", gate: 100 })).toBe(
      "0 / 100 · new rules and reader, count starts again",
    );
    expect(t("judge.collecting")).toBe("Collecting");
  });

  it("is not waiting for copy review", () => {
    const pending = (messages as { _pendingReview?: string[] })._pendingReview ?? [];
    expect(
      pending.filter((k) => /readerV4|Restart|judge\.collecting|etfMajorAsset/.test(k)),
    ).toEqual([]);
  });
});
