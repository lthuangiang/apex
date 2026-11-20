/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import {
  researchMarketSplitSchema,
  type ResearchMarketSplit,
  type ResearchMarketState,
} from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { HowItWorksDrawer, HowItWorksProvider, type HowTab } from "../research/how-it-works";
import { ByMarket, MarketAtDecision, MarketEntry } from "../research/market-state";

// Trạng thái thị trường lúc quyết định (#376; mockup docs/mockups/signal-research/catalyst-market-state-{1440,390}.png,
// catalyst-drawer-market-state-1440.png): chip trên thẻ Decide kèm số thật, ô "Market at entry", tab "By market" (ngưỡng
// 30 lệnh, Live / Backfilled riêng), tab Market state trong drawer. Thiếu dữ liệu: "Not available", không bao giờ 0.

vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: () => Promise.reject(new real.ApiError("NOT_FOUND", 404)),
  };
});

const intlErrors: string[] = [];
function Wrap({ children, onHow }: { children: ReactNode; onHow?: (t: HowTab) => void }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider
        locale="en"
        messages={messages}
        timeZone="UTC"
        onError={(e) => {
          intlErrors.push(e.message);
        }}
      >
        <HowItWorksProvider value={onHow ?? null}>{children}</HowItWorksProvider>
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

async function noViolations() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(" | ")}`)).toEqual([]);
}

/** Mockup: ETH Long lúc BTC giảm 2.4% / 24 h, biến động 4 h của ETH ở phân vị 81 trong 30 ngày. */
const ETH_STATE: ResearchMarketState = {
  btcChange24hPct: -2.4,
  btcTrend: "down",
  volMovePct: 1.9,
  volPercentile: 81,
  volatility: "high",
};

const group = <K extends string>(key: K, closed: number, avgPct: number | null = null) => ({
  key,
  closed,
  avgPct,
  need: Math.max(0, 30 - closed),
});

/**
 * Lệnh đóng được tính của Overall cho version này. Review #388: mỗi bảng (BTC trend, volatility) của mỗi nguồn cộng lại,
 * kể cả "Not recorded" và "Not available", đúng bằng số này (mockup ghi 30 + 30 là số minh hoạ không khớp).
 */
const COUNTED = 100;

/** Live: mọi nhóm dưới 30 lệnh. */
const LIVE: ResearchMarketSplit = researchMarketSplitSchema.parse({
  source: "live",
  minClosedPerGroup: 30,
  btcTrend: [group("up", 5), group("flat", 8), group("down", 9)],
  volatility: [group("low", 4), group("normal", 10), group("high", 8)],
  // 8 lệnh trước #376 + 70 lệnh chỉ có snapshot backfilled (không có trạng thái của nguồn live).
  notRecorded: 78,
  btcNotAvailable: 0,
  volNotAvailable: 0,
});

/** Backfilled (cùng version, cùng 100 lệnh): nhóm đủ 30 lệnh có trung bình; 4 lệnh thiếu nến (volatility Not available). */
const BACKFILLED: ResearchMarketSplit = researchMarketSplitSchema.parse({
  source: "backfilled",
  minClosedPerGroup: 30,
  btcTrend: [group("up", 41, 0.42), group("flat", 30, -0.18), group("down", 29)],
  volatility: [group("low", 30, 0), group("normal", 36, 0.31), group("high", 30, -0.2)],
  notRecorded: 0,
  btcNotAvailable: 0,
  volNotAvailable: 4,
});

beforeEach(() => {
  intlErrors.length = 0;
});
afterEach(() => {
  cleanup();
  expect(intlErrors).toEqual([]);
});

describe("Market at decision (Decide card)", () => {
  it("chips and the real numbers behind them, with How it works › Market state", async () => {
    const onHow = vi.fn();
    render(
      <Wrap onHow={onHow}>
        <MarketAtDecision state={ETH_STATE} market="ETH-USD" />
      </Wrap>,
    );
    const box = screen.getByRole("region", { name: "Market at decision" });
    expect(within(box).getByText("BTC trend: down")).toBeInTheDocument();
    expect(within(box).getByText("Volatility (ETH): high")).toBeInTheDocument();
    expect(box).toHaveTextContent(
      "BTC −2.4% in the last 24 h · ETH 30-day move rank: 81st percentile · How it works › Market state",
    );
    await userEvent.click(within(box).getByRole("button", { name: "How it works › Market state" }));
    expect(onHow).toHaveBeenCalledWith("market");
    await noViolations();
  });

  it("ordinals: 1st, 2nd, 3rd, 11th, 22nd", () => {
    for (const [n, s] of [
      [1, "1st"],
      [2, "2nd"],
      [3, "3rd"],
      [11, "11th"],
      [22, "22nd"],
    ] as const) {
      render(
        <Wrap>
          <MarketAtDecision state={{ ...ETH_STATE, volPercentile: n }} market="SOL-USD" />
        </Wrap>,
      );
      expect(screen.getByText(new RegExp(`SOL 30-day move rank: ${s} percentile`))).toBeTruthy();
      cleanup();
    }
  });

  it("missing data: Not available on the chip, no number is invented", () => {
    render(
      <Wrap>
        <MarketAtDecision
          state={{ ...ETH_STATE, volMovePct: null, volPercentile: null, volatility: null }}
          market="ETH-USD"
        />
      </Wrap>,
    );
    const box = screen.getByRole("region", { name: "Market at decision" });
    expect(within(box).getByText("Volatility (ETH): Not available")).toBeInTheDocument();
    expect(box).toHaveTextContent("BTC −2.4% in the last 24 h");
    expect(box).not.toHaveTextContent("move rank");
    cleanup();
    render(
      <Wrap>
        <MarketAtDecision state={null} market="ETH-USD" />
      </Wrap>,
    );
    const old = screen.getByRole("region", { name: "Market at decision" });
    expect(within(old).getByText("BTC trend: Not available")).toBeInTheDocument();
    expect(within(old).getByText("Volatility (ETH): Not available")).toBeInTheDocument();
    expect(old).not.toHaveTextContent(/\b0(\.0)?%/);
  });
});

describe("Market at entry (Paper trades)", () => {
  it("chip, Not available for old trades, Market: Not available on the phone card", () => {
    render(
      <Wrap>
        <MarketEntry state={ETH_STATE} />
        <MarketEntry state={{ ...ETH_STATE, volatility: "normal" }} short />
        <MarketEntry state={{ ...ETH_STATE, btcTrend: null }} />
        <MarketEntry state={null} />
        <MarketEntry state={null} short />
      </Wrap>,
    );
    expect(screen.getByText("BTC trend: down · volatility: high")).toBeInTheDocument();
    expect(screen.getByText("BTC trend: down · volatility: normal")).toBeInTheDocument();
    expect(screen.getByText("BTC trend: Not available · volatility: high")).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText("Market: Not available")).toBeInTheDocument();
  });
});

describe("Is it working? › By market", () => {
  const rows = (name: string) =>
    within(screen.getByRole("table", { name }))
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.textContent);

  it("live: groups under 30 show what is missing, old trades are Not recorded / Not compared", async () => {
    render(
      <Wrap>
        <ByMarket live={LIVE} backfilled={BACKFILLED} />
      </Wrap>,
    );
    expect(
      screen.getByText(
        /^Same closed trades as Overall, split by the market at decision\. A group needs 30 closed trades before its average shows\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Live" })).toHaveAttribute("aria-pressed", "true");
    const cols = within(screen.getByRole("table", { name: "By BTC trend" }))
      .getAllByRole("columnheader")
      .map((c) => c.textContent);
    expect(cols).toEqual(["Market at decision", "Closed trades", "Average after fees"]);
    expect(rows("By BTC trend")).toEqual([
      "BTC trend: up5Not enough trades · needs 25 more",
      "BTC trend: flat8Not enough trades · needs 22 more",
      "BTC trend: down9Not enough trades · needs 21 more",
      "Not recorded (before Phase 0)78Not compared",
    ]);
    expect(rows("By volatility of the traded asset")).toEqual([
      "Volatility: low4Not enough trades · needs 26 more",
      "Volatility: normal10Not enough trades · needs 20 more",
      "Volatility: high8Not enough trades · needs 22 more",
      "Not recorded (before Phase 0)78Not compared",
    ]);
    await noViolations();
  });

  it("backfilled is its own set: averages from 30 trades (0 is a real average), Not available row", async () => {
    render(
      <Wrap>
        <ByMarket live={LIVE} backfilled={BACKFILLED} />
      </Wrap>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Backfilled" }));
    expect(screen.getByRole("button", { name: "Backfilled" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(rows("By BTC trend")).toEqual([
      "BTC trend: up41+0.42%",
      "BTC trend: flat30−0.18%",
      "BTC trend: down29Not enough trades · needs 1 more",
    ]);
    expect(rows("By volatility of the traded asset")).toEqual([
      "Volatility: low300.00%",
      "Volatility: normal36+0.31%",
      "Volatility: high30−0.20%",
      "Not available4Not compared",
    ]);
  });

  it("every table adds up to Overall's counted closed trades, for each source (review #388)", async () => {
    // Khoá ở dữ liệu: mỗi bảng của mỗi nguồn cộng lại (kể cả Not recorded / Not available) = lệnh đóng được tính.
    for (const s of [LIVE, BACKFILLED]) {
      const sum = (gs: readonly { closed: number }[], na: number) =>
        gs.reduce((a, g) => a + g.closed, 0) + na + s.notRecorded;
      expect(sum(s.btcTrend, s.btcNotAvailable)).toBe(COUNTED);
      expect(sum(s.volatility, s.volNotAvailable)).toBe(COUNTED);
    }
    // Và ở màn hình: cột "Closed trades" của mỗi bảng cộng lại đúng số đó, ở cả Live lẫn Backfilled.
    render(
      <Wrap>
        <ByMarket live={LIVE} backfilled={BACKFILLED} />
      </Wrap>,
    );
    const shown = (name: string) =>
      within(screen.getByRole("table", { name }))
        .getAllByRole("row")
        .slice(1)
        .reduce((a, r) => a + Number(within(r).getAllByRole("cell")[0]?.textContent ?? "NaN"), 0);
    for (const source of ["Live", "Backfilled"]) {
      await userEvent.click(screen.getByRole("button", { name: source }));
      expect(shown("By BTC trend")).toBe(COUNTED);
      expect(shown("By volatility of the traded asset")).toBe(COUNTED);
    }
  });

  it("no split from the API: Not available, never a table of zeros", () => {
    render(
      <Wrap>
        <ByMarket live={null} backfilled={null} />
      </Wrap>,
    );
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("How it works › Market state", () => {
  it("states the agreed thresholds: 24 h ±1.5%, 4 h, 33rd / 67th percentile of 30 days, missing candles", async () => {
    render(
      <Wrap>
        <HowItWorksDrawer
          tab="market"
          onTab={() => undefined}
          onClose={() => undefined}
          version={null}
          rulesVersion={3}
        />
      </Wrap>,
    );
    const dlg = await screen.findByRole("dialog", { name: "How it works" });
    expect(within(dlg).getByRole("tab", { name: "Market state" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const panel = within(dlg).getByRole("tabpanel");
    expect(panel).toHaveTextContent(
      "Market state is saved with every decision. It describes the market at that moment. It never changes a decision; it’s only used to split the results in Is it working? › By market.",
    );
    expect(panel).toHaveTextContent(
      "BTC trendBTC-USD change over the last 24 h, from SoDEX prices:· up: more than +1.5%· down: less than −1.5%· flat: in between",
    );
    expect(panel).toHaveTextContent(
      "Volatility (of the traded asset)The asset’s move over the last 4 h, ranked against its own last 30 days:· low: below the 33rd percentile· high: above the 67th percentile· normal: in between",
    );
    expect(panel).toHaveTextContent(
      "No price data at that moment: “Not available”. Trades opened before market state was recorded show “Not available” too.",
    );
    expect(panel).toHaveTextContent(
      "Volatility is “Not available” too when the last 4 h has fewer than 90% of its 1-minute candles, or no trades at all.",
    );
    await noViolations();
  });
});
