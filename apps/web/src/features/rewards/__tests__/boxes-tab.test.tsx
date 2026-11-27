// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { resetActions } from "../action-store";
import { resetRewardsRateLimit } from "../client";
import { BoxesTab } from "../components/boxes-tab";
import { saveRewardsToken } from "../token-store";
import { useRewardsAuth } from "../use-rewards-auth";

import { FAKE_TOKEN, MASTER, fakeGateway, type Reply, type Route } from "./gateway-fixtures";

// Rewards › Blind Boxes chỉ đọc (#550, bản phác 10–14): dải ready to claim (không nút Claim), Backpack (byLevel, danh
// sách box, nhãn From, voucher), History (ledger + history, Load more), Weekly draw (wins là số), Live feed; rỗng, tải,
// lỗi, 429. Gateway SoDEX, wagmi và API DeskLabs đều giả; không ký ví thật, không có nút Claim / Open / Merge.

const state = vi.hoisted<{ master: string | null; wallet: string | undefined }>(() => ({
  master: null,
  wallet: undefined,
}));
const signMessage = vi.hoisted(() => vi.fn(() => Promise.resolve("0xsig")));
const connect = vi.hoisted(() => vi.fn(() => Promise.resolve({})));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/queries", () => ({
  useSodexConnection: () => ({
    isPending: false,
    data: {
      connection: state.master === null ? null : { address: state.master, status: "connected" },
    },
  }),
}));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: () => Promise.resolve(null),
}));
vi.mock("wagmi", () => ({
  useConfig: () => ({}),
  useConnection: () => ({ address: state.wallet, isConnected: state.wallet !== undefined }),
  useSignMessage: () => ({ mutateAsync: signMessage }),
  useConnect: () => ({ mutateAsync: connect }),
  useDisconnect: () => ({ mutateAsync: () => Promise.resolve() }),
  useConnectors: () => [],
  useSwitchChain: () => ({ mutateAsync: () => Promise.resolve() }),
  useSignTypedData: () => ({ mutateAsync: () => Promise.reject(new Error("not in this test")) }),
}));
vi.mock("@/lib/wagmi", () => ({ valueChain: { id: 286623 } }));
vi.mock("wagmi/actions", () => ({ getConnection: () => ({ address: state.wallet }) }));

let gw: ReturnType<typeof fakeGateway>;
function gateway(routes: Partial<Record<Route, Reply>> = {}) {
  gw = fakeGateway(routes);
  vi.stubGlobal("fetch", gw.fn);
}

function Tab() {
  const auth = useRewardsAuth();
  return <BoxesTab session={auth} tz="UTC" />;
}

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Tab />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

async function openSub(name: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: new RegExp(`^${name}`) }));
}

beforeEach(() => {
  localStorage.clear();
  state.master = MASTER;
  state.wallet = undefined;
  saveRewardsToken(MASTER, FAKE_TOKEN);
  gateway();
});
afterEach(() => {
  cleanup();
  resetActions();
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
});

describe("Blind Boxes › ready to claim", () => {
  it("shows the count with Claim all / Claim 1", async () => {
    show();
    expect(await screen.findByText("3 boxes ready to claim")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Claiming adds them to your backpack and shows their level. No wallet signature needed.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim all 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Claim 1" })).toBeInTheDocument();
  });

  it("singular for one box; nothing when none", async () => {
    gateway({ "lottery/treasures": { body: { code: 0, data: { total: 1, maxPerOpen: 100 } } } });
    show();
    expect(await screen.findByText("1 box ready to claim")).toBeInTheDocument();
    cleanup();
    gateway({ "lottery/treasures": { body: { code: 0, data: { total: 0, maxPerOpen: 100 } } } });
    show();
    await screen.findByRole("heading", { name: "Boxes in your backpack" });
    expect(screen.queryByText(/ready to claim/)).toBeNull();
  });
});

describe("Blind Boxes › Backpack (mockup 10)", () => {
  it("shows levels with merge progress, boxes newest first with From labels, and the voucher note", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole("button", { name: "Grid" });
    const common = screen.getAllByText(/Merge 10 → 1/)[0]?.closest("li");
    expect(common).toHaveTextContent("20");
    expect(within(common as HTMLElement).getByText("2 merges ready")).toBeInTheDocument();
    expect(screen.getByText(/5 more to merge/)).toBeInTheDocument();
    expect(screen.getByText(/Merge 4 → 1/)).toBeInTheDocument();
    // Cấp rỗng: hình mờ + "No boxes at this level.", không có số 0 lớn.
    const superRare = screen.getByText("SuperRare").closest("li") as HTMLElement;
    expect(within(superRare).getByText("No boxes at this level.")).toBeInTheDocument();
    expect(within(superRare).queryByText("0")).toBeNull();
    // Danh sách: lưới mặc định; chuyển sang bảng: mới nhất trước; nhãn From PM duyệt, giá trị lạ hiện nguyên.
    expect(screen.getByRole("button", { name: "Grid" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Table" }));
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector("td")?.textContent)).toEqual([
      "#201640",
      "#200913",
      "#188540",
    ]);
    expect(within(table).getByText("Trading")).toBeInTheDocument();
    expect(within(table).getByText("Invite")).toBeInTheDocument();
    // Source lạ: nguyên chuỗi, viết hoa chữ đầu.
    expect(within(table).getByText("Milestone")).toBeInTheDocument();
    expect(screen.getByText("27 · newest first")).toBeInTheDocument();
    expect(
      screen.getByText("Vouchers and other items that aren't Blind Boxes show only on SoDEX."),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open on SoDEX ↗" });
    expect(link).toHaveAttribute("href", "https://sodex.com/blind-box");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    // Không có PFP: không vẽ thẻ PFPs.
    expect(screen.queryByRole("heading", { name: "PFPs" })).toBeNull();
  });

  it("reads further pages with limit / offset and stops when no new boxes come back", async () => {
    show();
    await screen.findByRole("button", { name: "Grid" });
    const calls = gw.calls.filter((c) => c.path === "lottery/boxes");
    expect(calls[0]?.url).toContain("limit=200");
    expect(calls[0]?.url).toContain("offset=0");
    expect(calls[1]?.url).toContain("offset=3");
    expect(calls).toHaveLength(2);
  });

  it("empty backpack: empty state, the voucher note still shows", async () => {
    gateway({
      "lottery/boxes": {
        body: { code: 0, data: { total: 0, maxPerOpen: 30, byLevel: [], boxes: [] } },
      },
    });
    show();
    expect(await screen.findByText("No Blind Boxes yet")).toBeInTheDocument();
    expect(screen.getByText("Boxes SoDEX gives this wallet show up here.")).toBeInTheDocument();
    expect(
      screen.getByText("Vouchers and other items that aren't Blind Boxes show only on SoDEX."),
    ).toBeInTheDocument();
  });

  it("PFPs: display only, Open on SoDEX for unopened ones", async () => {
    gateway({
      "lottery/pfps": {
        body: { code: 0, data: { total: 1, pfps: [{ profileTokenId: 2051 }], won: [] } },
      },
    });
    show();
    expect(await screen.findByText("Cybereator #2051")).toBeInTheDocument();
    expect(await screen.findByText("Unopened")).toBeInTheDocument();
    expect(
      screen.getByText("Opening a PFP is an on-chain transaction paid in SOSO. Do it on SoDEX."),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Open on SoDEX ↗" })).toHaveLength(2);
  });

  it("boxes in a running job are tagged In an open; the job line has View", async () => {
    gateway({
      "lottery/jobs": {
        body: {
          code: 0,
          data: {
            jobs: [{ jobId: 5, kind: "box_open", status: "pending", boxes: [{ tokenId: 188540 }] }],
          },
        },
      },
    });
    show();
    expect(await screen.findByText("Opening 1 box…")).toBeInTheDocument();
    expect(await screen.findByText("In an open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View" })).toBeInTheDocument();
  });

  it("loading: skeleton, no numbers", () => {
    gateway({ "lottery/boxes": "pending" });
    const { container } = show();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText("Not available")).toBeNull();
  });

  it("network error: Couldn't reach SoDEX rewards", async () => {
    gateway({ "lottery/boxes": "network" });
    show();
    expect(await screen.findByText("Couldn't reach SoDEX rewards.")).toBeInTheDocument();
    expect(screen.getAllByText("Not available").length).toBeGreaterThan(0);
  });

  it("429: busy with countdown", async () => {
    gateway({ "lottery/boxes": { status: 429, body: { code: 429, data: { retryAfter: 30 } } } });
    show();
    expect(
      await screen.findByText(/^SoDEX rewards is busy\. Try again in (30|29) s\.$/),
    ).toBeInTheDocument();
  });

  it("passes axe", async () => {
    const { container } = show();
    await screen.findByRole("button", { name: "Grid" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("Blind Boxes › polish (#575, DEC-400)", () => {
  const META = {
    body: {
      code: 0,
      data: {
        rules: {
          mergeSize: { Common: 10, Uncommon: 10, Rare: 4, SuperRare: 0 },
          limits: { maxTreasureOpen: 100, maxBoxOpen: 30 },
          rewardBands: [
            { level: "Common", minUsd: 1, maxUsd: 8 },
            { level: "Uncommon", minUsd: 10.2, maxUsd: 215 },
            { level: "Rare", minUsd: 103, maxUsd: 1325 },
          ],
          tradeBoxLevels: ["Common", "Uncommon"],
        },
      },
    },
  };

  it("level cards: box art per level, Reward range where SoDEX sets a band, From trading by tradeBoxLevels", async () => {
    gateway({ "lottery/meta": META });
    const { container } = show();
    await screen.findByRole("button", { name: "Grid" });
    const card = (level: string) =>
      screen
        .getAllByText(level)
        .map((e) => e.closest("li"))
        .find((li) => li?.querySelector(".bx")) as HTMLElement;
    await within(card("Common")).findByText("$1.00 – $8.00");
    expect(within(card("Common")).getByText("Reward range · set by SoDEX")).toBeInTheDocument();
    expect(within(card("Common")).getByText("From trading")).toBeInTheDocument();
    expect(within(card("Common")).getByText("boxes")).toBeInTheDocument();
    expect(within(card("Rare")).getByText("$103.00 – $1,325.00")).toBeInTheDocument();
    expect(within(card("Rare")).queryByText("From trading")).toBeNull();
    // SuperRare: không có band → không có dòng; cấp rỗng → hình mờ.
    expect(within(card("SuperRare")).queryByText("Reward range · set by SoDEX")).toBeNull();
    expect(card("SuperRare").querySelector(".bx")?.getAttribute("style")).toContain("opacity");
    expect(card("Common").querySelector(".bx")?.getAttribute("data-kind")).toBe("common");
    // Không có xác suất.
    expect(container.textContent).not.toMatch(/%|chance|probability/i);
  });

  it("sub-tabs are underlined (2 px accent on the selected one) and scroll sideways on mobile", async () => {
    const user = userEvent.setup();
    show();
    const list = await screen.findByRole("tablist", { name: "Blind Boxes sections" });
    expect(list.className).toContain("overflow-x-auto");
    expect(list.className).toContain("border-b");
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent.replace(/\d+$/, ""))).toEqual([
      "Backpack",
      "History",
      "Weekly draw",
      "Live feed",
    ]);
    const [backpack, history] = tabs;
    if (backpack === undefined || history === undefined) throw new Error("tabs missing");
    expect(backpack).toHaveAttribute("aria-selected", "true");
    expect(backpack.className).toContain("border-b-2");
    expect(backpack.className).toContain("border-accent");
    expect(history.className).toContain("border-transparent");
    await user.click(history);
    expect(history).toHaveAttribute("aria-selected", "true");
    expect(history.className).toContain("border-accent");
    expect(backpack.className).toContain("border-transparent");
  });

  it("no rewardBands in meta: no Reward range anywhere", async () => {
    show();
    await screen.findByRole("button", { name: "Grid" });
    expect(screen.queryByText("Reward range · set by SoDEX")).toBeNull();
  });

  it("box list is a grid by default with box art per level, and switches to a table", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole("button", { name: "Grid" });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("img", { name: "Rare" })).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Common" })).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Table" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Table" })).toHaveAttribute("aria-pressed", "true");
  });

  it("ready block shows unclaimed (Mystery) boxes; nothing at all when total is 0", async () => {
    show();
    await screen.findByText("3 boxes ready to claim");
    expect(screen.getByRole("img", { name: "Unclaimed" })).toHaveAttribute("data-kind", "mystery");
    cleanup();
    gateway({ "lottery/treasures": { body: { code: 0, data: { total: 0, maxPerOpen: 100 } } } });
    show();
    await screen.findByRole("button", { name: "Grid" });
    expect(screen.queryByRole("img", { name: "Unclaimed" })).toBeNull();
  });

  it("passes axe with box art and ranges", async () => {
    gateway({ "lottery/meta": META });
    const { container } = show();
    await screen.findByText("$1.00 – $8.00");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("Blind Boxes › History (mockup 12)", () => {
  it("lists every kind read-only, with reward totals per asset and no hard-coded assets", async () => {
    show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("History");
    expect(await screen.findByText("Rewards from opened boxes")).toBeInTheDocument();
    expect(await screen.findByText("vsoUSDC")).toBeInTheDocument();
    expect(screen.getByText("3.88412")).toBeInTheDocument();
    expect(screen.getByText("Total at open time $412.36")).toBeInTheDocument();
    expect(await screen.findByText("Opened")).toBeInTheDocument();
    expect(screen.getByText("0.0612 vANT")).toBeInTheDocument();
    expect(screen.getByText("$5.07")).toBeInTheDocument();
    expect(screen.getByText("Merged")).toBeInTheDocument();
    expect(screen.getByText("10 Common → #201877")).toBeInTheDocument();
    expect(screen.getByText("Claimed")).toBeInTheDocument();
    expect(screen.getByText(/^Trading · /)).toBeInTheDocument();
    expect(screen.getByText("Transfer in")).toBeInTheDocument();
    expect(screen.getAllByText("#201640 · Common").length).toBeGreaterThan(0);
    expect(
      screen.getByText(/^Weekly draw prize · Round 10 · from 0x71b0…22d1 · /),
    ).toBeInTheDocument();
    // Không địa chỉ đầy đủ, không nút cho transfer.
    expect(screen.queryByText(/0x71b00000000000000000000000000000000022d1/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Transfer|Send/ })).toBeNull();
  });

  it("filters by kind", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("History");
    await screen.findByText("Opened");
    await user.click(screen.getByRole("radio", { name: "Transfers" }));
    expect(screen.queryByText("Opened")).toBeNull();
    expect(screen.getByText("Transfer in")).toBeInTheDocument();
  });

  it("pages the ledger 100 at a time with Load more", async () => {
    const page = (offset: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: "treasure",
        tsMs: 1764000000000 - (offset + i) * 1000,
        level: "Common",
        tokenId: 300000 + offset + i,
        source: "trade",
      }));
    gateway({
      "lottery/ledger": (url) => {
        const offset = Number(url.searchParams.get("offset"));
        const items = offset === 0 ? page(0, 100) : page(100, 19);
        return Promise.resolve(
          new Response(JSON.stringify({ code: 0, data: { total: 119, items } }), { status: 200 }),
        );
      },
    });
    const user = userEvent.setup();
    show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("History");
    expect(await screen.findByText("#300000 · Common")).toBeInTheDocument();
    expect(screen.queryByText("#300118 · Common")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("#300118 · Common")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    const offsets = gw.calls
      .filter((c) => c.path === "lottery/ledger")
      .map((c) => new URL(c.url).searchParams.get("offset"));
    expect(offsets).toEqual(["0", "100"]);
    expect(gw.calls.find((c) => c.path === "lottery/ledger")?.url).toContain("limit=100");
  });

  it("passes axe", async () => {
    const { container } = show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("History");
    await screen.findByText("Opened");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("Blind Boxes › Weekly draw (mockup 13, round 10 shape)", () => {
  it("shows the round, raw status, counts, winning tickets and prize boxes from the ledger separately", async () => {
    show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("Weekly draw");
    expect(await screen.findByRole("heading", { name: "Round 10" })).toBeInTheDocument();
    expect(screen.getByText("distributed")).toBeInTheDocument();
    expect(screen.getByText("Snapshot")).toBeInTheDocument();
    expect(
      screen.getByText("Each unopened box you hold at the snapshot counts as one ticket."),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Round 10 results:" })).toBeInTheDocument();
    expect(screen.getByText("1 of your 3 tickets won")).toBeInTheDocument();
    expect(screen.getByText("Prize: Common box")).toBeInTheDocument();
    expect(screen.getByText(/#188201/)).toBeInTheDocument();
    expect(screen.queryByText(/#188202/)).toBeNull();
    expect(await screen.findByText("Prize boxes received in round 10")).toBeInTheDocument();
    expect(screen.getByText(/#190044/)).toBeInTheDocument();
    expect(screen.getByText("Results from SoDEX's weekly draw.")).toBeInTheDocument();
  });

  it("no results card before the draw (wins missing)", async () => {
    gateway({
      "lottery/draw/entries": {
        body: {
          code: 0,
          data: { round: 11, status: "snapshot", deadlineMs: 1765191600000, tickets: 1, boxes: 1 },
        },
      },
    });
    show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("Weekly draw");
    expect(await screen.findByText("snapshot")).toBeInTheDocument();
    expect(screen.queryByText(/results:/)).toBeNull();
  });

  it("one ticket: singular", async () => {
    gateway({
      "lottery/draw/entries": {
        body: {
          code: 0,
          data: {
            round: 10,
            status: "distributed",
            tickets: 1,
            wins: 1,
            entries: [{ tokenId: 1, level: "Common", won: true, prizeLevel: "Common" }],
          },
        },
      },
    });
    show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("Weekly draw");
    expect(await screen.findByText("1 of your 1 ticket won")).toBeInTheDocument();
  });

  it("passes axe", async () => {
    const { container } = show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("Weekly draw");
    await screen.findByText("1 of your 3 tickets won");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("Blind Boxes › Live feed (mockup 14)", () => {
  it("lists SoDEX's feed with wallets as SoDEX shortened them", async () => {
    show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("Live feed");
    expect(
      await screen.findByText(
        "Recent big opens across SoDEX (USD 50+ or a PFP). Shown with a 5-minute delay.",
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("0x67fc…c7a0")).toBeInTheDocument();
    expect(screen.getByText("0x05d8…389e")).toBeInTheDocument();
  });

  it("empty history: says so", async () => {
    gateway({ "lottery/ledger": { body: { code: 0, data: { total: 0, items: [] } } } });
    show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("History");
    expect(await screen.findByText("No box history yet.")).toBeInTheDocument();
  });

  it("empty feed", async () => {
    gateway({ "lottery/feed": { body: { code: 0, data: { items: [] } } } });
    show();
    await screen.findByRole("button", { name: "Grid" });
    await openSub("Live feed");
    expect(await screen.findByText("No big opens to show right now.")).toBeInTheDocument();
  });
});
