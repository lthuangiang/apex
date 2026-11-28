// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ResearchArticle, ResearchArticleTrace } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { SignalAnalysisPage } from "../components/signal-analysis-page";

import {
  EVENT_FIRST,
  EVENT_FIRST_TRACE,
  EVENT_REPOST,
  EVENT_REPOST_TRACE,
} from "./news-event-fixtures";
import { LATENCY_1D, PAGE_SIZE, SUMMARY_1D, SUMMARY_7D } from "./news-trace-fixtures";
import { RESEARCH_TRADES } from "./research-fixtures";

// #530 (news-v6) PR3: trace của sự kiện tin nêu nhiều coin và bài đăng lại "Same event" trên màn thật
// (docs/mockups/signal-research/news-event-coins.html). Cùng API giả với news-trace.test.tsx; fixture qua đúng zod schema.

const TRACES: Record<string, ResearchArticleTrace> = {
  [EVENT_FIRST.id]: EVENT_FIRST_TRACE,
  [EVENT_REPOST.id]: EVENT_REPOST_TRACE,
};
const FUNNEL = SUMMARY_1D.funnel;
if (FUNNEL === null) throw new Error("fixture");
/** Trong khoảng có lệnh là phần chia của sự kiện: ghi chú Decide "Up to 500 USDC each". */
const SUMMARY_SPLIT = {
  ...SUMMARY_1D,
  funnel: {
    ...FUNNEL,
    sizeSplit: true,
    articleStops: [
      ...FUNNEL.articleStops,
      {
        stage: "filter" as const,
        outcome: "dropped" as const,
        reason: "sameEvent" as const,
        mergeReason: null,
        n: 1,
      },
    ],
  },
};

const state = vi.hoisted(
  (): { paths: string[]; reduced: boolean; cycleMinutes: number | null | undefined } => ({
    paths: [],
    reduced: false,
    // #394: undefined = giữ `cycleMinutes` của fixture (5).
    cycleMinutes: undefined,
  }),
);

vi.mock("@/features/account/market-hours-time", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/account/market-hours-time")>();
  return { ...real, browserTimeZone: () => "Asia/Ho_Chi_Minh" };
});

function feed(q: URLSearchParams): { items: ResearchArticle[]; total: number } {
  const ARTICLES: ResearchArticle[] = [EVENT_REPOST, EVENT_FIRST];
  const show = q.get("show") ?? "all";
  const stage = q.get("stage");
  const reason = q.get("reason");
  const items = ARTICLES.filter(
    (a) =>
      (show === "all" ||
        (show === "traded" && a.outcome === "traded") ||
        (show === "dropped" && a.outcome === "dropped") ||
        (show === "claude" && a.sentToClaude)) &&
      (stage === null || a.stage === stage) &&
      (reason === null || a.reason === reason),
  );
  return { items, total: items.length };
}

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string, schema: z.ZodType) => {
      state.paths.push(path);
      const u = new URL(path, "http://x");
      const p = u.pathname;
      if (p.endsWith("/signal-research/summary")) {
        const base = u.searchParams.get("range") === "7d" ? SUMMARY_7D : SUMMARY_SPLIT;
        return Promise.resolve(
          schema.parse(
            state.cycleMinutes === undefined ? base : { ...base, cycleMinutes: state.cycleMinutes },
          ),
        );
      }
      if (p.endsWith("/signal-research/latency")) return Promise.resolve(schema.parse(LATENCY_1D));
      if (p.endsWith("/signal-research/trades"))
        return Promise.resolve(schema.parse(RESEARCH_TRADES));
      if (p.endsWith("/signal-research/articles")) {
        const { items, total } = feed(u.searchParams);
        const second = u.searchParams.get("cursor") === "a2";
        return Promise.resolve(
          schema.parse({
            items: second ? items.slice(PAGE_SIZE) : items.slice(0, PAGE_SIZE),
            nextCursor: !second && items.length > PAGE_SIZE ? "a2" : null,
            total,
            totalInRange: u.searchParams.get("range") === "7d" ? 1240 : 58,
          }),
        );
      }
      const m = /\/signal-research\/articles\/([^/]+)\/trace$/.exec(p);
      if (m !== null) {
        const tr = TRACES[decodeURIComponent(m[1] ?? "")];
        if (tr === undefined) return Promise.reject(new real.ApiError("NOT_FOUND", 404));
        return Promise.resolve(schema.parse(tr));
      }
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});
vi.mock("@/lib/use-media", () => ({ useMediaQuery: () => false }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
vi.mock("@/components/workspace", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({
    title,
    subtitle,
    action,
  }: {
    title: string;
    subtitle: ReactNode;
    action?: ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {action}
    </header>
  ),
}));

const intlErrors: string[] = [];
const scrolled: string[] = [];
function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        timeZone="UTC"
        onError={(e) => {
          intlErrors.push(e.message);
        }}
      >
        <SignalAnalysisPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.paths = [];
  state.reduced = false;
  state.cycleMinutes = undefined;
  intlErrors.length = 0;
  scrolled.length = 0;
  window.history.replaceState(null, "", "/admin/signal-analysis?tab=research");
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolled.push(this.id);
  };
  // jsdom không có matchMedia; chỉ cần `matches` cho prefers-reduced-motion.
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

async function noViolations() {
  // color-contrast tắt vì jsdom không tính được màu; cặp màu token được kiểm ở packages/ui.
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

const funnel = () => screen.getByRole("region", { name: /From headline to trade/ });
const verdict = () => within(funnel()).getByRole("status");
// #593: khối "News by market" cũng gọi `/articles?` (không có `show=`); feed luôn gửi `show=`.
const isMarketNews = (p: string) => p.includes("/articles?") && !p.includes("show=");
const lastPath = (part: string) =>
  [...state.paths].reverse().find((p) => p.includes(part) && !isMarketNews(p)) ?? "";
const card = (title: string) =>
  within(funnel()).getByRole("button", { name: new RegExp(title.replace(/[$.]/g, "\\$&")) });

async function ready() {
  wrap();
  await screen.findByRole("region", { name: /From headline to trade/ });
  await within(funnel()).findByRole("button", { name: /A major broker adds AAVE/ });
}

describe("Signal research · multi-coin news event (#530)", { timeout: 30_000 }, () => {
  it("totals: Decide note says 'Up to 500 USDC each' and 'Same event' is a drop reason", async () => {
    await ready();
    const f = funnel();
    const band = (name: string) =>
      within(f).getByRole("button", { name: `List articles that stopped at ${name}` });
    expect(band("Decide")).toHaveAttribute(
      "title",
      "Up to 500 USDC each · TP / SL from volatility",
    );
    expect(band("Filter").getAttribute("title")).toContain("1 same event");
    const drops = within(f).getByRole("group", { name: "Why they dropped out" });
    await userEvent.click(within(drops).getByRole("button", { name: "Same event · 1" }));
    await waitFor(() => {
      expect(within(f).getByText("Reason: Same event")).toBeInTheDocument();
    });
    expect(lastPath("/articles?")).toContain("reason=sameEvent");
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("first article: per-coin Filter and Decide, size split line, chip lists traded coins", async () => {
    state.reduced = true;
    await ready();
    expect(within(funnel()).getByText("Long AAVE-USD, LINK-USD · paper trade")).toBeInTheDocument();
    await userEvent.click(card("A major broker adds AAVE"));
    const f = funnel();
    await waitFor(() => {
      expect(verdict()).toHaveTextContent(
        "Reached Decide: Long AAVE-USD, 166.66 USDC · Long LINK-USD, 166.66 USDC",
      );
    });
    const bands = within(f).getByTestId("sr-funnel-bands");
    expect(bands.querySelector("[data-band='normalize']")).toHaveTextContent(
      "AAVE-USD, LINK-USD, UNI-USD · new story",
    );
    expect(bands.querySelector("[data-band='filter']")).toHaveTextContent("2 of 3 coins passed");
    expect(bands.querySelector("[data-band='decide']")).toHaveTextContent("Long 166.66 USDC × 2");
    expect(within(f).getByTestId("sr-token")).toHaveTextContent("Paper trade · AAVE-USD, LINK-USD");
    // Khung 4 · Context cạnh phễu: một khối cho mỗi coin có snapshot (nhãn market + ba cảnh của coin đó).
    const panel = within(f).getByTestId("sr-ctx-panel");
    expect(panel).toHaveAttribute("data-state", "shown");
    expect(
      within(panel)
        .getAllByTestId("sr-ctx-coin")
        .map((x) => x.getAttribute("aria-label")),
    ).toEqual(["AAVE-USD", "LINK-USD"]);
    const list = within(f).getByRole("list", { name: "Steps this article went through" });
    expect(within(list).getByText("Checked each coin on its own.")).toBeInTheDocument();
    expect(within(list).getByText("Opened paper trades on the News bot.")).toBeInTheDocument();
    expect(within(list).getByText("Size split across 3 coins from one event.")).toBeInTheDocument();
    const uni = within(list).getAllByRole("region", { name: "UNI-USD" });
    expect(uni.length).toBeGreaterThan(0);
    expect(within(list).getAllByText("Dropped: Take profit under 2× cost").length).toBe(2);
    expect(within(list).getByText("Long LINK-USD · 166.66 USDC")).toBeInTheDocument();
    // Không có mã nội bộ nào hiện ra.
    expect(f.textContent).not.toMatch(/\b[A-Z]{2,}(_[A-Z]+)+\b/);
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("repost: stops at Filter with 'Same event' and links to the first article with its date", async () => {
    state.reduced = true;
    await ready();
    await userEvent.click(card("Major broker adds COMP and AAVE"));
    const f = funnel();
    await waitFor(() => {
      expect(verdict()).toHaveTextContent(
        "Stopped at Filter: this article repeats an event that was already handled",
      );
    });
    expect(
      within(f).getByTestId("sr-funnel-bands").querySelector("[data-band='filter']"),
    ).toHaveTextContent("Same event");
    const list = within(f).getByRole("list", { name: "Steps this article went through" });
    expect(
      within(list).getByText("This article repeats an event that was already handled."),
    ).toBeInTheDocument();
    expect(within(list).getByText("First article")).toBeInTheDocument();
    expect(
      within(list).getByText("A major broker adds AAVE, LINK and UNI trading (Nov 24 22:35)"),
    ).toBeInTheDocument();
    expect(within(list).getByText("Dropped: Same event")).toHaveAttribute("title", "SAME_EVENT");
    expect(within(list).getByText("Merged: joined a story already open")).toBeInTheDocument();
    // Khung 4 · Context theo từng coin, theo thứ tự bài nêu (COMP trước).
    expect(
      within(within(f).getByTestId("sr-ctx-panel"))
        .getAllByTestId("sr-ctx-coin")
        .map((x) => x.getAttribute("aria-label")),
    ).toEqual(["COMP-USD", "AAVE-USD"]);
    await noViolations();
    expect(intlErrors).toEqual([]);
  });
});
