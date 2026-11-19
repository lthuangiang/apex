// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ResearchSignalContext } from "@drift/shared";
import { act, cleanup, render, renderHook, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { createTranslator, NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { ContextCard, ContextPanel, type ContextPanelState } from "../research/context-panel";
import { contextYesCount, h1Text, h2Text, h3Text } from "../research/context-text";
import type { Tr } from "../research/text";
import {
  bandPhase,
  CONTEXT_STEP_MS,
  DONE,
  STEP_MS,
  traceModel,
  useStepPlayer,
} from "../research/trace-player";
import { traceView } from "../research/trace-text";

import {
  CTX_AGAINST_LATE,
  CTX_BACKFILLED,
  CTX_ETH,
  CTX_NA_ASSET,
  CTX_NA_WALLETS,
  CTX_NONE,
} from "./context-fixtures";
import { ETH_TRACE, HYPE_TRACE, KNTQ_TRACE, SOL_TRACE } from "./news-trace-fixtures";

// Khung 4 · Context, thẻ bước 4 và bộ điều khiển hiệu ứng (#343). Giờ ở Asia/Ho_Chi_Minh như mockup.

const TZ = "Asia/Ho_Chi_Minh";
const t = createTranslator({
  locale: "en",
  messages,
  namespace: "signalAnalysis.research" as never,
}) as unknown as Tr;

const state = vi.hoisted(() => ({ reduced: false }));
beforeEach(() => {
  state.reduced = false;
  window.matchMedia = (query: string) =>
    Object.assign(new EventTarget(), {
      matches: query.includes("prefers-reduced-motion") ? state.reduced : false,
      media: query,
      onchange: null,
    }) as unknown as MediaQueryList;
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const intlErrors: string[] = [];
function wrap(node: ReactNode) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      timeZone="UTC"
      onError={(e) => {
        intlErrors.push(e.message);
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

function panel(c: ResearchSignalContext | null, s: ContextPanelState = "shown", asset = "ETH") {
  wrap(<ContextPanel state={s} context={c} asset={asset} tz={TZ} playKey="k" />);
  return screen.getByTestId("sr-ctx-panel");
}

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => v.id)).toEqual([]);
}

describe("context text (pure)", () => {
  it("yes count and the H1 answers, never 0 for a missing value", () => {
    expect(contextYesCount(CTX_ETH)).toBe(2);
    expect(contextYesCount(CTX_NONE)).toBe(0);
    expect(h1Text(CTX_ETH, "ETH", TZ, t)).toMatchObject({
      answer: "yes",
      badge: "Yes",
      tag: "2 whales · +$1.4M Long",
    });
    expect(h1Text(CTX_NONE, "SOL", TZ, t).tag).toBe("12 wallets checked · quiet");
    // walletsChecked là số thật đã kiểm, không phải số của leaderboard.
    const seven = { ...CTX_NONE, h1: { ...CTX_NONE.h1, walletsChecked: 7 } };
    expect(h1Text(seven, "SOL", TZ, t).text).toBe(
      "Checked 7 tracked wallets: none traded SOL in the 60 min before.",
    );
    const noCount = { ...CTX_NONE, h1: { ...CTX_NONE.h1, walletsChecked: null } };
    expect(h1Text(noCount, "SOL", TZ, t).tag).toBe("Wallets checked: Not available · quiet");
    expect(h1Text(CTX_AGAINST_LATE, "ETH", TZ, t)).toMatchObject({
      answer: "against",
      badge: "Disagree",
      tag: "1 wallet went Short · opposite",
    });
  });

  it("H1 Not available has two reasons from the API, plus the backfilled sentence", () => {
    expect(h1Text(CTX_NA_ASSET, "META", TZ, t)).toMatchObject({
      answer: "na",
      badge: "Not available",
      tag: "No whale data for META",
      text: "This asset is not on Hyperliquid, so there is no whale data. The signal is left out of the H1 comparison.",
    });
    expect(h1Text(CTX_NA_WALLETS, "ETH", TZ, t)).toMatchObject({
      tag: "No tracked wallet has data",
      text: "No tracked wallet has data, so there is no whale data. The signal is left out of the H1 comparison.",
    });
    expect(h1Text(CTX_BACKFILLED, "ETH", TZ, t)).toMatchObject({
      answer: "na",
      tag: "Not available",
      text: "Not available for backfilled signals: past wallet tracking can't be rebuilt.",
    });
  });

  it("H2 / H3: percentile ordinal, threshold by side, amber warning, Not available when missing", () => {
    expect(h2Text(CTX_NONE, t).text).toBe(
      "Funding 0.010% per 8 h · 48th percentile of 30 days · Short needs ≥ 80th",
    );
    expect(h2Text(CTX_NA_ASSET, t)).toMatchObject({ answer: "na", tag: "Funding: Not available" });
    expect(h3Text(CTX_AGAINST_LATE, t)).toMatchObject({
      answer: "yes",
      badge: "Yes · warning",
      tag: "Ran +1.1% before · late?",
      text: "+1.1% before entry · typical 1 h move 0.8% · threshold 0.8%",
    });
    expect(h3Text(CTX_NA_ASSET, t)).toMatchObject({
      answer: "na",
      tag: "Price run: Not available",
      text: "Move before entry: Not available · typical 1 h move Not available · threshold Not available",
    });
  });
});

describe("ContextPanel", () => {
  it("yes: the whale jumps with the real size, the see-saw tips, the price line is on time", async () => {
    const p = panel(CTX_ETH);
    expect(p).toHaveAttribute("data-state", "shown");
    expect(within(p).getByTestId("sr-ctx-h1")).toHaveAttribute("data-answer", "yes");
    expect(within(p).getByText("2 whales · +$1.4M Long")).toHaveClass("text-accent-ink");
    expect(within(p).getByTestId("sr-ctx-h2")).toHaveAttribute("data-answer", "yes");
    expect(within(p).getByText("+0.2% before · on time")).toBeInTheDocument();
    // Cá voi lội nền chỉ có ở No.
    expect(p.querySelectorAll(".sr-swim")).toHaveLength(0);
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("no signal (all No): sonar and two background whales that hide on reduced motion, never over the text", () => {
    const p = panel(CTX_NONE, "shown", "SOL");
    const h1 = within(p).getByTestId("sr-ctx-h1");
    expect(h1).toHaveAttribute("data-answer", "no");
    const swim = h1.querySelectorAll(".sr-swim");
    expect(swim).toHaveLength(2);
    for (const w of swim) {
      expect(w.getAttribute("class")).toContain("motion-reduce:hidden");
      expect(w.getAttribute("class")).toContain("motion-safe:animate-[sr-swim");
      expect(w).toHaveAttribute("aria-hidden", "true");
    }
    // Tag nằm trên cá voi (z-index) và đọc được ngay (không phụ thuộc hiệu ứng).
    expect(within(h1).getByText("12 wallets checked · quiet")).toHaveClass("z-[1]");
    expect(within(p).getByText("Funding p48 · no crowd")).toBeInTheDocument();
  });

  it("disagree: grey whale swims away; H3 Yes is amber, a warning", () => {
    const p = panel(CTX_AGAINST_LATE);
    expect(within(p).getByTestId("sr-ctx-h1")).toHaveAttribute("data-answer", "against");
    expect(within(p).getByText("1 wallet went Short · opposite")).toBeInTheDocument();
    expect(within(p).getByText("Ran +1.1% before · late?")).toHaveClass("bg-warn-bg", "text-warn");
    expect(p.innerHTML).not.toMatch(/text-pos|bg-pos/);
  });

  it("not available: dashed empty box with the API reason", () => {
    const p = panel(CTX_NA_ASSET, "shown", "META");
    expect(within(p).getByTestId("sr-ctx-h1")).toHaveAttribute("data-answer", "na");
    expect(within(p).getByText("No whale data for META")).toBeInTheDocument();
    expect(within(p).getByText("Funding: Not available")).toBeInTheDocument();
    expect(within(p).getByText("Price run: Not available")).toBeInTheDocument();
  });

  it("waiting, never reached and recorded-before-step-4 states", () => {
    expect(panel(CTX_ETH, "waiting")).toHaveTextContent("Waiting for the article to reach step 4…");
    cleanup();
    expect(panel(null, "notReached")).toHaveTextContent(
      "This article never reaches step 4, so no context is checked.",
    );
    cleanup();
    expect(panel(null, "missing")).toHaveTextContent(
      "This article came before step 4, so no context was recorded.",
    );
  });

  it("every effect is motion-safe only, so reduced motion shows the end frame", () => {
    const p = panel(CTX_NONE, "shown", "SOL");
    for (const el of p.querySelectorAll("[class*='animate-']"))
      expect(el.getAttribute("class")).not.toMatch(/(^|\s)animate-/);
  });
});

describe("ContextCard", () => {
  it("backfilled snapshot: Backfilled tag and the backfilled H1 sentence", async () => {
    wrap(<ContextCard context={CTX_BACKFILLED} asset="ETH" tz={TZ} />);
    expect(screen.getByText("Backfilled · does not change the trade")).toBeInTheDocument();
    expect(screen.getByTestId("sr-ctx-card-h1")).toHaveTextContent(
      "Not available for backfilled signals: past wallet tracking can't be rebuilt.",
    );
    expect(screen.getByRole("heading", { name: "4 · Context at 10:20:14" })).toBeInTheDocument();
    await noViolations();
  });

  it("exploratory values: collapsed by default; missing ones say Not available, never 0", () => {
    wrap(<ContextCard context={CTX_NONE} asset="SOL" tz={TZ} />);
    const details = screen.getByText("Exploratory values").closest("details");
    expect(details?.tagName).toBe("DETAILS");
    expect(details).not.toHaveAttribute("open");
    const row = (label: string) => screen.getByText(label).closest("div");
    expect(row("Volume vs 24 h average")).toHaveTextContent("Not available");
    expect(row("Range breakout")).toHaveTextContent("Not available");
    expect(row("Open interest")).toHaveTextContent("Not available");
  });
});

describe("band text (#343)", () => {
  it("short results for the funnel bands; the long line stays on the step card", () => {
    const v = traceView(ETH_TRACE, TZ, t);
    expect(v.steps.map((x) => x.band)).toEqual([
      "Seen 4 min after release",
      "ETH-USD · new story",
      "ETF approved → Long",
      "4 of 4 checks",
      "Long 500 USDC",
    ]);
    expect(v.steps[2]?.short).toBe("ETF approved → Long · Medium · $0.0021");
    const sol = traceView(SOL_TRACE, TZ, t);
    expect(sol.steps[3]?.band).toBe("TP 0.15% < 2× cost");
  });
});

describe("trace player and 6-band model", () => {
  it("maps the 5 API steps to 6 bands with Context as band 4", () => {
    const v = (tr: typeof ETH_TRACE) => traceView(tr, TZ, t);
    expect(traceModel(v(ETH_TRACE), ETH_TRACE.context)).toMatchObject({
      stop: 6,
      reach: "recorded",
    });
    expect(traceModel(v(SOL_TRACE), SOL_TRACE.context)).toMatchObject({
      stop: 5,
      reach: "recorded",
    });
    expect(traceModel(v(KNTQ_TRACE), null)).toMatchObject({ stop: 2, reach: "notReached" });
    expect(traceModel(v(HYPE_TRACE), null)).toMatchObject({ stop: 3, reach: "notReached" });
    // Bài trước khi có bước 4: qua Context mà không có snapshot.
    expect(traceModel(v(ETH_TRACE), null)).toMatchObject({ stop: 6, reach: "missing" });
    const m = traceModel(v(ETH_TRACE), ETH_TRACE.context);
    expect([1, 2, 3, 4, 5, 6].map((b) => m.apiIndex(b))).toEqual([0, 1, 2, null, 3, 4]);
  });

  it("band phases", () => {
    expect(bandPhase(2, 3, 6)).toBe("done");
    expect(bandPhase(3, 3, 6)).toBe("active");
    expect(bandPhase(4, 3, 6)).toBe("idle");
    expect(bandPhase(4, DONE, 2)).toBe("skip");
  });

  it("plays each step once, holds step 4 longer, stops at the end; reduced motion jumps to the end", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useStepPlayer({ ready: true, stop: 6 }));
    expect(result.current.step).toBe(DONE);
    act(() => {
      result.current.play();
    });
    expect(result.current.step).toBe(0);
    for (let i = 0; i < 4; i++)
      act(() => {
        vi.advanceTimersByTime(STEP_MS);
      });
    expect(result.current.step).toBe(4);
    act(() => {
      vi.advanceTimersByTime(STEP_MS);
    });
    expect(result.current.step).toBe(4);
    act(() => {
      vi.advanceTimersByTime(CONTEXT_STEP_MS - STEP_MS);
    });
    expect(result.current.step).toBe(5);
    for (let i = 0; i < 5; i++)
      act(() => {
        vi.advanceTimersByTime(STEP_MS);
      });
    // Dừng ở kết luận (6 tầng xong), không chạy tiếp.
    expect(result.current.step).toBe(DONE);
    const run = result.current.run;
    state.reduced = true;
    act(() => {
      result.current.play();
    });
    expect(result.current.step).toBe(DONE);
    expect(result.current.run).toBe(run + 1);
  });
});
