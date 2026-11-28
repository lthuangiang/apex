// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { antPerps, markets } from "../../us-market/__tests__/fixtures";
import { CreateBot } from "../components/create-bot";
import { emptyValues } from "../fields";

// Form tạo bot trên market có giới hạn theo sổ lệnh (#591, bản phác màn 03, DEC-402 mục 5): bảng độ sâu + "Largest
// position" chỉ cho market trong `features.depthCapMarkets` (api quyết định) và có dòng ở `/markets/us`; câu lỗi
// `order_book_depth` của server khi Save / Start.

const page = vi.hoisted<{
  caps: string[] | undefined;
  markets: unknown;
  createError: Error | null;
}>(() => ({
  caps: ["ANT-USD"],
  markets: null,
  createError: null,
}));

vi.mock("@/lib/markets", () => ({
  useMarketNames: () => ({ asset: (a: string) => a, market: (m: string) => m }),
  useMarkets: () => ({ data: { items: [] } }),
  useMarketLast: () => ({ data: undefined }),
}));
vi.mock("../components/market-picker", () => ({
  MarketPicker: ({ value }: { value: string }) => <span>{value}</span>,
}));
vi.mock("../components/amount-lines", () => ({ AmountLines: () => null }));
vi.mock("@/components/workspace-shell", () => ({
  WorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/not-connected", () => ({
  NotConnected: () => null,
  useSodexMissing: () => false,
}));
vi.mock("@/lib/queries", () => ({
  ME_KEY: ["me"],
  useMe: () => ({ data: { role: "user", timezone: "UTC", defaultMaxLossPct: null } }),
  useFeatures: () => ({ data: { mmFee: null, depthCapMarkets: page.caps } }),
  useBuilderFeeRate: () => 10,
  useTwoFactorNeeded: () => false,
}));
vi.mock("@/lib/use-media", () => ({
  BELOW_LG: "(max-width: 1023px)",
  useMediaQuery: () => false,
}));
vi.mock("@/lib/api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/api")>();
  return {
    ApiError: actual.ApiError,
    api: (method: string, path: string) => {
      if (path === "/api/v1/markets/us") return Promise.resolve(page.markets);
      if (method === "POST" && path === "/api/v1/bots")
        return page.createError === null
          ? new Promise(() => undefined)
          : Promise.reject(page.createError);
      return new Promise(() => undefined);
    },
  };
});
vi.mock("../components/ai-params", () => ({
  AiPanel: () => null,
  useAiParameters: () => ({
    enabled: false,
    state: {
      paramSource: "manual",
      mode: "manual",
      sources: {},
      placeholders: {},
      loading: false,
      needsCapital: false,
    },
  }),
}));
vi.mock("../components/start-checks", () => ({
  CheckList: () => null,
  leverageWarning: () => null,
  useDryRunChecks: () => ({
    query: { data: undefined, error: null },
    valid: true,
    invalidKeys: [],
  }),
}));
vi.mock("../components/visual-panel", () => ({ VisualPanel: () => <div data-testid="visual" /> }));
vi.mock("../components/market-chart", () => ({
  MarketChart: () => <div data-testid="market-chart" />,
}));
vi.mock("../components/mm-markets", () => ({ MmSuggestions: () => null }));

const saveButton = () => {
  const [first] = screen.getAllByRole("button", { name: "Save draft" });
  if (first === undefined) throw new Error("no Save draft button");
  return first;
};
Element.prototype.scrollIntoView = () => undefined;
vi.setConfig({ testTimeout: 20_000 });

beforeEach(() => {
  page.caps = ["ANT-USD"];
  page.markets = markets();
  page.createError = null;
});
afterEach(() => {
  cleanup();
});

function showCreate(market = "ANT-USD", margin = "600", leverage = "2") {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <CreateBot
          strategy="futures_grid"
          preset={{ ...emptyValues("futures_grid"), market, margin, leverage }}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

describe("Create bot on a market with order book caps", () => {
  it("shows the order book panel and a fitting Largest position", async () => {
    showCreate();
    const panel = await screen.findByTestId("order-book-panel");
    expect(within(panel).getByRole("heading", { name: "ANT-USD order book" })).toBeInTheDocument();
    expect(within(panel).getByText("Thin")).toBeInTheDocument();
    expect(within(panel).getByText("$2,449.00")).toBeInTheDocument();
    expect(within(panel).getAllByText("$1,955.00")).toHaveLength(2);
    expect(
      within(panel).getByText(/^The thinner side, 10 levels\. Read \d+ s ago from SoDEX\.$/),
    ).toBeInTheDocument();
    const largest = screen.getByTestId("largest-position");
    expect(within(largest).getByText("1,200.00")).toBeInTheDocument();
    expect(
      within(largest).getByText(
        "Fits. ANT-USD allows up to 1,955.00 USDC right now. Checked again when you start.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("Make the position fit the order book")).not.toBeInTheDocument();
  });

  it("says when the position is too large and keeps Start off until it fits", async () => {
    showCreate("ANT-USD", "1000", "2");
    expect(
      await screen.findByText(
        "This position is larger than the ANT-USD order book can take: 1,955.00 USDC. Lower the investment or the leverage.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Make the position fit the order book")).toBeInTheDocument();
  });

  it("says when one side of the book is empty", async () => {
    page.markets = markets({ anthropic: [antPerps({ bookStatus: "empty" })] });
    showCreate();
    expect(
      await screen.findByText(
        "ANT-USD has no orders on one side of the order book. Try again when it trades.",
      ),
    ).toBeInTheDocument();
    expect(within(screen.getByTestId("order-book-panel")).getByText("Empty")).toBeInTheDocument();
  });

  it("shows nothing for a market the API doesn't list in depthCapMarkets (or when the list is missing)", async () => {
    page.caps = [];
    const view = showCreate();
    await screen.findByTestId("visual");
    expect(screen.queryByTestId("order-book-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("largest-position")).not.toBeInTheDocument();
    view.unmount();
    page.caps = undefined;
    showCreate();
    await screen.findByTestId("visual");
    expect(screen.queryByTestId("order-book-panel")).not.toBeInTheDocument();
  });

  it('treats depthCapMarkets ["*"] as every market', async () => {
    page.caps = ["*"];
    showCreate();
    expect(await screen.findByTestId("order-book-panel")).toBeInTheDocument();
  });

  it("shows nothing when /markets/us has no row for the market", async () => {
    page.caps = ["BTC-USD"];
    showCreate("BTC-USD");
    await screen.findByTestId("visual");
    expect(screen.queryByTestId("order-book-panel")).not.toBeInTheDocument();
  });

  it("shows the server's order book error on Save", async () => {
    const { ApiError } = await import("@/lib/api");
    page.createError = new ApiError("VALIDATION_FAILED", 400, {
      reason: "order_book_depth",
      market: "ANT-USD",
      maxPosition: "300",
    });
    const user = userEvent.setup({ delay: null });
    showCreate("ANT-USD", "100", "1");
    await screen.findByTestId("order-book-panel");
    await user.click(saveButton());
    expect(
      await screen.findByText(
        "Too large for ANT-USD's order book: max position is 300.00 USD here (the thinner side of the top 10 levels).",
      ),
    ).toBeInTheDocument();
  });

  it("shows the server's empty-book error on Save", async () => {
    const { ApiError } = await import("@/lib/api");
    page.createError = new ApiError("VALIDATION_FAILED", 400, {
      reason: "order_book_depth",
      market: "ANT-USD",
    });
    const user = userEvent.setup({ delay: null });
    showCreate("ANT-USD", "100", "1");
    await screen.findByTestId("order-book-panel");
    await user.click(saveButton());
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "ANT-USD has no orders on one side of the order book. Try again when it trades.",
    );
  });

  it("has no axe violations in the order book panel and the Largest position line", async () => {
    showCreate();
    const panel = await screen.findByTestId("order-book-panel");
    for (const el of [panel, screen.getByTestId("largest-position")]) {
      const r = await axe.run(el, { rules: { "color-contrast": { enabled: false } } });
      expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
    }
  });
});
