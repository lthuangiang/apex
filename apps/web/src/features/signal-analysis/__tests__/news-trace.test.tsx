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
import { CONTEXT_STEP_MS, STEP_MS } from "../research/news-trace";

import {
  ARTICLES,
  LATENCY_1D,
  PAGE_SIZE,
  SUMMARY_1D,
  SUMMARY_7D,
  TRACES,
} from "./news-trace-fixtures";
import { RESEARCH_TRADES } from "./research-fixtures";

// News feed và funnel trace của tab Signal research (#292, thiết kế docs/mockups/signal-research/news-trace.html).
// API giả (#291) trả fixture đã qua đúng zod schema; giờ hiển thị ở Asia/Ho_Chi_Minh (UTC+7) như mockup.

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
        const base = u.searchParams.get("range") === "7d" ? SUMMARY_7D : SUMMARY_1D;
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
    // #343: trên desktop feed cao bằng khối phễu (lưới 3 cột), cuộn trong khung; điện thoại tối đa 420 px.
    expect(scroll).toHaveClass("overflow-y-auto", "max-h-[420px]", "md:max-h-none");
    expect(within(scroll).getAllByRole("listitem").length).toBeGreaterThan(0);
    const f = funnel();
    // #342: tên mới + phụ đề; khoảng thời gian chỉ ở nhóm nút 1 day / 7 days.
    expect(within(f).getAllByText("From headline to trade").length).toBeGreaterThan(0);
    expect(
      within(f).getByText(
        "Every article, what happened to it, and why. Pick one to watch it go through.",
      ),
    ).toBeInTheDocument();
    expect(within(f).getByRole("button", { name: "Last 24 h" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Số trong tầng (desktop) và trong tầng điện thoại. #297: mọi tầng đếm BÀI thu trong khoảng (articleStops), vào − ra
    // = tầng sau: 58 − 36 = 22, 22 − 19 = 3, 3 − 2 = 1 (1 TP dưới chi phí, 1 gộp), 1 bài mở lệnh = Long 1 · Short 0.
    expect(within(f).getAllByText("58 articles").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("22 articles on SoDEX").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("3 signals").length).toBeGreaterThan(0);
    expect(within(f).getAllByText("1 left").length).toBeGreaterThan(0);
    // Decide: câu dài + câu ngắn (container query), mỗi cặp nhãn–số không ngắt dòng.
    const decide = within(f).getByTestId("sr-funnel-bands").querySelector("[data-band='decide']");
    expect(decide).toHaveTextContent("Long 1 · Short 0");
    expect(decide).toHaveTextContent("L 1 · S 0");
    expect([...(decide?.querySelectorAll("[data-pair]") ?? [])].map((x) => x.textContent)).toEqual([
      "Long 1",
      "Short 0",
      "L 1",
      "S 0",
    ]);
    // #343: phễu sáng 6 tầng; ghi chú từng tầng nằm ở chú thích khi rê chuột (title), không cạnh tầng.
    const band = (name: string) =>
      within(f).getByRole("button", { name: `List articles that stopped at ${name}` });
    expect(band("Collect")).toHaveAttribute("title", "every SoSoValue article");
    // "No coin tagged" bị Normalize loại (event NO_SODEX_MARKET): trừ ở Normalize.
    expect(band("Normalize")).toHaveAttribute(
      "title",
      "36 out · 31 not on SoDEX, 3 no coin tagged",
    );
    expect(band("Score")).toHaveAttribute("title", "19 out · 15 not a catalyst, 4 promo");
    expect(band("Filter")).toHaveAttribute(
      "title",
      "2 out · 1 TP under cost, 1 merged into a story",
    );
    expect(band("Decide")).toHaveAttribute("title", "500 USDC each · TP / SL from volatility");
    // Tầng 4 · Context: viền đứt, chỉ ghi nhận, không bấm được; #358: số tín hiệu có H1 / H2 / H3 = yes trong khoảng.
    const ctxBand = within(f).getByTestId("sr-funnel-bands").querySelector("[data-band='context']");
    expect(ctxBand).toHaveTextContent("4 · Context");
    expect(ctxBand).toHaveAttribute("title", "Whales agree 2 · Funding vs crowd 1 · Ran early 1");
    // #345: mỗi cặp nhãn–số không ngắt dòng; câu dài khi tầng rộng, câu ngắn khi hẹp (container query).
    const pairs = [...(ctxBand?.querySelectorAll("[data-pair]") ?? [])];
    expect(pairs.map((x) => x.textContent)).toEqual([
      "Whales agree 2",
      "Funding vs crowd 1",
      "Ran early 1",
      "Whales 2",
      "Funding 1",
      "Ran early 1",
    ]);
    for (const x of pairs) expect(x).toHaveClass("whitespace-nowrap");
    expect(pairs[0]?.parentElement).toHaveClass("hidden", "@[480px]:inline");
    expect(pairs[3]?.parentElement).toHaveClass("@[480px]:hidden");
    expect(ctxBand).not.toHaveTextContent("saved, not used yet");
    expect(ctxBand?.tagName).toBe("DIV");
    expect(ctxBand).toHaveClass("border-dashed");
    expect(
      within(within(f).getByTestId("sr-funnel-bands"))
        .getAllByText(/^[1-6] · /)
        .map((x) => x.textContent),
    ).toEqual([
      "1 · Collect",
      "2 · Normalize",
      "3 · Score",
      "4 · Context",
      "5 · Filter",
      "6 · Decide",
    ]);
    // Trang gọn (2026-11-20): ba ô giải thích bước 4 dưới phễu đã bỏ (nội dung ở drawer › Context questions).
    expect(within(f).queryByText(/Where the other signals go: step 4 · Context\./)).toBeNull();
    // #343: khung 4 · Context luôn hiện; chế độ tổng là hoạt cảnh chờ, không badge, không số.
    const idle = within(f).getByTestId("sr-ctx-panel");
    expect(idle).toHaveAttribute("data-state", "idle");
    expect(idle).toHaveTextContent("Waiting for the next signal");
    expect(
      within(f).getByText("Each step shows how many of the last 1 day’s articles are still in."),
    ).toBeInTheDocument();
    // #375: "Where the time goes" thay ô Delay: median từng chặng, chặng chậm nhất, chặng thiếu ghi rõ.
    const lat = within(f).getByTestId("sr-latency");
    expect(lat).toHaveTextContent("Where the time goes");
    expect(lat).toHaveTextContent("median · last 1 day · 58 articles");
    const row = (k: string) => lat.querySelector(`[data-stage='${k}']`);
    expect(row("sourceToSoso")).toHaveTextContent(
      "Published by the source → SoSoValueNot provided",
    );
    expect(row("publishedToCollected")).toHaveTextContent(
      "SoSoValue → DeskLabs collected · waiting for the 5-min check5 min 45 s",
    );
    expect(row("publishedToCollected")).toHaveAttribute("data-slowest");
    expect(row("collectedToClaudeDone")).toHaveTextContent("9 s");
    expect(row("claudeDoneToDecided")).toHaveTextContent("1 s");
    expect(row("decidedToOpened")).toHaveTextContent("Not measured yet");
    expect(within(lat).getByTestId("sr-latency-slowest")).toHaveTextContent(
      "Slowest leg: waiting for the 5-min check. SoSoValue is checked every 5 min, so most of the delay is the wait for the next check.",
    );
    expect(within(lat).getByTestId("sr-latency-total")).toHaveTextContent(
      "Total, SoSoValue → paper trade opened: Not measured yet",
    );
    expect(lat).not.toHaveTextContent(/(^|\D)0 s/);
    expect(within(f).getByText("$0.03 · last 24 h")).toBeInTheDocument();
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
      expect(within(funnel()).getByRole("button", { name: "7 days" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
    expect(lastPath("/summary")).toContain("range=7d");
    expect(lastPath("/articles?")).toContain("range=7d");
    expect(await within(funnel()).findByText("$2.94 · last 7 days")).toBeInTheDocument();
    expect(within(funnel()).getAllByText("1,240 articles").length).toBeGreaterThan(0);
    expect(within(funnel()).getAllByText("340 articles on SoDEX").length).toBeGreaterThan(0);
    expect(within(funnel()).getAllByText("108 signals").length).toBeGreaterThan(0);
    expect(within(funnel()).getAllByText("41 left").length).toBeGreaterThan(0);
    expect(
      within(funnel()).getByTestId("sr-funnel-bands").querySelector("[data-band='decide']"),
    ).toHaveTextContent("Long 29 · Short 12");
    expect(
      within(funnel()).getByRole("button", { name: "List articles that stopped at Normalize" }),
    ).toHaveAttribute("title", "900 out · 808 duplicate, 52 not on SoDEX");
    // 7 ngày: API chưa có snapshot live trong khoảng (context null) → giữ "saved, not used yet", không bao giờ 0.
    const ctx7 = within(funnel())
      .getByTestId("sr-funnel-bands")
      .querySelector("[data-band='context']");
    expect(ctx7).toHaveTextContent("saved, not used yet");
    expect(ctx7).not.toHaveTextContent(/Whales agree/);
    expect(intlErrors).toEqual([]);
  });

  // #394: số phút của "Where the time goes" lấy từ API tổng kết (`cycleMinutes`), không từ hằng của web.
  it("the check interval comes from the summary API: 1 minute reads “every minute”, missing leaves the number out", async () => {
    state.cycleMinutes = 1;
    await ready();
    let lat = await within(funnel()).findByTestId("sr-latency");
    await waitFor(() => {
      expect(within(lat).getByTestId("sr-latency-slowest")).toHaveTextContent(
        "Slowest leg: waiting for the 1-min check. SoSoValue is checked every minute, so most of the delay is the wait for the next check.",
      );
    });
    expect(lat).not.toHaveTextContent("5-min");
    expect(lat).not.toHaveTextContent("1 minutes");
    cleanup();

    state.cycleMinutes = null;
    await ready();
    lat = await within(funnel()).findByTestId("sr-latency");
    await waitFor(() => {
      expect(lat.querySelector("[data-stage='publishedToCollected']")).toHaveTextContent(
        /^SoSoValue → DeskLabs collected5 min 45 s$/,
      );
    });
    expect(lat).not.toHaveTextContent("-min check");
    expect(lat).not.toHaveTextContent("checked every");
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
    expect(within(f).queryByRole("button", { name: /List articles that stopped at/ })).toBeNull();
    expect(within(f).queryByRole("list", { name: "Steps this article went through" })).toBeNull();
    // Khung Context cạnh phễu chờ tới bước 4.
    const panel = within(f).getByTestId("sr-ctx-panel");
    expect(panel).toHaveAttribute("data-state", "waiting");
    expect(panel).toHaveTextContent("Waiting for the article to reach step 4…");
    expect(panel).toHaveTextContent("saved, not used yet");

    const names = ["Collect", "Normalize", "Score", "Context", "Filter", "Decide"];
    for (const [i, n] of names.entries()) {
      // Bước 4 · Context giữ lâu hơn để hiệu ứng H1 / H2 / H3 chạy xong.
      await tick(i === 4 ? CONTEXT_STEP_MS : STEP_MS);
      expect(verdict()).toHaveTextContent(`Step ${String(i + 1)} · ${n}…`);
      // Thẻ của bước đang chạy chưa hiện; các bước trước đã hiện.
      const list = within(f).queryByRole("list", { name: "Steps this article went through" });
      expect(list === null ? 0 : within(list).getAllByRole("listitem").length).toBe(i);
      if (i === 3) {
        // Chip tới bước 4: khung chạy hiệu ứng theo snapshot của bài này.
        expect(panel).toHaveAttribute("data-state", "shown");
        expect(within(panel).getByTestId("sr-ctx-h1")).toHaveAttribute("data-answer", "yes");
        expect(within(panel).getByText("2 whales · +$1.4M Long")).toBeInTheDocument();
        expect(within(panel).getByTestId("sr-ctx-h2")).toHaveAttribute("data-answer", "yes");
        expect(within(panel).getByText("Funding p8 · shorts pay")).toBeInTheDocument();
        expect(within(panel).getByTestId("sr-ctx-h3")).toHaveAttribute("data-answer", "no");
        expect(within(panel).getByText("+0.2% before · on time")).toBeInTheDocument();
      }
    }
    await tick();
    expect(verdict()).toHaveTextContent("Reached Decide: Long ETH-USD, 500 USDC · Claude $0.0021");
    expect(
      within(within(f).getByTestId("sr-funnel-bands")).getByText("2 of 3 yes"),
    ).toBeInTheDocument();
    const list = within(f).getByRole("list", { name: "Steps this article went through" });
    expect(
      within(list)
        .getAllByRole("heading")
        .map((h) => h.textContent),
    ).toEqual([
      "1. Collect",
      "2. Normalize",
      "3. Score",
      "4 · Context at 10:20:14",
      "5. Filter",
      "6. Decide",
    ]);
    expect(within(list).getAllByText("Passed")).toHaveLength(5);
    // #375: thẻ Collect có dòng thời gian 6 mốc (giờ trang Asia/Ho_Chi_Minh), khoảng "+N" giữa hai mốc.
    const tl = within(list).getByTestId("sr-latency-timeline");
    const mark = (k: string) => tl.querySelector(`[data-mark='${k}']`);
    expect(tl).toHaveTextContent("From news to trade");
    expect(tl).toHaveTextContent("SoSoValue → paper trade opened: 4 min 18 s");
    expect(mark("published")).toHaveTextContent(
      "Published by the sourceSoSoValue doesn’t send the source’s timeNot provided",
    );
    expect(mark("released")).toHaveTextContent("SoSoValue released10:16:02");
    expect(mark("collected")).toHaveTextContent(
      "DeskLabs collected+4 min 9 s · waited for the 5-min check10:20:11",
    );
    expect(mark("claudeDone")).toHaveTextContent("Claude done+8 s10:20:19");
    expect(mark("decided")).toHaveTextContent("Decided: Long ETH+1 s10:20:20");
    expect(mark("opened")).toHaveTextContent("Paper trade opened+40 ms10:20:20");
    // #376: thẻ Decide có "Market at decision"; snapshot này ghi trước #376 nên cả hai chip là Not available.
    const market = within(list).getByRole("region", { name: "Market at decision" });
    const decide = market.closest("li");
    if (decide === null) throw new Error("Decide card");
    expect(within(decide).getByRole("heading")).toHaveTextContent("6. Decide");
    expect(within(market).getByText("BTC trend: Not available")).toBeInTheDocument();
    expect(within(market).getByText("Volatility (ETH): Not available")).toBeInTheDocument();
    // Thẻ bước 4: giá trị lưu lúc quyết định; Yes màu xanh dương trung tính, không phải xanh lá.
    expect(within(list).getByText("Recorded · does not change the trade")).toBeInTheDocument();
    const h1 = within(list).getByTestId("sr-ctx-card-h1");
    expect(h1).toHaveTextContent("H1 · Whales agree");
    expect(within(h1).getByText("Yes")).toHaveClass("text-accent-ink");
    expect(h1).toHaveTextContent(
      "2 tracked wallets added Long ETH in the 60 min before · $1.4M · first at 09:41",
    );
    expect(within(list).getByTestId("sr-ctx-card-h2")).toHaveTextContent(
      "Funding −0.010% per 8 h · 8th percentile of 30 days · Long needs ≤ 20th",
    );
    const h3 = within(list).getByTestId("sr-ctx-card-h3");
    expect(within(h3).getByText("No")).toHaveClass("text-ink-2");
    expect(h3).toHaveTextContent("+0.2% before entry · typical 1 h move 0.6% · threshold 0.6%");
    // Exploratory values: <details> gập sẵn.
    const details = within(list).getByText("Exploratory values").closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(within(list).getByText("1.8×")).toBeInTheDocument();
    expect(within(list).getByText("Open interest").closest("div")).toHaveTextContent(
      "Not available",
    );
    // #343: tầng phễu chỉ hiện kết quả gọn, không cắt "…" (xuống 2 dòng nếu cần).
    const bandsBox = within(f).getByTestId("sr-funnel-bands");
    const notes = [...bandsBox.querySelectorAll("[data-band]")].map(
      (b) => b.lastElementChild?.textContent ?? "",
    );
    expect(notes).toEqual([
      "Seen 4 min after release",
      "ETH-USD · new story",
      "ETF approved → Long",
      "2 of 3 yes",
      "4 of 4 checks",
      "Long 500 USDC",
    ]);
    for (const el of bandsBox.querySelectorAll("[data-band] span"))
      expect(el.getAttribute("class") ?? "").not.toMatch(/truncate|text-ellipsis|line-clamp/);
    // Chip "Paper trade · ETH" đỗ ở hàng trống dưới Decide, không che "Long 500 USDC".
    const chip = within(f).getByTestId("sr-token");
    expect(chip).toHaveTextContent("Paper trade · ETH");
    expect(chip.style.top).toBe("268px");
    expect(within(f).getByTestId("sr-token-dock")).toBeInTheDocument();
    expect(bandsBox.querySelector("[data-band='normalize'] > span:last-child")).toHaveClass(
      "whitespace-normal",
    );
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
    // Replay: khung Context về chờ, hiệu ứng chạy lại khi chip tới bước 4.
    expect(within(f).getByTestId("sr-ctx-panel")).toHaveAttribute("data-state", "waiting");
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

  it("an article dropped at Filter stops there: grey step, the internal code, no Decide card; all-No context", async () => {
    await ready();
    vi.useFakeTimers();
    fireEvent.click(card("Solana Foundation"));
    await tick(0);
    for (let i = 0; i < 4; i++) await tick();
    // Bước 4: "no signal" (cả ba No, mockup trace-no-signal): sonar + 2 cá voi lội nền, bập bênh cân bằng, "on time".
    const f = funnel();
    const panel = within(f).getByTestId("sr-ctx-panel");
    expect(panel).toHaveAttribute("data-state", "shown");
    expect(within(panel).getByTestId("sr-ctx-h1")).toHaveAttribute("data-answer", "no");
    expect(within(panel).getByText("12 wallets checked · quiet")).toBeInTheDocument();
    expect(within(panel).getByText("Funding p48 · no crowd")).toBeInTheDocument();
    expect(within(panel).getByText("−0.1% before · on time")).toBeInTheDocument();
    const swim = panel.querySelectorAll(".sr-swim");
    expect(swim).toHaveLength(2);
    for (const w of swim) expect(w.getAttribute("class")).toContain("motion-reduce:hidden");
    await tick(CONTEXT_STEP_MS);
    await tick();
    expect(verdict()).toHaveTextContent(
      "Stopped at Filter: take profit under 2× cost · Claude $0.0022",
    );
    expect(within(f).getByText("TP 0.15% < 2× cost")).toBeInTheDocument();
    expect(
      within(within(f).getByTestId("sr-funnel-bands")).getByText("0 of 3 yes"),
    ).toBeInTheDocument();
    const list = within(f).getByRole("list", { name: "Steps this article went through" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
    // #375: Filter loại → quyết định không vào lệnh; không có lệnh để đo.
    const tlSol = within(list).getByTestId("sr-latency-timeline");
    expect(tlSol.querySelector("[data-mark='decided']")).toHaveTextContent("Decided: no trade+2 s");
    expect(tlSol.querySelector("[data-mark='opened']")).toHaveTextContent(
      "Paper trade openedNot available",
    );
    expect(tlSol).toHaveTextContent("SoSoValue → decided:");
    expect(within(list).getByText("Dropped")).toHaveClass("bg-bg");
    expect(within(list).getByTestId("sr-ctx-card-h1")).toHaveTextContent(
      "Checked 12 tracked wallets: none traded SOL in the 60 min before.",
    );
    expect(within(list).getByTestId("sr-ctx-card-h2")).toHaveTextContent("Short needs ≥ 80th");
    expect(
      within(list).getByText("The expected move is too small to beat the cost of a trade."),
    ).toBeInTheDocument();
    expect(within(list).getByText("0.15% vs 2 × 0.10% = 0.20%")).toBeInTheDocument();
    // Mã nội bộ không in ra thẻ: cùng câu với "Why they dropped out", mã chỉ ở tooltip.
    const result = within(list).getByText("Dropped: Take profit under 2× cost");
    expect(result).toHaveAttribute("title", "MOVE_TOO_SMALL_FOR_COST");
    expect(within(list).queryByText(/MOVE_TOO_SMALL_FOR_COST/)).toBeNull();
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
    // #375: bài không qua Claude, chưa quyết định: các mốc sau ghi "Not measured yet", không bao giờ 0.
    const tlOld = within(list).getByTestId("sr-latency-timeline");
    for (const k of ["claudeDone", "decided", "opened"])
      expect(tlOld.querySelector(`[data-mark='${k}']`)).toHaveTextContent("Not measured yet");
    expect(tlOld).toHaveTextContent("SoSoValue → decided: Not measured yet");
    expect(within(list).getByText("Dropped: Not on SoDEX")).toHaveAttribute(
      "title",
      "NO_SODEX_MARKET",
    );
    // Không còn mã nội bộ / enum thô nào hiện ra trong phễu, thẻ bước hay feed.
    expect(f.textContent).not.toMatch(/\b[A-Z]{2,}(_[A-Z]+)+\b/);
    // Chip bài bị loại đỗ trong rãnh bên phải tầng Normalize, cùng hàng, không xoay.
    const chip = within(f).getByTestId("sr-token");
    expect(chip).toHaveAttribute("data-tone", "dropped");
    expect(chip.style.top).toBe("44px");
    expect(chip.style.left).toBe("calc(100% - 100px)");
    expect(chip.className).not.toMatch(/rotate/);
    expect(
      within(list).getByText(
        "No SoDEX market for KNTQ, so the article stops here and Claude is not called.",
      ),
    ).toBeInTheDocument();
    expect(within(f).getByText("KNTQ not on SoDEX")).toBeInTheDocument();
    // Bài dừng trước bước 4: không kiểm ngữ cảnh.
    expect(within(f).getByTestId("sr-ctx-panel")).toHaveAttribute("data-state", "notReached");
    expect(within(f).getByText("This article stopped before step 4")).toBeInTheDocument();
    // Không có lớp hiệu ứng nào chạy ngoài motion-safe.
    for (const el of f.querySelectorAll("[class*='animate-']"))
      expect(el.getAttribute("class") ?? "").not.toMatch(/(^|\s)animate-/);
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
