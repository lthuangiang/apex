// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ResearchArticle } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

import messages from "../../../../messages/en.json";
import { MarketNews } from "../research/market-news";

// #593 (DEC-402 mục 6; bản phác docs/mockups/us-market màn 04): khối "News by market" với tab ANT-USD. Tiêu đề bài là câu
// mẫu tự viết; mọi số từ API giả.

const state = vi.hoisted((): { items: unknown[]; paths: string[]; fail: boolean } => ({
  items: [],
  paths: [],
  fail: false,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_m: string, path: string, schema: z.ZodType) => {
      state.paths.push(path);
      if (state.fail) return Promise.reject(new real.ApiError("INTERNAL_ERROR", 500));
      if (path.includes("/signal-research/articles?")) {
        const market = new URLSearchParams(path.split("?")[1]).get("market");
        const items = (state.items as ResearchArticle[]).filter(
          (a) => market === null || a.candidates.includes(market),
        );
        return Promise.resolve(
          schema.parse({ items, nextCursor: null, total: items.length, totalInRange: 9 }),
        );
      }
      return Promise.reject(new real.ApiError("NOT_FOUND", 404));
    },
  };
});

const M = messages.signalAnalysis.research.marketNews;

function article(p: Partial<ResearchArticle> & Pick<ResearchArticle, "id">): ResearchArticle {
  return {
    title: null,
    excerpt: null,
    url: null,
    source: "Newswire",
    tier: "top",
    publishedAt: "2026-11-27T14:02:00.000Z",
    collectedAt: "2026-11-27T14:03:00.000Z",
    delaySecs: 60,
    tagged: [],
    candidates: [],
    asset: null,
    side: null,
    stage: "score",
    outcome: "dropped",
    reason: null,
    reasonLimit: null,
    mergeReason: null,
    sentToClaude: true,
    claude: null,
    tradeId: null,
    versionId: null,
    shadowTradeId: null,
    opposite: null,
    context: null,
    rulesVersion: 7,
    readerVersion: "news-classifier-v7",
    ...p,
  };
}

const COMPANY = article({
  id: "a-co",
  title: "Sample headline: funding round reported",
  candidates: ["ANT-USD"],
  asset: "ANT-USD",
  side: "long",
  stage: "decide",
  outcome: "traded",
  book: { bidsUsd: "2610", asksUsd: "2180" },
});
const PRODUCT = article({
  id: "a-pr",
  title: "Sample headline: new model released",
  source: "Company blog",
  publishedAt: "2026-11-26T18:30:00.000Z",
  candidates: ["ANT-USD"],
  reason: "productNews",
  sentToClaude: false,
});
const NEGATIVE = article({
  id: "a-neg",
  title: "Sample headline: regulator opens inquiry",
  publishedAt: "2026-11-25T09:12:00.000Z",
  candidates: ["ANT-USD"],
  asset: "ANT-USD",
  side: "short",
  stage: "filter",
  outcome: "dropped",
  reason: "tooThin",
  book: { bidsUsd: "1900", asksUsd: "2050" },
});
const BTC = article({
  id: "a-btc",
  title: "Sample headline: exchange lists a token",
  candidates: ["BTC-USD"],
  asset: "BTC-USD",
  side: "long",
  outcome: "waiting",
  stage: "filter",
});

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <main>{node}</main>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

beforeEach(() => {
  state.items = [COMPANY, PRODUCT, NEGATIVE, BTC];
  state.paths = [];
  state.fail = false;
});
afterEach(() => {
  cleanup();
});

const table = () => screen.getByRole("table");
const rowOf = (title: string) => {
  const cell = within(table()).getByText(title);
  const row = cell.closest("tr");
  if (row === null) throw new Error(`no row for ${title}`);
  return row;
};

describe("News by market (#593)", () => {
  it("All markets first: 7 days, no market filter; every article listed", async () => {
    wrap(<MarketNews tz="UTC" versionId={null} onSetUp={() => undefined} />);
    expect(await screen.findByRole("tab", { name: M.all, selected: true })).toBeInTheDocument();
    await within(await screen.findByRole("table")).findByText(COMPANY.title ?? "");
    const last = state.paths.at(-1) ?? "";
    expect(last).toContain("range=7d");
    expect(last).not.toContain("market=");
    expect(within(table()).getAllByRole("row")).toHaveLength(5);
    // Không có nút / chú thích ANT-USD ngoài tab ANT-USD.
    expect(screen.queryByRole("button", { name: M.setUp })).toBeNull();
    expect(screen.getByText(M.notForecast)).toBeInTheDocument();
  });

  it("ANT-USD tab (NEW): market filter, read as, rules, book at the time, product not traded", async () => {
    const user = userEvent.setup();
    const onSetUp = vi.fn();
    wrap(
      <MarketNews tz="UTC" versionId="11111111-1111-4111-8111-111111111111" onSetUp={onSetUp} />,
    );
    const ant = await screen.findByRole("tab", { name: /^ANT-USD/ });
    await user.click(ant);
    expect(ant).toHaveAttribute("aria-selected", "true");
    await waitFor(() => {
      expect(state.paths.at(-1)).toContain("market=ANT-USD");
    });
    expect(state.paths.at(-1)).toContain("versionId=11111111-1111-4111-8111-111111111111");
    expect(await screen.findByText(M.antNote)).toBeInTheDocument();
    await screen.findByRole("table");
    await waitFor(() => {
      expect(within(table()).queryByText(BTC.title ?? "")).toBeNull();
    });

    const co = rowOf(COMPANY.title ?? "");
    expect(within(co).getByText("Newswire · company news")).toBeInTheDocument();
    expect(within(co).getByText("Nov 27, 14:02")).toBeInTheDocument();
    expect(within(co).getByText("ANT-USD")).toBeInTheDocument();
    expect(within(co).getByText(M.readAs.positive)).toBeInTheDocument();
    expect(within(co).getByText(M.rules.traded)).toBeInTheDocument();
    expect(within(co).getByText("$2,610.00 / $2,180.00")).toBeInTheDocument();

    const pr = rowOf(PRODUCT.title ?? "");
    expect(within(pr).getByText("Company blog · product news")).toBeInTheDocument();
    expect(within(pr).getByText(M.readAs.product)).toBeInTheDocument();
    expect(within(pr).getByText(M.rules.skipped)).toBeInTheDocument();
    // Không chụp sổ → "–", không bao giờ $0.00.
    expect(within(pr).getByText("–")).toBeInTheDocument();
    expect(pr.textContent).not.toContain("$0.00");

    const neg = rowOf(NEGATIVE.title ?? "");
    expect(within(neg).getByText(M.readAs.negative)).toBeInTheDocument();
    expect(within(neg).getByText("$1,900.00 / $2,050.00")).toBeInTheDocument();

    expect(screen.getByText(M.footnote)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: M.setUp }));
    expect(onSetUp).toHaveBeenCalledTimes(1);
    await noViolations();
  });

  it("arrow keys move between market tabs (roving tab index)", async () => {
    const user = userEvent.setup();
    wrap(<MarketNews tz="UTC" versionId={null} onSetUp={() => undefined} />);
    const all = await screen.findByRole("tab", { name: M.all });
    all.focus();
    await user.keyboard("{ArrowRight}");
    const btc = screen.getByRole("tab", { name: "BTC-USD" });
    expect(btc).toHaveAttribute("aria-selected", "true");
    expect(btc).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /^ANT-USD/ })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: M.all })).toHaveFocus();
  });

  it("empty and error states; axe clean", async () => {
    state.items = [];
    wrap(<MarketNews tz="UTC" versionId={null} onSetUp={() => undefined} />);
    expect(await screen.findByText(M.empty)).toBeInTheDocument();
    await noViolations();
    cleanup();
    state.fail = true;
    wrap(<MarketNews tz="UTC" versionId={null} onSetUp={() => undefined} />);
    // 500 được thử lại một lần (retry của hook) trước khi báo lỗi.
    expect(await screen.findByRole("alert", {}, { timeout: 4000 })).toHaveTextContent(M.error);
  });
});
