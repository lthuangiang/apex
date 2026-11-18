// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import type { DeskPerformance } from "@drift/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { PerformanceCard } from "../components/performance-card";

// AI Desk "How your bots performed" (#234, thiết kế #232 + review UX).

const cost = (o: Partial<DeskPerformance["current"]> = {}): DeskPerformance["current"] => ({
  volume: "1210000",
  fills: 1184,
  cost: "259",
  sodexFee: "128.26",
  builderFee: "54.45",
  priceMove: "76.29",
  perMillion: { cost: "214", sodexFee: "106", builderFee: "45", priceMove: "63" },
  ...o,
});
const hours = Array.from({ length: 24 }, (_, hour) => ({
  hour,
  fills: hour === 0 ? 10 : 50,
  feesPerMillion: "150",
  pricePerMillion: String(hour * 3),
  costPerMillion: String(150 + hour * 3),
  thin: hour === 0,
}));
const READY: DeskPerformance = {
  period: "7d",
  tz: "UTC",
  state: "ready",
  current: cost(),
  previous: cost({
    perMillion: { cost: "252", sodexFee: "104", builderFee: "45", priceMove: "103" },
  }),
  hours,
  cheapest: { from: 1, costPerMillion: "156", fills: 150 },
  dearest: { from: 21, costPerMillion: "216", fills: 150 },
  exits: {
    bots: 2,
    trades: 1184,
    items: [
      { reason: "holdTime", trades: 568, share: 0.48, avgNet: "-0.12" },
      { reason: "stopLoss", trades: 154, share: 0.13, avgNet: "-0.41" },
      { reason: "takeProfit", trades: 142, share: 0.12, avgNet: "0.19" },
    ],
  },
  bots: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "ETH Volume Builder",
      strategy: "volume_farm",
      market: "ETH-USD",
      current: cost({
        volume: "520000",
        perMillion: { cost: "291", sodexFee: "110", builderFee: "50", priceMove: "131" },
      }),
      previous: cost({
        perMillion: { cost: "338", sodexFee: "110", builderFee: "50", priceMove: "178" },
      }),
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "BTC Market Making",
      strategy: "volume_maker",
      market: "BTC-USD",
      current: cost({ fills: 12, volume: "4000" }),
      previous: null,
    },
  ],
  ideas: [
    {
      kind: "maxSpread",
      botId: "11111111-1111-4111-8111-111111111111",
      botName: "ETH Volume Builder",
      trades: 52,
      fromBps: "10",
      toBps: "8",
      worseCostPerMillion: "520",
      betterCostPerMillion: "214",
      worseShare: 0.25,
    },
  ],
};

const state = vi.hoisted((): { view: unknown; calls: string[]; fail: boolean } => ({
  view: null,
  calls: [],
  fail: false,
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...real,
    api: (_m: string, url: string) => {
      state.calls.push(url);
      return state.fail
        ? Promise.reject(new real.ApiError("NETWORK", 0))
        : Promise.resolve(state.view);
    },
  };
});
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <PerformanceCard />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  state.view = null;
  state.calls = [];
  state.fail = false;
});

async function axeClean() {
  const r = await axe.run(document.body, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
    rules: { "color-contrast": { enabled: false } },
  });
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

describe("How your bots performed", () => {
  it("leads with real money, splits SoDEX and DeskLabs fees and compares with the week before", async () => {
    state.view = READY;
    wrap();
    expect(await screen.findByText(/Your bots traded/)).toHaveTextContent(
      "Your bots traded 1.21M USDC and paid 259 USDC in fees and price moves.",
    );
    expect(
      screen.getByText(
        (_, el) => el?.tagName === "P" && el.textContent === "That's $214 per $1M traded",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("$38 less than the week before")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This is what trading cost, not your profit or loss. Your net result is on each bot's page. Practice bots aren't counted.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: /SoDEX fee \$106, DeskLabs builder fee \$45, price moved against your trades \$63/,
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(/\$2 more than the week before/)).toBeInTheDocument();
    // Giờ: nhãn chữ trên dải, khung giờ địa phương.
    expect(
      screen.getByRole("img", { name: /Cheapest 01:00–04:00\. Most expensive 21:00–00:00\./ }),
    ).toBeInTheDocument();
    // Bot mỏng: không có số.
    const table = screen.getByRole("table", { name: "Cost per $1M by bot" });
    expect(within(table).getByText("Not enough trades yet (12 of 30)")).toBeInTheDocument();
    expect(within(table).getByText("$291")).toBeInTheDocument();
    // Gợi ý trong cài đặt có thật, kèm %.
    expect(
      screen.getByRole("heading", { name: "Lower Max spread from 10 to 8 bp (0.10% → 0.08%)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open settings" })).toHaveAttribute(
      "href",
      "/bots/11111111-1111-4111-8111-111111111111/edit",
    );
    expect(screen.getByText("Hold time ended (random time you set)")).toBeInTheDocument();
    await axeClean();
  }, 20_000);

  it("asks the API in UTC after Show in UTC and for 30 days after the period switch", async () => {
    const user = userEvent.setup({ delay: null });
    state.view = READY;
    wrap();
    await user.click(await screen.findByRole("button", { name: "Show in UTC" }));
    await waitFor(() => {
      expect(state.calls.at(-1)).toContain("tz=UTC");
    });
    await user.click(screen.getByRole("radio", { name: "30 days" }));
    await waitFor(() => {
      expect(state.calls.at(-1)).toContain("period=30d");
    });
  });

  it("says Not available instead of $0 and never draws an hour without a price", async () => {
    state.view = {
      ...READY,
      current: cost({
        cost: null,
        priceMove: null,
        perMillion: { cost: null, sodexFee: "106", builderFee: "45", priceMove: null },
      }),
      // Kỳ trước có giao dịch nhưng thiếu giá: không nói "didn't trade then".
      previous: cost({
        cost: null,
        priceMove: null,
        perMillion: { cost: null, sodexFee: "104", builderFee: "45", priceMove: null },
      }),
      hours: hours.map((h) =>
        h.hour === 5
          ? { ...h, fills: 40, feesPerMillion: null, pricePerMillion: null, costPerMillion: null }
          : h,
      ),
    };
    wrap();
    const bar = await screen.findByRole("img", { name: /^Of Not available per \$1M/ });
    expect(bar.getAttribute("aria-label")).not.toMatch(/\$0/);
    expect(screen.getByText("Cost per $1M: Not available")).toBeInTheDocument();
    expect(screen.queryByText(/didn't trade then/)).toBeNull();
    const naHour = screen.getByTitle("05:00: Not available, 40 trades");
    expect(naHour.querySelector(".bg-accent, .border-accent")).toBeNull();
    // Cột "vs" của bot luôn có chữ.
    const table = screen.getByRole("table", { name: "Cost per $1M by bot" });
    expect(within(table).getByText("$47 less")).toBeInTheDocument();
  });

  it("shows the price helping as its own line, never a negative bar", async () => {
    state.view = {
      ...READY,
      current: cost({
        cost: "60",
        priceMove: "-40",
        perMillion: { cost: "50", sodexFee: "60", builderFee: "23", priceMove: "-33" },
      }),
    };
    wrap();
    expect(await screen.findByText("Price moved in your favour: −$33")).toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: /The price moved in your favour by \$33/ }),
    ).toBeInTheDocument();
  });

  it("shows the empty, not-enough and error states", async () => {
    state.view = {
      ...READY,
      state: "noBots",
      current: cost({ fills: 0 }),
      bots: [],
      ideas: [],
      exits: null,
    };
    wrap();
    expect(await screen.findByText("No live bots yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start a bot" })).toHaveAttribute("href", "/desk/new");
    cleanup();
    state.view = { ...READY, state: "notEnough", current: cost({ fills: 12 }) };
    wrap();
    expect(await screen.findByRole("status")).toHaveTextContent("Not enough trades yet");
    expect(screen.getByRole("img", { name: "12 of 30 trades" })).toBeInTheDocument();
    cleanup();
    state.fail = true;
    wrap();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't load how your bots performed.Your bots keep running; nothing changed.",
    );
  });
});
