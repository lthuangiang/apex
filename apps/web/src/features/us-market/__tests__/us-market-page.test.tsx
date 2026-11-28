// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { UsMarketsResponse, WealthMeResponse } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { UsMarketPage } from "../components/us-market-page";

import { antPerps, antSpot, markets, NOW, wealthOk } from "./fixtures";

// Trang US Market (#591, bản phác màn 02, DEC-402): số theo API, thiếu thì "Not provided" / "–", "Last trade" khi
// volume null, nhãn Thin / Very thin, Empty / Halted, công tắc tắt thì Not found, không nút "Tell me when it trades".

const state = vi.hoisted<{
  usMarket: boolean | undefined;
  signalResearch: boolean;
  markets: unknown;
  marketsError: boolean;
  wealth: unknown;
}>(() => ({
  usMarket: true,
  signalResearch: false,
  markets: null,
  marketsError: false,
  wealth: null,
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
}));
vi.mock("@/lib/queries", () => ({
  useFeatures: () => ({
    data:
      state.usMarket === undefined
        ? undefined
        : { usMarket: state.usMarket, signalResearch: state.signalResearch },
  }),
}));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (_m: string, path: string) => {
    if (path === "/api/v1/markets/us")
      return state.marketsError
        ? Promise.reject(new Error("SODEX_UNAVAILABLE"))
        : Promise.resolve(state.markets);
    if (path === "/api/v1/wealth/me") return Promise.resolve(state.wealth);
    return new Promise(() => undefined);
  },
}));

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
  rules: { "color-contrast": { enabled: false } },
};

function show() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <UsMarketPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const rowOf = async (name: string) => {
  const cell = await screen.findByText(name);
  const row = cell.closest("tr");
  if (row === null) throw new Error(`row ${name} not found`);
  return within(row);
};

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  state.usMarket = true;
  state.signalResearch = false;
  state.markets = markets();
  state.marketsError = false;
  state.wealth = wealthOk();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("US Market page", () => {
  it("renders the Anthropic markets from the API: price, volume, book status, depth, labels, largest position", async () => {
    show();
    const perps = await rowOf("ANT-USD");
    expect(perps.getByText("Perps · max 10x")).toBeInTheDocument();
    expect(perps.getByText("$91.38")).toBeInTheDocument();
    expect(perps.getByText("$129,004.10")).toBeInTheDocument();
    expect(perps.getByText("Trading")).toBeInTheDocument();
    expect(perps.getByText("$2,449.00 / $1,955.00")).toBeInTheDocument();
    expect(perps.getByText("Thin")).toBeInTheDocument();
    expect(perps.getByText("$1,955.00")).toBeInTheDocument();
    expect(perps.getByRole("link", { name: "Start a bot on ANT-USD" })).toHaveAttribute(
      "href",
      "/bots?tab=catalog&market=ANT-USD&engine=perps",
    );
    const spot = await rowOf("vANT / vUSDC");
    expect(spot.getByText("Spot")).toBeInTheDocument();
    expect(spot.getByText("Very thin")).toBeInTheDocument();
    expect(screen.getByText("Order book read 20 s ago")).toBeInTheDocument();
    expect(screen.getByText("Thin order book.")).toBeInTheDocument();
  });

  it("shows strategy chips for the Anthropic markets, without Funding Arbitrage", async () => {
    state.signalResearch = true;
    show();
    await screen.findByText("ANT-USD");
    expect(screen.getByRole("link", { name: "Futures Grid · ANT-USD" })).toHaveAttribute(
      "href",
      "/bots/new/futures_grid?market=ANT-USD&engine=perps",
    );
    expect(screen.getByRole("link", { name: "Futures DCA · ANT-USD" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "News Signal · ANT-USD" })).toHaveAttribute(
      "href",
      "/signal-research",
    );
    expect(screen.getByRole("link", { name: "Spot DCA · vANT" })).toHaveAttribute(
      "href",
      "/bots/new/spot_dca?market=vANT_vUSDC&engine=spot",
    );
    expect(screen.getByRole("link", { name: "Spot Grid · vANT" })).toBeInTheDocument();
    expect(screen.queryByText(/Funding Arbitrage/)).not.toBeInTheDocument();
  });

  it("hides the News Signal chip when the account can't open Signal Research", async () => {
    show();
    await screen.findByText("ANT-USD");
    expect(screen.queryByRole("link", { name: /News Signal/ })).not.toBeInTheDocument();
  });

  it("shows Last trade instead of volume when the API returns no volume", async () => {
    state.markets = markets({
      anthropic: [
        antPerps({ volume24h: null, lastTradeAt: new Date(NOW - 3 * 86_400_000).toISOString() }),
        antSpot({ volume24h: null, lastTradeAt: null }),
      ],
    });
    show();
    expect((await rowOf("ANT-USD")).getByText("Last trade 3 days ago")).toBeInTheDocument();
    expect((await rowOf("vANT / vUSDC")).getByText("Not provided")).toBeInTheDocument();
  });

  it("shows Empty and Halted books, and never a number the API did not return", async () => {
    state.markets = markets({
      anthropic: [
        antPerps({ bookStatus: "halted", depth: null, lastPrice: null }),
        antSpot({ bookStatus: null, depth: null }),
      ],
    });
    show();
    const perps = await rowOf("ANT-USD");
    expect(perps.getByText("Halted")).toBeInTheDocument();
    expect(perps.getByText("Not provided")).toBeInTheDocument();
    expect(perps.getAllByText("–")).toHaveLength(2);
    const spot = await rowOf("vANT / vUSDC");
    expect(spot.getByText("Not provided")).toBeInTheDocument();
    expect(screen.queryByText("Thin order book.")).not.toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
  });

  it("lists US fund tokens as Watching with Empty books, no depth and no notify button", async () => {
    show();
    const voo = await rowOf("vVOO / vUSDC");
    expect(voo.getByText("vVOO Fund")).toBeInTheDocument();
    expect(voo.getByText("3 days ago")).toBeInTheDocument();
    expect(voo.getByText("Empty")).toBeInTheDocument();
    expect(voo.getByText("–")).toBeInTheDocument();
    expect((await rowOf("vQQQ / vUSDC")).getByText("1 day ago")).toBeInTheDocument();
    expect(screen.getByText("Watching")).toBeInTheDocument();
    expect(screen.getByText("2 more: vSMH, vVGT")).toBeInTheDocument();
    expect(screen.queryByText("vSMH / vUSDC")).not.toBeInTheDocument();
    expect(screen.queryByText(/Tell me when it trades/)).not.toBeInTheDocument();
  });

  it("shows SoDEX Wealth funds with what the user holds, and Not provided for a missing fund size", async () => {
    show();
    const unitree = await rowOf("UNITREE FUND");
    expect(unitree.getByText("$99.00")).toBeInTheDocument();
    expect(unitree.getByText("$202,644.90")).toBeInTheDocument();
    expect(unitree.getByText("Open")).toBeInTheDocument();
    expect(unitree.getByText("–")).toBeInTheDocument();
    const cxmt = await rowOf("CXMT");
    expect(cxmt.getByText("Not provided")).toBeInTheDocument();
    expect(cxmt.getByText("Opens Mon")).toBeInTheDocument();
    expect(cxmt.getByText("$166.05")).toBeInTheDocument();
    expect(
      screen.getByText(
        "NAV and fund size as SoDEX reports them. DeskLabs shows no yield or return figures for funds.",
      ),
    ).toBeInTheDocument();
  });

  it("links Open SoDEX Wealth and Invest to the SoDEX Wealth page in a new tab, with no parameters", async () => {
    show();
    const open = await screen.findByRole("link", { name: "Open SoDEX Wealth ↗" });
    const invest = await screen.findByRole("link", {
      name: "Invest in UNITREE FUND on SoDEX (opens in a new tab)",
    });
    for (const link of [open, invest]) {
      expect(link).toHaveAttribute("href", "https://sodex.com/wealth");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noopener noreferrer");
    }
  });

  it("shows the Your SoDEX Wealth strip from the API, and hides it when not connected", async () => {
    const view = show();
    const strip = await screen.findByRole("region", { name: "Your SoDEX Wealth" });
    expect(within(strip).getByText("$2,662.72")).toBeInTheDocument();
    expect(within(strip).getByText("+$201.39")).toBeInTheDocument();
    expect(within(strip).getByText("−$12.05")).toBeInTheDocument();
    expect(within(strip).getByText("1")).toBeInTheDocument();
    expect(within(strip).getByRole("link", { name: "Open My Wealth" })).toHaveAttribute(
      "href",
      "/portfolio?tab=wealth",
    );
    view.unmount();
    state.wealth = { status: "not_connected" } satisfies WealthMeResponse;
    show();
    await screen.findByText("ANT-USD");
    expect(screen.queryByRole("region", { name: "Your SoDEX Wealth" })).not.toBeInTheDocument();
  });

  it("says Not available when the funds or fund tokens could not be read", async () => {
    state.markets = markets({
      fundTokens: { status: "not_provided" },
      funds: { status: "not_provided" },
    } satisfies Partial<UsMarketsResponse>);
    show();
    await screen.findByText("ANT-USD");
    expect(screen.getAllByText("Not available")).toHaveLength(2);
  });

  it("shows an error with a retry when the page data can't be read", async () => {
    state.marketsError = true;
    show();
    expect(
      await screen.findByText("Couldn’t read US Market data from SoDEX. Try again in a moment."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("is Not found when the US Market switch is off", () => {
    state.usMarket = false;
    expect(() => show()).toThrow("NEXT_NOT_FOUND");
  });

  it("has no axe violations", async () => {
    show();
    await screen.findByText("UNITREE FUND");
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 15_000);
});
