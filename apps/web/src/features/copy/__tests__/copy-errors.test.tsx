// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { CopyFlowPage } from "../components/copy-flow-page";
import { TraderProfilePage } from "../components/trader-profile-page";

// Lỗi Copy / Follow không bao giờ bị nuốt (báo cáo test WinDev A1, A2; DEC-200).

const TRADER = "0xaaa0000000000000000000000000000000000001";
const state = vi.hoisted(() => ({
  following: [] as string[],
  connected: false,
  followFails: false,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined }) }));
vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title }: { title: string }) => <h1>{title}</h1>,
  Card: ({ title, children }: { title?: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));

const card = (following: boolean) => ({
  address: TRADER,
  displayName: null,
  stats: {
    profit: "84120",
    worstDip: "9800",
    typicalHoldMs: 20_400_000,
    winRate: "0.62",
    closedEpisodes: 118,
    topTradeShare: "0.18",
    coverage: "1",
    liquidations: 0,
    markets: ["BTC-USD"],
    historyIncomplete: false,
  },
  curve: [],
  tags: [],
  slot: "open",
  following,
});

vi.mock("@/lib/api", () => {
  class ApiError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      readonly details: Record<string, unknown> = {},
    ) {
      super(code);
    }
  }
  return {
    ApiError,
    api: (method: string, path: string) => {
      if (path === "/api/v1/features") return Promise.resolve({ aiDesk: true, volumeBots: false });
      if (path === "/api/v1/me")
        return Promise.resolve({ id: "u", email: "a@b.c", twoFactor: false });
      if (path === "/api/v1/sodex/connection")
        return Promise.resolve({
          connection: state.connected ? { status: "connected" } : null,
        });
      if (path === "/api/v1/following")
        return Promise.resolve({
          limit: 5,
          checkedEveryMs: 120_000,
          traders: state.following.map((address) => ({
            address,
            displayName: null,
            lastEventAt: null,
            copying: false,
            newMarkets: [],
          })),
          events: [],
          bigMoveAlerts: false,
          newMarkets: [],
        });
      if (path === `/api/v1/traders/${TRADER}`)
        return Promise.resolve({
          card: card(state.following.includes(TRADER)),
          hidden: [],
          updatedOn: "2026-11-13",
          computedAt: "2026-11-13T00:00:00Z",
          fit: [],
          events: [],
          openPositions: [],
          copyable: { ok: true, reason: null },
        });
      if (path === `/api/v1/traders/${TRADER}/follow` && method === "POST")
        return state.followFails
          ? Promise.reject(new ApiError("STATE_CONFLICT", 409, { reason: "follow_limit" }))
          : Promise.resolve({ following: true });
      if (path === "/api/v1/copy/preview") return Promise.reject(new ApiError("INTERNAL", 500));
      return new Promise(() => undefined);
    },
  };
});

const show = (ui: ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {ui}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  state.following = [];
  state.connected = false;
  state.followFails = false;
});
afterEach(() => {
  cleanup();
});

describe("Follow", () => {
  it("locks Follow at 5 of 5 and says why", async () => {
    state.following = ["0x1", "0x2", "0x3", "0x4", "0x5"];
    show(<TraderProfilePage address={TRADER} />);
    expect(
      await screen.findByText("You can follow up to 5 traders. Unfollow one to add another."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "☆ Follow" })).toBeDisabled();
  });

  it("shows the server's refusal instead of doing nothing", async () => {
    state.followFails = true;
    const user = userEvent.setup({ delay: null });
    show(<TraderProfilePage address={TRADER} />);
    await user.click(await screen.findByRole("button", { name: "☆ Follow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "You can follow up to 5 traders. Unfollow one to add another.",
    );
  });
});

describe("Copy", () => {
  it("asks to connect SoDEX on the Budget step and keeps Continue off", async () => {
    show(<CopyFlowPage leader={TRADER} />);
    expect(await screen.findByText("Connect SoDEX to copy")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect SoDEX" })).toHaveAttribute(
      "href",
      "/onboarding/connect",
    );
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
  });

  it("shows a preview error instead of a silent button", async () => {
    state.connected = true;
    show(<CopyFlowPage leader={TRADER} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong. Try again.");
    expect(screen.getByRole("button", { name: /Continue/ })).toBeDisabled();
  });
});
