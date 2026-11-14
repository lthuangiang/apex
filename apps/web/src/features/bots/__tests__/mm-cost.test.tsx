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
import { MmSuggestions } from "../components/mm-markets";
import { MmMarkoutCard } from "../components/mm-markout";
import { applyMmSuggestion } from "../mm-cost";

// Market Making · chi phí / $1M: gợi ý market dưới Contract (DEC-228) và Price PnL đến từ đâu (D2, DEC-227).

const state = vi.hoisted(() => ({ empty: false }));

const row = (
  market: string,
  total: string | null,
  capacity: string | null,
  extra: Record<string, unknown> = {},
) => ({
  market,
  stepBps: total === null ? null : "1.25",
  spreadTicks: total === null ? null : 1,
  swingBps: total === null ? null : "2.4",
  volume24h: capacity === null ? null : String(Number(capacity) * 20),
  capacityPerDay: capacity,
  tooLittleVolume: capacity !== null && Number(capacity) < 100_000,
  candleMinutes24h: total === null ? 0 : 1440,
  activeMinutes24h: total === null ? 0 : 1400,
  hoursWithData: 0,
  trades24h: 0,
  notional24h: "0",
  publicPricePnlPerMillion: null,
  pricePnlPerMillion: total === null ? null : String(150 - Number(total)),
  source: total === null ? null : "model",
  yourRoundTrips: 0,
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
          updatedAt: null,
          makerFeePerMillion: "120",
          builderFeePerMillion: "30",
          modelVersion: 0,
          model: { a: "0.25", k: "0.095" },
          markets: state.empty
            ? [row("NEW-USD", null, null)]
            : [
                row("ZERO-USD", "-12", "800000"),
                row("SOL-USD", "132", "210000"),
                row("ETH-USD", "216", "1550000", { yourBot: true, source: "yours" }),
                row("BTC-USD", "228", "2700000"),
                row("THIN-USD", "40", "47000"),
                row("NEW-USD", null, null),
              ],
          suggested: state.empty ? [] : ["ZERO-USD", "SOL-USD", "ETH-USD"],
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

describe("Market Making · suggested markets under Contract (DEC-228)", () => {
  it("offers up to 3 markets with cost and capacity, fills Contract, and states the cost of the chosen one", async () => {
    const user = userEvent.setup({ delay: null });
    const picked: string[] = [];
    const { rerender } = wrap(
      <MmSuggestions
        value=""
        onPick={(m) => {
          picked.push(m);
        }}
      />,
    );
    const list = within(await screen.findByRole("list"));
    expect(list.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "ZERO-USD · 0 or less per $1M · up to $800K/day",
      "SOL-USD · about 132 per $1M · up to $210K/day",
      "ETH-USD · about 216 per $1M · up to $1.6M/day",
    ]);
    await user.click(list.getByRole("button", { name: /^SOL-USD/ }));
    expect(picked).toEqual(["SOL-USD"]);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={qc}>
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <MmSuggestions value="SOL-USD" onPick={() => undefined} />
        </NextIntlClientProvider>
      </QueryClientProvider>,
    );
    const sol = await screen.findByRole("button", { name: /^SOL-USD.*Selected$/ });
    expect(sol).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("Estimated cost here: 132 per $1M (last 24 hours, not a forecast)."),
    ).toBeInTheDocument();
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 15_000);

  it("compares all markets in a dialog with the Data column, and Choose fills Contract and closes it", async () => {
    const user = userEvent.setup({ delay: null });
    const picked: string[] = [];
    wrap(
      <MmSuggestions
        value="NEW-USD"
        onPick={(m) => {
          picked.push(m);
        }}
      />,
    );
    expect(
      await screen.findByText("Estimated cost here: not enough data yet."),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Compare all markets" }));
    const dialog = await screen.findByRole("dialog", { name: "Compare all markets" });
    const names = () =>
      within(within(dialog).getByRole("table"))
        .getAllByRole("rowheader")
        .map((h) => h.textContent);
    expect(names()).toEqual([
      "ZERO-USDCheapest",
      "SOL-USD",
      "ETH-USDYour bot today",
      "BTC-USD",
      "THIN-USDToo little volume",
      "NEW-USD",
    ]);
    const cells = (m: string) =>
      within(
        within(dialog)
          .getByRole("rowheader", { name: new RegExp(`^${m}`) })
          .closest("tr") as HTMLElement,
      )
        .getAllByRole("cell")
        .map((c) => c.textContent);
    expect(cells("ZERO-USD").slice(5, 7)).toEqual(["0 or less", "Model"]);
    expect(cells("ETH-USD")[6]).toBe("Your bots");
    expect(cells("NEW-USD")[5]).toBe("Not enough data");
    expect(
      within(dialog).getByText(
        "Estimated from the SoDEX maker fee, the DeskLabs builder fee and how much the price usually moves against a market-making bot on this market, over the last 24 hours. Not a forecast.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Most volume" }));
    expect(names()[0]).toBe("BTC-USD");
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Choose ETH-USD" }));
    expect(picked).toEqual(["ETH-USD"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  }, 15_000);

  it("explains that suggestions need a day of data", async () => {
    state.empty = true;
    wrap(<MmSuggestions value="" onPick={() => undefined} />);
    expect(
      await screen.findByText("Suggestions appear once we have a day of SoDEX data."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Compare all markets" })).not.toBeInTheDocument();
    state.empty = false;
  });
});

describe("Market Making · where the price PnL comes from (D2)", () => {
  it("shows markout, the price step, losing round trips, In short, and ways to lower it", async () => {
    wrap(
      <MmMarkoutCard
        botId="b1"
        config={{ quoteLevel: 1, closeAtEntry: true, pauseOnFastMoves: false }}
      />,
    );
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
    expect(
      screen.getByRole("link", { name: /Close only at your entry price or better/ }),
    ).toHaveAttribute("href", "/bots/b1/edit?suggest=close-at-entry");
    // Trạng thái thật theo config, không có nhãn "New setting".
    expect(screen.queryByText("New setting")).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("link", { name: /Close only at your entry/ })).getByText("On"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("link", { name: /Pause on fast moves/ })).getByText("Off"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Setting: Quote position in the order book · now 1"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Pause on fast moves/ })).toHaveAttribute(
      "href",
      "/bots/b1/edit?suggest=pause-fast",
    );
    expect(screen.getByRole("link", { name: /Move to a cheaper market/ })).toHaveAttribute(
      "href",
      "/bots/new/volume_maker",
    );
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 15_000);

  it("prefills Edit one step further back (up to the limit) or with a new setting turned on", () => {
    expect(applyMmSuggestion({ quoteLevel: "0", x: "1" }, "quote-back")).toEqual({
      quoteLevel: "1",
      x: "1",
    });
    expect(applyMmSuggestion({}, "quote-back").quoteLevel).toBe("1");
    expect(applyMmSuggestion({ quoteLevel: "20" }, "quote-back").quoteLevel).toBe("20");
    expect(applyMmSuggestion({ closeAtEntry: false }, "close-at-entry").closeAtEntry).toBe(true);
    expect(applyMmSuggestion({}, "pause-fast").pauseOnFastMoves).toBe(true);
  });
});
