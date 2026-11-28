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
  type ResearchTradeDetail,
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

import { LATENCY_EMPTY } from "./news-trace-fixtures";
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
const state = vi.hoisted(
  (): {
    mode: Mode;
    paths: string[];
    classifiers: unknown;
    summary: unknown;
    versions: unknown;
    bots: unknown[];
    /** #511: lệnh đầu tiên đóng `max_hold_no_price` (danh sách và chi tiết). */
    noPrice: boolean;
    /** #530: chi tiết lệnh News là phần chia của sự kiện 3 coin. */
    split: boolean;
  } => ({
    mode: "ok",
    paths: [],
    classifiers: null,
    summary: null,
    versions: null,
    bots: [],
    noPrice: false,
    split: false,
  }),
);

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

/** #511: lệnh đóng ở hạn giữ khi SoDEX không có giá: không có giá thoát, không có kết quả. */
const NO_PRICE_DETAIL: ResearchTradeDetail = {
  ...NEWS_DETAIL,
  trade: {
    ...NEWS_DETAIL.trade,
    result: { pnl: null, unrealized: null, outcome: "maxHoldNoPrice", leftSecs: null },
  },
  steps: NEWS_DETAIL.steps.map((s) => ({
    ...s,
    facts: s.facts.map((f) =>
      f.key === "exit" ? { ...f, price: null, outcome: "maxHoldNoPrice", usd: null, pct: null } : f,
    ),
  })),
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
      if (p.endsWith("/signal-research/versions"))
        return Promise.resolve(schema.parse(state.versions ?? VERSIONS));
      if (p.endsWith("/signal-research/classifiers"))
        return Promise.resolve(schema.parse(state.classifiers ?? CLASSIFIERS));
      if (p.endsWith("/signal-research/markets")) return Promise.resolve(schema.parse(MARKETS));
      // #421: bot mainnet của người xem (phần Mainnet có test riêng ở mainnet.test.tsx).
      if (p === "/api/v1/signal-research/bots")
        return Promise.resolve(schema.parse({ items: state.bots }));
      // #375: độ trễ theo chặng có test riêng (news-trace.test.tsx, latency.test.tsx); ở đây cửa sổ chưa đo được gì.
      if (p.endsWith("/signal-research/latency"))
        return Promise.resolve(schema.parse(LATENCY_EMPTY));
      if (p.endsWith("/signal-research/summary")) {
        if (state.summary !== null) return Promise.resolve(schema.parse(state.summary));
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
          const first = RESEARCH_TRADES.items[0];
          const firstShown =
            state.noPrice && first !== undefined
              ? {
                  ...first,
                  result: {
                    pnl: null,
                    unrealized: null,
                    outcome: "maxHoldNoPrice",
                    leftSecs: null,
                  },
                }
              : first;
          return Promise.resolve(
            schema.parse(
              other
                ? { items: [], nextCursor: null }
                : { items: [firstShown, SKIPPED_TRADE], nextCursor: null },
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
        if (state.noPrice && !p.endsWith(SKIPPED_ID))
          return Promise.resolve(schema.parse(NO_PRICE_DETAIL));
        if (state.split && !p.endsWith(SKIPPED_ID))
          return Promise.resolve(
            schema.parse({ ...NEWS_DETAIL, sizeUsdc: "166.66", eventCoins: 3 }),
          );
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
  state.noPrice = false;
  state.split = false;
  state.mode = "ok";
  state.paths = [];
  state.classifiers = null;
  state.summary = null;
  state.versions = null;
  state.bots = [];
  intlErrors.length = 0;
  window.history.replaceState(null, "", "/admin/signal-analysis?tab=research");
  // #457: chế độ Paper / Mainnet được nhớ trong localStorage; mỗi test bắt đầu như người xem mới.
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
    // #421: chữ đầu của dải đang chờ PM duyệt (`_pendingReview`), nên test không kiểm câu đó.
    const note = screen.getByText("Nothing here is sent to SoDEX.").closest("[role=note]");
    if (!(note instanceof HTMLElement)) throw new Error("banner");
    expect(note).toHaveClass("bg-warn-bg", "text-warn", "border-warn-border");
    expect(screen.getByText("Prices from mainnet")).toBeInTheDocument();
    expect(screen.queryByText("Read only")).not.toBeInTheDocument();
    expect(screen.getByText(/Times in your time zone: Asia\/Ho_Chi_Minh/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: /Volume Builder/ }));
    expect(window.location.search).toBe("?tab=vb");
  });

  it("sources show Live / Delayed / Down with the replay gap left out", async () => {
    wrap();
    // #342: nguồn nằm trong dải "Research only · fake money"; trang gọn (2026-11-20): hiện cả trên điện thoại, mỗi nguồn
    // một chấm (Live xanh dương).
    const src = await screen.findByRole("list", { name: "Sources" });
    expect(src).not.toHaveClass("max-md:hidden");
    expect(within(src).getByText("SoSoValue news · Live · 2 min ago")).toBeInTheDocument();
    expect(within(src).getByText("Macro calendar · Live")).toBeInTheDocument();
    expect(
      within(src).getByText(/Whale events · last replay 01:00, 2 h gap Nov 16 left out/),
    ).toBeInTheDocument();
    expect(within(src).getByText("Status: Delayed.")).toBeInTheDocument();
    expect(within(src).getByText(/Funding rates · replayed 01:00/)).toBeInTheDocument();
    expect(within(src).getByText(/^Claude · Delayed · /)).toBeInTheDocument();
  });

  it("paper bots: News bot versions only, no replay cards (#385)", async () => {
    wrap();
    await screen.findByRole("region", { name: "Bots & labels" });
    const bots = region("Bots & labels");
    // #306: lane News là các News bot version; Baseline có balance của API versions.
    const baseline = await within(bots).findByRole("article", { name: "News bot v3 · Baseline" });
    expect(within(baseline).getByText("10,024.6")).toBeInTheDocument();
    // #297: "+$3.25 unrealized" của tổng kết, chỉ trên thẻ của version mà tổng kết mô tả.
    expect(within(baseline).getByText("+$3.25 unrealized")).toBeInTheDocument();
    const v4 = within(bots).getByRole("article", { name: "News bot v4 · Strict subject" });
    expect(within(v4).queryByText(/unrealized/)).not.toBeInTheDocument();
    // #385: thẻ replay (Whales, Funding · Price patterns) đã bỏ: API không bao giờ trả bot replay.
    expect(within(bots).queryByText("Whales bot")).not.toBeInTheDocument();
    expect(within(bots).queryByText("Funding · Price patterns")).not.toBeInTheDocument();
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
    expect(screen.getByText(/each trade costs about 0.10%/)).toBeInTheDocument();
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
    const bots = region("Bots & labels");
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

  it("#511: a trade closed at the hold limit without a price says so; the result is Not available, never 0", async () => {
    state.mode = "news";
    state.noPrice = true;
    wrap();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    const row = within(tbl).getByRole("row", { name: /SEC delays decision on SOL ETF/ });
    expect(within(row).getByText("Max hold · no price")).toBeInTheDocument();
    for (const z of ["$0", "$0.00", "+$0.00"]) expect(within(row).queryByText(z)).toBeNull();
    await userEvent.click(
      within(tbl).getByRole("button", { name: "SEC delays decision on SOL ETF" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(
        "Closed at the hold limit. SoDEX had no price, so there is no result.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).getAllByText(/Max hold · no price/).length).toBeGreaterThan(0);
    for (const z of ["$0", "$0.00", "+$0.00"]) expect(within(dialog).queryByText(z)).toBeNull();
    expect(intlErrors).toEqual([]);
  });

  it("#530: a share of a multi-coin event shows the size to the cent and the split line", async () => {
    state.mode = "news";
    state.split = true;
    wrap();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    await userEvent.click(
      within(tbl).getByRole("button", { name: "SEC delays decision on SOL ETF" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("Size split across 3 coins from one event."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/on 166\.66 USDC/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/\$167/)).toBeNull();
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
    await screen.findByRole("region", { name: "Bots & labels" });
    const bots = region("Bots & labels");
    // #385: không còn thẻ replay (trước đây ba số dư "Not available" của Whales / Funding / Price patterns nằm ở đây).
    // Số dư thiếu không bao giờ thành "0.0". (Số đếm 0 thật của API versions, như Closed 0, vẫn hiện: từ #342 danh sách
    // version tải ngay ở đầu trang.)
    expect(within(bots).queryByText(/^0\.0$/)).not.toBeInTheDocument();
    const f = region(/From headline to trade/);
    // #375: ô Delay cũ ("Not available") nay là "Where the time goes": chặng chưa đo ghi "Not measured yet", không bao giờ 0.
    expect(within(f).getAllByText("Not available")).toHaveLength(1);
    expect(
      within(within(f).getByTestId("sr-latency")).getAllByText("Not measured yet"),
    ).toHaveLength(5); // 4 chặng + dòng Total
    const tbl = screen.getByRole("table", { name: "Where each signal type stands" });
    const whales = within(tbl).getByRole("row", { name: /Whales/ });
    expect(within(whales).getAllByText("Not available")).toHaveLength(2);
    expect(screen.getByText(/each trade costs about Not available/)).toBeInTheDocument();
    const trades = await screen.findByRole("table", { name: "Signal research trades" });
    const sol = within(trades).getByRole("row", { name: /SEC delays decision/ });
    // + #376: "Market at entry" của lệnh không có trạng thái thị trường.
    expect(within(sol).getAllByText("Not available")).toHaveLength(3);
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
    const bots = region("Bots & labels");
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

  it("#421: the Bots switch shows Mainnet (shared trace, no paper-only sections) and keeps ?bots=mainnet", async () => {
    const M = messages.signalAnalysis.research.mainnet;
    wrap();
    await picker();
    const sw = screen.getByRole("radiogroup", { name: M.mode.label });
    await userEvent.click(within(sw).getByRole("radio", { name: M.mode.mainnet }));
    expect(window.location.search).toContain("bots=mainnet");
    expect(await screen.findByRole("button", { name: M.count.start })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Is it working?" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Summary" })).not.toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole("radiogroup", { name: M.mode.label })).getByRole("radio", {
        name: M.mode.paper,
      }),
    );
    expect(window.location.search).not.toContain("bots=");
    expect(await screen.findByRole("region", { name: "Summary" })).toBeInTheDocument();
  });

  it("#457: picking Mainnet is remembered; opening the page again without ?bots= reopens Mainnet", async () => {
    const M = messages.signalAnalysis.research.mainnet;
    const view = wrap();
    await picker();
    await userEvent.click(screen.getByRole("radio", { name: M.mode.mainnet }));
    expect(window.localStorage.getItem("sr:mode")).toBe("mainnet");
    view.unmount();
    // Bấm menu Signal Research: URL không có ?bots=.
    window.history.replaceState(null, "", "/admin/signal-analysis?tab=research");
    wrap();
    expect(await screen.findByRole("radio", { name: M.mode.mainnet })).toBeChecked();
    expect(await screen.findByRole("button", { name: M.count.start })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("radio", { name: M.mode.paper }));
    expect(window.localStorage.getItem("sr:mode")).toBe("paper");
  });

  it("#457: ?bots= wins over the remembered mode", async () => {
    const M = messages.signalAnalysis.research.mainnet;
    window.localStorage.setItem("sr:mode", "mainnet");
    window.history.replaceState(null, "", "/admin/signal-analysis?tab=research&bots=paper");
    wrap();
    expect(await screen.findByRole("radio", { name: M.mode.paper })).toBeChecked();
    expect(await screen.findByRole("region", { name: "Summary" })).toBeInTheDocument();
  });

  it("#457: storage that throws or holds junk opens Paper and the page still works", async () => {
    const M = messages.signalAnalysis.research.mainnet;
    window.localStorage.setItem("sr:mode", "garbage");
    const view = wrap();
    expect(await screen.findByRole("radio", { name: M.mode.paper })).toBeChecked();
    view.unmount();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    wrap();
    expect(await screen.findByRole("radio", { name: M.mode.paper })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: M.mode.mainnet }));
    expect(screen.getByRole("radio", { name: M.mode.mainnet })).toBeChecked();
    expect(window.location.search).toContain("bots=mainnet");
  });

  it("#457: the picked mainnet bot is remembered; a remembered bot that is gone falls back to the first", async () => {
    const M = messages.signalAnalysis.research.mainnet;
    const mk = (id: string, name: string) => ({
      id,
      name,
      strategy: "news_signal",
      market: "",
      engine: "perps",
      state: "running",
      reasonCode: null,
      needsAttention: false,
      activeVersion: 1,
      netPnl: null,
      createdAt: "2026-11-22T10:00:00.000Z",
      updatedAt: "2026-11-22T10:00:00.000Z",
    });
    const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    state.bots = [mk(A, "News · A"), mk(B, "News · B")];
    window.localStorage.setItem("sr:mode", "mainnet");
    window.localStorage.setItem("sr:mainnetBot", "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
    const view = wrap();
    const sel = await screen.findByRole("combobox", { name: M.bot });
    await waitFor(() => {
      expect(sel).toHaveValue(A);
    });
    await userEvent.selectOptions(sel, B);
    expect(window.localStorage.getItem("sr:mainnetBot")).toBe(B);
    view.unmount();
    wrap();
    const again = await screen.findByRole("combobox", { name: M.bot });
    await waitFor(() => {
      expect(again).toHaveValue(B);
    });
  });

  it("summary strip: one line per running / paused version (max 3), the picked one marked, a plain-words label row", async () => {
    wrap();
    await picker();
    const strip = screen.getByRole("region", { name: "Summary" });
    // Dải Paper nằm trong dải tóm tắt.
    expect(within(strip).getByRole("note")).toHaveTextContent("Nothing here is sent to SoDEX.");
    const lines = await within(strip).findByRole("list", { name: "Running News bot versions" });
    const items = within(lines).getAllByRole("listitem");
    // v6 đã dừng: không có dòng. v5 tạm dừng, có kết luận; v3 là version đang hiện ở dưới.
    expect(items.map((li) => li.textContent)).toEqual([
      "News bot · Majors only (v5) · Paused · Balance 10,105.2 · 0 open · Verdict: Passed once · repeat 40 / 100",
      "News bot · Strict subject (v4) · Running · Balance 10,000.0 · 0 open",
      "News bot · Baseline (v3) · Running · Balance 10,024.6 (+$3.25 unrealized) · 7 open · shown below",
    ]);
    expect(items[2]).toHaveAttribute("aria-current", "true");
    // Running dùng xanh dương (trung tính), không xanh lá.
    expect(within(items[2] ?? strip).getByText("Running")).toHaveClass("bg-accent-tint");
    const row = within(strip).getByTestId("sr-label-row");
    expect(row).toHaveAttribute("data-state", "needs");
    expect(row).toHaveClass("bg-accent-tint");
    expect(row).toHaveTextContent(
      "Not counting yet: label 13 signals to check Claude (37 done)Context: Not available",
    );
    for (const b of ["Label signals", "Manage versions", "How it works"])
      expect(within(strip).getByRole("button", { name: b })).toBeInTheDocument();
    // Không còn dòng Progress.
    expect(screen.queryByRole("navigation", { name: "Progress" })).toBeNull();
    // Theo version đang chọn.
    await userEvent.selectOptions(await picker(), V4_ID);
    await waitFor(() => {
      expect(
        within(lines)
          .getAllByRole("listitem")
          .find((li) => li.getAttribute("aria-current") === "true"),
      ).toHaveTextContent(/^News bot · Strict subject \(v4\)/);
    });
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("summary strip says Not available when the versions and classifier APIs fail, never 0", async () => {
    state.mode = "noVersions";
    wrap();
    await screen.findByRole("region", { name: "Is it working?" });
    const strip = screen.getByRole("region", { name: "Summary" });
    await waitFor(() => {
      expect(within(strip).getByText("News bot versions:").closest("p")).toHaveTextContent(
        "News bot versions: Not available",
      );
    });
    const row = within(strip).getByTestId("sr-label-row");
    expect(row).toHaveAttribute("data-state", "na");
    expect(row).toHaveTextContent("Claude check: Not available");
    expect(row).toHaveTextContent("Context: Not available");
    expect(strip).not.toHaveTextContent(/\b0 open\b|\b0 done\b/);
    expect(screen.queryByRole("combobox", { name: "Version" })).not.toBeInTheDocument();
    expect(intlErrors).toEqual([]);
  });

  it("Bots & labels starts folded; Manage versions opens it and scrolls there", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      wrap();
      const bl = await screen.findByRole("region", { name: "Bots & labels" });
      const details = bl.querySelector("details");
      if (details === null) throw new Error("details");
      expect(details.open).toBe(false);
      const summary = within(bl).getByText("Show").closest("summary");
      expect(summary).toHaveTextContent(
        // #377: phần thí nghiệm thay "N versions tried" (desktop), rồi bản điện thoại chỉ có phần thí nghiệm.
        "Bots & labels2 of 3 slots in use · 0 experiments running · 0 not a clean test · 0 finished · Claude reader v2: 37 of 50 labels" +
          "0 experiments running · 0 not a clean test · 0 finishedShow",
      );
      // Thứ tự trang: dải tóm tắt → From headline to trade → Is it working? → Paper trades → Bots & labels.
      const order = [
        screen.getByRole("region", { name: "Summary" }),
        region(/From headline to trade/),
        region("Is it working?"),
        await screen.findByRole("region", { name: "Paper trades" }),
        bl,
      ];
      for (let i = 1; i < order.length; i++)
        expect(
          (order[i - 1] as Element).compareDocumentPosition(order[i] as Element) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
      await userEvent.click(screen.getByRole("button", { name: "Manage versions" }));
      await waitFor(() => {
        expect(details.open).toBe(true);
      });
      expect(within(bl).getByText("Hide")).toBeInTheDocument();
      expect(scrolled).toContain(bl);
      expect(document.activeElement).toBe(details.querySelector("summary"));
      // Bên trong: thẻ version, bảng All versions, chất lượng Claude reader, kiểm tra thêm.
      expect(within(bl).getByRole("article", { name: "News bot v3 · Baseline" })).toBeVisible();
      expect(within(bl).getByRole("table", { name: "All News bot versions" })).toBeInTheDocument();
      expect(
        within(bl).getByRole("region", { name: "Is Claude reading news right?" }),
      ).toBeInTheDocument();
      expect(within(bl).getByText(/Extra check is on\./)).toBeInTheDocument();
      await noViolations();
      // Bấm lại tiêu đề thì gập.
      if (summary === null) throw new Error("summary");
      await userEvent.click(summary);
      await waitFor(() => {
        expect(details.open).toBe(false);
      });
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("Label signals opens Bots & labels, starts labelling and moves focus to it", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    try {
      wrap();
      const strip = await screen.findByRole("region", { name: "Summary" });
      await screen.findByRole("region", { name: "Bots & labels" });
      await userEvent.click(within(strip).getByRole("button", { name: "Label signals" }));
      const heading = screen.getByRole("heading", { name: "Is Claude reading news right?" });
      await waitFor(() => {
        expect(heading.closest("details")?.open).toBe(true);
      });
      expect(scrolled).toContain(heading);
      expect(heading).toHaveFocus();
      // Luồng gắn nhãn ngẫu nhiên đã bắt đầu: đã hỏi labels/next (API giả không có route này → thông báo lỗi).
      await waitFor(() => {
        expect(state.paths.some((p) => p.includes("/labels/next"))).toBe(true);
      });
      expect(
        await screen.findByText("Couldn’t load a signal to label.", {}, { timeout: 5_000 }),
      ).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("no “classifier” anywhere on the UI: page, Bots & labels open, every drawer tab", async () => {
    wrap();
    await picker();
    await screen.findByRole("region", { name: "Paper trades" });
    await userEvent.click(screen.getByRole("button", { name: "Manage versions" }));
    await screen.findByRole("table", { name: "Claude reader quality by version" });
    expect(document.body.textContent).not.toMatch(/classifier/i);
    await userEvent.click(screen.getByRole("button", { name: "How it works" }));
    const dlg = await screen.findByRole("dialog", { name: "How it works" });
    for (const tab of within(dlg).getAllByRole("tab")) {
      await userEvent.click(tab);
      expect(dlg.textContent).not.toMatch(/classifier|\bgate\b/i);
    }
    // Mọi câu chữ của tab trong en.json cũng vậy (kể cả câu chưa hiện trong fixture này).
    const words: string[] = [];
    const walk = (o: unknown) => {
      if (typeof o === "string") words.push(o);
      else if (o !== null && typeof o === "object") Object.values(o).forEach(walk);
    };
    walk(messages.signalAnalysis.research);
    expect(words.filter((w) => /classifier/i.test(w))).toEqual([]);
  });

  it("How it works › Labels: what a label is, which labels count, the current reader and Label signals", async () => {
    wrap();
    await picker();
    await userEvent.click(screen.getByRole("button", { name: "How it works" }));
    const dlg = await screen.findByRole("dialog", { name: "How it works" });
    const list = within(dlg).getByRole("tablist", { name: "How it works sections" });
    expect(list).toHaveClass("overflow-x-auto");
    await userEvent.click(within(dlg).getByRole("tab", { name: "Labels" }));
    expect(within(dlg).getByRole("tab", { name: "Labels" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      within(dlg)
        .getByText(/^What a label is\./)
        .closest("p"),
    ).toHaveTextContent(
      "What a label is. A person reads an article Claude called a signal and marks Claude’s reading Right or Wrong. The trade result stays hidden until you save, so it can’t sway the label.",
    );
    expect(
      within(dlg)
        .getByText(/^Which labels count\./)
        .closest("p"),
    ).toHaveTextContent(/Only labels from Label signals count toward the 50\./);
    expect(await within(dlg).findByText(/Claude reader v2 \(current\)/)).toBeInTheDocument();
    expect(within(dlg).getByText(/37 of 50 labels · marked right 84%/)).toBeInTheDocument();
    expect(within(dlg).getByRole("button", { name: "Label signals" })).toBeInTheDocument();
    await userEvent.click(within(dlg).getByRole("tab", { name: "Versions" }));
    expect(within(dlg).getByText(/^One Claude read per article\./)).toBeInTheDocument();
    expect(within(dlg).getByText(/Up to 3 versions run at once/)).toBeInTheDocument();
    expect(within(dlg).getByText(/^Saved versions never change\./)).toBeInTheDocument();
    await noViolations();
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
    // #391: mở không chỉ định tab thì vào Overview.
    expect(within(dlg).getByRole("tab", { name: "Overview" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await userEvent.click(within(dlg).getByRole("tab", { name: "News types" }));
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
    await userEvent.click(within(d2).getByRole("tab", { name: "News types" }));
    expect(within(d2).getAllByText("Off")).toHaveLength(2);
    await userEvent.click(within(d2).getByRole("tab", { name: "Take profit / Stop loss" }));
    expect(within(d2).getByText(/the asset’s typical move/)).toHaveTextContent(
      "TP = 1.5 × and SL = 0.75 × the asset’s typical move over the max hold (from its last 30 days). If TP is under 2× the cost of a trade, the signal is skipped.",
    );
    // #530: Rules hiện tại chia cỡ lệnh cho các coin của một sự kiện → "up to".
    expect(within(d2).getByText(/of fake money/)).toHaveTextContent(
      /^Each trade is up to [\d,.]+ USDC of fake money; one event with several coins splits it\.$/,
    );
    await userEvent.click(within(d2).getByRole("tab", { name: "When a signal passes" }));
    // Cổng nêu đủ điều kiện đã chốt, gồm so với vào lệnh ngẫu nhiên và cùng dấu ở hai nửa.
    expect(within(d2).getByText(/passes these checks/)).toHaveTextContent(
      "A signal type gets a page for users only after it passes these checks: 100 trades or more, average result after fees at least 2× the cost of a trade, a likely range that stays above 0, it beats random entries at the same moments, and the result has the same sign in both halves.",
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
      within(dlg).getByText(
        "Rules v2 · Claude reader v2 · a starting guess that the results prove or drop",
      ),
    ).toBeInTheDocument();
  });

  it("section titles follow the redesign; on phones the tab row scrolls with a fade edge", async () => {
    wrap();
    await screen.findByRole("region", { name: "Is it working?" });
    expect(region("Bots & labels")).toBeInTheDocument();
    expect(region(/From headline to trade/)).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Paper trades" })).toBeInTheDocument();
    expect(screen.getByRole("tablist", { name: "Strategy" })).toHaveClass(
      "overflow-x-auto",
      "max-md:mask-r-from-85%",
    );
    // Trang gọn: How it works (trong dải tóm tắt) đứng trước phễu; Bots & labels ở cuối trang.
    const how = screen.getByRole("button", { name: "How it works" });
    expect(
      how.compareDocumentPosition(region(/From headline to trade/)) &
        Node.DOCUMENT_POSITION_FOLLOWING,
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
    expect(within(r).getByText("Labels for Claude reader v2")).toBeInTheDocument();
    expect(within(r).getByText("84% right so far")).toBeInTheDocument();
    expect(within(r).getAllByRole("button", { name: "Label signals" }).length).toBeGreaterThan(0);
    expect(within(r).getByText("Context: whales agree")).toBeInTheDocument();
    expect(within(r).getByText("30 trades each")).toBeInTheDocument();
    const w = within(r).getByRole("progressbar", {
      name: "Context: whales agree · With · closed trades",
    });
    expect(w).toHaveAttribute("aria-valuenow", "12");
    expect(w).toHaveAttribute("aria-valuemax", "30");
    expect(within(r).getByText("12 / 30")).toBeInTheDocument();
    expect(within(r).getByText("21 / 30")).toBeInTheDocument();
    // Dải tóm tắt ở đầu trang theo khối context.
    expect(screen.getByTestId("sr-label-row")).toHaveTextContent(
      "Context: still collecting answers · see Is it working?",
    );
  });

  it("Overall hides the average under 30 counted closed trades; cost says no v3 trade reached the cost check", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Where each signal type stands" });
    const news = within(tbl).getByRole("row", { name: /News · Live paper/ });
    expect(
      within(news).getByText("Shows after 30 closed trades (18 more) · a verdict needs 100"),
    ).toBeInTheDocument();
    expect(within(news).getByText("Shows after 30 closed")).toBeInTheDocument();
    // API có trung bình (+0.40%) nhưng chưa đủ 30: không hiện.
    expect(within(news).queryByText("+0.40%")).not.toBeInTheDocument();
    expect(within(news).getByText("Collecting")).toBeInTheDocument();
    expect(
      screen.getByText(
        /each trade costs about Not available yet · no v3 trade has reached the cost check/,
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
    // #376: tab By market giữa By level và Does context help? (mockup catalyst-market-state-1440).
    expect(
      within(r)
        .getAllByRole("tab")
        .map((x) => x.textContent),
    ).toEqual(["Overall", "By level", "By market", "Does context help?"]);
    await userEvent.click(within(r).getByRole("tab", { name: "By market" }));
    // Tổng kết không có marketSplit: Not available, không có bảng số 0.
    expect(within(within(r).getByRole("tabpanel")).getByText("Not available")).toBeInTheDocument();
    expect(within(within(r).getByRole("tabpanel")).queryByRole("table")).toBeNull();
    await userEvent.click(overall);
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
    expect(within(r).getByText(/Slower than the main verdict\./)).toBeInTheDocument();
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

  it("Paper trades: Current rules (v3) by default; All rules adds the v2 trade with a version chip (#413)", async () => {
    wrap();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    // Current rules: mọi dòng cùng version, không gắn chip.
    expect(within(tbl).queryAllByTestId("sr-trade-rules")).toHaveLength(0);
    const last = () => [...state.paths].reverse().find((p) => p.includes("/trades?")) ?? "";
    expect(last()).not.toContain("olderRules");
    const group = screen.getByRole("radiogroup", { name: "Rules" });
    expect(within(group).getByRole("radio", { name: "Current rules (v3)" })).toBeChecked();
    expect(screen.queryByTestId("sr-all-rules-sum")).not.toBeInTheDocument();
    await userEvent.click(within(group).getByRole("radio", { name: "All rules" }));
    await waitFor(() => {
      expect(last()).toContain("olderRules=true");
    });
    const t2 = await screen.findByRole("table", { name: "Signal research trades" });
    await waitFor(() => {
      expect(
        within(t2)
          .getAllByTestId("sr-trade-rules")
          .map((x) => x.textContent),
      ).toEqual(["v3", "v2"]);
    });
    expect(screen.getByTestId("sr-all-rules-sum")).toHaveTextContent(
      /^All rules · \d+ trades · v2 rows are history, not counted toward Rules v3 results\.$/,
    );
    // Bots & labels ghi số lệnh rules cũ còn theo dõi.
    expect(
      within(region("Bots & labels")).getByText(
        "4 trades from older rules (v2) are still listed in Paper trades.",
      ),
    ).toBeInTheDocument();
    // #413: phễu không còn câu "Since rules v3 started" (phễu theo khoảng gồm mọi version).
    expect(
      within(region(/From headline to trade/)).queryByText(/^Since rules v3 started/),
    ).not.toBeInTheDocument();
    await noViolations();
  });

  it("no older rules: no Current / All rules buttons, no older-rules line in Bots & labels", async () => {
    state.mode = "ok";
    wrap();
    await screen.findByRole("table", { name: "Signal research trades" });
    expect(screen.queryByRole("radiogroup", { name: "Rules" })).not.toBeInTheDocument();
    expect(screen.queryByText(/from older rules/)).not.toBeInTheDocument();
  });
});

/** #395: Claude reader v4 hiện tại (bắt đầu `startedAt`), v3 đã retired với 4 lệnh đóng và 1 nhãn. */
function readerV4(startedAt: string) {
  const [cur, old] = CLASSIFIERS.items;
  if (cur === undefined || old === undefined) throw new Error("fixture");
  return {
    ...CLASSIFIERS,
    items: [
      {
        ...cur,
        classifierVersion: "news-classifier-v4",
        startedAt,
        signals: 0,
        labeled: 0,
        right: 0,
        traceLabeled: 0,
        closedTrades: 0,
        precisionPct: null,
        interval: null,
        labelsToGo: 50,
        mostCommonMistakes: [],
      },
      {
        ...old,
        classifierVersion: "news-classifier-v3",
        startedAt: "2026-11-19T06:00:00.000Z",
        closedTrades: 4,
        // PM #398: thẻ Retired chỉ đếm nhãn random (1), không cộng 2 nhãn trace.
        traceLabeled: 2,
        labeled: 1,
        right: 1,
        precisionPct: 100,
        interval: null,
        status: "needsLabels",
        labelsToGo: 50,
        mostCommonMistakes: [],
      },
    ],
  };
}

/** #505: dòng v6 của hộp reader; câu còn ở `_pendingReview` nên đọc từ en.json (bỏ thẻ <b>). */
const READER_V6_LINE = messages.signalAnalysis.research.rules.reader.types.replace(/<\/?b>/g, "");

/** #505: Claude reader v6 hiện tại (bắt đầu `v6Start`), v5 đã retired, v4 cũ hơn (Rules v4, bắt đầu `v4Start`). */
function readerV6(v6Start: string, v4Start: string) {
  const base = readerV5(v6Start, v4Start);
  const [cur, old] = base.items;
  if (cur === undefined || old === undefined) throw new Error("fixture");
  return {
    ...base,
    items: [
      { ...cur, classifierVersion: "news-classifier-v6" },
      { ...old, classifierVersion: "news-classifier-v4", startedAt: v4Start },
    ],
  };
}

/** #399: Claude reader v5 hiện tại (bắt đầu `v5Start`), v4 (lên cùng Rules v4, bắt đầu `v4Start`) đã retired. */
function readerV5(v5Start: string, v4Start: string) {
  const base = readerV4(v5Start);
  const [cur, old] = base.items;
  if (cur === undefined || old === undefined) throw new Error("fixture");
  return {
    ...base,
    items: [
      { ...cur, classifierVersion: "news-classifier-v5" },
      { ...old, classifierVersion: "news-classifier-v4", startedAt: v4Start },
    ],
  };
}

describe("Claude reader v4 + Rules v4 (#395)", { timeout: 30_000 }, () => {
  const DAY = 86_400_000;

  async function newsTypes() {
    await userEvent.click(await screen.findByRole("button", { name: "How it works" }));
    const dlg = await screen.findByRole("dialog", { name: "How it works" });
    await userEvent.click(within(dlg).getByRole("tab", { name: "News types" }));
    return dlg;
  }

  it("News types: two boxes; without reader v6 (Rules v5, #506) neither box nor the chip is labelled new", async () => {
    state.classifiers = readerV4(new Date(Date.now() - 2 * DAY).toISOString());
    wrap();
    const dlg = await newsTypes();
    const notCounted = await within(dlg).findByRole("region", { name: /^Not counted/ });
    expect(
      within(notCounted)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      "ETF news on BTC or ETH. Both already have many ETFs, so one more rarely moves the price. Dropped at Score as “ETF on BTC or ETH”.",
      "Treasury buys and sells of BTC or ETH. Too small next to their market. Dropped at Score as “Treasury on BTC or ETH”.",
      "Listings of BTC or ETH. Both already trade on every major exchange, so one more listing does not move the price. Dropped at Score as “Listing on BTC or ETH”.",
      // #593: câu còn chờ PM duyệt nên đọc từ en.json (bỏ thẻ <b>).
      messages.signalAnalysis.research.rules.notCounted.product.replace(/<\/?b>/g, ""),
    ]);
    const reads = within(dlg).getByRole("region", {
      name: /^What Claude reader v4 reads differently/,
    });
    expect(
      within(reads)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([
      READER_V6_LINE,
      "A company’s shares starting to trade is not a listing, and a fund buying a company’s shares is not a treasury buy.",
      "A bug report or a fixed vulnerability with no funds lost is not a hack.",
      "The coin that was stolen is never the hacked asset. In “$860M in ETH drained”, ETH only measures the loss.",
      "Moving or laundering funds from an earlier hack is not a new hack.",
      "An ETF listed on a smaller exchange for a coin that already has ETFs is not “ETF approved”.",
    ]);
    // #506: cả hai nhãn theo reader v6 (Rules v5 lên cùng reader v6); chưa có reader v6 thì không có nhãn nào.
    expect(within(notCounted).queryByText(/^New in v/)).not.toBeInTheDocument();
    expect(within(dlg).queryByText(/^New in v/)).not.toBeInTheDocument();
    expect(within(dlg).getByText(/Claude reader v4 · a starting guess/)).toHaveTextContent(
      "Rules v2 · Claude reader v4 · a starting guess that the results prove or drop",
    );
    expect(within(dlg).queryByText("v1 → v2")).not.toBeInTheDocument();
    // Bố cục cũ giữ nguyên: bảng loại tin và dòng "Not signals" vẫn ở đó.
    expect(
      within(dlg).getByRole("table", { name: "News types, direction and max hold" }),
    ).toBeInTheDocument();
    expect(within(dlg).getByText(/^Not signals:/)).toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("the New in v4 labels hide 14 days after v4 started (started_at from the API)", async () => {
    state.classifiers = readerV4(new Date(Date.now() - 14 * DAY - 60_000).toISOString());
    wrap();
    const dlg = await newsTypes();
    await within(dlg).findByRole("region", { name: "Not counted" });
    expect(within(dlg).queryByText("New in v4")).not.toBeInTheDocument();
    expect(within(dlg).queryByText("v1 → v2")).not.toBeInTheDocument();
    expect(
      within(dlg).getByRole("region", { name: "What Claude reader v4 reads differently" }),
    ).toBeInTheDocument();
  });

  it("#505 reader v6: the reader box follows the current reader, the v6 line first; New in v6 on both boxes (Rules v5, #506)", async () => {
    state.classifiers = readerV6(
      new Date(Date.now() - 1 * DAY).toISOString(),
      new Date(Date.now() - 2 * DAY).toISOString(),
    );
    wrap();
    const dlg = await newsTypes();
    const notCounted = await within(dlg).findByRole("region", { name: /^Not counted/ });
    const reads = within(dlg).getByRole("region", {
      name: /^What Claude reader v6 reads differently/,
    });
    expect(within(reads).getByText("New in v6")).toBeInTheDocument();
    expect(within(reads).getAllByRole("listitem")[0]).toHaveTextContent(READER_V6_LINE);
    expect(within(reads).getAllByRole("listitem")[1]).toHaveTextContent(
      "A company’s shares starting to trade is not a listing, and a fund buying a company’s shares is not a treasury buy.",
    );
    expect(within(reads).getAllByRole("listitem")).toHaveLength(6);
    expect(within(notCounted).getByText("New in v6")).toBeInTheDocument();
    expect(within(dlg).getAllByText("New in v6")).toHaveLength(2);
    expect(within(dlg).queryByText("New in v4")).not.toBeInTheDocument();
    expect(within(dlg).getByText(/Claude reader v6 · a starting guess/)).toBeInTheDocument();
    // Chip của Rules theo mốc reader v6 (lên 1 ngày trước, cùng Rules v5).
    expect(within(dlg).getByText("v1 → v2")).toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("#399 reader v5 after 14 days, Rules v4 older still: no New labels and no chip", async () => {
    state.classifiers = readerV5(
      new Date(Date.now() - 14 * DAY - 60_000).toISOString(),
      new Date(Date.now() - 20 * DAY).toISOString(),
    );
    wrap();
    const dlg = await newsTypes();
    await within(dlg).findByRole("region", { name: "Not counted" });
    expect(
      within(dlg).getByRole("region", { name: "What Claude reader v5 reads differently" }),
    ).toBeInTheDocument();
    expect(within(dlg).queryByText(/^New in v/)).not.toBeInTheDocument();
    expect(within(dlg).queryByText("v1 → v2")).not.toBeInTheDocument();
  });

  it("#399 no classifier rows yet: the reader box title has no version", async () => {
    state.classifiers = { ...CLASSIFIERS, items: [] };
    wrap();
    const dlg = await newsTypes();
    expect(
      await within(dlg).findByRole("region", { name: "What the Claude reader reads differently" }),
    ).toBeInTheDocument();
    expect(intlErrors).toEqual([]);
  });

  it("Is it working?: the v3 card says Retired with v4's start date, kept for history", async () => {
    state.mode = "judge";
    state.classifiers = readerV4("2026-11-21T06:00:00.000Z");
    wrap();
    const r = await screen.findByRole("region", { name: "Is it working?" });
    expect(await within(r).findByText("Claude reader v3")).toBeInTheDocument();
    expect(within(r).getByText("Retired Nov 21")).toBeInTheDocument();
    expect(
      within(r).getByText("4 closed trades · 1 label · kept for history, not counted toward v4"),
    ).toBeInTheDocument();
    await noViolations();
  });

  /** Tổng kết ngay sau khi đổi reader / luật: dòng News · live chưa có lệnh đóng nào được tính. */
  const zeroCounted = () => ({
    ...JUDGE,
    rows: JUDGE.rows.map((x) =>
      x.type === "news" && x.label === "live"
        ? {
            ...x,
            closed: 0,
            classifiers:
              x.classifiers === null ? null : { ...x.classifiers, counted: 0, notCounted: [] },
          }
        : x,
    ),
  });

  it("right after the switch (counts at 0, an older reader exists): count starts again and Collecting", async () => {
    state.mode = "judge";
    state.classifiers = readerV4("2026-11-21T06:00:00.000Z");
    state.summary = zeroCounted();
    state.versions = {
      ...VERSIONS,
      classifier: {
        ...VERSIONS.classifier,
        current: "news-classifier-v4",
        labeled: 0,
        precisionPct: null,
        labelsToGo: 50,
      },
    };
    wrap();
    const r = await screen.findByRole("region", { name: "Is it working?" });
    // Desktop (có <b>) và dòng ngắn của mobile cùng câu.
    expect(
      await within(r).findAllByText(
        (_, el) =>
          el?.tagName === "DIV" &&
          el.textContent === "0 / 100 · new rules and reader, count starts again",
      ),
    ).toHaveLength(2);
    const head = within(r).getByText("Labels for Claude reader v4").parentElement;
    if (head === null) throw new Error("labels card");
    expect(within(head).getByText("Collecting")).toBeInTheDocument();
    expect(within(r).queryByText(/not counting yet/)).not.toBeInTheDocument();
    await noViolations();
  });

  it("without an older reader the cards keep their usual lines and no Collecting pill", async () => {
    state.mode = "judge";
    const [cur] = CLASSIFIERS.items;
    state.classifiers = { ...CLASSIFIERS, items: cur === undefined ? [] : [cur] };
    state.summary = zeroCounted();
    state.versions = { ...VERSIONS, classifier: { ...VERSIONS.classifier, labeled: 0 } };
    wrap();
    const r = await screen.findByRole("region", { name: "Is it working?" });
    const head = (await within(r).findByText("Labels for Claude reader v2")).parentElement;
    if (head === null) throw new Error("labels card");
    expect(within(r).queryByText(/count starts again/)).not.toBeInTheDocument();
    expect(within(head).queryByText("Collecting")).not.toBeInTheDocument();
  });

  it("no retired card without an older reader", async () => {
    state.mode = "judge";
    const [cur] = CLASSIFIERS.items;
    state.classifiers = { ...CLASSIFIERS, items: cur === undefined ? [] : [cur] };
    wrap();
    const r = await screen.findByRole("region", { name: "Is it working?" });
    await within(r).findByText("Labels for Claude reader v2");
    expect(within(r).queryByText(/^Retired /)).not.toBeInTheDocument();
  });
});
