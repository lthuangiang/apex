/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import {
  DEFAULT_HOW_TAB,
  HOW_TABS,
  HelpButton,
  HowItWorksDrawer,
  HowItWorksProvider,
  type HowTab,
} from "../research/how-it-works";
import {
  HOLD_MS,
  MOVE_MS,
  STAGES,
  ease,
  endOf,
  pointAt,
  stageOfStep,
  wrapStage,
} from "../research/overview-flow";

import { CLASSIFIERS } from "./versions-fixtures";

// #391: tab Overview đầu tiên của drawer How it works (mockup docs/mockups/signal-research/how-it-works-overview.html).
// Mặc định khi mở không chỉ định tab; nút "?" vẫn mở đúng tab; bước trên sơ đồ là nút bấm bằng bàn phím; caption aria-live;
// reduced motion không tự chạy; số lấy từ hằng (file how-it-works-overview-constants.test.tsx đổi hằng); axe.

const state = vi.hoisted((): { classifiers: unknown } => ({ classifiers: null }));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string, schema: z.ZodType) => {
      const p = new URL(path, "http://x").pathname;
      if (p.endsWith("/signal-research/classifiers") && state.classifiers !== null)
        return Promise.resolve(schema.parse(state.classifiers));
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});

const intlErrors: string[] = [];

function Wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        timeZone="UTC"
        onError={(e) => {
          intlErrors.push(e.message);
        }}
      >
        {children}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

/** Trang thu nhỏ: nút "How it works" mở không chỉ định tab, nút "?" mở đúng tab, như research-tab.tsx. */
function Page() {
  const [tab, setTab] = useState<HowTab | null>(null);
  return (
    <HowItWorksProvider value={setTab}>
      <button
        type="button"
        onClick={() => {
          setTab(DEFAULT_HOW_TAB);
        }}
      >
        How it works
      </button>
      <span>
        Levels
        <HelpButton tab="levels" />
      </span>
      <HowItWorksDrawer
        tab={tab}
        onTab={setTab}
        onClose={() => {
          setTab(null);
        }}
        version={null}
        rulesVersion={3}
      />
    </HowItWorksProvider>
  );
}

function reducedMotion(on: boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({
      matches: on && q.includes("prefers-reduced-motion: reduce"),
      media: q,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

async function openDrawer() {
  render(
    <Wrap>
      <Page />
    </Wrap>,
  );
  await userEvent.click(screen.getByRole("button", { name: "How it works" }));
  return screen.findByRole("dialog", { name: "How it works" });
}

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

const caption = (dlg: HTMLElement) => within(dlg).getByTestId("hiw-caption");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  state.classifiers = null;
  Reflect.deleteProperty(window, "matchMedia");
  intlErrors.length = 0;
});

describe("overview flow geometry", () => {
  it("walks a polyline by length, eases, and wraps around the 8 stages", () => {
    const path = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 30, y: 10 },
    ];
    expect(pointAt(path, 0)).toEqual({ x: 0, y: 0 });
    expect(pointAt(path, 0.25)).toEqual({ x: 0, y: 10 });
    expect(pointAt(path, 0.5)).toEqual({ x: 10, y: 10 });
    expect(endOf(path)).toEqual({ x: 30, y: 10 });
    expect(ease(0)).toBe(0);
    expect(ease(0.5)).toBe(0.5);
    expect(ease(1)).toBe(1);
    expect(STAGES).toHaveLength(8);
    expect(wrapStage(8)).toBe(0);
    expect(wrapStage(-1)).toBe(7);
    expect(stageOfStep("score")).toBe(2);
    // Score: chấm sang Claude reader rồi quay về trục giữa.
    expect(endOf(STAGES[2]?.path ?? [])).toEqual({ x: 300, y: 240 });
  });
});

describe("How it works › Overview", { timeout: 30_000 }, () => {
  it("is the first tab and opens when no tab is asked for", async () => {
    reducedMotion(true);
    expect(HOW_TABS[0]).toBe("overview");
    const dlg = await openDrawer();
    const tabs = within(dlg).getAllByRole("tab");
    expect(tabs.map((x) => x.textContent)).toEqual([
      "Overview",
      "News types",
      "Levels",
      "Take profit / Stop loss",
      "When a signal passes",
      "Context questions",
      "Market state",
      "Versions",
      "Labels",
      "Experiments",
    ]);
    expect(within(dlg).getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const panel = within(dlg).getByRole("tabpanel");
    expect(panel).toHaveTextContent(
      "Every 5 minutes DeskLabs reads new crypto news, keeps articles about a coin listed on SoDEX, asks Claude what kind of news it is, then each running version decides whether to open a fake-money trade. A watcher closes trades at TP, SL or max hold.",
    );
    expect(within(dlg).getByTestId("hiw-never")).toHaveTextContent(
      "Never: no order is sent to SoDEX and no user money is touched.",
    );
    // Phím mũi tên trái từ Overview vòng về tab cuối, phải tới News types.
    within(dlg).getByRole("tab", { name: "Overview" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(within(dlg).getByRole("tab", { name: "News types" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{Home}");
    expect(within(dlg).getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(intlErrors).toEqual([]);
  });

  it('"?" still opens its own tab, not Overview', async () => {
    reducedMotion(true);
    render(
      <Wrap>
        <Page />
      </Wrap>,
    );
    await userEvent.click(screen.getByRole("button", { name: "How it works: Levels" }));
    const dlg = await screen.findByRole("dialog", { name: "How it works" });
    expect(within(dlg).getByRole("tab", { name: "Levels" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dlg).getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("numbers come from the shared constants; reader version from the running reader", async () => {
    reducedMotion(true);
    state.classifiers = CLASSIFIERS;
    const dlg = await openDrawer();
    const panel = within(dlg).getByRole("tabpanel");
    expect(panel).toHaveTextContent(
      "Right after Normalize, in the same 5-minute run. Oldest article first. Each article passes 4 checks before Claude sees it:",
    );
    expect(panel).toHaveTextContent("Published over 24 h ago → dropped, stale news");
    expect(panel).toHaveTextContent(
      "Over 30 min since it was published → dropped without asking Claude",
    );
    // Số lần gọi mỗi vòng và ngân sách ngày chỉnh bằng env: không có số.
    expect(panel).toHaveTextContent("This run has used its Claude calls → waits for the next run");
    expect(panel).toHaveTextContent("Today’s Claude budget is used up → dropped");
    expect(panel).toHaveTextContent("the first 4,000 characters");
    expect(panel).toHaveTextContent("the event is not over 24 h old");
    expect(panel).toHaveTextContent(
      "High needs two or more independent sources including a top one; one top source or two mid sources is Medium; otherwise Low.",
    );
    expect(await within(dlg).findByTestId("hiw-reader")).toHaveTextContent(
      "Claude reader v2 reads each article at step 3. Trades always open, but they only count once that reader has been checked: 50 random labels, at least 80% marked right. A new reader starts its count again. See Labels.",
    );
    expect(
      within(dlg).getByRole("img", { name: "Diagram of one Signal research run" }),
    ).toHaveTextContent(/Claude reader v2/);
    // Watcher: không ghi nhịp đọc giá (không cố định 1 giây).
    expect(dlg).not.toHaveTextContent(/every second/);
    expect(dlg).toHaveTextContent("keeps reading bid / ask: TP, SL, max hold");
    await userEvent.click(within(dlg).getByText("Filter", { selector: "summary span" }));
    expect(panel).toHaveTextContent(
      "One trade per story (coin + news type) per 7 days, the version’s minimum level and max source delay, fresh SoDEX prices, one open trade per coin, TP at least 2× the cost of a trade, then the version’s limits.",
    );
    expect(intlErrors).toEqual([]);
  });

  it("without reader data the version number is left out", async () => {
    reducedMotion(true);
    const dlg = await openDrawer();
    expect(within(dlg).getByTestId("hiw-reader")).toHaveTextContent(
      /^Claude reader reads each article at step 3\./,
    );
    expect(within(dlg).getByRole("img")).toHaveTextContent(/Claude reader/);
    expect(within(dlg).getByRole("img")).not.toHaveTextContent(/Claude reader v\d/);
  });

  it("each diagram step is a keyboard button that pauses and opens its list item", async () => {
    reducedMotion(false);
    const dlg = await openDrawer();
    // Không reduced motion: tự chạy.
    expect(within(dlg).getByRole("button", { name: "Pause" })).toBeInTheDocument();
    const steps = within(dlg)
      .getAllByRole("button")
      .filter((x) => x.dataset.step !== undefined);
    expect(steps.map((x) => x.getAttribute("aria-label"))).toEqual([
      "Step 1 Collect",
      "Step 2 Normalize",
      "Step 3 Score",
      "Step 4 Context",
      "Step 5 Filter",
      "Step 6 Decide",
    ]);
    const filter = document.getElementById("hiw-d-filter") as HTMLDetailsElement;
    expect(filter.open).toBe(false);
    // Bước 03 mở sẵn, có khung "When Claude is called".
    expect((document.getElementById("hiw-d-score") as HTMLDetailsElement).open).toBe(true);
    expect(within(dlg).getByTestId("hiw-when")).toHaveTextContent("When Claude is called");
    const step5 = within(dlg).getByRole("button", { name: "Step 5 Filter" });
    step5.focus();
    await userEvent.keyboard("{Enter}");
    expect(filter.open).toBe(true);
    expect(within(dlg).getByRole("button", { name: "Play" })).toBeInTheDocument();
    expect(step5).toHaveAttribute("aria-current", "step");
    expect(caption(dlg)).toHaveTextContent(
      "5 · FilterEach running version checks its own rules. A version that trades High only skips this Low signal.",
    );
    within(dlg).getByRole("button", { name: "Step 2 Normalize" }).focus();
    await userEvent.keyboard(" ");
    expect((document.getElementById("hiw-d-normalize") as HTMLDetailsElement).open).toBe(true);
    expect(caption(dlg)).toHaveTextContent(/^2 · Normalize/);
    await noViolations();
  });

  it("caption is aria-live; Previous / Next walk the 8 stages and wrap", async () => {
    reducedMotion(true);
    const dlg = await openDrawer();
    expect(caption(dlg)).toHaveAttribute("aria-live", "polite");
    expect(caption(dlg)).toHaveTextContent(/^1 · CollectA new run starts\./);
    await userEvent.click(within(dlg).getByRole("button", { name: "Previous step" }));
    expect(caption(dlg)).toHaveTextContent(
      "ResultsThe closed trade shows on this page and counts toward the 100 trades a news type needs.",
    );
    await userEvent.click(within(dlg).getByRole("button", { name: "Previous step" }));
    expect(caption(dlg)).toHaveTextContent(
      "WatcherThe watcher keeps reading SoDEX bid and ask. The ask reaches TP, so it closes the trade with the result after fees.",
    );
    await userEvent.click(within(dlg).getByRole("button", { name: "Next step" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Next step" }));
    expect(caption(dlg)).toHaveTextContent(/^1 · Collect/);
    await userEvent.click(within(dlg).getByRole("button", { name: "Next step" }));
    await userEvent.click(within(dlg).getByRole("button", { name: "Next step" }));
    expect(caption(dlg)).toHaveTextContent(
      "3 · ScorePublished 5 min ago, so Claude reads it: news type “ETF delayed”, coin SOL. The rules table sets the side to short. One low-tier source so far, so level Low.",
    );
    // Reduced motion: chấm đứng ngay ở cuối chặng, nhãn "drop" hiện luôn.
    const dot = within(dlg).getByTestId("hiw-dot");
    expect(dot).toHaveAttribute("data-x", "300");
    expect(dot).toHaveAttribute("data-y", "240");
    expect(within(dlg).getByTestId("hiw-drop")).toHaveClass("opacity-100");
  });

  it("reduced motion: does not play by itself, no running dashes", () => {
    reducedMotion(true);
    vi.useFakeTimers();
    render(
      <Wrap>
        <Page />
      </Wrap>,
    );
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    const dlg = screen.getByRole("dialog", { name: "How it works" });
    expect(within(dlg).getByRole("button", { name: "Play" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime((MOVE_MS + HOLD_MS) * 3);
    });
    expect(caption(dlg)).toHaveTextContent(/^1 · Collect/);
    // Cạnh đang đi dùng lớp sr-hiw-go: chỉ chạy nét đứt trong @media (prefers-reduced-motion: no-preference).
    const go = dlg.querySelectorAll("[data-go]");
    expect(go.length).toBeGreaterThan(0);
    for (const e of go) expect(e).toHaveClass("sr-hiw-go");
    // Bấm Play thì vẫn chạy theo nhịp đọc, chấm nhảy thẳng.
    fireEvent.click(within(dlg).getByRole("button", { name: "Play" }));
    act(() => {
      vi.advanceTimersByTime(HOLD_MS + 10);
    });
    expect(caption(dlg)).toHaveTextContent(/^2 · Normalize/);
  });

  it("without reduced motion it plays through the stages by itself", () => {
    reducedMotion(false);
    vi.useFakeTimers();
    render(
      <Wrap>
        <Page />
      </Wrap>,
    );
    fireEvent.click(screen.getByRole("button", { name: "How it works" }));
    const dlg = screen.getByRole("dialog", { name: "How it works" });
    expect(caption(dlg)).toHaveTextContent(/^1 · Collect/);
    act(() => {
      vi.advanceTimersByTime(MOVE_MS + HOLD_MS + 10);
    });
    expect(caption(dlg)).toHaveTextContent(/^2 · Normalize/);
    fireEvent.click(within(dlg).getByRole("button", { name: "Pause" }));
    act(() => {
      vi.advanceTimersByTime((MOVE_MS + HOLD_MS) * 2);
    });
    expect(caption(dlg)).toHaveTextContent(/^2 · Normalize/);
  });

  it("every block keeps its height in the scrolling drawer column (shrink-0)", async () => {
    reducedMotion(true);
    const dlg = await openDrawer();
    const list = within(dlg).getByRole("tablist", { name: "How it works sections" });
    const panel = within(dlg).getByRole("tabpanel");
    expect(list).toHaveClass("shrink-0");
    expect(panel).toHaveClass("shrink-0");
    expect(panel.children.length).toBeGreaterThanOrEqual(5);
    for (const c of panel.children) expect(c).toHaveClass("shrink-0");
    // Sơ đồ cuộn ngang trong khung riêng, không làm cả trang cuộn ngang.
    expect(within(dlg).getByTestId("hiw-flow")).toHaveClass("overflow-x-auto");
  });
});
