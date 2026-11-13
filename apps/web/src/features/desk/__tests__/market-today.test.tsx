// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { MarketToday } from "../components/market-today";

// Thẻ "Market today" (artboard BP-Home, DEC-TBD-desk-market): câu tất định từ số 24 giờ qua, ẩn khi không có dữ liệu.

const data = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("@/lib/api", () => ({ api: () => Promise.resolve(structuredClone(data)) }));

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <MarketToday />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
});

describe("Market today card", () => {
  it("says sideways / jumpy with the real range and links it to the user's bot kind", async () => {
    data.items = [
      { market: "ETH-USD", change: "0.4", range: "1.4", mood: "sideways", relation: "grid" },
      { market: "BTC-USD", change: "-3.1", range: "7.2", mood: "jumpy", relation: "volume" },
      { market: "vSOL_vUSDC", change: "2", range: "4", mood: null, relation: null },
    ];
    show();
    expect(
      await screen.findByText(
        "ETH is moving sideways (range 1.4% in 24 hours), which suits your grid.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("BTC is jumpy (range 7.2%), so volume bots pay more in fees today."),
    ).toBeInTheDocument();
    expect(screen.getByText("SOL moved +2% in 24 hours (range 4%).")).toBeInTheDocument();
    expect(screen.getByText("Last 24 hours on SoDEX · not a forecast")).toBeInTheDocument();
    expect(screen.queryByText("v2")).not.toBeInTheDocument();
  });

  it("hides the card without data", async () => {
    data.items = [];
    const { container } = show();
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
