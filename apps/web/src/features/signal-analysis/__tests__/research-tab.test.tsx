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
  NEWS_DETAIL,
  NEWS_ONLY_SUMMARY,
  RESEARCH_DETAIL,
  RESEARCH_SUMMARY,
  RESEARCH_TRADES,
  SKIPPED_DETAIL,
  SKIPPED_ID,
  SKIPPED_TRADE,
} from "./research-fixtures";

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
  | "one";
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
  bots: RESEARCH_SUMMARY.bots.map((b) => ({ ...b, balance: null, openTrades: null })),
  funnel:
    RESEARCH_SUMMARY.funnel === null
      ? null
      : { ...RESEARCH_SUMMARY.funnel, delayMedianSecs: null, claudeCostPerDay: null },
  rows: RESEARCH_SUMMARY.rows.map((r) =>
    r.type === "whales" ? { ...r, randomPct: null, diffPct: null, range: null } : r,
  ),
  costPct: null,
  risk: null,
};
const NULL_TRADES: ResearchTradesPage = {
  items: RESEARCH_TRADES.items.map((x) =>
    x.id === "sr-0001"
      ? { ...x, movedBeforePct: null, result: { outcome: "tp", leftSecs: null, pnl: null } }
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
                  : RESEARCH_SUMMARY,
          ),
        );
      }
      if (p.endsWith("/signal-research/trades")) {
        if (m === "tradesError") return Promise.reject(new real.ApiError("INTERNAL_ERROR", 500));
        if (m === "tradesEmpty")
          return Promise.resolve(schema.parse({ items: [], nextCursor: null }));
        if (m === "nulls") return Promise.resolve(schema.parse(NULL_TRADES));
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
    expect(screen.getAllByText(/Research only, fake money\./).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/Nothing is sent to SoDEX\. A signal type gets a page/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Times in your time zone: Asia\/Ho_Chi_Minh/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Volume Builder/ }));
    expect(window.location.search).toBe("?tab=vb");
  });

  it("sources show Live / Delayed / Down with the replay gap left out", async () => {
    wrap();
    const src = await screen.findByRole("region", { name: "Sources" });
    expect(within(src).getByText("SoSoValue news · Live · 2 min ago")).toBeInTheDocument();
    expect(within(src).getByText("Macro calendar · Live")).toBeInTheDocument();
    expect(
      within(src).getByText(/Whale events · last replay 01:00, 2 h gap Nov 16 left out/),
    ).toBeInTheDocument();
    expect(within(src).getByText("Status: Delayed.")).toBeInTheDocument();
    expect(within(src).getByText(/Funding rates · replayed 01:00/)).toBeInTheDocument();
  });

  it("paper bots: balance, open trades, rule version and last run", async () => {
    wrap();
    await screen.findByRole("region", { name: "Paper bots" });
    const bots = region("Paper bots");
    expect(within(bots).getByText("Running · live")).toBeInTheDocument();
    expect(within(bots).getByText("10,024.6")).toBeInTheDocument();
    expect(within(bots).getByText("2 trades")).toBeInTheDocument();
    expect(within(bots).getByText("01:00 · 23 trades")).toBeInTheDocument();
    expect(within(bots).getByText("9,623.4")).toBeInTheDocument();
    expect(within(bots).getByRole("link", { name: "Rules" })).toHaveAttribute("href", "#sr-rules");
  });

  it("funnel: an accessible image summarising the counts, plus the numbers and drop reasons as text", async () => {
    wrap();
    await screen.findByRole("region", { name: /How news becomes a paper trade · last 7 days/ });
    const img = screen.getByRole("img", {
      name: "Funnel: 1,240 articles collected, grouped into 380 stories, 96 scored as signals, 41 passed filters, 41 paper trades: 29 long and 12 short",
    });
    expect(img).toBeInTheDocument();
    const f = region(/How news becomes a paper trade/);
    expect(
      within(f).getByText("860 articles merged into a story already seen, none dropped"),
    ).toBeInTheDocument();
    expect(within(f).getByText("level at entry: High 21 · Medium 38 · Low 37")).toBeInTheDocument();
    expect(within(f).getByText("3 min 10 s")).toBeInTheDocument();
    expect(within(f).getByText("$0.42 / day")).toBeInTheDocument();
    expect(
      within(f).getByText("1,240 articles read · SoSoValue 2,016 of 10,000 calls this month"),
    ).toBeInTheDocument();
    expect(within(f).getByText("Score · −284 stories")).toBeInTheDocument();
    expect(
      within(f).getByText(
        "Take profit under 2× cost 27 · Trade already open on that asset 19 · Source late 9",
      ),
    ).toBeInTheDocument();
    expect(within(f).getByText("12 take profit")).toBeInTheDocument();
    expect(within(f).getByText("· 11 open")).toBeInTheDocument();
  });

  it("news signal rules and the per-level table say Not enough trades, never 0", async () => {
    wrap();
    await screen.findByRole("region", { name: "What counts as a news signal" });
    const r = region("What counts as a news signal");
    expect(
      within(r).getByText("Rules v2 · a starting guess that the results prove or drop"),
    ).toBeInTheDocument();
    expect(within(r).getByText("Short the affected token")).toBeInTheDocument();
    const lv = within(r).getByRole("table", { name: "Results by level at entry" });
    expect(within(lv).getAllByText("Not enough trades")).toHaveLength(3);
    expect(within(lv).getByText("Needs 87 more closed")).toBeInTheDocument();
    expect(within(lv).getByText(/8 later reached High/)).toBeInTheDocument();
    expect(within(lv).getByText("14 · 10")).toBeInTheDocument();
  });

  it("summary rows per type and label, random-entry difference, status, what it still needs, risk filter", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Where each signal type stands" });
    const whales = within(tbl).getByRole("row", { name: /Whales/ });
    expect(within(whales).getByText("Replay")).toBeInTheDocument();
    expect(within(whales).getByText("+0.21%")).toBeInTheDocument();
    expect(within(whales).getByText("+0.19%")).toBeInTheDocument();
    expect(within(whales).getByText(/better/)).toBeInTheDocument();
    expect(within(whales).getByText("−0.05% to +0.47%")).toBeInTheDocument();
    expect(within(whales).getByText("Failing")).toBeInTheDocument();
    const news = within(tbl).getByRole("row", { name: /News/ });
    expect(within(news).getByText("Live paper")).toBeInTheDocument();
    expect(within(news).getByText("41 opened")).toBeInTheDocument();
    expect(
      within(news).getByText("About 70 more closed (all news pooled) · first verdict in ~3 weeks"),
    ).toBeInTheDocument();
    expect(
      within(tbl).getByText("36 more trades. SoDEX funding covers 41 days."),
    ).toBeInTheDocument();
    expect(within(tbl).getByText("−0.18% to 0.00%")).toBeInTheDocument();
    expect(within(whales).getByText("41 days")).toBeInTheDocument();
    // Long / Short của News · live paper.
    const dir = screen.getByRole("table", { name: "Long and short results for News · Live paper" });
    const [, long, short] = within(dir).getAllByRole("row");
    if (long === undefined || short === undefined) throw new Error("rows");
    expect(within(long).getByText("+0.18%")).toBeInTheDocument();
    expect(within(long).getByText("−0.12% to +0.48%")).toBeInTheDocument();
    expect(within(long).getByText("7 days")).toBeInTheDocument();
    expect(within(short).getByText("Not enough trades")).toBeInTheDocument();
    expect(screen.getByText("Long · 21 trades · +0.18% (−0.12% to +0.48%)")).toBeInTheDocument();
    expect(screen.getByText("Short · 9 trades · Not enough trades")).toBeInTheDocument();
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
    const src = await screen.findByRole("region", { name: "Sources" });
    expect(within(src).getAllByRole("listitem")).toHaveLength(2);
    const bots = region("Paper bots");
    expect(within(bots).getByText("News bot")).toBeInTheDocument();
    expect(within(bots).queryByText("Whales bot")).not.toBeInTheDocument();
    expect(within(bots).getByText("Not available")).toBeInTheDocument();
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
    expect(within(bots).getAllByText("Not available").length).toBeGreaterThanOrEqual(4);
    expect(within(bots).queryByText(/^0(\.0)?$/)).not.toBeInTheDocument();
    const f = region(/How news becomes a paper trade/);
    expect(within(f).getAllByText("Not available")).toHaveLength(2);
    const tbl = screen.getByRole("table", { name: "Where each signal type stands" });
    const whales = within(tbl).getByRole("row", { name: /Whales/ });
    expect(within(whales).getAllByText("Not available")).toHaveLength(2);
    expect(screen.getByText(/cost of a trade ≈ Not available/)).toBeInTheDocument();
    const trades = await screen.findByRole("table", { name: "Signal research trades" });
    const sol = within(trades).getByRole("row", { name: /SEC delays decision/ });
    expect(within(sol).getAllByText("Not available")).toHaveLength(2);
    expect(within(sol).queryByText("$0.00")).not.toBeInTheDocument();
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
    expect(await screen.findByText("No trades match these filters")).toBeInTheDocument();
    d.unmount();
    state.mode = "tradesError";
    wrap();
    expect(
      await screen.findByText("Couldn’t load trades.", {}, { timeout: 5_000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(intlErrors).toEqual([]);
  });

  it("counts use singular and plural forms (1 story, 2 stories) and drop lines never read as a negative count", async () => {
    // Số nhiều (fixture mặc định).
    const a = wrap();
    const f0 = await screen.findByRole("region", {
      name: /How news becomes a paper trade · last 7 days/,
    });
    expect(within(f0).getByText(/· Collect\s+1,240 articles$/)).toBeInTheDocument();
    expect(within(f0).getByText(/· Normalize\s+380 stories$/)).toBeInTheDocument();
    expect(within(f0).getByText(/· Score\s+96 signals$/)).toBeInTheDocument();
    expect(within(f0).getByText("Score · −284 stories")).toHaveAttribute("aria-hidden", "true");
    expect(within(f0).getByText("Score: 284 stories dropped")).toBeInTheDocument();
    expect(within(f0).getByText("Filter: 55 signals dropped")).toBeInTheDocument();
    a.unmount();
    // Số ít và 0.
    state.mode = "one";
    wrap();
    const f = await screen.findByRole("region", {
      name: /How news becomes a paper trade · last 1 day$/,
    });
    expect(within(f).getByText(/· Collect\s+1 article$/)).toBeInTheDocument();
    expect(within(f).getByText(/· Normalize\s+1 story$/)).toBeInTheDocument();
    expect(within(f).getByText(/· Score\s+1 signal$/)).toBeInTheDocument();
    expect(
      within(f).getByText("1 article merged into a story already seen, none dropped"),
    ).toBeInTheDocument();
    expect(within(f).getByText(/^1 article read · SoSoValue/)).toBeInTheDocument();
    expect(within(f).getByText("Score · −1 story")).toBeInTheDocument();
    expect(within(f).getByText("Score: 1 story dropped")).toBeInTheDocument();
    expect(within(f).getByText("Filter · none dropped")).toBeInTheDocument();
    expect(within(f).queryByText(/−0/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Funnel: 1 article collected, grouped into 1 story, 1 scored as signals, 1 passed filters, 1 paper trade: 1 long and 0 short",
      }),
    ).toBeInTheDocument();
    const tbl = screen.getByRole("table", { name: "Where each signal type stands" });
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
