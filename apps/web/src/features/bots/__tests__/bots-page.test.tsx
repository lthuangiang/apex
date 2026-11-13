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
const flags = vi.hoisted(() => ({ adaptiveDca: false }));
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
vi.mock("@/lib/queries", () => ({ useMe: () => ({ data: { role: "user" } }) }));
vi.mock("@/lib/markets", () => ({ useMarketNames: () => (m: string) => m }));
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
        builderFees: {},
      });
    if (path.startsWith("/api/v1/bots")) return Promise.resolve({ items: [] });
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

describe("AI Adaptive DCA (Beta, DEC-TBD-adaptive-dca-beta)", () => {
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
