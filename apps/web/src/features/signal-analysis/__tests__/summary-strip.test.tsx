// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ResearchVersion, ResearchVersions } from "@drift/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { countPart, labelState, stripVersions, SummaryStrip } from "../research/summary-strip";

import { BASELINE, BASELINE_ID, V4, V4_ID, V5, V6, VERSIONS } from "./versions-fixtures";

// Dải tóm tắt của trang Signal research gọn (mockup docs/mockups/signal-research/compact-*.html): mọi trạng thái của
// dòng version và hàng nhãn. Số đến từ fixture đã qua zod; thiếu thì "Not available", không bao giờ 0.

afterEach(() => {
  cleanup();
});

const passed = (v: ResearchVersion, counted: number): ResearchVersion => ({
  ...v,
  counted,
  gate: { ...v.gate, status: "collecting", classifierStatus: "passed", labelsToGo: 0 },
});

const intlErrors: string[] = [];
function strip(
  versions: ResearchVersions | undefined,
  opts: {
    current?: ResearchVersion | null;
    weeks?: number | null;
    versionsError?: boolean;
    onLabel?: () => void;
    onManage?: () => void;
  } = {},
) {
  const current = opts.current === undefined ? BASELINE : opts.current;
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      timeZone="UTC"
      onError={(e) => {
        intlErrors.push(e.message);
      }}
    >
      <SummaryStrip
        sources={null}
        tz="UTC"
        versions={versions}
        versionsError={opts.versionsError ?? false}
        current={current}
        context={null}
        weeks={current === null ? null : { versionId: current.id, weeks: opts.weeks ?? null }}
        unrealized={null}
        onVersion={() => undefined}
        onHow={() => undefined}
        onLabel={opts.onLabel ?? (() => undefined)}
        onManage={opts.onManage ?? (() => undefined)}
      />
    </NextIntlClientProvider>,
  );
}

const lines = () =>
  within(screen.getByRole("list", { name: "Running News bot versions" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);
const row = () => screen.getByTestId("sr-label-row");

describe("summary strip: helpers", () => {
  it("stripVersions: running and paused only, at most 3, the picked one always shown", () => {
    const v7 = { ...V4, id: "00000000-0000-4000-8000-000000000007", number: 7, name: "Seven" };
    const items = [v7, V6, V5, V4, BASELINE];
    expect(stripVersions(items, BASELINE_ID).map((v) => v.number)).toEqual([3, 7, 5]);
    expect(stripVersions(items, V4_ID).map((v) => v.number)).toEqual([7, 5, 4]);
    expect(stripVersions(items, null).map((v) => v.number)).toEqual([7, 5, 4]);
    // Một version đã dừng vẫn hiện khi đang được chọn.
    expect(stripVersions(items, V6.id).map((v) => v.number)).toEqual([6, 7, 5]);
  });

  it("countPart: nothing before the Claude reader passes, counting after, verdict once decided", () => {
    expect(countPart(BASELINE, 3)).toEqual({ kind: "none" });
    expect(countPart(passed(BASELINE, 12), 3)).toEqual({ kind: "counting", n: 12, weeks: 3 });
    expect(countPart(V5, null)).toEqual({ kind: "verdict" });
  });

  it("labelState follows the current Claude reader of the versions API", () => {
    expect(labelState(null)).toEqual({ kind: "na" });
    expect(labelState(VERSIONS.classifier)).toEqual({ kind: "needs", k: 13, n: 37 });
    expect(
      labelState({ ...VERSIONS.classifier, status: "underPrecision", precisionPct: 72 }),
    ).toEqual({ kind: "under", pct: 72, n: 37 });
  });
});

describe("summary strip: states", () => {
  it("not counting yet: label row on a light blue background with Label signals and Manage versions", async () => {
    const onLabel = vi.fn();
    const onManage = vi.fn();
    strip(VERSIONS, { onLabel, onManage });
    expect(lines()).toEqual([
      "News bot · Majors only (v5) · Paused · Balance 10,105.2 · 0 open · Verdict: Passed once · repeat 40 / 100",
      "News bot · Strict subject (v4) · Running · Balance 10,000.0 · 0 open",
      "News bot · Baseline (v3) · Running · Balance 10,024.6 · 7 open · shown below",
    ]);
    expect(row()).toHaveAttribute("data-state", "needs");
    expect(row()).toHaveClass("bg-accent-tint");
    expect(row()).toHaveTextContent("Not counting yet: label 13 signals to check Claude (37 done)");
    await userEvent.click(screen.getByRole("button", { name: "Label signals" }));
    await userEvent.click(screen.getByRole("button", { name: "Manage versions" }));
    expect(onLabel).toHaveBeenCalledTimes(1);
    expect(onManage).toHaveBeenCalledTimes(1);
    const r = await axe.run(document.body, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(r.violations.map((v) => v.id)).toEqual([]);
    expect(intlErrors).toEqual([]);
  });

  it("counting: n of ~100 closed trades with ~weeks for the summary's version, time left Not available for others", () => {
    const base = passed(BASELINE, 12);
    const v4 = passed(V4, 0);
    strip(
      {
        ...VERSIONS,
        items: [v4, base],
        classifier: {
          ...VERSIONS.classifier,
          status: "passed",
          labeled: 50,
          precisionPct: 84,
          labelsToGo: 0,
        },
      },
      { current: base, weeks: 3 },
    );
    expect(lines()).toEqual([
      "News bot · Strict subject (v4) · Running · Balance 10,000.0 · 0 open · Counting: 0 of ~100 closed trades · time left Not available",
      "News bot · Baseline (v3) · Running · Balance 10,024.6 · 7 open · Counting: 12 of ~100 closed trades · ~3 weeks · shown below",
    ]);
    expect(row()).toHaveAttribute("data-state", "passed");
    expect(row()).toHaveTextContent("Claude check passed: 50 labels, 84% right · trades now count");
  });

  it("many versions: one line each, at most 3", () => {
    const extra = { ...V4, id: "00000000-0000-4000-8000-000000000008", number: 8, name: "Eight" };
    strip({ ...VERSIONS, items: [extra, V5, V4, BASELINE] });
    expect(lines()).toHaveLength(3);
    expect(lines()[0]).toMatch(/^News bot · Baseline \(v3\)/);
  });

  it("Claude reader under 80%: plain words on light amber, with Label signals", () => {
    strip({
      ...VERSIONS,
      classifier: {
        ...VERSIONS.classifier,
        status: "underPrecision",
        labeled: 40,
        precisionPct: 72,
      },
    });
    expect(row()).toHaveAttribute("data-state", "under");
    expect(row()).toHaveClass("bg-warn-bg");
    expect(row()).toHaveTextContent(
      "Not counting yet: Claude reader is right 72% of the time on 40 labels; it needs 80% on 50. Label more signals.",
    );
    expect(within(row()).getByRole("button", { name: "Label signals" })).toBeInTheDocument();
  });

  it("Not available when the versions API fails: no picker, no lines, never 0", () => {
    strip(undefined, { current: null, versionsError: true });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByText("News bot versions:").closest("p")).toHaveTextContent(
      "News bot versions: Not available",
    );
    expect(row()).toHaveAttribute("data-state", "na");
    expect(row()).toHaveTextContent("Claude check: Not available");
    expect(row()).toHaveTextContent("Context: Not available");
    expect(document.body.textContent).not.toMatch(/\b0\b/);
  });
});
