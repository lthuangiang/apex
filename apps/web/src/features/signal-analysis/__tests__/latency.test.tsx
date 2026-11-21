// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ResearchLatency } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { durationText, LatencyCard, LatencyTimeline, latencyRows } from "../research/latency";

import { ETH, LATENCY_1D, LATENCY_EMPTY, SOL } from "./news-trace-fixtures";

// #375: ô "Where the time goes" và dòng thời gian của thẻ Collect (mockup catalyst-latency-*). Mọi số từ API giả.

const state = vi.hoisted((): { latency: unknown; fail: boolean } => ({
  latency: null,
  fail: false,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_m: string, path: string, schema: z.ZodType) => {
      if (state.fail) return Promise.reject(new real.ApiError("INTERNAL_ERROR", 500));
      if (path.includes("/signal-research/latency"))
        return Promise.resolve(schema.parse(state.latency));
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <main>{node}</main>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

const withMs = (
  ms: Record<string, number | null>,
  total: ResearchLatency["total"] = null,
): ResearchLatency => ({
  ...LATENCY_1D,
  total,
  stages: LATENCY_1D.stages.map((s) =>
    s.key in ms ? { ...s, medianMs: ms[s.key] ?? null, n: ms[s.key] === null ? 0 : 5 } : s,
  ),
});

beforeEach(() => {
  state.latency = LATENCY_1D;
  state.fail = false;
});
afterEach(() => {
  cleanup();
});

describe("durationText", () => {
  function Probe({ ms }: { ms: number }) {
    const t = useTranslations("signalAnalysis.research");
    return <span>{durationText(ms, t)}</span>;
  }
  it("ms, s, min s, h min; never 0", () => {
    const cases: [number, string][] = [
      [0, "< 1 ms"],
      [40, "40 ms"],
      [9_000, "9 s"],
      [345_000, "5 min 45 s"],
      [120_000, "2 min"],
      [4_320_000, "1 h 12 min"],
    ];
    for (const [ms, text] of cases) {
      wrap(<Probe ms={ms} />);
      expect(screen.getByText(text)).toBeInTheDocument();
      cleanup();
    }
  });
});

describe("latencyRows", () => {
  it("source → SoSoValue is never measured; the slowest measured leg is flagged", () => {
    const rows = latencyRows(LATENCY_1D);
    expect(rows.map((r) => [r.key, r.medianMs, r.slowest])).toEqual([
      ["sourceToSoso", null, false],
      ["publishedToCollected", 345_000, true],
      ["collectedToClaudeDone", 9_000, false],
      ["claudeDoneToDecided", 1_000, false],
      ["decidedToOpened", null, false],
    ]);
    expect(latencyRows(LATENCY_EMPTY).some((r) => r.slowest)).toBe(false);
  });
});

describe("LatencyCard", () => {
  it("total is the API median of the full time with its article count; a slowest leg other than the wait has no wait explanation", async () => {
    state.latency = withMs(
      {
        publishedToCollected: 20_000,
        collectedToClaudeDone: 61_000,
        claudeDoneToDecided: 2_000,
        decidedToOpened: 40,
      },
      { medianMs: 95_000, n: 4 },
    );
    wrap(<LatencyCard range="7d" versionId={null} cycleMinutes={5} />);
    const card = await screen.findByTestId("sr-latency-total");
    // Số của API (1 min 35 s), không phải tổng các median (1 min 23 s).
    expect(card).toHaveTextContent(
      "Total, SoSoValue → paper trade opened: 1 min 35 s · median of the full time, 4 articles",
    );
    const slow = screen.getByTestId("sr-latency-slowest");
    expect(slow).toHaveTextContent("Slowest leg: Collected → Claude done.");
    expect(slow).not.toHaveTextContent("SoSoValue is checked every");
    expect(screen.getByText("median · last 7 days · 5 articles")).toBeInTheDocument();
    // Thanh chia chặng: một đoạn mỗi chặng có số, chặng chậm nhất màu cảnh báo.
    const bar = screen.getByRole("img", { name: "Median time per leg" });
    expect(bar.querySelectorAll("[data-seg]")).toHaveLength(4);
    expect(bar.querySelector("[data-seg='collectedToClaudeDone']")).toHaveClass("bg-warn-bar");
    await noViolations();
  });

  it("every leg has a median but no article has every leg: the total says Not measured yet (medians are never added)", async () => {
    state.latency = withMs({
      publishedToCollected: 20_000,
      collectedToClaudeDone: 61_000,
      claudeDoneToDecided: 2_000,
      decidedToOpened: 40,
    });
    wrap(<LatencyCard range="1d" versionId={null} cycleMinutes={5} />);
    const total = await screen.findByTestId("sr-latency-total");
    expect(total).toHaveTextContent("Total, SoSoValue → paper trade opened: Not measured yet");
    expect(total).not.toHaveTextContent("1 min 23 s");
  });

  it("nothing measured: Not measured yet on every leg, Not provided on the source leg, no bar, no slowest, never 0", async () => {
    state.latency = LATENCY_EMPTY;
    wrap(<LatencyCard range="1d" versionId={null} cycleMinutes={5} />);
    const card = await screen.findByTestId("sr-latency");
    await waitFor(() => {
      expect(within(card).getAllByText("Not measured yet")).toHaveLength(5);
    });
    expect(within(card).getByText("Not provided")).toBeInTheDocument();
    expect(within(card).queryByRole("img")).toBeNull();
    expect(within(card).queryByTestId("sr-latency-slowest")).toBeNull();
    expect(card).not.toHaveTextContent(/(^|\D)0 (s|ms)/);
    await noViolations();
  });

  // #394: số phút từ API (`cycleMinutes`), plural ICU.
  it.each([
    [1, "SoSoValue is checked every minute, so most of the delay", "waiting for the 1-min check"],
    [5, "SoSoValue is checked every 5 min, so most of the delay", "waiting for the 5-min check"],
  ])(
    "slowest leg is the wait: the cycle of %i min comes from the API",
    async (cycleMinutes, why, leg) => {
      state.latency = withMs({
        publishedToCollected: 200_000,
        collectedToClaudeDone: 6_000,
        claudeDoneToDecided: 2_000,
        decidedToOpened: 40,
      });
      wrap(<LatencyCard range="1d" versionId={null} cycleMinutes={cycleMinutes} />);
      const slow = await screen.findByTestId("sr-latency-slowest");
      expect(slow).toHaveTextContent(why);
      expect(slow).toHaveTextContent(leg);
      expect(slow).not.toHaveTextContent("1 minutes");
    },
  );

  it("API error: Not available, never 0", async () => {
    state.fail = true;
    wrap(<LatencyCard range="1d" versionId={null} cycleMinutes={null} />);
    const card = await screen.findByTestId("sr-latency");
    await waitFor(
      () => {
        expect(within(card).getAllByText("Not available")).toHaveLength(4);
        // Lỗi 5xx được thử lại một lần (api.ts) trước khi báo lỗi.
      },
      { timeout: 5000 },
    );
    expect(within(card).getByText("Not provided")).toBeInTheDocument();
    // Không biết nhịp hỏi: nhãn chặng không bịa số phút.
    expect(card).toHaveTextContent("SoSoValue → DeskLabs collected");
    expect(card).not.toHaveTextContent("-min check");
  });
});

describe("LatencyTimeline", () => {
  it("six marks with times and gaps; a decided-no-trade article never shows an open time", async () => {
    wrap(
      <LatencyTimeline
        article={SOL}
        latency={{
          claudeDoneAt: "2026-11-19T02:58:12.000Z",
          decidedAt: "2026-11-19T02:58:14.000Z",
          decision: "noTrade",
          openedAt: null,
        }}
        cycleMinutes={5}
        tz="UTC"
      />,
    );
    const tl = screen.getByTestId("sr-latency-timeline");
    expect(tl.querySelectorAll("[data-mark]")).toHaveLength(6);
    expect(tl.querySelector("[data-mark='collected']")).toHaveTextContent(
      "+5 min 35 s · waited for the 5-min check02:58:05",
    );
    expect(tl.querySelector("[data-mark='claudeDone']")).toHaveTextContent("+7 s02:58:12");
    expect(tl.querySelector("[data-mark='decided']")).toHaveTextContent(
      "Decided: no trade+2 s02:58:14",
    );
    expect(tl.querySelector("[data-mark='opened']")).toHaveTextContent("Not available");
    expect(tl).toHaveTextContent("SoSoValue → decided: 5 min 44 s");
    await noViolations();
  });

  it("an article from before the clocks: Not measured yet, the published leg says Not provided", async () => {
    wrap(
      <LatencyTimeline
        article={ETH}
        latency={{ claudeDoneAt: null, decidedAt: null, decision: null, openedAt: null }}
        cycleMinutes={5}
        tz="UTC"
      />,
    );
    const tl = screen.getByTestId("sr-latency-timeline");
    expect(tl.querySelector("[data-mark='published']")).toHaveTextContent("Not provided");
    for (const k of ["claudeDone", "decided", "opened"])
      expect(tl.querySelector(`[data-mark='${k}']`)).toHaveTextContent("Not measured yet");
    expect(tl.querySelector("[data-mark='decided']")).toHaveTextContent("Decided");
    expect(tl).not.toHaveTextContent(/\+0 /);
    await noViolations();
  });
});
