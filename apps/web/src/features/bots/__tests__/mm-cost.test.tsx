// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { MmMarketsPage } from "../components/mm-markets";
import { MmMarkoutCard } from "../components/mm-markout";
import { applyMmSuggestion } from "../mm-cost";

// Market Making · chi phí / $1M (DEC-227): bảng xếp hạng market (D1) và Price PnL đến từ đâu (D2).

const state = vi.hoisted(() => ({ pushed: [] as string[], updatedAt: "2026-11-14T09:58:00.000Z" }));

const row = (market: string, total: string | null, volume: string | null, extra = {}) => ({
  market,
  stepBps: total === null ? null : "1.25",
  spreadTicks: total === null ? null : 1,
  swingBps: total === null ? null : "2.4",
  volume24h: volume,
  pricePnlPerMillion: total === null ? null : String(150 - Number(total)),
  pricePnlSource: total === null ? null : "public",
  totalCostPerMillion: total,
  yourBot: false,
  ...extra,
});

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_method: string, path: string) => {
      if (path === "/api/v1/markets/mm-cost")
        return Promise.resolve({
          asOf: "2026-11-14T10:00:00.000Z",
          updatedAt: state.updatedAt,
          makerFeePerMillion: "120",
          builderFeePerMillion: "30",
          markets: [
            row("ETH-USD", "216", "31000000", { yourBot: true }),
            row("NEW-USD", null, null),
            row("SOL-USD", "132", "4200000"),
          ],
        });
      if (path === "/api/v1/bots/b1/mm-markout")
        return Promise.resolve({
          asOf: "2026-11-14T10:00:00.000Z",
          market: "ETH-USD",
          fills: 40,
          markout: { s5: "-0.3", s30: "-0.7", s60: null },
          stepBps: "0.53",
          roundTrips: { losing: 7, total: 12, losersLoseMore: true },
          inShort: true,
        });
      return new Promise(() => undefined);
    },
  };
});
vi.mock("@/components/workspace-shell", () => ({
  WorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/lib/queries", () => ({ useMe: () => ({ data: undefined }) }));
vi.mock("@/lib/markets", () => ({
  useMarketNames: () => ({ market: (m: string) => m }),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: (p: string) => {
      state.pushed.push(p);
    },
  }),
}));

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const markets = () =>
  within(screen.getByRole("table"))
    .getAllByRole("rowheader")
    .map((h) => h.textContent);

const AXE = {
  runOnly: {
    type: "tag" as const,
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
  rules: { "color-contrast": { enabled: false } },
};

afterEach(() => {
  cleanup();
});

describe("Market Making · choose a market (D1)", () => {
  it("ranks cheapest first with missing markets last, picks the cheapest, and continues to settings", async () => {
    const user = userEvent.setup({ delay: null });
    wrap(<MmMarketsPage />);
    await screen.findByRole("table");
    expect(markets()).toEqual(["SOL-USDCheapest", "ETH-USDYour bot today", "NEW-USD"]);
    const newRow = screen.getByRole("rowheader", { name: "NEW-USD" }).closest("tr");
    expect(within(newRow as HTMLElement).getAllByText("Not available")).toHaveLength(6);
    expect(screen.getByRole("heading", { name: "Chosen: SOL-USD" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Estimated total cost 132 USDC for every $1M of volume (last 24 hours, not a forecast).",
      ),
    ).toBeInTheDocument();
    // Dữ liệu mới (2 phút trước): không hiện dòng Updated.
    expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Most volume" }));
    expect(markets()).toEqual(["ETH-USDYour bot today", "SOL-USD", "NEW-USD"]);
    await user.click(screen.getByRole("button", { name: "Choose NEW-USD" }));
    expect(
      screen.getByText("We don’t have enough trades to estimate the cost on this market yet."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Choose ETH-USD" }));
    await user.click(screen.getByRole("button", { name: "Continue to settings" }));
    expect(state.pushed).toEqual(["/bots/new/volume_maker?market=ETH-USD&engine=perps"]);
    expect(screen.getByText(/DeskLabs builder fee \(0\.003%\)/)).toBeInTheDocument();
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 15_000);

  it("says when the numbers are more than an hour old", async () => {
    state.updatedAt = "2026-11-14T08:30:00.000Z";
    wrap(<MmMarketsPage />);
    expect(await screen.findByText(/^Updated /)).toBeInTheDocument();
    state.updatedAt = "2026-11-14T09:58:00.000Z";
  });
});

describe("Market Making · where the price PnL comes from (D2)", () => {
  it("shows markout, the price step, losing round trips, In short, and ways to lower it", async () => {
    wrap(<MmMarkoutCard botId="b1" />);
    expect(await screen.findByText("−0.3 bps")).toBeInTheDocument();
    expect(screen.getByText("−0.7 bps")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("One price step on ETH-USD")).toBeInTheDocument();
    expect(screen.getByText("0.53 bps")).toBeInTheDocument();
    expect(screen.getByText("7 of 12")).toBeInTheDocument();
    expect(screen.getByText("Losers lose more steps than winners win.")).toBeInTheDocument();
    expect(screen.getByText("In short:")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Quote one step back/ })).toHaveAttribute(
      "href",
      "/bots/b1/edit?suggest=quote-back",
    );
    expect(screen.getByRole("link", { name: /Move to a cheaper market/ })).toHaveAttribute(
      "href",
      "/bots/new/volume_maker",
    );
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 15_000);

  it("prefills Edit one step further back, up to the limit", () => {
    expect(applyMmSuggestion({ quoteLevel: "0", x: "1" }, "quote-back")).toEqual({
      quoteLevel: "1",
      x: "1",
    });
    expect(applyMmSuggestion({}, "quote-back").quoteLevel).toBe("1");
    expect(applyMmSuggestion({ quoteLevel: "20" }, "quote-back").quoteLevel).toBe("20");
  });
});
