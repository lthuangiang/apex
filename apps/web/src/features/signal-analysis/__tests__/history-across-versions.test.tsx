// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ResearchArticle, ResearchArticleTrace, ResearchSummary } from "@drift/shared";
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
import { feedRows, rulesSplit } from "../research/rules-history";

import {
  ARTICLES,
  ETH,
  HYPE,
  LATENCY_1D,
  PAGE_SIZE,
  SOL,
  SUMMARY_1D,
  TRACES,
} from "./news-trace-fixtures";
import { RESEARCH_TRADES } from "./research-fixtures";

// #413 (mockup docs/mockups/signal-research/history-across-versions.html): feed, phễu và trace hiện lịch sử của mọi
// version Rules. Bài version cũ có chip "Rules vN"; chỗ đổi version có dòng ngăn cách; phễu có câu "{a} articles ran on
// Rules v1 (until …), {b} on Rules v2"; trace bài cũ có banner và "counted under vN". Giờ ở Asia/Ho_Chi_Minh (UTC+7).

const V2_START = "2026-11-19T03:00:00.000Z"; // 10:00 giờ VN.
const HISTORY: ResearchSummary["rulesHistory"] = [
  { v: 1, startedAt: "2026-11-01T00:00:00.000Z", reader: "news-classifier-v1" },
  { v: 2, startedAt: V2_START, reader: "news-classifier-v2" },
];

const state = vi.hoisted(
  (): {
    current: number;
    old: ReadonlySet<string>;
    paths: string[];
  } => ({ current: 2, old: new Set(), paths: [] }),
);

/** Bài trong `state.old` thuộc Rules v1 · reader v1; còn lại v2 · reader v2. */
const tag = (a: ResearchArticle): ResearchArticle =>
  state.old.has(a.id)
    ? { ...a, rulesVersion: 1, readerVersion: "news-classifier-v1" }
    : { ...a, rulesVersion: 2, readerVersion: "news-classifier-v2" };

vi.mock("@/features/account/market-hours-time", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/account/market-hours-time")>();
  return { ...real, browserTimeZone: () => "Asia/Ho_Chi_Minh" };
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string, schema: z.ZodType) => {
      state.paths.push(path);
      const u = new URL(path, "http://x");
      const p = u.pathname;
      if (p.endsWith("/signal-research/summary")) {
        const f = SUMMARY_1D.funnel;
        if (f === null) throw new Error("fixture");
        const s: ResearchSummary = {
          ...SUMMARY_1D,
          newsRulesVersion: state.current,
          rulesHistory: HISTORY,
          funnel: {
            ...f,
            rules: [
              { v: 1, articles: 40 },
              { v: 2, articles: 18 },
            ],
          },
        };
        return Promise.resolve(schema.parse(s));
      }
      if (p.endsWith("/signal-research/latency")) return Promise.resolve(schema.parse(LATENCY_1D));
      if (p.endsWith("/signal-research/trades"))
        return Promise.resolve(schema.parse(RESEARCH_TRADES));
      if (p.endsWith("/signal-research/articles"))
        return Promise.resolve(
          schema.parse({
            items: ARTICLES.slice(0, PAGE_SIZE).map(tag),
            nextCursor: null,
            total: 58,
            totalInRange: 58,
          }),
        );
      const m = /\/signal-research\/articles\/([^/]+)\/trace$/.exec(p);
      if (m !== null) {
        const tr: ResearchArticleTrace | undefined = TRACES[decodeURIComponent(m[1] ?? "")];
        if (tr === undefined) return Promise.reject(new real.ApiError("NOT_FOUND", 404));
        return Promise.resolve(schema.parse({ ...tr, article: tag(tr.article) }));
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
  PageHead: ({ title, action }: { title: string; action?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {action}
    </header>
  ),
}));

const intlErrors: string[] = [];
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
  state.current = 2;
  state.old = new Set([SOL.id, "art-kntq"]);
  state.paths = [];
  intlErrors.length = 0;
  window.history.replaceState(null, "", "/admin/signal-analysis?tab=research");
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = (query: string) =>
    Object.assign(new EventTarget(), {
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      onchange: null,
    }) as unknown as MediaQueryList;
});
afterEach(() => {
  cleanup();
});

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

const funnel = () => screen.getByRole("region", { name: /From headline to trade/ });

async function ready() {
  wrap();
  await screen.findByRole("region", { name: /From headline to trade/ });
  await within(funnel()).findByRole("button", { name: /SEC approves in-kind creations/ });
}

describe("rules history helpers (#413)", () => {
  it("puts one divider where the Rules version changes, naming the newer version", () => {
    const items = [ETH, HYPE, SOL].map((a, i) => ({ ...a, rulesVersion: i < 2 ? 2 : 1 }));
    const rows = feedRows(items, HISTORY);
    expect(
      rows.map((r) => (r.kind === "divider" ? `divider v${String(r.start.v)}` : r.a.id)),
    ).toEqual([ETH.id, HYPE.id, "divider v2", SOL.id]);
    // Version không có trong lịch sử: vẫn có dòng ngăn cách, không có ngày / reader (không đoán).
    const unknown = feedRows(items, []);
    expect(unknown[2]).toMatchObject({
      kind: "divider",
      start: { v: 2, startedAt: null, reader: null },
    });
  });

  it("splits the funnel note only when the period has two or more Rules versions", () => {
    expect(rulesSplit({ rules: [{ v: 2, articles: 58 }] }, HISTORY)).toBeNull();
    expect(
      rulesSplit(
        {
          rules: [
            { v: 1, articles: 40 },
            { v: 2, articles: 18 },
          ],
        },
        HISTORY,
      ),
    ).toEqual([
      { v: 1, articles: 40, until: V2_START },
      { v: 2, articles: 18, until: null },
    ]);
  });
});

describe("Signal research · history across Rules versions (#413)", { timeout: 30_000 }, () => {
  it("feed: older-rules articles carry a Rules chip, one divider marks where Rules v2 started; the funnel says how many ran on each", async () => {
    await ready();
    const f = funnel();
    const chips = within(f).getAllByText("Rules v1");
    expect(chips).toHaveLength(2);
    const sol = within(f).getByRole("button", { name: /Solana Foundation flags exploit/ });
    expect(within(sol).getByText("Rules v1")).toBeInTheDocument();
    // Bài của version hiện tại không gắn chip.
    const eth = within(f).getByRole("button", { name: /SEC approves in-kind creations/ });
    expect(within(eth).queryByText(/^Rules v/)).not.toBeInTheDocument();
    const dividers = within(f).getAllByTestId("sr-rules-divider");
    expect(dividers.map((d) => d.textContent)).toEqual([
      "Rules v2 · Claude reader v2 started · Nov 19 10:00",
    ]);
    expect(within(f).getByText(/· all rules$/)).toBeInTheDocument();
    expect(within(f).getByTestId("sr-rules-split")).toHaveTextContent(
      "Last 24 h, all rules: 40 articles ran on Rules v1 (until Nov 19 10:00), 18 on Rules v2.",
    );
    expect(intlErrors).toEqual([]);
    await noViolations();
  });

  it("period buttons: Last 24 h / 7 days / 30 days; 30 days asks the API for 30d", async () => {
    await ready();
    const f = funnel();
    const group = within(f).getByRole("group", { name: "Period" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Last 24 h", "7 days", "30 days"]);
    await userEvent.click(within(group).getByRole("button", { name: "30 days" }));
    await waitFor(() => {
      expect(state.paths.some((x) => x.includes("/summary?") && x.includes("range=30d"))).toBe(
        true,
      );
      expect(state.paths.some((x) => x.includes("/articles?") && x.includes("range=30d"))).toBe(
        true,
      );
    });
  });

  it("trace of an older-rules article: banner with its Rules and reader, the trade is counted under its version", async () => {
    // Version hiện tại là v3: mọi bài fixture (v2) là lịch sử.
    state.current = 3;
    state.old = new Set();
    await ready();
    await userEvent.click(
      within(funnel()).getByRole("button", { name: /SEC approves in-kind creations/ }),
    );
    const banner = await within(funnel()).findByTestId("sr-old-rules-banner");
    expect(banner).toHaveTextContent(
      "This article ran on Rules v2 · Claude reader v2. The steps show what happened then. Today’s rules may decide differently.",
    );
    await waitFor(() => {
      expect(within(funnel()).getByText("counted under v2")).toBeInTheDocument();
    });
    expect(intlErrors).toEqual([]);
    await noViolations();
  });

  it("trace of a current-rules article has no banner and no counted-under tag", async () => {
    await ready();
    await userEvent.click(
      within(funnel()).getByRole("button", { name: /SEC approves in-kind creations/ }),
    );
    await waitFor(() => {
      expect(state.paths.some((x) => x.includes(`/articles/${ETH.id}/trace`))).toBe(true);
    });
    await within(funnel()).findByRole("heading", { name: /SEC approves in-kind creations/ });
    expect(within(funnel()).queryByTestId("sr-old-rules-banner")).not.toBeInTheDocument();
    expect(within(funnel()).queryByText(/^counted under v/)).not.toBeInTheDocument();
  });
});
