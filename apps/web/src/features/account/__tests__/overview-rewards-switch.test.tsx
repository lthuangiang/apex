// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { OverviewPage } from "../components/overview-page";

// Overview phương án B (DEC-397, #549): công tắc `sodexRewards` bật thì thẻ SoDEX rewards thay thẻ Trading Agent, cùng
// chỗ trong hàng Performance; tắt thì Overview như cũ (thẻ Trading Agent, không đọc SoDEX rewards).

const flags = vi.hoisted(() => ({ sodexRewards: false }));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title }: { title: string }) => <h1>{title}</h1>,
  Card: ({ title, children }: { title?: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("@/components/not-connected", () => ({
  NotConnected: () => null,
  useSodexMissing: () => false,
}));
vi.mock("@/lib/queries", () => ({
  useFeatures: () => ({ data: { sodexRewards: flags.sodexRewards } }),
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
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  // Overview đang tải: đủ để thấy thẻ nào nằm ở hàng Performance.
  api: () => new Promise(() => undefined),
}));
vi.mock("../components/charts", () => ({
  EquityChart: () => null,
  Meter: () => null,
}));
vi.mock("../components/watchlist-card", () => ({ WatchlistCard: () => null }));
vi.mock("@/features/rewards/components/rewards-card", () => ({
  RewardsCard: () => (
    <section aria-label="SoDEX rewards" className="flex-[1_1_320px]">
      rewards card
    </section>
  ),
}));

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <OverviewPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  flags.sodexRewards = false;
});

describe("Overview SoDEX rewards switch (#549)", () => {
  it("switch off: the Trading Agent card stays, no rewards card", () => {
    flags.sodexRewards = false;
    show();
    expect(screen.getByRole("heading", { name: "Trading Agent" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "SoDEX rewards" })).toBeNull();
  });

  it("switch on: the rewards card takes the Trading Agent card's place, next to Performance", () => {
    flags.sodexRewards = true;
    show();
    const rewards = screen.getByRole("region", { name: "SoDEX rewards" });
    expect(screen.queryByRole("heading", { name: "Trading Agent" })).toBeNull();
    const perf = screen.getByRole("region", { name: "Performance" });
    expect(perf.parentElement).toBe(rewards.parentElement);
    expect(perf.nextElementSibling).toBe(rewards);
  });
});
