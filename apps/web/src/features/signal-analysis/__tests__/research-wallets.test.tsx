// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { ResearchSignalContext, ResearchWallets } from "@drift/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { ContextCard } from "../research/context-panel";
import { ResearchWalletsBlock } from "../research/wallet-links";

import { CTX_AGAINST_LATE, CTX_ETH, CTX_V2 } from "./context-fixtures";

// #353: danh sách research wallets (khu Bots & labels) và link ví trên thẻ H1 (DEC-TBD-sr-research-wallet-list). Link tới
// `/traders/[address]` chỉ khi người xem bật AI Desk (`useFeatures().data.aiDesk`) và ví có trang trader; không có AI Desk
// thì địa chỉ chữ thường + "Turn on AI Desk to open trader pages" (không bao giờ dẫn tới trang 403).

const state = vi.hoisted(() => {
  const s: { aiDesk: boolean | undefined; wallets: unknown } = { aiDesk: true, wallets: undefined };
  return s;
});
vi.mock("@/lib/queries", () => ({
  useFeatures: () => ({ data: state.aiDesk === undefined ? undefined : { aiDesk: state.aiDesk } }),
}));
vi.mock("../research/api", () => ({
  useResearchWallets: () => ({ data: state.wallets, isError: false }),
}));

const TZ = "Asia/Ho_Chi_Minh";
const NO_DESK = "Turn on AI Desk to open trader pages";
const NOW = Date.now();
const minsAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const addr = (c: string) => `0x${c.repeat(40)}`;

const intlErrors: string[] = [];
function wrap(node: ReactNode) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={messages}
      timeZone="UTC"
      onError={(e) => {
        intlErrors.push(e.message);
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

async function noViolations() {
  // color-contrast tắt vì jsdom không tính được màu; cặp màu token được kiểm ở packages/ui.
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

const SET: ResearchWallets = {
  set: { version: 4, runDate: "2026-11-19", k: 30, size: 7, createdAt: "2026-11-19T02:00:00.000Z" },
  windowMinutes: 60,
  items: [
    { address: addr("1"), rank: 1, hasProfile: true, lastReadAt: minsAgo(2), readRecently: true },
    { address: addr("2"), rank: 2, hasProfile: true, lastReadAt: minsAgo(90), readRecently: false },
    { address: addr("3"), rank: 3, hasProfile: false, lastReadAt: null, readRecently: false },
    { address: addr("4"), rank: 4, hasProfile: true, lastReadAt: minsAgo(4), readRecently: true },
    { address: addr("5"), rank: 5, hasProfile: true, lastReadAt: minsAgo(5), readRecently: true },
    { address: addr("6"), rank: 6, hasProfile: true, lastReadAt: minsAgo(6), readRecently: true },
    { address: addr("7"), rank: 7, hasProfile: true, lastReadAt: minsAgo(7), readRecently: true },
  ],
};

beforeEach(() => {
  state.aiDesk = true;
  state.wallets = SET;
  intlErrors.length = 0;
});
afterEach(() => {
  cleanup();
});

describe("Research wallets list (#353)", () => {
  it("lists the set by rank with one set chip, last read, trader links and Show all", async () => {
    wrap(<ResearchWalletsBlock open />);
    const s = screen.getByRole("region", { name: "Research wallets (top 7)" });
    expect(within(s).getByText("Set v4 · Nov 19")).toBeInTheDocument();
    expect(
      within(s).getByText(
        "H1 · Whales agree checks these wallets · 5 of 7 read in the last 60 min.",
      ),
    ).toBeInTheDocument();
    const table = within(s).getByRole("table", { name: "Research wallets (top 7)" });
    // Không có cột Set ở từng dòng.
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Rank", "Wallet", "Last read", "Trader page"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(5);
    const row = (i: number): HTMLElement => {
      const r = rows[i];
      if (r === undefined) throw new Error(`row ${String(i)}`);
      return r;
    };
    expect(rows[0]).toHaveTextContent("#10x1111…1111read 2 min agoOpen ›");
    expect(within(row(0)).getByRole("link", { name: "0x1111…1111" })).toHaveAttribute(
      "href",
      `/traders/${addr("1")}`,
    );
    expect(rows[1]).toHaveTextContent("not read in the last 60 min");
    // Ví không có trang trader: chỉ địa chỉ, không link.
    expect(rows[2]).toHaveTextContent("No trader page");
    expect(within(row(2)).queryByRole("link")).toBeNull();
    expect(within(s).queryByText(NO_DESK)).toBeNull();
    await userEvent.click(within(s).getByRole("button", { name: "Show all 7" }));
    expect(within(table).getAllByRole("row")).toHaveLength(8);
    expect(within(s).queryByRole("button", { name: /Show all/ })).toBeNull();
    expect(intlErrors).toEqual([]);
    await noViolations();
  });

  it("without AI Desk shows plain addresses, never a trader link, and says how to turn it on", async () => {
    state.aiDesk = false;
    wrap(<ResearchWalletsBlock open />);
    const s = screen.getByRole("region", { name: "Research wallets (top 7)" });
    expect(within(s).queryAllByRole("link")).toEqual([]);
    expect(within(s).getByText("0x1111…1111")).toBeInTheDocument();
    expect(within(s).getByText(NO_DESK)).toBeInTheDocument();
    // Cột "Trader page" ẩn hẳn (không phải cột trống): chỉ 3 cột ở tiêu đề và ở từng dòng.
    const table = within(s).getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["Rank", "Wallet", "Last read"]);
    for (const r of within(table).getAllByRole("row").slice(1))
      expect(within(r).getAllByRole("cell")).toHaveLength(3);
    expect(within(table).queryByText("No trader page")).toBeNull();
    expect(within(table).queryByText("Not available")).toBeNull();
    await noViolations();
  });

  it("while the AI Desk flag is unknown, no link is shown either", () => {
    state.aiDesk = undefined;
    wrap(<ResearchWalletsBlock open />);
    expect(screen.queryAllByRole("link")).toEqual([]);
  });

  it("before the leaderboard has run: empty state", async () => {
    state.wallets = { set: null, windowMinutes: 60, items: [] } satisfies ResearchWallets;
    wrap(<ResearchWalletsBlock open />);
    expect(
      screen.getByText("No research wallets yet · the leaderboard hasn't run"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    expect(intlErrors).toEqual([]);
    await noViolations();
  });
});

const withWallets = (
  base: ResearchSignalContext,
  h1: Partial<ResearchSignalContext["h1"]>,
): ResearchSignalContext => ({ ...base, h1: { ...base.h1, ...h1 } });

describe("H1 card wallet links (#353)", () => {
  it("Yes shows the agreeing wallets as trader links", async () => {
    const c = withWallets(CTX_V2, {
      agreeing: [
        { address: addr("a"), hasProfile: true },
        { address: addr("b"), hasProfile: false },
      ],
      opposing: [],
    });
    wrap(<ContextCard context={c} asset="ETH" tz={TZ} canOpenTraders />);
    const h1 = screen.getByTestId("sr-ctx-card-h1");
    const line = within(h1).getByTestId("sr-ctx-h1-wallets");
    expect(line).toHaveTextContent("Same way: 0xaaaa…aaaa · 0xbbbb…bbbb");
    expect(within(line).getByRole("link", { name: "0xaaaa…aaaa" })).toHaveAttribute(
      "href",
      `/traders/${addr("a")}`,
    );
    // Không có trang trader: chỉ địa chỉ.
    expect(within(line).getAllByRole("link")).toHaveLength(1);
    expect(within(h1).queryByText(NO_DESK)).toBeNull();
    await noViolations();
  });

  it("Disagree shows at most 3 opposing wallets and +N more", () => {
    const opposing = ["c", "d", "e", "f", "9"].map((x) => ({ address: addr(x), hasProfile: true }));
    const c = withWallets(
      { ...CTX_AGAINST_LATE, contextVersion: "context-v2" },
      { agreeing: [], opposing, opposingWallets: 5 },
    );
    wrap(<ContextCard context={c} asset="ETH" tz={TZ} canOpenTraders />);
    const line = screen.getByTestId("sr-ctx-h1-wallets");
    expect(line).toHaveTextContent("Other way: 0xcccc…cccc · 0xdddd…dddd · 0xeeee…eeee · +2 more");
    expect(within(line).getAllByRole("link")).toHaveLength(3);
  });

  it("without AI Desk the wallets are plain text with the AI Desk line", async () => {
    const c = withWallets(CTX_V2, {
      agreeing: [{ address: addr("a"), hasProfile: true }],
      opposing: [],
    });
    wrap(<ContextCard context={c} asset="ETH" tz={TZ} canOpenTraders={false} />);
    const h1 = screen.getByTestId("sr-ctx-card-h1");
    expect(within(h1).queryAllByRole("link")).toEqual([]);
    expect(within(h1).getByText("0xaaaa…aaaa")).toBeInTheDocument();
    expect(within(h1).getByText(NO_DESK)).toBeInTheDocument();
    await noViolations();
  });

  it("an older snapshot without addresses keeps only the count", () => {
    expect(CTX_ETH.h1.agreeing).toBeNull();
    wrap(<ContextCard context={CTX_ETH} asset="ETH" tz={TZ} canOpenTraders />);
    const h1 = screen.getByTestId("sr-ctx-card-h1");
    expect(h1).toHaveTextContent("2 tracked wallets added Long ETH in the 60 min before");
    expect(within(h1).queryByTestId("sr-ctx-h1-wallets")).toBeNull();
    expect(intlErrors).toEqual([]);
  });
});
