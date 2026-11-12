// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";

// Thư viện chart không tải được → vẽ SVG; một lỗi render trong chart → bỏ widget, phần còn lại vẫn dùng được.
vi.mock("lightweight-charts", () => {
  throw new Error("blocked");
});
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (_m: string, path: string, schema: { parse: (x: unknown) => unknown }) =>
    Promise.resolve(
      schema.parse(
        path.includes("/candles")
          ? {
              market: "BTC-USD",
              interval: "1h",
              items: [{ t: 1_700_000_000_000, o: "100", h: "105", l: "95", c: "101" }],
            }
          : {
              market: "BTC-USD",
              interval: "1h",
              available: false,
              source: null,
              updatedAt: null,
              bands: [],
            },
      ),
    ),
}));
vi.mock("@/lib/queries", () => ({ useMe: () => ({ data: { timezone: "UTC" } }) }));
const names = vi.hoisted(() => ({ broken: false }));
vi.mock("@/lib/markets", () => ({
  useMarketNames: () => ({
    market: (n: string) => n,
    asset: (c: string) => c,
    info: (n: string) => ({ name: n, engine: "perps" }),
    priceDigits: () => {
      if (names.broken) throw new Error("boom");
      return 2;
    },
    qtyDigits: () => 4,
  }),
}));

const { MarketChart } = await import("../components/market-chart");

afterEach(() => {
  cleanup();
});

const ui = () => (
  <QueryClientProvider client={new QueryClient()}>
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <MarketChart
        strategy="futures_grid"
        values={{ market: "BTC-USD", upperPrice: "110", lowerPrice: "90" }}
        lastPrice={null}
      />
      <input aria-label="Upper price" />
    </NextIntlClientProvider>
  </QueryClientProvider>
);

describe("MarketChart fallback (IMP-05)", () => {
  it("draws SVG candles when the chart library can't load", async () => {
    render(ui());
    await waitFor(() => {
      const el = screen.getByRole("img", { name: "Price candles with bot levels" });
      expect(el.tagName.toLowerCase()).toBe("svg");
    });
    expect(screen.getByText("Upper 110.00")).toBeInTheDocument();
  });

  it("keeps the form usable when the chart crashes", () => {
    names.broken = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(ui());
    expect(screen.queryByTestId("market-chart")).toBeNull();
    expect(screen.getByLabelText("Upper price")).toBeEnabled();
  });
});
