// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { BotsPage } from "../components/bots-page";

// Strategy Lab (báo cáo test E21, E22; DEC-210): phí builder trên mọi thẻ, giải thích SoPoints ở thẻ
// khối lượng, khối rỗng có nút sang catalog.

const tab = vi.hoisted(() => ({ value: "catalog" }));
const flags = vi.hoisted<{
  adaptiveDca: boolean;
  builderFees: Record<string, number>;
  mmFee: unknown;
}>(() => ({
  adaptiveDca: false,
  builderFees: {},
  mmFee: null,
}));
const list = vi.hoisted(() => ({ items: [] as unknown[] }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(`tab=${tab.value}`),
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
}));
vi.mock("@/components/workspace-shell", () => ({
  WorkspaceShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("@/components/workspace", () => ({
  PageHead: ({ title, action }: { title: string; action?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {action}
    </header>
  ),
}));
vi.mock("@/lib/queries", () => ({
  useMe: () => ({ data: { role: "user" } }),
  useSodexConnection: () => ({ data: undefined, isSuccess: false, isPending: true }),
}));
vi.mock("@/lib/markets", () => ({
  useMarketNames: () =>
    Object.assign((m: string) => m, {
      market: (m: string) => m,
      asset: (a: string) => a,
      info: () => undefined,
    }),
}));
vi.mock("@/lib/use-media", () => ({ useMediaQuery: () => false }));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: (_m: string, path: string) => {
    if (path === "/api/v1/features")
      return Promise.resolve({
        volumeMaker: true,
        volumeFarm: true,
        aiDesk: false,
        adaptiveDca: flags.adaptiveDca,
        builderFees: flags.builderFees,
        mmFee: flags.mmFee,
      });
    if (path.startsWith("/api/v1/bots")) return Promise.resolve({ items: list.items });
    return new Promise(() => undefined);
  },
}));

const show = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <BotsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

afterEach(() => {
  flags.adaptiveDca = false;
  flags.builderFees = {};
  flags.mmFee = null;
  list.items = [];
  cleanup();
});

describe("Strategy Lab", () => {
  it("shows the builder fee on every catalog card and explains SoPoints on volume cards", async () => {
    tab.value = "catalog";
    show();
    // Thẻ khối lượng hiện sau khi cờ tính năng tải xong.
    const sopoints = await screen.findAllByText(/^SoPoints are SoDEX’s rewards/);
    expect(sopoints).toHaveLength(2);
    const cards = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.closest("li") as HTMLElement);
    expect(cards.length).toBe(10);
    for (const c of cards) expect(within(c).getByText(/^Builder fee /)).toBeInTheDocument();
    // Market Making: mặc định 0.003% kèm bảng 3 bậc (docs/mockups/mm-fee-tiers 2a).
    const [mmCard] = cards;
    if (mmCard === undefined) throw new Error("no Market Making card");
    expect(within(mmCard).getByText("Builder fee 0.003%")).toBeInTheDocument();
    expect(within(mmCard).getAllByRole("row")).toHaveLength(4);
  });

  it("Market Making card shows a team-set rate (0.01%) as the user's own rate, with the ladder", async () => {
    // Báo cáo "Builder fee 0.01%" trên thẻ Market Making: mức team đặt tay cho tài khoản (DEC-159), không phải lỗi.
    flags.builderFees = { volume_maker: 10 };
    flags.mmFee = { rate: 10, source: "custom", volume30d: null, nextVolume: null, nextRate: null };
    tab.value = "catalog";
    show();
    expect(
      await screen.findByText(
        "Set for your account by DeskLabs. Volume tiers don’t apply while this rate is set.",
      ),
    ).toBeInTheDocument();
    const mmCard = screen
      .getByRole("heading", { level: 2, name: "Market Making" })
      .closest("li") as HTMLElement;
    expect(within(mmCard).getByText("Your builder fee")).toBeInTheDocument();
    expect(within(mmCard).getByText("0.01%")).toBeInTheDocument();
    expect(within(mmCard).getAllByRole("row")).toHaveLength(4);
    expect(within(mmCard).queryByText("You")).not.toBeInTheDocument();
  });

  it("offers a way to the catalog when there are no bots yet", async () => {
    tab.value = "mine";
    show();
    expect(await screen.findByText("No bots yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Browse strategies" })).toHaveAttribute(
      "href",
      "/bots?tab=catalog",
    );
  });
});

describe("AI Adaptive DCA (Beta, DEC-218)", () => {
  it("shows the Beta chip, with the short note for screen readers, on its catalog card", async () => {
    flags.adaptiveDca = true;
    tab.value = "catalog";
    show();
    const heading = await screen.findByRole("heading", { level: 2, name: /^AI Adaptive DCA/ });
    expect(within(heading).getByText("Beta")).toHaveAttribute(
      "title",
      "Still being tested. Use small amounts.",
    );
    expect(heading).toHaveTextContent("Beta: Still being tested. Use small amounts.");
    // Thẻ khác không có Beta.
    const others = screen
      .getAllByRole("heading", { level: 2 })
      .filter((h) => h !== heading && within(h).queryByText("Beta") !== null);
    expect(others).toEqual([]);
  });
});

describe("paper bots in the bot list (SL-01, PB-01)", () => {
  it("shows Paper as the mode and names the rejected order as simulated", async () => {
    tab.value = "mine";
    list.items = [
      {
        id: "01a1ab7e-2236-76d7-b9a7-37aa8624c581",
        name: "Futures Grid · BTC",
        strategy: "futures_grid",
        market: "BTC-USD",
        engine: "perps",
        state: "paused",
        reasonCode: "ORDER_REJECTED",
        needsAttention: false,
        activeVersion: 1,
        netPnl: "-0.02",
        capital: "100",
        capitalUnit: "quote",
        marketLabel: null,
        fills: 1,
        waiting: null,
        mode: "paper",
        createdAt: "2026-11-05T11:35:00.000Z",
        updatedAt: "2026-11-05T11:35:36.000Z",
      },
    ];
    show();
    const row = (await screen.findByText("Futures Grid · BTC")).closest("tr") as HTMLElement;
    expect(within(row).getByText("Paper")).toBeInTheDocument();
    expect(within(row).queryByText("Mainnet")).toBeNull();
    expect(within(row).getByText("Paused: a simulated order was rejected")).toBeInTheDocument();
    expect(within(row).queryByText(/SoDEX rejected/)).toBeNull();
  });
});
