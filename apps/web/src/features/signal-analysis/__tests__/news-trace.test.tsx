// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { RESEARCH_DROP_REASONS, RESEARCH_MERGE_REASONS, type ResearchArticle } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { SignalAnalysisPage } from "../components/signal-analysis-page";
import { STEP_MS } from "../research/news-trace";

import { ARTICLES, PAGE_SIZE, SUMMARY_1D, SUMMARY_7D, TRACES } from "./news-trace-fixtures";
import { RESEARCH_TRADES } from "./research-fixtures";

// News feed và funnel trace của tab Signal research (#292, thiết kế docs/mockups/signal-research/news-trace.html).
// API giả (#291) trả fixture đã qua đúng zod schema; giờ hiển thị ở Asia/Ho_Chi_Minh (UTC+7) như mockup.

const state = vi.hoisted((): { paths: string[]; reduced: boolean } => ({
  paths: [],
  reduced: false,
}));

vi.mock("@/features/account/market-hours-time", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/features/account/market-hours-time")>();
  return { ...real, browserTimeZone: () => "Asia/Ho_Chi_Minh" };
});

function feed(q: URLSearchParams): { items: ResearchArticle[]; total: number } {
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
      if (p.endsWith("/signal-research/summary"))
        return Promise.resolve(
          schema.parse(u.searchParams.get("range") === "7d" ? SUMMARY_7D : SUMMARY_1D),
        );
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

const funnel = () => screen.getByRole("region", { name: /How news becomes a paper trade/ });
const verdict = () => within(funnel()).getByRole("status");
const lastPath = (part: string) => [...state.paths].reverse().find((p) => p.includes(part)) ?? "";
const card = (title: string) =>
  within(funnel()).getByRole("button", { name: new RegExp(title.replace(/[$.]/g, "\\$&")) });

async function ready() {
  wrap();
  await screen.findByRole("region", { name: /How news becomes a paper trade/ });
  await within(funnel()).findByRole("button", { name: /SEC approves in-kind creations/ });
}

/** Chạy với fake timers: từng bước 950 ms. */
async function tick(ms = STEP_MS) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("Signal research · news feed and funnel trace", { timeout: 30_000 }, () => {
  it("totals mode: 1 day by default, counts, notes, delay, Claude cost and drop reasons; 7 days refetches", async () => {
    await ready();
    expect(lastPath("/summary")).toContain("range=1d");
    expect(lastPath("/articles?")).toContain("range=1d");
    // #297: 20 bài mỗi trang, feed cuộn trong khung cao cố định (không kéo dài trang).
    expect(lastPath("/articles?")).toContain("limit=20");
    const scroll = screen.getByTestId("sr-feed-scroll");
    expect(scroll).toHaveClass("overflow-y-auto", "max-h-[420px]", "md:max-h-[470px]");
    expect(within(scroll).getAllByRole("listitem").length).toBeGreaterThan(0);
    const f = funnel();
    expect(within(f).getByText("How news becomes a paper trade · last 1 day")).toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "1 day" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Số trong tầng (desktop) và trong tầng điện thoại. #297: mọi tầng đếm BÀI thu trong khoảng (articleStops), vào − ra
    // = tầng sau: 58 − 36 = 22, 22 − 19 = 3, 3 − 2 = 1 (1 TP dưới chi phí, 1 gộp), 1 bài mở lệnh = Long 1 · Short 0.
    expect(within(f).getAllByText("58 articles").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("22 articles on SoDEX").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("3 signals").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("1 left").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("Long 1 · Short 0").length).toBeGreaterThan(0);
    expect(within(f).getByText("every SoSoValue article")).toBeInTheDocument();
    // "No coin tagged" bị Normalize loại (event NO_SODEX_MARKET): trừ ở Normalize.
    expect(within(f).getByText("36 out · 31 not on SoDEX, 3 no coin tagged")).toBeInTheDocument();
    expect(within(f).getByText("19 out · 15 not a catalyst, 4 promo")).toBeInTheDocument();
    expect(
      within(f).getByText("2 out · 1 TP under cost, 1 merged into a story"),
    ).toBeInTheDocument();
    expect(
      within(f).getByText(
        "Every step counts the same articles, collected in the last 1 day: in − out = next step.",
      ),
    ).toBeInTheDocument();
    expect(within(f).getByText("500 USDC each · TP / SL from volatility")).toBeInTheDocument();
    expect(within(f).getByText("4 min 20 s")).toBeInTheDocument();
    expect(within(f).getByText("$0.03 today")).toBeInTheDocument();
    expect(
      within(f).getByText(
        "Totals for last 1 day. Click a step to list its articles, or pick an article to watch it go through.",
      ),
    ).toBeInTheDocument();
    expect(verdict()).toHaveTextContent(
      "Pick an article on the left, or click a step to list its articles.",
    );
    // Lý do theo thứ tự bước rồi số bài; số bài khớp feed (articleStops).
    const reasons = within(within(f).getByRole("group", { name: "Why they dropped out" }))
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(reasons).toEqual([
      "No coin tagged · 3",
      "Not on SoDEX · 31",
      "Duplicate · 2",
      "Not a catalyst · 15",
      "Promotional · 4",
      "Take profit under 2× cost · 1",
    ]);
    // Feed: giờ, độ trễ, chi phí Claude, kết quả.
    expect(within(f).getByText("5 of 58 articles")).toBeInTheDocument();
    const eth = card("SEC approves in-kind creations");
    expect(within(eth).getByText("10:16 · 4 min after release")).toBeInTheDocument();
    expect(within(eth).getByText("$0.0021")).toBeInTheDocument();
    expect(within(eth).getByText("Long ETH · paper trade")).toBeInTheDocument();
    expect(within(card("Bithumb will list")).getByText("No Claude call")).toBeInTheDocument();
    expect(within(card("Bithumb will list")).getByText("Dropped at Normalize")).toBeInTheDocument();
    expect(within(card("Solana Foundation")).getByText("Dropped at Filter")).toBeInTheDocument();
    expect(within(card("Hyperliquid")).getByText("BTC, HYPE")).toBeInTheDocument();
    await noViolations();

    await userEvent.click(within(f).getByRole("button", { name: "7 days" }));
    await waitFor(() => {
      expect(
        within(funnel()).getByText("How news becomes a paper trade · last 7 days"),
      ).toBeInTheDocument();
    });
    expect(lastPath("/summary")).toContain("range=7d");
    expect(lastPath("/articles?")).toContain("range=7d");
    expect(await within(funnel()).findByText("$0.42 / day")).toBeInTheDocument();
    expect(within(funnel()).getAllByText("1,240 articles").length).toBeGreaterThan(0);
    expect(within(funnel()).getAllByText("340 articles on SoDEX").length).toBeGreaterThan(0);
    expect(within(funnel()).getAllByText("108 signals").length).toBeGreaterThan(0);
    expect(within(funnel()).getAllByText("41 left").length).toBeGreaterThan(0);
    expect(within(funnel()).getAllByText("Long 29 · Short 12").length).toBeGreaterThan(0);
    expect(
      within(funnel()).getByText("900 out · 808 duplicate, 52 not on SoDEX"),
    ).toBeInTheDocument();
    expect(intlErrors).toEqual([]);
  });

  it("clicking a band or a drop reason filters the feed, with Clear; Show filter and Load more", async () => {
    await ready();
    const f = funnel();
    const band = within(f).getByRole("button", { name: "List articles that stopped at Normalize" });
    await userEvent.click(band);
    expect(band).toHaveAttribute("aria-pressed", "true");
    expect(await within(f).findByText("Stopped at 2 · Normalize")).toBeInTheDocument();
    await waitFor(() => {
      expect(lastPath("/articles?")).toContain("stage=normalize");
    });
    await waitFor(() => {
      expect(within(f).queryByRole("button", { name: /SEC approves/ })).not.toBeInTheDocument();
    });
    expect(card("Bithumb will list")).toBeInTheDocument();
    await userEvent.click(within(f).getByRole("button", { name: "Clear" }));
    expect(within(f).queryByText("Stopped at 2 · Normalize")).not.toBeInTheDocument();
    expect(band).toHaveAttribute("aria-pressed", "false");
    await waitFor(() => {
      expect(lastPath("/articles?")).not.toContain("stage=");
    });

    await userEvent.click(within(f).getByRole("button", { name: "Take profit under 2× cost · 1" }));
    expect(await within(f).findByText("Reason: Take profit under 2× cost")).toBeInTheDocument();
    await waitFor(() => {
      expect(lastPath("/articles?")).toContain("reason=tpUnderCost");
    });
    expect(await within(f).findByText("1 of 58 articles")).toBeInTheDocument();
    // Bấm lại lý do đang chọn thì bỏ lọc.
    await userEvent.click(within(f).getByRole("button", { name: "Take profit under 2× cost · 1" }));
    expect(within(f).queryByText(/^Reason:/)).not.toBeInTheDocument();

    const group = within(f).getByRole("group", { name: "Filter articles" });
    await userEvent.click(within(group).getByRole("button", { name: "Sent to Claude" }));
    expect(within(group).getByRole("button", { name: "Sent to Claude" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() => {
      expect(lastPath("/articles?")).toContain("show=claude");
    });
    await waitFor(() => {
      expect(within(f).queryByRole("button", { name: /Bithumb/ })).not.toBeInTheDocument();
    });
    await userEvent.click(within(group).getByRole("button", { name: "All" }));
    await userEvent.click(await within(f).findByRole("button", { name: "Load more" }));
    await waitFor(() => {
      expect(state.paths.some((p) => p.includes("cursor=a2"))).toBe(true);
    });
    // Bài flash không có tiêu đề: hiện đoạn trích; bài gộp không phải bị loại.
    const merged = await within(f).findByRole("button", {
      name: /Spot ETH ETF approval confirmed/,
    });
    expect(within(merged).getByText("Merged into an existing story")).toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("trace mode: the chip goes down one band per step, cards appear one by one, then the verdict; Back and Replay", async () => {
    await ready();
    vi.useFakeTimers();
    fireEvent.click(card("SEC approves in-kind creations"));
    expect(card("SEC approves in-kind creations")).toHaveAttribute("aria-pressed", "true");
    expect(verdict()).toHaveTextContent("Article arriving…");
    await tick(0);
    expect(lastPath("/trace")).toContain("/articles/art-eth/trace");
    const f = funnel();
    expect(
      within(f).getByRole("heading", { name: "SEC approves in-kind creations for spot ETH ETFs" }),
    ).toBeInTheDocument();
    expect(
      within(f).getByText(/SoSoValue · Reuters \(top tier\) · published 10:16/),
    ).toBeInTheDocument();
    expect(within(f).getByRole("link", { name: "Open article" })).toHaveAttribute(
      "href",
      "https://example.com/eth-etf",
    );
    // Totals ẩn, tầng không bấm được khi đang trace.
    expect(within(f).queryByText("Why they dropped out")).not.toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "Collect" })).toBeDisabled();
    expect(within(f).queryByRole("list", { name: "Steps this article went through" })).toBeNull();

    const names = ["Collect", "Normalize", "Score", "Filter", "Decide"];
    for (const [i, n] of names.entries()) {
      await tick();
      expect(verdict()).toHaveTextContent(`Step ${String(i + 1)} · ${n}…`);
      // Thẻ của bước đang chạy chưa hiện; các bước trước đã hiện.
      const list = within(f).queryByRole("list", { name: "Steps this article went through" });
      expect(list === null ? 0 : within(list).getAllByRole("listitem").length).toBe(i);
    }
    await tick();
    expect(verdict()).toHaveTextContent("Reached Decide: Long ETH-USD, 500 USDC · Claude $0.0021");
    const list = within(f).getByRole("list", { name: "Steps this article went through" });
    expect(
      within(list)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual(names.map((n, i) => `${String(i + 1)}. ${n}`));
    expect(within(list).getAllByText("Passed")).toHaveLength(5);
    expect(within(f).getAllByText("Seen 4 min after release").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("ETH → ETH-USD · new story").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("ETF approved → Long · Medium · $0.0021").length).toBeGreaterThan(
      0,
    );
    expect(within(f).getAllByText("4 of 4 checks passed").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("Long ETH-USD · 500 USDC").length).toBeGreaterThan(0);
    expect(within(list).getByText("10:20:11 (4 min 9 s later)")).toBeInTheDocument();
    expect(within(list).getByText("ETHEREUM (ETH)")).toBeInTheDocument();
    expect(within(list).getByText("New · ETF approved · ETH-USD")).toBeInTheDocument();
    expect(within(list).getByText("Medium: Reuters (top tier)")).toBeInTheDocument();
    expect(within(list).getByText("in 512 · cache read 4,635 · out 118")).toBeInTheDocument();
    expect(within(list).getByText("$0.0021 (claude-haiku-4-5)")).toBeInTheDocument();
    expect(within(list).getByText("4 min (limit 30 min)")).toBeInTheDocument();
    expect(within(list).getByText("SoDEX price available, spread 1.1 bp")).toBeInTheDocument();
    expect(within(list).getByText("1.60% vs 2 × 0.10% cost: ok")).toBeInTheDocument();
    expect(within(list).getByText("3,412.50 at 10:20:14")).toBeInTheDocument();
    expect(within(list).getByText("3,467.10 (+1.6%) / 3,385.20 (−0.8%)")).toBeInTheDocument();
    expect(within(list).getByText("500 USDC (fake money)")).toBeInTheDocument();
    expect(within(list).getByText("3 d")).toBeInTheDocument();
    // Không chạy tiếp sau kết luận.
    await tick(STEP_MS * 3);
    expect(verdict()).toHaveTextContent("Reached Decide");

    fireEvent.click(within(f).getByRole("button", { name: "Replay" }));
    expect(verdict()).toHaveTextContent("Article arriving…");
    expect(within(f).queryByRole("list", { name: "Steps this article went through" })).toBeNull();
    await tick();
    expect(verdict()).toHaveTextContent("Step 1 · Collect…");

    fireEvent.click(within(f).getByRole("button", { name: "Back to totals" }));
    expect(verdict()).toHaveTextContent("Pick an article on the left");
    expect(within(f).getByText("Why they dropped out")).toBeInTheDocument();
    expect(card("SEC approves in-kind creations")).toHaveAttribute("aria-pressed", "false");
    vi.useRealTimers();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("an article dropped at Filter stops there: red step, the internal code, no Decide card", async () => {
    await ready();
    vi.useFakeTimers();
    fireEvent.click(card("Solana Foundation"));
    await tick(0);
    for (let i = 0; i < 5; i++) await tick();
    const f = funnel();
    expect(verdict()).toHaveTextContent(
      "Stopped at Filter: take profit under 2× cost · Claude $0.0022",
    );
    expect(within(f).getByText("Dropped · TP 0.15% < 2× cost")).toBeInTheDocument();
    const list = within(f).getByRole("list", { name: "Steps this article went through" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    expect(within(list).getByText("Dropped")).toBeInTheDocument();
    expect(
      within(list).getByText("The expected move is too small to beat the cost of a trade."),
    ).toBeInTheDocument();
    expect(within(list).getByText("0.15% vs 2 × 0.10% = 0.20%")).toBeInTheDocument();
    expect(within(list).getByText("Dropped: MOVE_TOO_SMALL_FOR_COST")).toBeInTheDocument();
    expect(within(list).getByText("Hack → Short")).toBeInTheDocument();
    expect(within(list).queryByRole("heading", { name: /Decide/ })).not.toBeInTheDocument();
    expect(within(f).getByText(/SoSoValue · project account \(mid tier\)/)).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("prefers-reduced-motion: no animation, the final state shows at once", async () => {
    state.reduced = true;
    await ready();
    await userEvent.click(card("Bithumb will list"));
    const f = funnel();
    await waitFor(() => {
      expect(verdict()).toHaveTextContent(
        "Stopped at Normalize: KNTQ is not on SoDEX · No Claude call",
      );
    });
    const list = within(f).getByRole("list", { name: "Steps this article went through" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Dropped: NO_SODEX_MARKET")).toBeInTheDocument();
    expect(
      within(list).getByText(
        "No SoDEX market for KNTQ, so the article stops here and Claude is not called.",
      ),
    ).toBeInTheDocument();
    expect(within(f).getByText("Dropped · KNTQ not on SoDEX")).toBeInTheDocument();
    // Không có lớp hiệu ứng nào chạy ngoài motion-safe.
    for (const el of f.querySelectorAll("[class*='animate-']"))
      expect(el.className).not.toMatch(/(^|\s)animate-/);
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("Trace in the Trades table scrolls to the funnel and runs that article; rows without an article have no Trace", async () => {
    state.reduced = true;
    await ready();
    const tbl = await screen.findByRole("table", { name: "Signal research trades" });
    // Chỉ dòng News có articleId mới có Trace.
    expect(within(tbl).getAllByRole("button", { name: /^Trace: / })).toHaveLength(2);
    expect(within(tbl).getByRole("columnheader", { name: "Trace" })).toBeInTheDocument();
    await userEvent.click(
      within(tbl).getByRole("button", { name: "Trace: SEC delays decision on SOL ETF" }),
    );
    expect(scrolled).toContain("sr-funnel");
    await waitFor(() => {
      expect(verdict()).toHaveTextContent("Stopped at Filter: take profit under 2× cost");
    });
    expect(lastPath("/trace")).toContain("/articles/art-sol/trace");
    expect(card("Solana Foundation")).toHaveAttribute("aria-pressed", "true");
    // Bấm lại cùng bài: chạy lại.
    const n = state.paths.length;
    await userEvent.click(
      within(tbl).getByRole("button", { name: "Trace: SEC delays decision on SOL ETF" }),
    );
    expect(scrolled.filter((x) => x === "sr-funnel")).toHaveLength(2);
    expect(state.paths.length).toBeGreaterThanOrEqual(n);
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("missing Claude usage shows Not available, never $0; a trace the API cannot find shows the error", async () => {
    state.reduced = true;
    await ready();
    expect(within(card("Hyperliquid")).getByText("Not available")).toBeInTheDocument();
    await userEvent.click(card("Hyperliquid"));
    const f = funnel();
    await waitFor(() => {
      expect(verdict()).toHaveTextContent(
        "Stopped at Score: passing mention, not a signal type · Claude cost not available",
      );
    });
    const list = within(f).getByRole("list", { name: "Steps this article went through" });
    const row = (label: string) => within(list).getByText(label).closest("div");
    expect(row("Claude tokens")).toHaveTextContent("Not available");
    expect(row("Claude cost")).toHaveTextContent("Not available");
    expect(within(list).getByText("Passing mention")).toBeInTheDocument();
    expect(within(list).getByText("BITCOIN (BTC), HYPERLIQUID (HYPE)")).toBeInTheDocument();
    expect(within(f).queryByText(/\$0(\.0+)?$/)).not.toBeInTheDocument();

    // Bài gộp (không có trace trong fixture) → API 404.
    await userEvent.click(within(f).getByRole("button", { name: "Back to totals" }));
    await userEvent.click(within(f).getByRole("button", { name: "Load more" }));
    await userEvent.click(await within(f).findByRole("button", { name: /Spot ETH ETF approval/ }));
    await waitFor(() => {
      expect(verdict()).toHaveTextContent("Couldn’t load this article’s trace.");
    });
    expect(within(f).queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    await noViolations();
    expect(intlErrors).toEqual([]);
  });

  it("times follow Show in UTC", async () => {
    await ready();
    expect(
      within(card("SEC approves")).getByText("10:16 · 4 min after release"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show in UTC" }));
    await waitFor(() => {
      expect(
        within(card("SEC approves")).getByText("03:16 · 4 min after release"),
      ).toBeInTheDocument();
    });
  });

  it("every new enum value has its English text", () => {
    const tr = messages.signalAnalysis.research.trace;
    for (const k of RESEARCH_DROP_REASONS) {
      expect(Object.keys(tr.reasonLabels)).toContain(k);
      expect(Object.keys(tr.noteReasons)).toContain(k);
      expect(Object.keys(tr.why)).toContain(k);
    }
    for (const k of RESEARCH_MERGE_REASONS) expect(Object.keys(tr.why)).toContain(k);
    expect(messages._pendingReview).toContain("signalAnalysis.research.trace");
  });
});
