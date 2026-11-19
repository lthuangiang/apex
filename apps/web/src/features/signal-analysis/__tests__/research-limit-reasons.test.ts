import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { reasonText, skipText, type Tr } from "../research/text";

import { SKIPPED_TRADE } from "./research-fixtures";

// #304 (PM review PR #313): lý do giới hạn đúng như mockup, "Limit: N open" / "Limit: N per day"; dòng cũ không có N thì
// câu không có số, không bao giờ "0".

const t = createTranslator({
  locale: "en",
  messages,
  namespace: "signalAnalysis.research" as never,
}) as unknown as Tr;

describe("limit reasons", () => {
  it("show the version's limit when the API sends it", () => {
    expect(reasonText(t, "limitOpen", 20)).toBe("Limit: 20 open");
    expect(reasonText(t, "limitDay", 5)).toBe("Limit: 5 per day");
    expect(
      skipText(
        {
          ...SKIPPED_TRADE,
          skipped: { reason: "limitOpen", tpPct: null, neededPct: null, limit: 20, shadow: null },
        },
        t,
        false,
      ),
    ).toContain("Limit: 20 open");
  });

  it("fall back to a label without a number for old rows", () => {
    expect(reasonText(t, "limitOpen", null)).toBe("Limit: open trades");
    expect(reasonText(t, "limitDay", null)).toBe("Limit: trades per day");
    const s = skipText(
      {
        ...SKIPPED_TRADE,
        skipped: { reason: "limitDay", tpPct: null, neededPct: null, limit: null, shadow: null },
      },
      t,
      false,
    );
    expect(s).toContain("Limit: trades per day");
    expect(s).not.toMatch(/\d/);
  });

  it("other reasons ignore a limit", () => {
    expect(reasonText(t, "noBalance", 3)).toBe("Not enough fake balance");
  });

  it("the trace namespace has the same N forms", () => {
    const tr = createTranslator({
      locale: "en",
      messages,
      namespace: "signalAnalysis.research.trace" as never,
    }) as unknown as (k: string, v?: Record<string, number>) => string;
    expect(tr("reasonLabelsN.limitOpen", { n: 20 })).toBe("Limit: 20 open");
    expect(tr("reasonLabelsN.limitDay", { n: 5 })).toBe("Limit: 5 per day");
    expect(tr("reasonLabels.limitOpen")).toBe("Limit: open trades");
  });
});
