// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { botSummarySchema, type BotSummary } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { DEFAULT_FILTERS } from "../bot-picker";
import {
  BotPickerPanel,
  BotSelector,
  BotSelectorError,
  BotSelectorSkeleton,
  BotSelectorStale,
  NoneRunning,
} from "../components/bot-selector";

// Bộ chọn bot của Trading Agent, phương án A (docs/mockups/agent-selector; DEC-294).

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
};

const media = vi.hoisted(() => ({ phone: false }));
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: () => undefined }),
}));
vi.mock("next/link", () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/use-media", () => ({ useMediaQuery: () => media.phone }));
vi.mock("@/lib/queries", () => ({ useMe: () => ({ data: { timezone: "UTC" } }) }));
vi.mock("@/lib/markets", () => ({
  useMarketNames: () =>
    Object.assign((m: string) => m, {
      market: (m: string) => m,
      asset: (a: string) => a.replace(/^v/, ""),
      info: () => undefined,
      qtyDigits: () => 4,
    }),
}));

beforeAll(() => {
  Element.prototype.scrollIntoView = () => undefined;
});

let n = 0;
function bot(over: Partial<BotSummary> = {}): BotSummary {
  n += 1;
  return botSummarySchema.parse({
    id: uuid(100 + n),
    name: `Bot ${String(n)}`,
    strategy: "volume_maker",
    market: "BTC-USD",
    engine: "perps",
    state: "running",
    reasonCode: null,
    needsAttention: false,
    activeVersion: 1,
    netPnl: "1.5",
    fills: 3,
    summary: "$50 · 1 bp · Smart quoting",
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-10T00:00:00.000Z",
    ...over,
  });
}
const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

const current = bot({ id: uuid(1), name: "BTC Market Making", activeVersion: 4, netPnl: "18.42" });
const attnA = bot({
  id: uuid(2),
  name: "ETH Market Making",
  market: "ETH-USD",
  state: "paused",
  reasonCode: "BOT_MAX_LOSS",
  needsAttention: true,
  netPnl: "-14.2",
});
const runB = bot({
  id: uuid(3),
  name: "SOL Grid",
  strategy: "futures_grid",
  market: "SOL-USD",
  summary: null,
  capital: "300",
});
const pausedC = bot({
  id: uuid(4),
  name: "Paused one",
  state: "paused",
  updatedAt: "2026-11-01T00:00:00.000Z",
});
const stopped1 = bot({
  id: uuid(5),
  name: "Old grid",
  strategy: "spot_grid",
  market: "vBTC_vUSDC",
  engine: "spot",
  state: "stopped",
});
const stopped2 = bot({ id: uuid(6), name: "Old MM", state: "stopped", reasonCode: "TAKE_PROFIT" });
const archivedD = bot({
  id: uuid(7),
  name: "Archived TWAP",
  strategy: "twap",
  market: "vSOL_vUSDC",
  engine: "spot",
  state: "archived",
});
const draftE = bot({ id: uuid(8), name: "A draft", state: "draft" });
const paperF = bot({ id: uuid(9), name: "Paper bot", mode: "paper", fills: 0, netPnl: null });
const BOTS = [current, attnA, runB, pausedC, stopped1, stopped2, archivedD, draftE, paperF];

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <main>
          <h1>Trading Agent</h1>
          {ui}
        </main>
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
const show = (bots: BotSummary[] = BOTS, cur: BotSummary = current) =>
  wrap(<BotSelector bots={bots} current={cur} />);

const trigger = () => screen.getByRole("button", { name: /Switch bot/ });
const openPanel = () => {
  fireEvent.click(trigger());
  return screen.getByRole("combobox", { name: "Find a bot" });
};
/** Dòng bot trong listbox (không lẫn `<option>` của ô Strategy / Market). */
const opts = (root: HTMLElement = document.body) =>
  within(within(root).getByRole("listbox")).getAllByRole("option");
const optNames = () => opts().map((o) => o.getAttribute("aria-label")?.split(",")[0]);
const groupNames = () =>
  screen
    .getAllByRole("group")
    .filter((g) => g.closest('[role="listbox"]'))
    .map((g) => g.getAttribute("aria-label"));
const optionNames = (group: string) =>
  within(screen.getByRole("group", { name: new RegExp(`^${group},`) }))
    .getAllByRole("option")
    .map((o) => o.getAttribute("aria-label")?.split(",")[0]);

afterEach(() => {
  media.phone = false;
  push.mockReset();
  cleanup();
});

describe("Trading Agent bot selector (1440)", () => {
  it("summary bar shows the bot being viewed with short id, summary and Switch bot", () => {
    show();
    const t = trigger();
    expect(t).toHaveAttribute("aria-haspopup", "dialog");
    expect(t).toHaveAttribute("aria-expanded", "false");
    expect(t).toHaveTextContent("BTC Market Making");
    expect(t).toHaveTextContent("··00000001");
    expect(t).toHaveTextContent("BTC-USD · Market Making · v4 · $50 · 1 bp · Smart quoting");
    expect(screen.getByRole("button", { name: "1 needs attention" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Next live bot" })).toBeInTheDocument();
  });

  it("opens with focus in the search, groups in order, Viewing on the current bot", async () => {
    show();
    const input = openPanel();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveFocus();
    expect(groupNames()).toEqual(["Needs attention, 1 bot", "Running, 3 bots", "Paused, 1 bot"]);
    expect(optionNames("Needs attention")).toEqual(["ETH Market Making"]);
    expect(optionNames("Running")).toEqual(["BTC Market Making", "SOL Grid", "Paper bot"]);
    const selected = opts().filter((o) => o.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    const [cur] = selected;
    if (cur === undefined) throw new Error("no selected option");
    expect(cur).toHaveAttribute(
      "aria-label",
      "BTC Market Making, id ending 00000001, BTC-USD, version 4, Running, net PnL up 18.42 USDC",
    );
    expect(within(cur).getByText("Viewing")).toBeInTheDocument();
    // Draft và archived không có; stopped thu gọn.
    expect(screen.queryByRole("option", { name: /^A draft,/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Archived TWAP,/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /^Old grid,/ })).not.toBeInTheDocument();
    // Lý do pause của bot cần chú ý; summary null → capital.
    expect(screen.getByRole("option", { name: /^ETH Market Making,/ })).toHaveTextContent("▲");
    expect(screen.getByRole("option", { name: /^SOL Grid,/ })).toHaveTextContent("300.00 USDC");
    expect(screen.getByRole("option", { name: /^Paper bot,/ })).toHaveTextContent("PAPER");
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });

  it("Show N stopped bots reveals the Stopped group", () => {
    show();
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 stopped bots" }));
    expect(groupNames().at(-1)).toBe("Stopped, 2 bots");
    expect(screen.queryByRole("button", { name: /stopped bots/ })).not.toBeInTheDocument();
  });

  it("Archived filter shows archived bots read only and opens their page", () => {
    show();
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "Archived 1" }));
    expect(screen.getByRole("button", { name: "Archived 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(groupNames()).toEqual(["Archived · read only, 1 bot"]);
    fireEvent.click(screen.getByRole("option", { name: /^Archived TWAP,/ }));
    expect(push).toHaveBeenCalledWith(`/agent/${archivedD.id}`);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("search narrows every state except Archived, announces the count, and offers to clear", () => {
    show();
    const input = openPanel();
    fireEvent.change(input, { target: { value: "old" } });
    expect(optNames()).toEqual(["Old grid", "Old MM"]);
    expect(screen.getByRole("status")).toHaveTextContent("2 bots match");
    fireEvent.change(input, { target: { value: "xrp" } });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByText("No bots match “xrp”.")).toBeInTheDocument();
    expect(
      screen.getByText("Search looks at name, market, strategy and id, in every state."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear search and filters" }));
    expect(input).toHaveValue("");
    expect(opts().length).toBeGreaterThan(0);
  });

  it("strategy and market filters", () => {
    show();
    openPanel();
    const strategy = screen.getByRole("combobox", { name: /^Strategy/ });
    fireEvent.change(strategy, { target: { value: "futures_grid" } });
    expect(optNames()).toEqual(["SOL Grid"]);
    fireEvent.change(strategy, { target: { value: "all" } });
    fireEvent.change(screen.getByRole("combobox", { name: /^Market/ }), {
      target: { value: "ETH" },
    });
    expect(optNames()).toEqual(["ETH Market Making"]);
  });

  it("keyboard: arrows, Home / End move the active option, Enter opens, Esc closes to the trigger", () => {
    show();
    const input = openPanel();
    const active = () =>
      document
        .getElementById(input.getAttribute("aria-activedescendant") ?? "")
        ?.getAttribute("aria-label")
        ?.split(",")[0];
    // Bắt đầu ở bot đang xem.
    expect(active()).toBe("BTC Market Making");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(active()).toBe("SOL Grid");
    fireEvent.keyDown(input, { key: "Home" });
    expect(active()).toBe("ETH Market Making");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(active()).toBe("ETH Market Making");
    fireEvent.keyDown(input, { key: "End" });
    expect(active()).toBe("Paused one");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(push).toHaveBeenCalledWith(`/agent/${pausedC.id}`);
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    openPanel();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Find a bot" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it("type-to-search from the trigger", () => {
    show();
    fireEvent.keyDown(trigger(), { key: "s" });
    const input = screen.getByRole("combobox", { name: "Find a bot" });
    expect(input).toHaveValue("s");
  });

  it("one bot: Your only bot, no switch", () => {
    show([current], current);
    expect(screen.getByText("Your only bot")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Switch bot/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "New bot" })).toHaveAttribute(
      "href",
      "/bots?tab=catalog",
    );
  });
});

describe("Trading Agent bot selector (390)", () => {
  it("header card opens a bottom sheet with the same list", async () => {
    media.phone = true;
    window.innerWidth = 390;
    show();
    const card = screen.getByRole("button", { name: /Switch$/ });
    expect(card).toHaveTextContent("BTC-USD · v4 · $50 · 1 bp · Smart quoting");
    expect(screen.getByRole("button", { name: /1 other bot needs attention/ })).toBeInTheDocument();
    fireEvent.click(card);
    const dialog = screen.getByRole("dialog", { name: "Switch bot" });
    expect(within(dialog).getByText("7 bots")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Close" })).toHaveClass("size-11");
    expect(within(dialog).getByRole("combobox", { name: "Find a bot" })).toHaveFocus();
    expect(opts(dialog).find((o) => o.getAttribute("aria-selected") === "true")).toHaveTextContent(
      "Viewing",
    );
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    window.innerWidth = 1024;
  });
});

describe("selector states", () => {
  it("loading skeleton is hidden from screen readers", () => {
    const { container } = wrap(<BotSelectorSkeleton />);
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });

  it("list error keeps the bot in the URL and offers Try again", () => {
    const retry = vi.fn();
    wrap(<BotSelectorError bot={current} onRetry={retry} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t load your other bots.");
    expect(screen.getByText("BTC Market Making")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalled();
  });

  it("stale list shows when it was last updated", () => {
    wrap(<BotSelectorStale updatedAt={Date.parse("2026-11-16T11:42:10.000Z")} />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Bot states may be out of date. Updated 11:42:10.",
    );
  });

  it("only stopped bots: No bot is running opens the Stopped list", () => {
    wrap(<NoneRunning bots={[stopped1, stopped2, archivedD]} />);
    expect(screen.getByRole("heading", { name: "No bot is running" })).toBeInTheDocument();
    expect(
      screen.getByText("You have 2 stopped bots. Open one to see what it did, or start a new one."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open a stopped bot" }));
    const dialog = screen.getByRole("dialog", { name: "Switch bot" });
    expect(opts(dialog)).toHaveLength(2);
    expect(opts(dialog).filter((o) => o.getAttribute("aria-selected") === "true")).toEqual([]);
  });

  it("reused outside Trading Agent (#289): All row, onSelect, fixed strategy, account, no PnL column", () => {
    const onSelect = vi.fn();
    const lite = [current, runB, stopped2].map((b) => ({
      id: b.id,
      name: b.name,
      strategy: b.strategy,
      market: b.market,
      marketLabel: null,
      state: b.state,
      reasonCode: null,
      needsAttention: false,
      activeVersion: b.activeVersion,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      account: "Account ··b569370e",
    }));
    wrap(
      <BotPickerPanel
        bots={lite}
        currentId={null}
        filters={{ ...DEFAULT_FILTERS, showStopped: true }}
        setFilters={() => undefined}
        phone={false}
        onPick={() => undefined}
        onEscape={null}
        onSelect={onSelect}
        allOption={{ label: "All MM bots", sub: "3 bots" }}
        fixedStrategy
        created={() => "Nov 2"}
        keysHint="↑ ↓ to move · Enter to choose · Esc to close"
        manageLink={false}
      />,
    );
    expect(screen.queryByRole("combobox", { name: "Strategy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Manage all bots/ })).not.toBeInTheDocument();
    const list = screen.getByRole("listbox", { name: "Switch bot" });
    const rows = within(list).getAllByRole("option");
    expect(rows[0]).toHaveTextContent("All MM bots");
    expect(rows[0]).toHaveAttribute("aria-selected", "true");
    expect(rows[1]).toHaveAttribute(
      "aria-label",
      `BTC Market Making, id ending ${current.id.slice(-8)}, BTC-USD, version 4, Account ··b569370e, Running`,
    );
    expect(rows[1]).toHaveTextContent("Created Nov 2 · Account ··b569370e");
    expect(list.textContent).not.toMatch(/net PnL|USDC/);
    fireEvent.click(within(list).getByRole("option", { name: /^BTC Market Making/ }));
    expect(onSelect).toHaveBeenLastCalledWith(current.id);
    fireEvent.click(within(list).getByText("All MM bots"));
    expect(onSelect).toHaveBeenLastCalledWith(null);
    expect(push).not.toHaveBeenCalled();
  });
});
