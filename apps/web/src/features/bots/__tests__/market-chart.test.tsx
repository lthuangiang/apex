// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import type { FormValues } from "../fields";

// Chart thật vẽ canvas; jsdom không có canvas nên giả thư viện và ghi lại đường giá được tạo.
const lc = vi.hoisted(() => ({
  lines: [] as { price: number; title: string }[],
  fail: false,
  click: null as ((p: { point?: { x: number; y: number } }) => void) | null,
  primitives: 0,
  fits: 0,
}));
vi.mock("lightweight-charts", () => {
  if (lc.fail) throw new Error("no canvas");
  return {
    CandlestickSeries: {},
    LineStyle: { Dashed: 2 },
    CrosshairMode: { Normal: 0 },
    createChart: () => ({
      addSeries: () => ({
        setData: vi.fn(),
        attachPrimitive: () => {
          lc.primitives += 1;
        },
        coordinateToPrice: () => 76400.126,
        createPriceLine: (o: { price: number; title: string }) => {
          lc.lines.push(o);
          return o;
        },
        removePriceLine: (o: { price: number; title: string }) => {
          lc.lines = lc.lines.filter((x) => x !== o);
        },
      }),
      subscribeClick: (fn: (p: { point?: { x: number; y: number } }) => void) => {
        lc.click = fn;
      },
      timeScale: () => ({
        fitContent: () => {
          lc.fits += 1;
        },
      }),
      priceScale: () => ({ applyOptions: vi.fn() }),
      remove: vi.fn(),
    }),
  };
});

const calls: string[] = [];
const responses: { candles: unknown; liq: unknown } = { candles: null, liq: null };
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (_m: string, path: string, schema: { parse: (x: unknown) => unknown }) => {
    calls.push(path);
    const body = path.includes("/candles") ? responses.candles : responses.liq;
    if (body instanceof Error) return Promise.reject(body);
    return Promise.resolve(schema.parse(body));
  },
}));
vi.mock("@/lib/queries", () => ({ useMe: () => ({ data: { timezone: "UTC" } }) }));
vi.mock("@/lib/markets", () => ({
  useMarketNames: () => ({
    market: (n: string) => n,
    asset: (c: string) => c,
    info: (n: string) => ({ name: n, engine: n.includes("-") ? "perps" : "spot" }),
    priceDigits: () => 2,
    qtyDigits: () => 4,
  }),
}));

const { MarketChart } = await import("../components/market-chart");

const candles = (market: string) => ({
  market,
  interval: "1h",
  items: [
    { t: 1_700_000_000_000, o: "100", h: "105", l: "95", c: "101" },
    { t: 1_700_003_600_000, o: "101", h: "106", l: "99", c: "104" },
  ],
});
const noMap = (market: string) => ({
  market,
  interval: "1h",
  available: false,
  source: null,
  updatedAt: null,
  bands: [],
});

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>
  );
}

const grid = (over: FormValues = {}): FormValues => ({
  market: "BTC-USD",
  upperPrice: "110",
  lowerPrice: "90",
  ...over,
});

beforeEach(() => {
  calls.length = 0;
  lc.lines = [];
  responses.candles = candles("BTC-USD");
  responses.liq = noMap("BTC-USD");
  lc.click = null;
  lc.fits = 0;
});
afterEach(() => {
  cleanup();
});

describe("MarketChart (IMP-05)", () => {
  it("asks for a market first", () => {
    render(wrap(<MarketChart strategy="futures_grid" values={{}} lastPrice={null} />));
    expect(screen.getByText("Choose a market to see its chart.")).toBeInTheDocument();
    expect(calls).toEqual([]);
  });

  it("renders nothing for Rebalancing", () => {
    render(wrap(<MarketChart strategy="rebalancing" values={{}} lastPrice={null} />));
    expect(screen.queryByTestId("market-chart")).toBeNull();
  });

  // Test đầu tiên vẽ chart khi có dữ liệu (lazy import + createChart): ~0.3 s ở máy nhưng tới 5.2 s trên runner CI
  // 2 vCPU khi các package test song song; bước bấm "4h" một mình đã quá 1 s dưới tải. Nên có timeout riêng và
  // waitFor dài hơn mặc định 1 s. Không đổi timeout chung.
  it("loads candles for the chosen market and timeframe", async () => {
    const slow = { timeout: 5_000 };
    const view = render(
      wrap(<MarketChart strategy="futures_grid" values={grid()} lastPrice="100" />),
    );
    await waitFor(() => {
      expect(calls).toContain("/api/v1/markets/BTC-USD/candles?engine=perps&interval=1h");
    }, slow);
    fireEvent.click(screen.getByRole("button", { name: "4h" }));
    await waitFor(() => {
      expect(calls).toContain("/api/v1/markets/BTC-USD/candles?engine=perps&interval=4h");
    }, slow);
    responses.candles = candles("ETH-USD");
    view.rerender(
      wrap(
        <MarketChart
          strategy="futures_grid"
          values={grid({ market: "ETH-USD" })}
          lastPrice="100"
        />,
      ),
    );
    await waitFor(() => {
      expect(calls.some((c) => c.startsWith("/api/v1/markets/ETH-USD/candles"))).toBe(true);
    }, slow);
  }, 15_000);

  it("moves the dashed lines when a setting changes", async () => {
    const view = render(
      wrap(<MarketChart strategy="futures_grid" values={grid()} lastPrice="100" />),
    );
    await waitFor(() => {
      expect(lc.lines.map((l) => l.title)).toEqual(["Upper 110.00", "Lower 90.00"]);
    });
    view.rerender(
      wrap(
        <MarketChart
          strategy="futures_grid"
          values={grid({ upperPrice: "120" })}
          lastPrice="100"
        />,
      ),
    );
    await waitFor(() => {
      expect(lc.lines.map((l) => l.title)).toEqual(["Upper 120.00", "Lower 90.00"]);
    });
  });

  it("shows an error with retry when candles fail", async () => {
    responses.candles = new Error("down");
    render(wrap(<MarketChart strategy="futures_grid" values={grid()} lastPrice={null} />));
    expect(await screen.findByText("Can’t load candles from SoDEX right now.")).toBeInTheDocument();
    responses.candles = candles("BTC-USD");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(screen.queryByText("Can’t load candles from SoDEX right now.")).toBeNull();
    });
  });

  it("copies the clicked price rounded to the market tick", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(wrap(<MarketChart strategy="futures_grid" values={grid()} lastPrice={null} />));
    await waitFor(() => {
      expect(lc.click).not.toBeNull();
    });
    lc.click?.({ point: { x: 10, y: 20 } });
    expect(writeText).toHaveBeenCalledWith("76400.13");
    expect(await screen.findByText("Copied 76400.13")).toBeInTheDocument();
  });

  it("resets the zoom on request", async () => {
    render(wrap(<MarketChart strategy="futures_grid" values={grid()} lastPrice={null} />));
    await waitFor(() => {
      expect(lc.fits).toBeGreaterThan(0);
    });
    const before = lc.fits;
    fireEvent.click(await screen.findByRole("button", { name: "Reset zoom" }));
    expect(lc.fits).toBe(before + 1);
  });

  it("hides the Liquidation map tab when the server has no data", async () => {
    render(wrap(<MarketChart strategy="futures_grid" values={grid()} lastPrice={null} />));
    await screen.findByRole("img", { name: "Price candles with bot levels" });
    expect(screen.queryByRole("tab", { name: "Liquidation map" })).toBeNull();
    expect(screen.queryByText(/estimates from other exchanges/)).toBeNull();
  });

  it("shows the map with its disclaimer when a provider has data", async () => {
    responses.liq = {
      ...noMap("BTC-USD"),
      available: true,
      source: "Test provider",
      updatedAt: 1_700_000_000_000,
      bands: [
        { price: "96", value: "10" },
        { price: "104", value: "40" },
      ],
    };
    render(wrap(<MarketChart strategy="futures_grid" values={grid()} lastPrice={null} />));
    fireEvent.click(await screen.findByRole("tab", { name: "Liquidation map" }));
    expect(
      screen.getByRole("img", { name: "Estimated liquidation map with price candles" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not positions on SoDEX\. Price can pass straight through these zones\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Source: Test provider/)).toBeInTheDocument();
    expect(screen.queryByText(/support|resistance/i)).toBeNull();
  });

  it("collapses on mobile", () => {
    render(wrap(<MarketChart inline strategy="futures_grid" values={grid()} lastPrice={null} />));
    fireEvent.click(screen.getByRole("button", { name: "Hide chart" }));
    expect(screen.queryByRole("group", { name: "Timeframe" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show chart" }));
    expect(screen.getByRole("group", { name: "Timeframe" })).toBeInTheDocument();
  });
});
