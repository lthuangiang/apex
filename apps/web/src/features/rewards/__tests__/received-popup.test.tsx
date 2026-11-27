// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { resetActions, setActionState } from "../action-store";
import { resetRewardsRateLimit } from "../client";
import { ReceivedPopup } from "../components/received-popup";
import { writeSeen, readSeen } from "../received";
import { saveRewardsToken } from "../token-store";
import { useRewardsAuth } from "../use-rewards-auth";

import { FAKE_TOKEN, MASTER, OTHER, fakeGateway, type Reply } from "./gateway-fixtures";

// Popup box mới nhận / vé trúng (#556, bản phác docs/mockups/rewards/received/): lần ký đầu không báo, một box, nhiều box,
// vé trúng + box thưởng (tách riêng), gộp (e), thiếu dữ liệu, nhiều tab, xếp hàng sau popup thao tác, plural, reduced motion,
// axe. Gateway, ví và localStorage đều giả / của jsdom; địa chỉ là ví giả của test.

const state = vi.hoisted<{
  master: string | null;
  wallet: string | undefined;
  /** Ví đọc lúc bấm ký (getConnection); khác `wallet` để thử ví vừa đổi sang địa chỉ khác. */
  signer: string | undefined;
}>(() => ({ master: null, wallet: undefined, signer: undefined }));
const signMessage = vi.hoisted(() => vi.fn(() => Promise.resolve("0xsig")));
/** #558: watch phía server (null = tính năng tắt) và thông báo server giả. */
const srv = vi.hoisted<{
  watch: unknown;
  notes: { items: unknown[]; unread: number } | undefined;
  reads: string[];
}>(() => ({ watch: null, notes: undefined, reads: [] }));
const connect = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const signTyped = vi.hoisted(() =>
  vi.fn<(td: unknown) => Promise<string>>(() => Promise.resolve("0xsig")),
);

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
  // #558: thông báo server (nguồn popup khi watch active).
  useNotifications: (enabled = true) => ({ data: enabled ? srv.notes : undefined }),
  NOTIFICATIONS_KEY: ["notifications"],
}));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (method: string, path: string) => {
    if (path === "/api/v1/rewards/watch") return Promise.resolve(srv.watch);
    const read = /^\/api\/v1\/notifications\/([^/]+)\/read$/.exec(path);
    if (method === "POST" && read?.[1] !== undefined) srv.reads.push(read[1]);
    return Promise.resolve(null);
  },
}));
vi.mock("wagmi", () => ({
  useConfig: () => ({}),
  useConnection: () => ({ address: state.wallet, isConnected: state.wallet !== undefined }),
  useSignMessage: () => ({ mutateAsync: signMessage }),
  useConnect: () => ({ mutateAsync: connect }),
  useDisconnect: () => ({ mutateAsync: () => Promise.resolve() }),
  useConnectors: () => [],
  useSwitchChain: () => ({ mutateAsync: () => Promise.resolve() }),
  useSignTypedData: () => ({ mutateAsync: signTyped }),
}));
vi.mock("@/lib/wagmi", () => ({
  valueChain: {
    id: 286623,
    blockExplorers: { default: { name: "ValueChain Scan", url: "https://scan.example" } },
  },
}));
vi.mock("wagmi/actions", () => ({
  getConnection: () => ({ address: state.signer ?? state.wallet, chainId: 286623 }),
}));

let gw: ReturnType<typeof fakeGateway>;
function gateway(routes: Partial<Record<string, Reply>> = {}) {
  gw = fakeGateway(routes);
  vi.stubGlobal("fetch", gw.fn);
}

function Host() {
  const auth = useRewardsAuth();
  return <ReceivedPopup session={auth} />;
}

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Host />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const ok = (data: unknown) => ({ body: { code: 0, msg: "ok", data } });
const SEEN_AT = 1764000000000;
const recv = (i: number, extra: Record<string, unknown> = {}) => ({
  kind: "transfer",
  tsMs: SEEN_AT + 1000 * (i + 1),
  level: "Common",
  tokenId: 201955 + i,
  txHash: `0xtx${String(i)}`,
  direction: "in",
  from: OTHER,
  to: MASTER,
  ...extra,
});
const ledger = (items: unknown[]) => ok({ total: items.length, items });
const noDraw = ok({ round: 11, status: "snapshot", tickets: 1, boxes: 1 });
const DRAW10 = ok({
  round: 10,
  status: "distributed",
  tickets: 27,
  boxes: 27,
  wins: 1,
  entries: [
    { tokenId: 188201, level: "Rare", won: true, prizeLevel: "Common" },
    { tokenId: 188202, level: "Common", won: false, prizeLevel: null },
  ],
});
const prize = (i: number, round = 10) =>
  recv(50 + i, { reason: "lottery_prize", round, tokenId: 202044 + i, from: MASTER });

function seenAt(ts = SEEN_AT, drawRounds: number[] = []) {
  writeSeen(MASTER, { ledgerTsMs: ts, drawRounds });
}

beforeEach(() => {
  srv.watch = null;
  srv.notes = undefined;
  srv.reads = [];
  localStorage.clear();
  localStorage.clear();
  state.master = MASTER;
  state.wallet = MASTER;
  state.signer = undefined;
  saveRewardsToken(MASTER, FAKE_TOKEN);
});
afterEach(() => {
  cleanup();
  resetActions();
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
});

describe("first sign-in on this browser", () => {
  it("shows nothing and sets the mark to what is already there", async () => {
    gateway({ "lottery/ledger": ledger([recv(1), recv(0)]), "lottery/draw/entries": DRAW10 });
    show();
    await waitFor(() => {
      expect(readSeen(MASTER)).toEqual({ ledgerTsMs: SEEN_AT + 2000, drawRounds: [10] });
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("received boxes (mockups 02, 03, 07)", () => {
  it("one box: level, sender with explorer link, time; closing marks it seen and it never shows again", async () => {
    seenAt();
    gateway({ "lottery/ledger": ledger([recv(0)]), "lottery/draw/entries": noDraw });
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "You received a Common box" });
    expect(within(dialog).getByText("#201955")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "0x71b0…22d1 ↗" })).toHaveAttribute(
      "href",
      "https://scan.example/tx/0xtx0",
    );
    expect(within(dialog).getByText(/^Received /)).toBeInTheDocument();
    expect(
      within(dialog).getByText("You can find them later in Blind Boxes › History."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "View boxes" })).toHaveAttribute(
      "href",
      "/rewards?tab=boxes",
    );
    expect((await axe.run(dialog)).violations).toEqual([]);
    // Reduced motion: box chỉ mờ dần.
    expect(within(dialog).getByText("#201955").parentElement?.className).toContain(
      "motion-reduce:animate-[rw-fade",
    );
    const close = within(dialog).getAllByRole("button", { name: "Close" }).at(-1);
    if (close === undefined) throw new Error("no Close");
    await user.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(readSeen(MASTER)?.ledgerTsMs).toBe(SEEN_AT + 1000);
    cleanup();
    show();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("many boxes: one popup, level chips, 5 rows + and N more (plural)", async () => {
    seenAt();
    gateway({
      "lottery/ledger": ledger([
        recv(5),
        recv(4, { level: "Rare" }),
        recv(3),
        recv(2, { level: "Uncommon" }),
        recv(1),
        recv(0),
      ]),
      "lottery/draw/entries": noDraw,
    });
    show();
    const dialog = await screen.findByRole("dialog", { name: "You received 6 boxes" });
    expect(
      within(dialog)
        .getAllByText(/^\d+ (Common|Uncommon|Rare)$/)
        .map((e) => e.textContent),
    ).toEqual(["4 Common", "1 Uncommon", "1 Rare"]);
    expect(within(dialog).getByText("and 1 more")).toBeInTheDocument();
  });

  it("missing level and txHash: 'You received a box', 'Box', sender as plain text", async () => {
    seenAt();
    gateway({
      "lottery/ledger": ledger([recv(0, { level: null, txHash: null })]),
      "lottery/draw/entries": noDraw,
    });
    show();
    const dialog = await screen.findByRole("dialog", { name: "You received a box" });
    expect(within(dialog).getByText("Box")).toBeInTheDocument();
    expect(within(dialog).getByText("0x71b0…22d1")).toBeInTheDocument();
    expect(within(dialog).queryByRole("link", { name: /0x71b0/ })).toBeNull();
  });
});

describe("weekly draw (mockups 04, 05, 06)", () => {
  it("wins from draw/entries, prize boxes from the ledger, listed separately; prizes never in Received", async () => {
    seenAt();
    gateway({ "lottery/ledger": ledger([prize(1), prize(0)]), "lottery/draw/entries": DRAW10 });
    show();
    const dialog = await screen.findByRole("dialog", { name: "1 of your 27 tickets won" });
    expect(within(dialog).getByText("Weekly draw · Round 10 · distributed")).toBeInTheDocument();
    expect(within(dialog).getByText("#188201")).toBeInTheDocument();
    expect(within(dialog).getByText("Prize: Common box")).toBeInTheDocument();
    expect(within(dialog).getByText("Prize boxes received in round 10")).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "#202044 ↗" })).toBeInTheDocument();
    expect(within(dialog).getByRole("link", { name: "#202045 ↗" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/^Received/)).toBeNull();
    expect(within(dialog).queryByText("#188202")).toBeNull();
    expect((await axe.run(dialog)).violations).toEqual([]);
  });

  it("one ticket: singular", async () => {
    seenAt();
    gateway({
      "lottery/ledger": ledger([]),
      "lottery/draw/entries": ok({
        round: 10,
        status: "distributed",
        tickets: 1,
        wins: 1,
        entries: [{ tokenId: 1, level: "Common", won: true, prizeLevel: "Common" }],
      }),
    });
    show();
    expect(
      await screen.findByRole("dialog", { name: "1 of your 1 ticket won" }),
    ).toBeInTheDocument();
  });

  it("prize from a round draw/entries doesn't cover: prize-only popup", async () => {
    seenAt();
    gateway({ "lottery/ledger": ledger([prize(0, 9)]), "lottery/draw/entries": noDraw });
    show();
    const dialog = await screen.findByRole("dialog", { name: "Weekly draw prize received" });
    expect(within(dialog).getByText("Prize boxes received in round 9")).toBeInTheDocument();
    expect(within(dialog).getByText("Weekly draw prize · Round 9")).toBeInTheDocument();
  });

  it("draw and received together: one popup, tickets first, then Received · n", async () => {
    seenAt();
    gateway({
      "lottery/ledger": ledger([recv(1, { level: "Uncommon" }), recv(0), prize(0)]),
      "lottery/draw/entries": DRAW10,
    });
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "New boxes in your backpack" });
    expect(
      within(dialog).getByText("Weekly draw · Round 10 · 1 of your 27 tickets won"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Received · 2")).toBeInTheDocument();
    const text = dialog.textContent;
    expect(text.indexOf("Ticket")).toBeLessThan(text.indexOf("Received · 2"));
    await user.click(within(dialog).getByRole("link", { name: "View boxes" }));
    expect(readSeen(MASTER)).toEqual({ ledgerTsMs: SEEN_AT + 51000, drawRounds: [10] });
  });
});

describe("other tabs and the action popup", () => {
  it("another tab marking it seen closes the popup here", async () => {
    seenAt();
    gateway({ "lottery/ledger": ledger([recv(0)]), "lottery/draw/entries": noDraw });
    show();
    await screen.findByRole("dialog", { name: "You received a Common box" });
    act(() => {
      const key = `desklabs.rewards.seen.${MASTER.toLowerCase()}`;
      localStorage.setItem(key, JSON.stringify({ ledgerTsMs: SEEN_AT + 1000, drawRounds: [] }));
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("waits while a Claim / Open / Merge popup is open, then shows", async () => {
    seenAt();
    gateway({ "lottery/ledger": ledger([recv(0)]), "lottery/draw/entries": noDraw });
    act(() => {
      setActionState({ open: true });
    });
    show();
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => {
      setActionState({ open: false });
    });
    expect(
      await screen.findByRole("dialog", { name: "You received a Common box" }),
    ).toBeInTheDocument();
  });
});

describe("server alerts as the event source (#558, watch active)", () => {
  const ACTIVE = {
    status: "active",
    reason: null,
    expiresAt: "2026-12-11T07:02:00.000Z",
    lastCheckedAt: null,
    delayed: false,
  };
  const note = (id: string, type: string, readAt: string | null = null) => ({
    id,
    type,
    data: { count: 1, levels: [] },
    createdAt: "2026-11-26T08:00:00Z",
    readAt,
  });

  it("no unread server alert: no popup even with new ledger rows (another device already showed them)", async () => {
    srv.watch = ACTIVE;
    srv.notes = { items: [note("n1", "rewards_box_received", "2026-11-26T08:05:00Z")], unread: 0 };
    seenAt();
    gateway({ "lottery/ledger": ledger([recv(0)]), "lottery/draw/entries": noDraw });
    show();
    await new Promise((r) => setTimeout(r, 80));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unread server alert: popup from the ledger rows; closing marks the server alerts read", async () => {
    srv.watch = ACTIVE;
    srv.notes = {
      items: [note("n2", "rewards_box_received"), note("n3", "rewards_claimable")],
      unread: 2,
    };
    seenAt();
    gateway({ "lottery/ledger": ledger([recv(0)]), "lottery/draw/entries": noDraw });
    const user = userEvent.setup();
    show();
    const dialog = await screen.findByRole("dialog", { name: "You received a Common box" });
    const close = within(dialog).getAllByRole("button", { name: "Close" }).at(-1);
    if (close === undefined) throw new Error("no Close");
    await user.click(close);
    await waitFor(() => {
      expect(srv.reads).toEqual(["n2"]);
    });
    expect(readSeen(MASTER)?.ledgerTsMs).toBe(SEEN_AT + 1000);
  });

  it("watch off or paused: falls back to the localStorage mark", async () => {
    srv.watch = { ...ACTIVE, status: "paused", reason: "expired" };
    seenAt();
    gateway({ "lottery/ledger": ledger([recv(0)]), "lottery/draw/entries": noDraw });
    show();
    expect(
      await screen.findByRole("dialog", { name: "You received a Common box" }),
    ).toBeInTheDocument();
    expect(srv.reads).toEqual([]);
  });
});
