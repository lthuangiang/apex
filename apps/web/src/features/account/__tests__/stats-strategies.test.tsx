// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { PlatformOverview } from "@drift/shared";
import { cleanup, render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import messages from "../../../../messages/en.json";
import { Strategies } from "../components/stats-overview";

// Platform Stats › By strategy: cột Net cost / $1M (DEC-TBD-stats-net-cost). Thiếu số → "Not available", không bao
// giờ 0; lãi → $0.00 như trang bot.

const wrap = (node: ReactNode) =>
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );

afterEach(cleanup);

type Row = PlatformOverview["strategies"][number];
const row = (strategy: string, netCostPerMillion: string | null): Row => ({
  strategy,
  bots: 1,
  running: 0,
  volume: "1000",
  feePerMillion: "120",
  netCostPerMillion,
  ordersPlaced: 10,
  fillRatePct: 50,
  rejectRatePct: 0,
});

const overview = (strategies: Row[]): PlatformOverview => ({
  kpis: {
    activeUsers: { cur: 0, prev: 0 },
    volume: { cur: "0", prev: "0" },
    revenue: { cur: "0", prev: "0" },
    revenuePerMillion: null,
    unchargedVolumePct: null,
  },
  activation: [],
  strategies,
  stops: [],
  builderFeeSources: [],
  health: { priceAgeSec: null, needsAttention: 0, rejected24h: 0, lastFillAt: null },
  insights: [],
});

describe("Stats › By strategy", () => {
  it("shows Net cost / $1M with its help, Not available when missing and $0.00 for a gain", async () => {
    const { container } = wrap(
      <Strategies
        period={30}
        o={overview([
          row("volume_maker", "21778.85"),
          row("spot_grid", "0"),
          row("futures_grid", null),
        ])}
      />,
    );
    const header = screen.getByRole("columnheader", { name: "Net cost / $1M" });
    expect(header).toHaveAccessibleDescription(
      "Net cost / $1M · What bots really lost per $1M traded after fees and price moves, the same number as on each bot’s page. Fees / $1M is only the fee part.",
    );
    const cells = (name: string) =>
      within(screen.getByRole("row", { name: new RegExp(name) }))
        .getAllByRole("cell")
        .map((c) => c.textContent);
    expect(cells("Market Making")[4]).toBe("$21,778.85");
    expect(cells("Spot Grid")[4]).toBe("$0.00");
    expect(cells("Futures Grid")[4]).toBe("Not available");
    const res = await axe.run(container);
    expect(res.violations).toEqual([]);
  });
});
