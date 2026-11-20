// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  RESEARCH_CHECKS,
  RESEARCH_DROP_REASONS,
  RESEARCH_FACTS,
  RESEARCH_LABELS,
  RESEARCH_LEVELS,
  RESEARCH_NEWS_TYPES,
  RESEARCH_SHOWS,
  RESEARCH_SOURCE_STATUSES,
  RESEARCH_SOURCES,
  RESEARCH_STATUSES,
  RESEARCH_TYPES,
  type ResearchSummary,
  type ResearchTradesPage,
} from "@drift/shared";
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
  JUDGE,
  NEWS_DETAIL,
  NEWS_ONLY_SUMMARY,
  RESEARCH_DETAIL,
  RESEARCH_SUMMARY,
  RESEARCH_TRADES,
  SKIPPED_DETAIL,
  SKIPPED_ID,
  SKIPPED_TRADE,
  V2_TRADE,
} from "./research-fixtures";
import { BASELINE_ID, CLASSIFIERS, MARKETS, V4_ID, VERSIONS } from "./versions-fixtures";

// Tab Signal research (team, #273): mọi số từ API team (#271); ở đây API giả trả fixture đã qua đúng zod schema.

type Mode =
  | "ok"
  | "forbidden"
  | "error"
  | "empty"
  | "pending"
  | "nulls"
  | "tradesEmpty"
  | "tradesError"
  | "news"
  | "one"
  | "noVersions"
  | "judge";
const state = vi.hoisted((): { mode: Mode; paths: string[] } => ({ mode: "ok", paths: [] }));

vi.mock("@/features/account/market-hours-time", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/account/market-hours-time")>();
  return { ...real, browserTimeZone: () => "Asia/Ho_Chi_Minh" };
});

// Số đếm bằng 1 (và 0) để kiểm số ít / số nhiều (ICU plural).
const BASE_FUNNEL = RESEARCH_SUMMARY.funnel;
if (BASE_FUNNEL === null) throw new Error("fixture");
const ONE: ResearchSummary = {
  ...RESEARCH_SUMMARY,
  funnel: {
    ...BASE_FUNNEL,
    days: 1,
    articlesRead: 1,
    collected: 1,
    stories: 1,
    merged: 1,
    signals: 1,
    passed: 1,
    long: 1,
    short: 0,
    drops: {
      score: { n: 1, reasons: [{ reason: "notCatalyst", n: 1 }] },
      filter: { n: 0, reasons: [] },
    },
  },
  rows: RESEARCH_SUMMARY.rows.map((r) =>
    r.type === "funding"
      ? { ...r, needs: { kind: "moreTrades" as const, more: 1, fundingDays: 1 } }
      : r.type === "news"
        ? { ...r, needs: { kind: "pooled" as const, more: 70, weeks: 1 } }
        : r,
  ),
  risk: RESEARCH_SUMMARY.risk === null ? null : { ...RESEARCH_SUMMARY.risk, windows: 1, days: 1 },
};

const NULLS: ResearchSummary = {
  ...RESEARCH_SUMMARY,
  sources: RESEARCH_SUMMARY.sources.slice(0, 1),
  bots: RESEARCH_SUMMARY.bots.map((b) => ({
    ...b,
    balance: null,
    realized: null,
    unrealized: null,
    openTrades: null,
  })),
  funnel:
    RESEARCH_SUMMARY.funnel === null
      ? null
      : {
          ...RESEARCH_SUMMARY.funnel,
          delayMedianSecs: null,
          claudeCostPerDay: null,
          claudeCost: null,
        },
  rows: RESEARCH_SUMMARY.rows.map((r) =>
    r.type === "whales" ? { ...r, randomPct: null, diffPct: null, range: null } : r,
  ),
  costPct: null,
  risk: null,
};
const NULL_TRADES: ResearchTradesPage = {
  items: RESEARCH_TRADES.items.map((x) =>
    x.id === "sr-0001"
      ? {
          ...x,
          movedBeforePct: null,
          result: { outcome: "tp", leftSecs: null, pnl: null, unrealized: null },
        }
      : x.result?.outcome === "open"
        ? // #297: lệnh đang mở chưa có giá SoDEX → thẻ ghi "Open", không bao giờ 0.
          { ...x, result: { ...x.result, unrealized: null } }
        : x,
  ),
  nextCursor: null,
};

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string, schema: z.ZodType) => {
      state.paths.push(path);
      const p = new URL(path, "http://x").pathname;
      const m = state.mode;
      if (m === "forbidden") return Promise.reject(new real.ApiError("FORBIDDEN", 403));
      if (m === "pending") return new Promise(() => undefined);
      // #306: News bot versions (thẻ, bảng) có test riêng ở versions.test.tsx.
      if (m === "noVersions" && (p.endsWith("/versions") || p.endsWith("/classifiers")))
        return Promise.reject(new real.ApiError("INTERNAL_ERROR", 500));
      if (p.endsWith("/signal-research/versions")) return Promise.resolve(schema.parse(VERSIONS));
      if (p.endsWith("/signal-research/classifiers"))
        return Promise.resolve(schema.parse(CLASSIFIERS));
      if (p.endsWith("/signal-research/markets")) return Promise.resolve(schema.parse(MARKETS));
      if (p.endsWith("/signal-research/summary")) {
        if (m === "error") return Promise.reject(new real.ApiError("INTERNAL_ERROR", 500));
        if (m === "empty")
          return Promise.resolve(
            schema.parse({
              ...RESEARCH_SUMMARY,
              sources: [],
              bots: [],
              funnel: null,
              rows: [],
              levels: [],
            }),
          );
        return Promise.resolve(
          schema.parse(
            m === "nulls"
              ? NULLS
              : m === "one"
                ? ONE
                : m === "news"
                  ? NEWS_ONLY_SUMMARY
                  : m === "judge"
                    ? JUDGE
                    : RESEARCH_SUMMARY,
          ),
        );
      }
      if (p.endsWith("/signal-research/trades")) {
        if (m === "tradesError") return Promise.reject(new real.ApiError("INTERNAL_ERROR", 500));
        if (m === "tradesEmpty")
          return Promise.resolve(schema.parse({ items: [], nextCursor: null }));
        if (m === "nulls") return Promise.resolve(schema.parse(NULL_TRADES));
        if (m === "judge") {
          // Lệnh rules v2 chỉ khi bật "Show older rules" (olderRules=true).
          const older = new URL(path, "http://x").searchParams.get("olderRules") === "true";
          return Promise.resolve(
            schema.parse({
              items: older ? [RESEARCH_TRADES.items[0], V2_TRADE] : [RESEARCH_TRADES.items[0]],
              nextCursor: null,
            }),
          );
        }
        if (m === "news") {
          // #278: chỉ News live có dữ liệu; loại khác hoặc label=replay → trang rỗng.
          const q = new URL(path, "http://x").searchParams;
          const other = (q.get("type") ?? "news") !== "news" || q.get("label") === "replay";
          return Promise.resolve(
            schema.parse(
              other
                ? { items: [], nextCursor: null }
                : { items: [RESEARCH_TRADES.items[0], SKIPPED_TRADE], nextCursor: null },
            ),
          );
        }
        return Promise.resolve(schema.parse(RESEARCH_TRADES));
      }
      // News feed / trace (#292) có test riêng ở news-trace.test.tsx; ở đây feed rỗng.
      if (p.endsWith("/signal-research/articles"))
        return Promise.resolve(
          schema.parse({ items: [], nextCursor: null, total: 0, totalInRange: 0 }),
        );
      if (p.includes("/signal-research/trades/")) {
        if (p.endsWith("/sr-0004"))
          return Promise.resolve(schema.parse({ ...NEWS_DETAIL, trade: RESEARCH_TRADES.items[3] }));
        if (m !== "news") return Promise.resolve(schema.parse(RESEARCH_DETAIL));
        return Promise.resolve(schema.parse(p.endsWith(SKIPPED_ID) ? SKIPPED_DETAIL : NEWS_DETAIL));
      }
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});
// Bộ lọc Bot dùng bộ chọn của Trading Agent (#289): desktop; danh sách market / me không cần cho trang này.
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
  state.mode = "ok";
  state.paths = [];
  intlErrors.length = 0;
  window.history.replaceState(null, "", "/admin/signal-analysis?tab=research");
});
afterEach(() => {
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

const region = (name: string | RegExp) => screen.getByRole("region", { name });

describe("Signal research tab", { timeout: 30_000 }, () => {
  it("is a fourth tab, opened from ?tab=research, with the research-only note", async () => {
    wrap();
    const tab = await screen.findByRole("tab", { name: "Signal research" });
    expect(tab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Team only.")).toBeInTheDocument();
    // #342: dải cảnh báo nổi (token warn) và chip "Prices from mainnet" thay "Read only" ở tab này.
    const note = screen.getByText("Research only · fake money").closest("[role=note]");
    if (!(note instanceof HTMLElement)) throw new Error("banner");
    expect(note).toHaveClass("bg-warn-bg", "text-warn", "border-warn-border");
    expect(within(note).getByText("Research only · fake money")).toBeInTheDocument();
    expect(within(note).getByText("Nothing here is sent to SoDEX.")).toBeInTheDocument();
    expect(screen.getByText("Prices from mainnet")).toBeInTheDocument();
    expect(screen.queryByText("Read only")).not.toBeInTheDocument();
    expect(screen.getByText(/Times in your time zone: Asia\/Ho_Chi_Minh/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Volume Builder/ }));
    expect(window.location.search).toBe("?tab=vb");
  });

  it("sources show Live / Delayed / Down with the replay gap left out", async () => {
    wrap();
    // #342: nguồn nằm trong dải "Research only · fake money" (ẩn dưới 768px như mockup 390).
    const src = await screen.findByRole("list", { name: "Sources" });
    expect(src).toHaveClass("max-md:hidden");
    expect(within(src).getByText("SoSoValue news · Live · 2 min ago")).toBeInTheDocument();
    expect(within(src).getByText("Macro calendar · Live")).toBeInTheDocument();
    expect(
      within(src).getByText(/Whale events · last replay 01:00, 2 h gap Nov 16 left out/),
    ).toBeInTheDocument();
    expect(within(src).getByText("Status: Delayed.")).toBeInTheDocument();
    expect(within(src).getByText(/Funding rates · replayed 01:00/)).toBeInTheDocument();
    expect(within(src).getByText(/^Claude · Delayed · /)).toBeInTheDocument();
  });

  it("paper bots: News bot versions, replay bots with balance, last run and rule version", async () => {
    wrap();
    await screen.findByRole("region", { name: "Paper bots" });
    const bots = region("Paper bots");
    // #306: lane News là các News bot version; Baseline có balance của API versions.
    const baseline = await within(bots).findByRole("article", { name: "News bot v3 · Baseline" });
    expect(within(baseline).getByText("10,024.6")).toBeInTheDocument();
    // #297: "+$3.25 unrealized" của tổng kết, chỉ trên thẻ của version mà tổng kết mô tả.
    expect(within(baseline).getByText("+$3.25 unrealized")).toBeInTheDocument();
    const v4 = within(bots).getByRole("article", { name: "News bot v4 · Strict subject" });
    expect(within(v4).queryByText(/unrealized/)).not.toBeInTheDocument();
    expect(within(bots).getByText("01:00 · 23 trades")).toBeInTheDocument();
    expect(within(bots).getByText("9,623.4")).toBeInTheDocument();
  });

  it("the per-level table sits under Is it working? › By level and says Not enough trades, never 0", async () => {
    wrap();
    await screen.findByRole("region", { name: "Is it working?" });
    // #342: khối "What counts as a news signal" không còn trên trang (nội dung ở drawer How it works).
    expect(
      screen.queryByRole("region", { name: "What counts as a news signal" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Short the affected token")).not.toBeInTheDocument();
    const r = region("Is it working?");
    // #344: bảng theo mức ở tab By level.
    expect(within(r).queryByRole("table", { name: "Results by level at entry" })).toBeNull();
    await userEvent.click(within(r).getByRole("tab", { name: "By level" }));
    const lv = within(r).getByRole("table", { name: "Results by level at entry" });
    expect(within(lv).getAllByText("Not enough trades")).toHaveLength(3);
    expect(within(lv).getByText("Needs 87 more closed")).toBeInTheDocument();
    expect(within(lv).getByText(/8 later reached High/)).toBeInTheDocument();
    expect(within(lv).getByText("14 · 10")).toBeInTheDocument();
  });

  it("Overall: mockup columns, average after fees with its range, random-entry difference, status, what it still needs, risk filter", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Where each signal type stands" });
    expect(
      within(tbl)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Signal type", "Closed trades", "Average after fees", "vs random entry", "Status"]);
    const whales = within(tbl).getByRole("row", { name: /Whales · Replay/ });
    expect(within(whales).getByText("+0.21%")).toBeInTheDocument();
    expect(within(whales).getByText("+0.19%")).toBeInTheDocument();
    expect(within(whales).getByText(/better/)).toBeInTheDocument();
    expect(within(whales).getByText("−0.05% to +0.47% · 41 days")).toBeInTheDocument();
    expect(within(whales).getByText("Failing")).toBeInTheDocument();
    const news = within(tbl).getByRole("row", { name: /News · Live paper/ });
    expect(within(news).getByText("41 opened")).toBeInTheDocument();
    expect(
      within(news).getByText("About 70 more closed (all news pooled) · first verdict in ~3 weeks"),
    ).toBeInTheDocument();
    expect(
      within(tbl).getByText("36 more trades. SoDEX funding covers 41 days."),
    ).toBeInTheDocument();
    expect(within(tbl).getByText("−0.18% to 0.00% · 41 days")).toBeInTheDocument();
    // Long / Short của News · live paper.
    const dir = screen.getByRole("table", { name: "Long and short results for News · Live paper" });
    const [, long, short] = within(dir).getAllByRole("row");
    if (long === undefined || short === undefined) throw new Error("rows");
    // PM (#358): dưới 30 lệnh đóng, Long / Short không hiện trung bình (API có +0.18% cho 21 lệnh Long).
    expect(within(long).queryByText("+0.18%")).not.toBeInTheDocument();
    expect(within(long).getByText("Not enough trades · needs 9 more")).toBeInTheDocument();
    expect(within(long).queryByText("−0.12% to +0.48%")).not.toBeInTheDocument();
    expect(within(short).getByText("Not enough trades · needs 21 more")).toBeInTheDocument();
    expect(
      screen.getByText("Long · 21 trades · Not enough trades · needs 9 more"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Short · 9 trades · Not enough trades · needs 21 more"),
    ).toBeInTheDocument();
    expect(screen.getByText(/cost of a trade ≈ 0.10%/)).toBeInTheDocument();
    expect(
      screen.getByText(
        /64 big-news windows of the last 30 days, the cost per \$1M would have been 6% lower and volume 3% lower\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("FOMC · Nov 19, 01:45–02:45")).toBeInTheDocument();
    // Thẻ cho điện thoại: cùng số.
    expect(screen.getByText("Replay · 312 trades · +0.21% (−0.05% to +0.47%)")).toBeInTheDocument();
    expect(screen.getByText("Live paper · 30 trades · needs 70 more")).toBeInTheDocument();
  });

  it("trades: entered by default, moved before entry, level at entry, skipped reasons on All, cursor Load more", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    expect(
      state.paths.some((p) => p.includes("/signal-research/trades?") && p.includes("show=entered")),
    ).toBe(true);
    const sol = within(tbl).getByRole("row", { name: /SEC delays decision on SOL ETF/ });
    expect(within(sol).getByText("22:35:02")).toBeInTheDocument();
    expect(within(sol).getByText("3 min after release")).toBeInTheDocument();
    expect(within(sol).getByText("−0.6%")).toBeInTheDocument();
    expect(within(sol).getByText("143.60")).toBeInTheDocument();
    expect(within(sol).getByText("+$9.50")).toBeInTheDocument();
    expect(within(sol).getByText("Hit take profit")).toBeInTheDocument();
    expect(within(sol).getByText("Medium")).toBeInTheDocument();
    expect(within(sol).getByText(/later High \(3 sources\)/)).toBeInTheDocument();
    const eth = within(tbl).getByRole("row", { name: /Wallet ··9c3fa1e2 opened long, \$1\.2M/ });
    expect(within(eth).getByText("price 31 s after the fill")).toBeInTheDocument();
    expect(within(eth).getByText("31 s after the whale’s fill")).toBeInTheDocument();
    expect(within(tbl).getByText("Open · 2 d 4 h left")).toBeInTheDocument();
    // #297: lệnh đang mở hiện lãi / lỗ chưa chốt theo giá SoDEX; tiêu đề cắt 2 dòng, đủ trong title.
    expect(within(tbl).getByText("+$2.17 unrealized")).toBeInTheDocument();
    const solTitle = within(sol).getByRole("button", { name: "SEC delays decision on SOL ETF" });
    expect(solTitle).toHaveAttribute("title", "SEC delays decision on SOL ETF");
    expect(solTitle).toHaveClass("line-clamp-2");
    expect(tbl).toHaveClass("xl:table-fixed");
    // Lệnh vào ở lần thử lại (#278): nhãn Retry có tooltip; độ trễ tính từ bài đầu.
    const nvda = within(tbl).getByRole("row", { name: /Nvidia raises/ });
    const retry = within(nvda).getByText("Retry");
    expect(retry).toHaveAttribute(
      "title",
      "Opened on a later article of the same story, within 2 hours of the first one.",
    );
    expect(within(nvda).getByText("1 h 35 min after the first article")).toBeInTheDocument();
    expect(within(sol).queryByText("Retry")).not.toBeInTheDocument();
    expect(
      within(tbl).getByText("Skipped: take profit under 2× cost (0.15% vs 0.20% needed)"),
    ).toBeInTheDocument();
    expect(
      within(tbl).getByText("Skipped: a Funding trade on ETH is already open"),
    ).toBeInTheDocument();
    expect(within(tbl).getAllByText("Not traded")).toHaveLength(2);

    await userEvent.click(screen.getByRole("radio", { name: "All" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Signal type" }), "news");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Tested as" }), "live");
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Asset" }), "SOL");
    await waitFor(() => {
      const last = [...state.paths].reverse().find((p) => p.includes("/trades?")) ?? "";
      expect(last).toContain("show=all");
      expect(last).toContain("type=news");
      expect(last).toContain("label=live");
      expect(last).toContain("asset=SOL");
    });
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(state.paths.some((p) => p.includes("cursor=c2"))).toBe(true);
    });
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("times follow Show in UTC", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    expect(within(tbl).getByText("22:35:02")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show in UTC" }));
    await waitFor(() => {
      expect(
        within(screen.getByRole("table", { name: "Signal research trades" })).getByText("15:35:02"),
      ).toBeInTheDocument();
    });
    // API trả giờ UTC và bỏ qua tz (#278): đổi múi giờ không gửi lại request, web tự đổi giờ.
    expect(state.paths.some((p) => p.includes("tz="))).toBe(false);
  });

  it("with the #278 data (News live only): Not available where the API has nothing, empty replay lists", async () => {
    state.mode = "news";
    wrap();
    const src = await screen.findByRole("list", { name: "Sources" });
    expect(within(src).getAllByRole("listitem")).toHaveLength(2);
    const bots = region("Paper bots");
    expect(
      await within(bots).findByRole("article", { name: "News bot v3 · Baseline" }),
    ).toBeInTheDocument();
    expect(within(bots).queryByText("Whales bot")).not.toBeInTheDocument();
    const tbl = screen.getByRole("table", { name: "Where each signal type stands" });
    expect(within(tbl).getAllByRole("row")).toHaveLength(2);
    // Risk filter null → Not available (dải desktop, cửa sổ kế tiếp, dòng mobile).
    expect(screen.getAllByText("Not available").length).toBeGreaterThanOrEqual(3);
    await screen.findByRole("table", { name: "Signal research trades" });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Tested as" }), "replay");
    expect(await screen.findByText("No trades match these filters")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(
      await screen.findByRole("table", { name: "Signal research trades" }),
    ).toBeInTheDocument();
    expect(intlErrors).toEqual([]);
  });

  it("News detail from #278: no Scored step, article source, event date, moved before entry, result move, MFE / MAE Not available", async () => {
    state.mode = "news";
    wrap();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    await userEvent.click(
      within(tbl).getByRole("button", { name: "SEC delays decision on SOL ETF" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("News · Live paper · rules v2")).toBeInTheDocument();
    const steps = within(dialog).getByRole("list", { name: "Steps this signal went through" });
    expect(
      within(steps)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(["Received", "Understood", "Checks", "Trade", "Result"]);
    expect(within(dialog).getByText("CoinDesk")).toBeInTheDocument();
    expect(within(dialog).getByText("22:35:02 · 3 min late")).toBeInTheDocument();
    expect(within(dialog).getByText("Nov 18")).toBeInTheDocument();
    expect(within(dialog).getByText("Medium · 1 source")).toBeInTheDocument();
    expect(within(dialog).getByText("Moved before entry")).toBeInTheDocument();
    expect(within(dialog).getByText("−0.6%")).toBeInTheDocument();
    expect(within(dialog).getByText("139.34 at 09:15:03 · take profit")).toBeInTheDocument();
    expect(within(dialog).getByText("−$0.50")).toBeInTheDocument();
    expect(within(dialog).getByText("Best move for us").closest("div")).toHaveTextContent(
      "Not available",
    );
    expect(within(dialog).getByText("+2.00% · $10.00")).toBeInTheDocument();
    expect(within(dialog).getByText("−0.04% average")).toBeInTheDocument();
    expect(within(dialog).getByText("Worst move against").closest("div")).toHaveTextContent(
      "Not available",
    );
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("a trade opened on a retry shows the Retry tag in the detail header", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    await userEvent.click(
      within(tbl).getByRole("button", { name: "Nvidia raises its revenue growth forecast" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Retry")).toHaveAttribute(
      "title",
      "Opened on a later article of the same story, within 2 hours of the first one.",
    );
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("a skipped signal opens too; its steps stop at the failed check", async () => {
    state.mode = "news";
    wrap();
    await screen.findByRole("table", { name: "Signal research trades" });
    await userEvent.click(screen.getByRole("radio", { name: "All" }));
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    await userEvent.click(
      within(tbl).getByRole("button", { name: "Exchange lists BTC perpetuals" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("Skipped: take profit under 2× cost (0.15% vs 0.20% needed)"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Take profit 0.15% is under 2× the cost (0.10%)"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("heading", { name: "Trade" })).not.toBeInTheDocument();
    expect(state.paths.some((p) => p.endsWith(`/trades/${SKIPPED_ID}`))).toBe(true);
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("trade detail opens as a dialog with the steps it went through", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    await userEvent.click(
      within(tbl).getByRole("button", { name: /Wallet ··9c3fa1e2 opened long/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("Whales · Replay · rules v1")).toBeInTheDocument();
    expect(within(dialog).getByText("Long ETH")).toBeInTheDocument();
    expect(within(dialog).getByText(/hit stop loss after 1 h 48 min/)).toBeInTheDocument();
    expect(within(dialog).getByText("−$3.01")).toBeInTheDocument();
    const steps = within(dialog).getByRole("list", { name: "Steps this signal went through" });
    for (const s of ["Received", "Understood", "Scored · 0.78", "Checks", "Trade", "Result"])
      expect(within(steps).getByRole("heading", { name: s })).toBeInTheDocument();
    expect(within(dialog).getByText("21:12:44 · 31 s later")).toBeInTheDocument();
    expect(within(dialog).getByText("Whale events, synced every 30 s")).toBeInTheDocument();
    expect(within(dialog).getByText("$1.2M · 3.4× this wallet’s usual")).toBeInTheDocument();
    expect(within(dialog).getByText("Top 20, 61% profitable months")).toBeInTheDocument();
    expect(
      within(dialog).getByText("Other whales same way, 30 min (weight 25)"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Take profit 1.0% is at least 2× the cost (0.20%)"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("3,395.4 at 23:00:31 · stop loss")).toBeInTheDocument();
    expect(within(dialog).getByText("3,446.6 (+1.0%)")).toBeInTheDocument();
    expect(within(dialog).getByText("−0.50% · −$2.51")).toBeInTheDocument();
    expect(within(dialog).getByText("3,408.9 · we paid 0.11% more")).toBeInTheDocument();
    expect(within(dialog).getByText(/in since Oct 2/)).toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("missing values show Not available, never 0", async () => {
    state.mode = "nulls";
    wrap();
    await screen.findByRole("region", { name: "Paper bots" });
    const bots = region("Paper bots");
    // Whales balance, Funding balance, Price patterns balance (lane News: News bot versions).
    expect(within(bots).getAllByText("Not available").length).toBeGreaterThanOrEqual(3);
    // Số dư thiếu không bao giờ thành "0.0". (Số đếm 0 thật của API versions, như Closed 0, vẫn hiện: từ #342 danh sách
    // version tải ngay ở đầu trang.)
    expect(within(bots).queryByText(/^0\.0$/)).not.toBeInTheDocument();
    const f = region(/From headline to trade/);
    expect(within(f).getAllByText("Not available")).toHaveLength(2);
    const tbl = screen.getByRole("table", { name: "Where each signal type stands" });
    const whales = within(tbl).getByRole("row", { name: /Whales/ });
    expect(within(whales).getAllByText("Not available")).toHaveLength(2);
    expect(screen.getByText(/cost of a trade ≈ Not available/)).toBeInTheDocument();
    const trades = await screen.findByRole("table", { name: "Signal research trades" });
    const sol = within(trades).getByRole("row", { name: /SEC delays decision/ });
    expect(within(sol).getAllByText("Not available")).toHaveLength(2);
    expect(within(sol).queryByText("$0.00")).not.toBeInTheDocument();
    expect(screen.getByText("Open", { selector: "b" })).toBeInTheDocument();
    expect(screen.queryByText(/unrealized/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("shows loading, error with retry and empty states", async () => {
    state.mode = "pending";
    const a = wrap();
    expect(await screen.findByText("Loading signal research…")).toBeInTheDocument();
    a.unmount();
    state.mode = "error";
    const b = wrap();
    expect(
      await screen.findByText("Couldn’t load the analysis", {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    b.unmount();
    state.mode = "empty";
    const c = wrap();
    expect(await screen.findByText("No signal research data yet")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing has been collected or replayed yet. Nothing is sent to SoDEX."),
    ).toBeInTheDocument();
    await noViolations();
    c.unmount();
    state.mode = "tradesEmpty";
    const d = wrap();
    expect(
      await screen.findByText("No trades match these filters", {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    d.unmount();
    state.mode = "tradesError";
    wrap();
    expect(
      await screen.findByText("Couldn’t load trades.", {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(intlErrors).toEqual([]);
  });

  it("counts use singular and plural forms (1 trade, 1 day)", async () => {
    state.mode = "one";
    wrap();
    const tbl = await screen.findByRole("table", { name: "Where each signal type stands" });
    expect(within(tbl).getByText("1 more trade. SoDEX funding covers 1 day.")).toBeInTheDocument();
    expect(
      within(tbl).getByText("About 70 more closed (all news pooled) · first verdict in ~1 week"),
    ).toBeInTheDocument();
    expect(screen.getByText(/in the 1 big-news window of the last day,/)).toBeInTheDocument();
    expect(intlErrors).toEqual([]);
  });

  it("tells people outside the team the page is team only", async () => {
    state.mode = "forbidden";
    wrap();
    expect(
      await screen.findByText("Signal Analysis is for the DeskLabs team only."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("every enum value from the API has its English text in en.json", () => {
    const r = messages.signalAnalysis.research;
    const has = (o: object, keys: readonly string[]) => {
      for (const k of keys) expect(Object.keys(o)).toContain(k);
    };
    has(r.reasons, RESEARCH_DROP_REASONS);
    has(r.trades.newsTypes, RESEARCH_NEWS_TYPES);
    has(r.detail.facts, RESEARCH_FACTS);
    has(r.detail.checks, RESEARCH_CHECKS);
    has(r.sources.names, RESEARCH_SOURCES);
    has(r.types, RESEARCH_TYPES);
    has(r.labels, RESEARCH_LABELS);
    has(r.levels, RESEARCH_LEVELS);
    has(r.status, RESEARCH_STATUSES);
    has(r.sources.status, RESEARCH_SOURCE_STATUSES);
    has(r.trades.shows, RESEARCH_SHOWS);
  });
});

// #342: đầu trang mới (bộ chọn Version cho cả trang, Progress, How it works). Thiết kế
// docs/mockups/signal-research/redesign-full-page*.html.
describe("Signal research page shell (#342)", { timeout: 30_000 }, () => {
  const picker = () => screen.findByRole("combobox", { name: "Version" });
  const progress = () => screen.getByRole("navigation", { name: "Progress" });

  it("one Version picker drives the page and lives in ?version=", async () => {
    wrap();
    const sel = await picker();
    expect(sel).toHaveValue(BASELINE_ID);
    expect(
      within(sel)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["v6 · Wider stops", "v5 · Majors only", "v4 · Strict subject", "Baseline (v3)"]);
    expect(window.location.search).toBe("?tab=research");
    state.paths = [];
    await userEvent.selectOptions(sel, V4_ID);
    expect(new URLSearchParams(window.location.search).get("version")).toBe(V4_ID);
    await waitFor(() => {
      for (const p of ["/summary?", "/articles?", "/trades?"])
        expect(state.paths.some((x) => x.includes(p) && x.includes(`versionId=${V4_ID}`))).toBe(
          true,
        );
    });
    // Thẻ version vẫn chọn được, và đổi cả bộ chọn lẫn URL.
    const bots = region("Paper bots");
    const base = await within(bots).findByRole("article", { name: "News bot v3 · Baseline" });
    await userEvent.click(within(base).getByRole("button", { name: "News bot v3 · Baseline" }));
    expect(await picker()).toHaveValue(BASELINE_ID);
    expect(new URLSearchParams(window.location.search).get("version")).toBe(BASELINE_ID);
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("opens on the version from the URL; an unknown id falls back to Baseline", async () => {
    window.history.replaceState(null, "", `/admin/signal-analysis?tab=research&version=${V4_ID}`);
    const a = wrap();
    expect(await picker()).toHaveValue(V4_ID);
    await waitFor(() => {
      expect(state.paths.some((x) => x.includes(`/summary?`) && x.includes(V4_ID))).toBe(true);
    });
    a.unmount();
    const gone = "00000000-0000-4000-8000-0000000000ff";
    window.history.replaceState(null, "", `/admin/signal-analysis?tab=research&version=${gone}`);
    wrap();
    expect(await picker()).toHaveValue(BASELINE_ID);
    await waitFor(() => {
      expect(new URLSearchParams(window.location.search).get("version")).toBeNull();
    });
  });

  it("Progress: closed trades, classifier labels, context and open trades, each a link", async () => {
    wrap();
    await picker();
    const p = progress();
    const links = within(p).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["0 of ~100 closed trades", "#sr-sum"],
      ["Classifier v2: 37 of 50 labels · 84% right", "#sr-labels"],
      ["Context: Not available", "#sr-sum"],
      ["7 open trades", "#sr-trades"],
    ]);
    // Theo version đang chọn.
    await userEvent.selectOptions(await picker(), V4_ID);
    expect(within(progress()).getByRole("link", { name: "0 open trades" })).toBeInTheDocument();
  });

  it("Progress says Not available when the versions and classifier APIs fail, never 0", async () => {
    state.mode = "noVersions";
    wrap();
    await screen.findByRole("region", { name: "Is it working?" });
    await waitFor(() => {
      expect(
        within(progress())
          .getAllByRole("link")
          .map((l) => l.textContent),
      ).toEqual([
        "Closed trades: Not available",
        "Classifier: Not available",
        "Context: Not available",
        "Open trades: Not available",
      ]);
    });
    expect(screen.queryByRole("combobox", { name: "Version" })).not.toBeInTheDocument();
    expect(intlErrors).toEqual([]);
  });

  it("How it works: never opens by itself, tabs follow the picked version, Esc closes and returns focus", async () => {
    wrap();
    await picker();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "How it works" });
    await userEvent.click(btn);
    const dlg = await screen.findByRole("dialog", { name: "How it works" });
    expect(dlg).toHaveAccessibleDescription("Rules of Baseline (v3).");
    const tabs = within(dlg).getAllByRole("tab");
    expect(tabs.map((x) => x.textContent)).toEqual([
      "News types",
      "Levels",
      "Take profit / Stop loss",
      "The gate",
      "Context questions",
      "Versions",
    ]);
    expect(within(dlg).getByRole("tab", { name: "News types" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const types = within(dlg).getByRole("table", { name: "News types, direction and max hold" });
    expect(within(types).queryByText("Off")).not.toBeInTheDocument();
    // Focus giữ trong drawer.
    for (let i = 0; i < 12; i++) {
      await userEvent.tab();
      expect(dlg.contains(document.activeElement)).toBe(true);
    }
    // Phím mũi tên đổi tab.
    within(dlg).getByRole("tab", { name: "News types" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(within(dlg).getByRole("tab", { name: "Levels" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(dlg).getByText(/This version trades level/)).toHaveTextContent(
      "This version trades level Low and up.",
    );
    await noViolations();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(btn).toHaveFocus();

    // Version khác: luật của version đó (v4 tắt Treasury, level Medium trở lên).
    await userEvent.selectOptions(await picker(), V4_ID);
    await userEvent.click(btn);
    const d2 = await screen.findByRole("dialog", { name: "How it works" });
    expect(d2).toHaveAccessibleDescription("Rules of v4 · Strict subject.");
    expect(within(d2).getAllByText("Off")).toHaveLength(2);
    await userEvent.click(within(d2).getByRole("tab", { name: "Take profit / Stop loss" }));
    expect(within(d2).getByText(/the asset’s typical move/)).toHaveTextContent(
      "TP = 1.5 × and SL = 0.75 × the asset’s typical move over the max hold (from its last 30 days). If TP is under 2× the cost of a trade, the signal is skipped.",
    );
    await userEvent.click(within(d2).getByRole("tab", { name: "The gate" }));
    // Cổng nêu đủ điều kiện đã chốt, gồm so với vào lệnh ngẫu nhiên và cùng dấu ở hai nửa.
    expect(within(d2).getByText(/passes the gate/)).toHaveTextContent(
      "A signal type gets a page for users only after it passes the gate: 100 trades or more, average result after fees at least 2× the cost of a trade, a likely range that stays above 0, it beats random entries at the same moments, and the result has the same sign in both halves.",
    );
    await userEvent.click(within(d2).getByRole("tab", { name: "Context questions" }));
    expect(within(d2).getByText(/Where the other signals go/)).toBeInTheDocument();
    await userEvent.click(within(d2).getByRole("button", { name: "Close" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(intlErrors).toEqual([]);
  });

  it('"?" next to Rules vN and the level chips opens the matching tab', async () => {
    wrap();
    const r = await screen.findByRole("region", { name: "Is it working?" });
    await userEvent.click(within(r).getByRole("tab", { name: "By level" }));
    const lv = within(r).getByRole("table", { name: "Results by level at entry" });
    const help = within(lv).getAllByRole("button", { name: "How it works: Levels" });
    expect(help).toHaveLength(3);
    const first = help[0];
    if (first === undefined) throw new Error("help");
    await userEvent.click(first);
    let dlg = await screen.findByRole("dialog", { name: "How it works" });
    expect(within(dlg).getByRole("tab", { name: "Levels" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(first).toHaveFocus();
    await userEvent.click(within(r).getByRole("tab", { name: "Overall" }));
    const sum = within(r).getByRole("table", { name: "Where each signal type stands" });
    const rules = within(sum).getAllByRole("button", { name: "How it works: News types" });
    expect(rules.length).toBeGreaterThan(0);
    await userEvent.click(rules[0] ?? first);
    dlg = await screen.findByRole("dialog", { name: "How it works" });
    expect(within(dlg).getByRole("tab", { name: "News types" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      within(dlg).getByText("Rules v2 · a starting guess that the results prove or drop"),
    ).toBeInTheDocument();
  });

  it("section titles follow the redesign; on phones the tab row scrolls with a fade edge", async () => {
    wrap();
    await screen.findByRole("region", { name: "Is it working?" });
    expect(region("Paper bots")).toBeInTheDocument();
    expect(region(/From headline to trade/)).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Paper trades" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Strategy" })).toHaveClass(
      "overflow-x-auto",
      "max-md:mask-r-from-85%",
    );
    // Thanh Version + How it works đứng trước Paper bots (thứ tự của mockup 390).
    const how = screen.getByRole("button", { name: "How it works" });
    expect(
      how.compareDocumentPosition(region("Paper bots")) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("Is it working? redesign (#344) and older rules (#321)", { timeout: 30_000 }, () => {
  beforeEach(() => {
    state.mode = "judge";
  });

  it("progress bars: closed trades for the gate, classifier labels, context H1 with / without", async () => {
    wrap();
    const r = await screen.findByRole("region", { name: "Is it working?" });
    const closed = within(r).getByRole("progressbar", { name: "Closed trades" });
    expect(closed).toHaveAttribute("aria-valuenow", "12");
    expect(closed).toHaveAttribute("aria-valuemax", "100");
    expect(within(r).getByText("~3 weeks to go")).toBeInTheDocument();
    expect(
      within(r).getByText((_, el) => el?.textContent === "12 / 100 · needs 88 more"),
    ).toBeInTheDocument();
    expect(within(r).getByText("12 / 100 · needs 88 more · ~3 weeks")).toBeInTheDocument();
    const labels = within(r).getByRole("progressbar", { name: "Labels" });
    expect(labels).toHaveAttribute("aria-valuenow", "37");
    expect(labels).toHaveAttribute("aria-valuemax", "50");
    expect(within(r).getByText("Classifier v2 labels")).toBeInTheDocument();
    expect(within(r).getByText("84% right so far")).toBeInTheDocument();
    expect(within(r).getAllByRole("link", { name: "Label a random signal" })[0]).toHaveAttribute(
      "href",
      "#sr-labels",
    );
    expect(within(r).getByText("Context (H1 whales)")).toBeInTheDocument();
    expect(within(r).getByText("each group needs 30")).toBeInTheDocument();
    const w = within(r).getByRole("progressbar", {
      name: "Context (H1 whales) · With · closed trades",
    });
    expect(w).toHaveAttribute("aria-valuenow", "12");
    expect(w).toHaveAttribute("aria-valuemax", "30");
    expect(within(r).getByText("12 / 30")).toBeInTheDocument();
    expect(within(r).getByText("21 / 30")).toBeInTheDocument();
    // Progress ở đầu trang theo khối context.
    expect(
      within(screen.getByRole("navigation", { name: "Progress" })).getByRole("link", {
        name: "Context: collecting",
      }),
    ).toBeInTheDocument();
  });

  it("Overall hides the average under 30 counted closed trades; cost says no v3 trade reached the cost check", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Where each signal type stands" });
    const news = within(tbl).getByRole("row", { name: /News · Live paper/ });
    expect(
      within(news).getByText("Average shows at 30 closed (18 more); the gate needs 100"),
    ).toBeInTheDocument();
    expect(within(news).getByText("Shown at 30 closed")).toBeInTheDocument();
    // API có trung bình (+0.40%) nhưng chưa đủ 30: không hiện.
    expect(within(news).queryByText("+0.40%")).not.toBeInTheDocument();
    expect(within(news).getByText("Collecting")).toBeInTheDocument();
    expect(
      screen.getByText(
        /cost of a trade ≈ Not available yet · no v3 trade has reached the cost check/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Live paper · 12 trades · needs 88 more")).toBeInTheDocument();
    // Long / Short: từ 30 lệnh đóng mới hiện trung bình (PM, #358).
    const dir = screen.getByRole("table", { name: "Long and short results for News · Live paper" });
    const [, long, short] = within(dir).getAllByRole("row");
    if (long === undefined || short === undefined) throw new Error("rows");
    expect(within(long).getByText("+0.18%")).toBeInTheDocument();
    expect(within(long).getByText("−0.12% to +0.48%")).toBeInTheDocument();
    expect(within(short).getByText("Not enough trades · needs 21 more")).toBeInTheDocument();
    expect(screen.getByText("Long · 34 trades · +0.18% (−0.12% to +0.48%)")).toBeInTheDocument();
  });

  it("tabs switch with click and arrow keys", async () => {
    wrap();
    const r = await screen.findByRole("region", { name: "Is it working?" });
    const overall = within(r).getByRole("tab", { name: "Overall" });
    expect(overall).toHaveAttribute("aria-selected", "true");
    overall.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(within(r).getByRole("tab", { name: "By level" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(r).getByRole("tab", { name: "By level" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(within(r).getByRole("tab", { name: "Does context help?" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(r).getByRole("tabpanel")).toHaveAttribute(
      "aria-labelledby",
      "sr-judge-tab-context",
    );
    await noViolations();
  });

  it("Does context help?: progress under 30 per group, verdicts only when both groups have 30, live and backfilled apart", async () => {
    wrap();
    const r = await screen.findByRole("region", { name: "Is it working?" });
    await userEvent.click(within(r).getByRole("tab", { name: "Does context help?" }));
    expect(
      within(r).getByRole("heading", { name: /Does context make news signals better\?/ }),
    ).toBeInTheDocument();
    expect(
      within(r).getByText("Baseline (v3) · from the page's version picker"),
    ).toBeInTheDocument();
    expect(within(r).getByText(/Slower than the main gate\./)).toBeInTheDocument();
    const tbl = within(r).getByRole("table", { name: "Does context make news signals better?" });
    const rows = (q: string) =>
      [...tbl.querySelectorAll(`tr[data-question="${q}"]`)] as HTMLElement[];
    // H1: cả hai nhóm dưới 30 → thanh tiến độ, không có trung bình / chênh / khoảng.
    const [h1w, h1o] = rows("h1");
    if (h1w === undefined || h1o === undefined) throw new Error("h1");
    expect(
      within(h1w).getByRole("progressbar", { name: "H1 · Whales agree · With · closed trades" }),
    ).toHaveAttribute("aria-valuenow", "12");
    expect(
      within(h1o).getByRole("progressbar", { name: "H1 · Whales agree · Without · closed trades" }),
    ).toHaveAttribute("aria-valuenow", "21");
    expect(within(h1w).getByText("12 / 30")).toBeInTheDocument();
    expect(within(h1w).getByText("Not enough trades")).toBeInTheDocument();
    expect(within(h1o).getByText("Not enough trades")).toBeInTheDocument();
    expect(within(h1w).getByText("Not enough trades to compare")).toBeInTheDocument();
    expect(within(h1w).getByText("Collecting")).toBeInTheDocument();
    expect(within(h1w).getByText("18 more with · 9 more without")).toBeInTheDocument();
    expect(within(h1w).queryByText(/%/)).not.toBeInTheDocument();
    // H2: đủ 30 ở cả hai nhóm → số, chênh, khoảng; khoảng chứa 0.
    const [h2w, h2o] = rows("h2");
    if (h2w === undefined || h2o === undefined) throw new Error("h2");
    expect(within(h2w).queryByRole("progressbar")).toBeNull();
    expect(within(h2w).getByText("34")).toBeInTheDocument();
    expect(within(h2w).getByText("+0.21%")).toBeInTheDocument();
    expect(within(h2o).getByText("+0.04%")).toBeInTheDocument();
    expect(within(h2w).getByText("+0.17%")).toBeInTheDocument();
    expect(within(h2w).getByText("−0.06% to +0.41%")).toBeInTheDocument();
    expect(within(h2w).getByText("No clear difference")).toBeInTheDocument();
    // PM (#358): chưa có kết luận → số màu trung tính; badge With không xanh lá.
    expect(within(h2w).getByText("+0.21%")).toHaveClass("text-ink");
    expect(within(h2w).getByText("+0.17%")).toHaveClass("text-ink");
    expect(within(h2w).getByText("+0.21%")).not.toHaveClass("text-pos");
    expect(within(h2w).getByText("With")).toHaveClass("bg-accent-tint");
    expect(within(h2w).getByText("With")).not.toHaveClass("bg-pos-bg");
    expect(within(h2o).getByText("Without")).toHaveClass("bg-bg");
    expect(within(h2w).getByText("The range still includes 0")).toBeInTheDocument();
    const [h3w] = rows("h3");
    if (h3w === undefined) throw new Error("h3");
    expect(within(h3w).getByText("Worse with it")).toBeInTheDocument();
    // Có kết luận → tô màu theo dấu (Average và Difference).
    expect(within(h3w).getByText("−0.32%")).toHaveClass("text-neg");
    expect(within(h3w).getByText("−0.41%")).toHaveClass("text-neg");
    const [, h3o] = rows("h3");
    if (h3o === undefined) throw new Error("h3o");
    expect(within(h3o).getByText("+0.09%")).toHaveClass("text-pos");
    expect(
      within(h3w).getByText('Candidate option: "Skip if price already moved"'),
    ).toBeInTheDocument();
    expect(
      within(r).getByText("2 closed trades have no live context and are left out."),
    ).toBeInTheDocument();
    expect(
      within(r).getByText(
        /^Whale data: 41 of 75 signals .* Funding: 75 of 75\. Price run: 75 of 75\./,
      ),
    ).toBeInTheDocument();
    expect(
      within(r).getByText(/H1 "Without" counts only signals on assets with whale data/),
    ).toBeInTheDocument();
    expect(within(r).queryByText(/Sample numbers/)).not.toBeInTheDocument();

    // Backfilled: khối riêng, không trộn số live.
    const live = within(r).getByRole("button", { name: "Live" });
    const bf = within(r).getByRole("button", { name: "Backfilled" });
    expect(live).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(bf);
    expect(bf).toHaveAttribute("aria-pressed", "true");
    expect(within(r).getByText("No backfilled signals yet.")).toBeInTheDocument();
    const tbl2 = within(r).getByRole("table", { name: "Does context make news signals better?" });
    expect(within(tbl2).getAllByText("0 / 30")).toHaveLength(6);
    expect(within(tbl2).queryByText("+0.21%")).not.toBeInTheDocument();
    expect(within(tbl2).getAllByText("30 more with · 30 more without")).toHaveLength(3);
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("Paper trades: picked version only by default; Show older rules (v2) · 4 adds v2 trades tagged Rules v2 · not counted", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    expect(within(tbl).queryByText("Rules v2 · not counted")).not.toBeInTheDocument();
    const last = () => [...state.paths].reverse().find((p) => p.includes("/trades?")) ?? "";
    expect(last()).not.toContain("olderRules");
    const toggle = screen.getByRole("checkbox", { name: /Show older rules \(v2\) · 4/ });
    expect(toggle).not.toBeChecked();
    await userEvent.click(toggle);
    await waitFor(() => {
      expect(last()).toContain("olderRules=true");
    });
    const t2 = await screen.findByRole("table", { name: "Signal research trades" });
    await waitFor(() => {
      expect(within(t2).getAllByText("Rules v2 · not counted")).toHaveLength(1);
    });
    // Paper bots ghi số lệnh rules cũ còn theo dõi.
    expect(
      within(region("Paper bots")).getByText("4 trades from older rules (v2) still tracked below"),
    ).toBeInTheDocument();
    // Phễu: rules v3 chạy chưa hết 1 ngày.
    expect(
      within(region(/From headline to trade/)).getByText(/^Since rules v3 started at \d\d:\d\d$/),
    ).toBeInTheDocument();
    await noViolations();
  });

  it("no older rules: no toggle, no Paper bots line", async () => {
    state.mode = "ok";
    wrap();
    await screen.findByRole("table", { name: "Signal research trades" });
    expect(screen.queryByRole("checkbox", { name: /older rules/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/from older rules/)).not.toBeInTheDocument();
  });
});
