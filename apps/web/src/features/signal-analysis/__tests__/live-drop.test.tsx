// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ResearchArticle, ResearchNewArticles } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { SignalAnalysisPage } from "../components/signal-analysis-page";
import {
  advance,
  EMPTY_QUEUE,
  enqueue,
  enqueueNewest,
  interrupt,
  LIVE_CONTEXT_MS,
  LIVE_HOLD_MS,
  LIVE_POLL_MS,
  LIVE_STEP_MS,
  liveDuration,
} from "../research/live-drop";
import { STEP_MS } from "../research/news-trace";
import { BAND_COUNT, BANDS, CONTEXT_BAND } from "../research/trace-player";

import {
  ARTICLES,
  ETH,
  HYPE,
  KNTQ,
  MERGED,
  PAGE_SIZE,
  SOL,
  SUMMARY_1D,
  SUMMARY_7D,
  TRACES,
} from "./news-trace-fixtures";
import { RESEARCH_TRADES } from "./research-fixtures";

// Bài mới live (#345, docs/mockups/signal-research/redesign-live-new-article.html): hỏi `/articles/new?since=` mỗi 15 s
// chỉ khi Live bật + tab hiển thị + chế độ tổng; bài rơi xuống phễu, chạy từng bước, khung 4 · Context chạy hiệu ứng của
// bài đó; hàng đợi 3 + "+N more"; không cắt ngang trace; reduced motion hiện ngay khung cuối. Fake timers.

const state = vi.hoisted(
  (): {
    paths: string[];
    reduced: boolean;
    next: ResearchNewArticles[];
  } => ({ paths: [], reduced: false, next: [] }),
);

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
      if (p.endsWith("/signal-research/summary"))
        return Promise.resolve(
          schema.parse(u.searchParams.get("range") === "7d" ? SUMMARY_7D : SUMMARY_1D),
        );
      if (p.endsWith("/signal-research/trades"))
        return Promise.resolve(schema.parse(RESEARCH_TRADES));
      if (p.endsWith("/signal-research/articles/new")) {
        const since = u.searchParams.get("since");
        const r = state.next.shift() ?? { items: [], since: since ?? "c0" };
        return Promise.resolve(schema.parse(r));
      }
      if (p.endsWith("/signal-research/articles"))
        return Promise.resolve(
          schema.parse({
            items: ARTICLES.slice(0, PAGE_SIZE),
            nextCursor: null,
            total: ARTICLES.length,
            totalInRange: 58,
          }),
        );
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
  PageHead: ({ title, action }: { title: string; action?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {action}
    </header>
  ),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <SignalAnalysisPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

let visibility: DocumentVisibilityState = "visible";
function setVisible(v: DocumentVisibilityState) {
  visibility = v;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

beforeEach(() => {
  state.paths = [];
  state.reduced = false;
  state.next = [];
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  window.localStorage.clear();
  window.history.replaceState(null, "", "/admin/signal-analysis?tab=research");
  Element.prototype.scrollIntoView = () => undefined;
  window.matchMedia = (query: string) =>
    Object.assign(new EventTarget(), {
      matches: query.includes("prefers-reduced-motion") ? state.reduced : false,
      media: query,
      onchange: null,
    }) as unknown as MediaQueryList;
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.unstubAllGlobals();
});

const funnel = () => screen.getByRole("region", { name: /From headline to trade/ });
const verdict = () => within(funnel()).getByRole("status");
const newCalls = () => state.paths.filter((p) => p.includes("/articles/new"));
const summaryCalls = () => state.paths.filter((p) => p.includes("/summary")).length;
const liveSwitch = () => within(funnel()).getByRole("switch", { name: "Animate new articles" });
const panel = () => within(funnel()).queryByTestId("sr-ctx-panel");
const token = () => within(funnel()).queryByTestId("sr-token");

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Hẹn giờ của bước sau chỉ đặt sau khi React vẽ xong bước trước: tiến từng bước một. */
async function ticks(n: number, ms: number) {
  for (let i = 0; i < n; i++) await tick(ms);
}

/** Một lần hỏi 15 s, rồi để phản hồi và trace của bài mới về (react-query báo qua setTimeout 0). */
async function poll() {
  await tick(LIVE_POLL_MS);
  await tick(0);
  await tick(0);
}

async function ready() {
  wrap();
  await screen.findByRole("region", { name: /From headline to trade/ });
  await within(funnel()).findByRole("button", { name: /SEC approves in-kind creations/ });
  await tick(0);
}

/** Signal giả (đã qua Score) không có trace: dùng để lấp hàng đợi. */
const sig = (id: string): ResearchArticle => ({ ...ETH, id });
const batchLine = () => within(funnel()).queryByTestId("sr-live-batch");

/** Tiến từng bước cho tới khi phễu rảnh (về chế độ tổng). */
async function untilIdle(max = 60) {
  for (let i = 0; i < max; i++) {
    if (verdict().textContent.includes("Pick an article on the left")) return;
    await tick(LIVE_STEP_MS);
  }
}

const page = (since: string, items: ResearchArticle[] = []): ResearchNewArticles => ({
  items,
  since,
});

describe("live queue (pure)", () => {
  it("keeps at most 3 waiting, counts the rest, and puts an interrupted article back in front", () => {
    // #474: mọi bài đều vào hàng đợi; đầy thì signal (ETH, SOL, MERGED) giữ chỗ trước bài bị loại (HYPE, KNTQ).
    let s = enqueue(EMPTY_QUEUE, [ETH, HYPE, SOL, KNTQ, MERGED]);
    expect(s.queue.map((a) => a.id)).toEqual([ETH.id, SOL.id, MERGED.id]);
    expect(s.extra).toBe(2);
    s = advance(s);
    expect(s.current?.id).toBe(ETH.id);
    expect(s.queue).toHaveLength(2);
    // Đang có bài rơi: không lấy bài khác.
    expect(advance(s)).toBe(s);
    s = interrupt(s);
    expect(s.current).toBeNull();
    expect(s.queue.map((a) => a.id)).toEqual([ETH.id, SOL.id, MERGED.id]);
    // Quay lại sau khi lỡ 5 bài: giữ 3 bài mới nhất, signal trước; phần còn lại chỉ đếm.
    const back = enqueueNewest(EMPTY_QUEUE, [ETH, HYPE, SOL, KNTQ, MERGED]);
    expect(back.queue.map((a) => a.id)).toEqual([ETH.id, SOL.id, MERGED.id]);
    expect(back.extra).toBe(2);
    // Hết bài: xoá "+N more".
    expect(advance({ current: null, queue: [], extra: 4 }).extra).toBe(0);
  });

  it("#474: articles dropped before Score queue too; when full, signals keep their place", () => {
    const d = (id: string): ResearchArticle => ({ ...HYPE, id });
    // Không có signal: 3 bài sớm nhất rơi, còn lại đếm.
    const plain = enqueue(EMPTY_QUEUE, [HYPE, KNTQ, d("d3"), d("d4")]);
    expect(plain.queue.map((a) => a.id)).toEqual([HYPE.id, KNTQ.id, "d3"]);
    expect(plain.extra).toBe(1);
    // Đầy: signal tới sau vẫn giữ chỗ, bài bị loại muộn nhất nhường chỗ; thứ tự cũ → mới giữ nguyên.
    const full = enqueue(EMPTY_QUEUE, [HYPE, KNTQ, d("d3"), ETH]);
    expect(full.queue.map((a) => a.id)).toEqual([HYPE.id, KNTQ.id, ETH.id]);
    expect(full.extra).toBe(1);
    // Bài đang chờ cũng nhường chỗ cho signal mới.
    const later = enqueue(plain, [SOL]);
    expect(later.queue.map((a) => a.id)).toEqual([HYPE.id, KNTQ.id, SOL.id]);
    expect(later.extra).toBe(2);
    // Quay lại tab: bài mới nhất, signal trước.
    const back = enqueueNewest(EMPTY_QUEUE, [ETH, HYPE, KNTQ, d("d3"), d("d4")]);
    expect(back.queue.map((a) => a.id)).toEqual([ETH.id, "d3", "d4"]);
    const plainBack = enqueueNewest(EMPTY_QUEUE, [HYPE, KNTQ, d("d3"), d("d4")]);
    expect(plainBack.queue.map((a) => a.id)).toEqual([KNTQ.id, "d3", "d4"]);
  });
});

describe("Signal research · live new article", { timeout: 30_000 }, () => {
  it("polls every 15 s with the since cursor, only while the tab is visible and the funnel shows totals", async () => {
    state.next = [page("c1"), page("c2"), page("c3")];
    await ready();
    expect(newCalls()).toHaveLength(1);
    expect(newCalls()[0]).not.toContain("since=");
    await tick(LIVE_POLL_MS);
    expect(newCalls()).toHaveLength(2);
    expect(newCalls()[1]).toContain("since=c1");

    // Tab ẩn: không hỏi.
    setVisible("hidden");
    await tick(LIVE_POLL_MS * 3);
    expect(newCalls()).toHaveLength(2);
    // Hiện lại: hỏi ngay, tiếp con trỏ cũ.
    setVisible("visible");
    await tick(0);
    expect(newCalls()).toHaveLength(3);
    expect(newCalls()[2]).toContain("since=c2");

    // Đang xem trace: không hỏi.
    fireEvent.click(within(funnel()).getByRole("button", { name: /Bithumb will list/ }));
    await tick(LIVE_POLL_MS * 3);
    expect(newCalls()).toHaveLength(3);
  });

  it("back on the tab after missing 5 articles: the 3 newest drop, the rest show as +2 more", async () => {
    // 5 signal lỡ (cũ trước mới) xen 2 bài bị loại trước Score.
    state.next = [
      page("c1"),
      page("c2", [sig("art-s1"), HYPE, sig("art-s2"), KNTQ, SOL, MERGED, ETH]),
    ];
    await ready();
    setVisible("hidden");
    await tick(LIVE_POLL_MS * 2);
    expect(newCalls()).toHaveLength(1);
    setVisible("visible");
    await tick(0);
    await tick(0);
    await tick(0);
    // Hỏi bù với trang lớn để lấy được bài mới nhất của khoảng lỡ.
    expect(newCalls()[1]).toContain("since=c1");
    expect(newCalls()[1]).toContain("limit=50");
    // #474: 3 bài giữ chỗ là 3 signal mới nhất (SOL, MERGED, ETH); 4 bài còn lại chỉ đếm.
    expect(verdict()).toHaveTextContent(
      "New article · step 1 · Collect… · 2 waiting · +4 more counted",
    );
    // Bài rơi trước là signal cũ nhất trong 3 signal mới nhất (SOL), không phải bài cũ nhất của đợt.
    expect(state.paths.some((x) => x.includes(`/articles/${SOL.id}/trace`))).toBe(true);
    expect(state.paths.some((x) => x.includes("/articles/art-s1/trace"))).toBe(false);
    expect(batchLine()).toHaveTextContent("7 new articles · 5 signals · 2 dropped");
  });

  it("the first poll when the page opens only sets the cursor: nothing drops", async () => {
    state.next = [page("c1", [ETH])];
    await ready();
    await tick(0);
    expect(verdict()).toHaveTextContent("Pick an article on the left");
    // #343: khung Context luôn hiện; chế độ tổng là hoạt cảnh chờ.
    expect(panel()).toHaveAttribute("data-state", "idle");
    expect(state.paths.some((x) => x.includes("/trace"))).toBe(false);
  });

  it("Live off: no polling, and the choice is remembered for this viewer", async () => {
    await ready();
    expect(liveSwitch()).toHaveAttribute("aria-checked", "true");
    expect(newCalls()).toHaveLength(1);
    fireEvent.click(liveSwitch());
    expect(liveSwitch()).toHaveAttribute("aria-checked", "false");
    await tick(LIVE_POLL_MS * 3);
    expect(newCalls()).toHaveLength(1);
    expect(window.localStorage.getItem("drift.signalResearch.live")).toBe("off");

    cleanup();
    state.paths = [];
    await ready();
    expect(liveSwitch()).toHaveAttribute("aria-checked", "false");
    await tick(LIVE_POLL_MS * 2);
    expect(newCalls()).toHaveLength(0);
  });

  it("a new article drops in, runs the steps, and step 4 Context plays that article's whale scene", async () => {
    state.next = [page("c1"), page("c2", [ETH])];
    await ready();
    const before = summaryCalls();
    // #343: khung Context luôn hiện; chế độ tổng là hoạt cảnh chờ.
    expect(panel()).toHaveAttribute("data-state", "idle");
    await poll();
    // Trace của bài mới được tải để khung 4 có đủ snapshot.
    expect(state.paths.some((p) => p.includes(`/articles/${ETH.id}/trace`))).toBe(true);
    expect(verdict()).toHaveTextContent("New article · step 1 · Collect…");
    expect(panel()).toHaveAttribute("data-state", "waiting");
    await tick(LIVE_STEP_MS);
    expect(token()).toHaveStyle({ opacity: "1" });
    expect(verdict()).toHaveTextContent("New article · step 1 · Collect…");
    await ticks(3, LIVE_STEP_MS);
    expect(verdict()).toHaveTextContent("New article · step 4 · Context…");
    // Khung 4 chạy hiệu ứng như trace: cá voi (H1 Yes), bập bênh funding, đường giá.
    const p = within(funnel()).getByTestId("sr-ctx-panel");
    expect(p).toHaveAttribute("data-state", "shown");
    const h1 = within(p).getByTestId("sr-ctx-h1");
    expect(h1).toHaveAttribute("data-answer", "yes");
    expect(h1.querySelector("[class*='sr-whale']")).not.toBeNull();
    expect(within(p).getByTestId("sr-ctx-h2")).toBeInTheDocument();
    expect(within(p).getByTestId("sr-ctx-h3")).toBeInTheDocument();
    const ctxBand = within(funnel())
      .getByTestId("sr-funnel-bands")
      .querySelector("[data-band='context']");
    expect(ctxBand).toHaveAttribute("data-state", "active");

    await tick(LIVE_CONTEXT_MS);
    expect(verdict()).toHaveTextContent("New article · step 5 · Filter…");
    await ticks(2, LIVE_STEP_MS);
    expect(verdict()).toHaveTextContent("New article reached Decide: Long ETH");
    expect(token()).toHaveTextContent("Paper trade · ETH");
    // Giữ khung cuối rồi về chế độ tổng; số đếm và feed lấy lại từ API.
    await tick(LIVE_HOLD_MS);
    expect(verdict()).toHaveTextContent("Pick an article on the left");
    // #343: khung Context luôn hiện; chế độ tổng là hoạt cảnh chờ.
    expect(panel()).toHaveAttribute("data-state", "idle");
    expect(summaryCalls()).toBeGreaterThan(before);
    const card = within(funnel()).getByRole("button", { name: /SEC approves in-kind creations/ });
    expect(within(card).getByText("NEW")).toBeInTheDocument();
    expect(batchLine()).toHaveTextContent("1 new article · 1 signal · 0 dropped");
  });

  it("#474: articles dropped before Score drop too, run to their step, and keep the NEW badge", async () => {
    state.next = [page("c1"), page("c2", [HYPE, KNTQ])];
    await ready();
    const before = summaryCalls();
    await poll();
    expect(verdict()).toHaveTextContent("New article · step 1 · Collect… · 1 waiting");
    expect(batchLine()).toHaveTextContent("2 new articles · 0 signals · 2 dropped");
    await untilIdle();
    expect(state.paths.filter((x) => x.includes("/trace"))).toEqual([
      expect.stringContaining(`/articles/${HYPE.id}/trace`),
      expect.stringContaining(`/articles/${KNTQ.id}/trace`),
    ]);
    expect(summaryCalls()).toBeGreaterThan(before);
    for (const title of [/Hyperliquid: six whales/, /Bithumb will list/]) {
      const card = within(funnel()).getByRole("button", { name: title });
      expect(within(card).getByText("NEW")).toBeInTheDocument();
    }
  });

  it("#474: a mixed batch: all three drop in order; the summary counts all three", async () => {
    state.next = [page("c1"), page("c2", [HYPE, SOL, KNTQ])];
    await ready();
    await poll();
    expect(verdict()).toHaveTextContent("New article · step 1 · Collect… · 2 waiting");
    expect(batchLine()).toHaveTextContent("3 new articles · 1 signal · 2 dropped");
    await untilIdle();
    expect(state.paths.filter((x) => x.includes("/trace"))).toEqual([
      expect.stringContaining(`/articles/${HYPE.id}/trace`),
      expect.stringContaining(`/articles/${SOL.id}/trace`),
      expect.stringContaining(`/articles/${KNTQ.id}/trace`),
    ]);
  });

  it("the queue plays one article at a time, in order", async () => {
    // Fake timers thuần (không `shouldAdvanceTime`): thời gian chỉ đi khi test tiến, nên mỗi bước kiểm được đúng một
    // trạng thái dù máy CI chậm. Không có gì được hẹn trước lúc này, nên cài lại không mất hẹn giờ nào.
    vi.useRealTimers();
    vi.useFakeTimers();
    state.next = [page("c1"), page("c2", [ETH, SOL])];
    wrap();
    const traced = () =>
      state.paths
        .filter((x) => x.includes("/trace"))
        .map((x) => /articles\/([^/]+)\/trace/.exec(x)?.[1]);
    const text = () => verdict().textContent;
    // Fetch giả resolve ngay; react-query báo kết quả qua setTimeout 0. Chỉ chạy hẹn giờ tới hạn, đồng hồ không đi.
    async function flushUntil(done: () => boolean) {
      for (let i = 0; i < 50 && !done(); i++) await tick(0);
      expect(done()).toBe(true);
    }
    await flushUntil(
      () =>
        screen.queryByRole("region", { name: /From headline to trade/ }) !== null &&
        within(funnel()).queryByRole("button", { name: /SEC approves in-kind creations/ }) !== null,
    );
    expect(text()).toContain("Pick an article on the left");

    const stage = (n: number) =>
      messages.signalAnalysis.research.trace.stages[BANDS[n - 1] ?? "collect"];
    // Một bài chạy hết các bước, mỗi lần tiến đúng thời gian của bước đang đứng (hằng thật của live-drop); sau mỗi bước
    // kiểm dòng trạng thái, số bài chờ và các trace đã tải.
    async function plays(stop: number, end: string, waiting: string, loaded: string[]) {
      const dur = liveDuration(true);
      for (let n = 0; n <= stop; n++) {
        // Bước 0 (vừa rơi) hiện như bước 1.
        const shown = Math.max(n, 1);
        expect(text()).toBe(`New article · step ${String(shown)} · ${stage(shown)}…${waiting}`);
        expect(traced()).toEqual(loaded);
        await tick(dur(n));
      }
      expect(text()).toBe(`${end}${waiting}`);
      expect(traced()).toEqual(loaded);
    }

    // Lần hỏi 15 s mang về ETH và SOL: ETH rơi trước, SOL chờ và chưa được tải trace.
    await tick(LIVE_POLL_MS);
    await flushUntil(() => text().startsWith("New article"));
    expect(text()).toBe("New article · step 1 · Collect… · 1 waiting");
    // ETH dừng ở Decide (6 tầng), có snapshot Context.
    await plays(BAND_COUNT, "New article reached Decide: Long ETH", " · 1 waiting", [ETH.id]);

    // Giữ khung cuối rồi mới sang SOL: không chạy chồng.
    await tick(LIVE_HOLD_MS - 1);
    expect(text()).toBe("New article reached Decide: Long ETH · 1 waiting");
    expect(traced()).toEqual([ETH.id]);
    await tick(1);
    await flushUntil(() => text().startsWith("New article"));
    // SOL chạy một mình (không còn bài chờ), từ bước 1; ETH không chạy lại.
    expect(traced()).toEqual([ETH.id, SOL.id]);
    // SOL dừng ở Filter (tầng 5), có snapshot Context.
    await plays(CONTEXT_BAND + 1, "New article stopped at Filter", "", [ETH.id, SOL.id]);

    // Hết hàng đợi: về chế độ tổng.
    await tick(LIVE_HOLD_MS);
    await flushUntil(() => text().includes("Pick an article on the left"));
    expect(traced()).toEqual([ETH.id, SOL.id]);
  });

  it("drops each article only once (same id again is ignored)", async () => {
    state.next = [page("c1"), page("c2", [SOL]), page("c2", [SOL])];
    await ready();
    await poll();
    expect(verdict()).toHaveTextContent("New article · step 1 · Collect…");
    await untilIdle();
    expect(verdict()).toHaveTextContent("Pick an article on the left");
    const traces = () => state.paths.filter((x) => x.includes(`/articles/${SOL.id}/trace`));
    const n = traces().length;
    await poll();
    expect(verdict()).toHaveTextContent("Pick an article on the left");
    expect(traces()).toHaveLength(n);
  });

  it("#474: a full queue keeps 3 articles, signals first, and counts the rest as +N more", async () => {
    state.next = [
      page("c1"),
      page("c2", [ETH, HYPE, SOL, KNTQ, MERGED, sig("art-s1"), sig("art-s2")]),
    ];
    await ready();
    await poll();
    expect(verdict()).toHaveTextContent(
      "New article · step 1 · Collect… · 2 waiting · +4 more counted",
    );
    await untilIdle();
    // Bài bị loại (HYPE, KNTQ) nhường chỗ cho signal: chỉ ETH, SOL, MERGED rơi.
    expect(state.paths.filter((x) => x.includes("/trace"))).toEqual([
      expect.stringContaining(`/articles/${ETH.id}/trace`),
      expect.stringContaining(`/articles/${SOL.id}/trace`),
      expect.stringContaining(`/articles/${MERGED.id}/trace`),
    ]);
  });

  it("never interrupts a trace: new articles wait in “N new articles · play”", async () => {
    state.next = [page("c1"), page("c2", [SOL])];
    await ready();
    await poll();
    expect(verdict()).toHaveTextContent("New article · step 1 · Collect…");
    // Người dùng mở trace: trace chạy, bài mới chờ.
    fireEvent.click(within(funnel()).getByRole("button", { name: /Bithumb will list/ }));
    await tick(0);
    const chip = within(funnel()).getByRole("button", { name: "1 new article · play" });
    await ticks(4, STEP_MS);
    expect(verdict()).toHaveTextContent("Stopped at Normalize");
    expect(within(funnel()).getByRole("button", { name: "1 new article · play" })).toBe(chip);
    // Bấm chip: đóng trace, bài chờ rơi.
    fireEvent.click(chip);
    await tick(0);
    expect(verdict()).toHaveTextContent("New article · step 1 · Collect…");
    expect(within(funnel()).queryByRole("button", { name: /new article · play/ })).toBeNull();
  });

  it("funnel scrolled away: new articles only refresh the counts, no drop", async () => {
    let cb: IntersectionObserverCallback = () => undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(c: IntersectionObserverCallback) {
          cb = c;
        }
        observe() {
          cb(
            [{ isIntersecting: false } as IntersectionObserverEntry],
            this as unknown as IntersectionObserver,
          );
        }
        disconnect() {
          return undefined;
        }
      },
    );
    state.next = [page("c1"), page("c2", [ETH])];
    await ready();
    const before = summaryCalls();
    await poll();
    expect(verdict()).toHaveTextContent("Pick an article on the left");
    // #343: khung Context luôn hiện; chế độ tổng là hoạt cảnh chờ.
    expect(panel()).toHaveAttribute("data-state", "idle");
    expect(summaryCalls()).toBeGreaterThan(before);
  });

  it("prefers-reduced-motion: the final frame shows at once, nothing flies", async () => {
    state.reduced = true;
    state.next = [page("c1"), page("c2", [ETH])];
    await ready();
    await poll();
    expect(verdict()).toHaveTextContent("New article reached Decide: Long ETH");
    expect(panel()).toHaveAttribute("data-state", "shown");
    expect(token()).toHaveClass("motion-reduce:transition-none");
    for (const el of funnel().querySelectorAll("[class*='animate-']"))
      expect(el.getAttribute("class") ?? "").not.toMatch(/(^|\s)animate-/);
    await tick(2_500);
    expect(verdict()).toHaveTextContent("Pick an article on the left");
  });
});
