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
  feesPerMillion: "150",
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
                row("XAUT-USD", "150", "300000"),
                row("SOL-USD", "180", "210000"),
                row("ETH-USD", "216", "1550000", { yourBot: true, source: "yours" }),
                row("BTC-USD", "228", "2700000"),
                row("THIN-USD", "40", "47000"),
                row("NEW-USD", null, null),
              ],
          suggested: state.empty ? [] : ["ZERO-USD", "XAUT-USD", "SOL-USD"],
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
  it("offers up to 3 markets as a cost range with capacity, fills Contract, and states the range for the chosen one", async () => {
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
      // Không có lỗ giá (chi phí = phí): một số.
      "XAUT-USD · 150 per $1M · up to $300K/day",
      "SOL-USD · 150–180 per $1M · up to $210K/day",
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
      screen.getByText(
        "Estimated cost here: 150–180 per $1M (fees only to fees plus the usual price moves, last 24 hours, not a forecast).",
      ),
    ).toBeInTheDocument();
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  }, 15_000);

  it("compares markets in a dialog with fees-only and with-price-moves columns, hiding thin markets until asked", async () => {
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
    // Mặc định ẩn market "Too little volume" và chưa đủ dữ liệu.
    expect(names()).toEqual([
      "ZERO-USDCheapest",
      "XAUT-USD",
      "SOL-USD",
      "ETH-USDYour bot today",
      "BTC-USD",
    ]);
    expect(within(dialog).queryByRole("columnheader", { name: "Data" })).not.toBeInTheDocument();
    expect(
      within(dialog).getByRole("columnheader", { name: "Fees only / $1M" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("columnheader", { name: "With usual price moves / $1M" }),
    ).toBeInTheDocument();
    const cells = (m: string) =>
      within(
        within(dialog)
          .getByRole("rowheader", { name: new RegExp(`^${m}`) })
          .closest("tr") as HTMLElement,
      )
        .getAllByRole("cell")
        .map((c) => c.textContent);
    expect(cells("ZERO-USD").slice(5, 7)).toEqual(["150", "0 or less"]);
    expect(cells("SOL-USD").slice(5, 7)).toEqual(["150", "180"]);
    const toggle = within(dialog).getByRole("button", { name: "Show all markets (2 hidden)" });
    await user.click(toggle);
    expect(names()).toContain("THIN-USDToo little volume");
    expect(cells("NEW-USD")[6]).toBe("Not enough data");
    expect(
      within(dialog).getByRole("button", { name: "Hide markets with too little volume" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /The higher number is not a maximum: costs can be higher when the price moves a lot\./,
      ),
    ).toBeInTheDocument();
    const r = await axe.run(document.body, AXE);
    expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Choose ETH-USD" }));
    expect(picked).toEqual(["ETH-USD"]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // Mở lại: vẫn hiện tất cả (giữ trong phiên).
    await user.click(screen.getByRole("button", { name: "Compare all markets" }));
    const again = await screen.findByRole("dialog", { name: "Compare all markets" });
    expect(
      within(again).getByRole("button", { name: "Hide markets with too little volume" }),
    ).toBeInTheDocument();
  }, 20_000);

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
  it("shows markout, the price step, losing round trips and In short, without ways to lower it", async () => {
    wrap(<MmMarkoutCard botId="b1" />);
    expect(await screen.findByText("−0.3 bps")).toBeInTheDocument();
    expect(screen.getByText("−0.7 bps")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("One price step on ETH-USD")).toBeInTheDocument();
    expect(screen.getByText("0.53 bps")).toBeInTheDocument();
    expect(screen.getByText("7 of 12")).toBeInTheDocument();
    expect(screen.getByText("Losers lose more steps than winners win.")).toBeInTheDocument();
    expect(screen.getByText("In short:")).toBeInTheDocument();
    // "Ways to lower it" đã ẩn (DEC-241): gợi ý chưa đúng.
    expect(screen.queryByText("Ways to lower it")).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
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
    expect(applyMmSuggestion({}, "pause-fast").pauseOnFastMoves).toBe(true);
  });
});
