// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { RewardsDebugPage } from "../components/rewards-debug-page";
import { saveRewardsToken } from "../token-store";

// Trang chẩn đoán rewards (#547): chỉ team (người khác nhận Not found), chạy được cả khi công tắc REWARDS_ENABLED tắt,
// không bao giờ hiện token.

const MASTER = "0x3f2a000000000000000000000000000000009c4e";
const OTHER = "0x71b00000000000000000000000000000000022d1";
const state = vi.hoisted(() => ({
  role: "team",
  rewards: false,
  wallet: undefined as string | undefined,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title, subtitle }: { title: string; subtitle: string }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  ),
  Card: ({ title, children }: { title?: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
}));
vi.mock("@/lib/queries", () => ({
  useMe: () => ({ data: { role: state.role } }),
  useFeatures: () => ({ data: { sodexRewards: state.rewards } }),
  useSodexConnection: () => ({
    isPending: false,
    data: { connection: { address: MASTER, status: "connected" } },
  }),
}));
vi.mock("wagmi", () => ({
  useConfig: () => ({}),
  useConnection: () => ({ address: state.wallet, isConnected: state.wallet !== undefined }),
  useSignMessage: () => ({ mutateAsync: vi.fn() }),
  useConnect: () => ({ mutateAsync: vi.fn() }),
  useDisconnect: () => ({ mutateAsync: vi.fn() }),
  useConnectors: () => [],
}));
vi.mock("wagmi/actions", () => ({ getConnection: () => ({ address: state.wallet }) }));

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <RewardsDebugPage />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  state.role = "team";
  state.rewards = false;
  state.wallet = undefined;
});
afterEach(() => {
  cleanup();
});

describe("RewardsDebugPage", () => {
  it("is Not found for users who are not team", () => {
    state.role = "user";
    expect(() => renderPage()).toThrow("NEXT_NOT_FOUND");
  });

  it("works for team while the rewards switch is off", () => {
    renderPage();
    expect(screen.getByRole("heading", { name: "Rewards diagnostics" })).toBeInTheDocument();
    expect(screen.getByText(messages.rewardsDebug.switch.off)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign with wallet" })).toBeInTheDocument();
  });

  it("signed in: offers reading and sign out, never shows the token", () => {
    state.wallet = MASTER;
    saveRewardsToken(MASTER, "fake-test-value");
    const { container } = renderPage();
    expect(screen.getByRole("button", { name: "Read endpoints" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out of rewards" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("fake-test-value");
  });

  it("a different wallet clears the token and shows the approved mismatch copy after a sign attempt", async () => {
    state.wallet = OTHER;
    renderPage();
    screen.getByRole("button", { name: "Sign with wallet" }).click();
    expect(await screen.findByText("This wallet isn't your SoDEX account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose another wallet" })).toBeInTheDocument();
  });
});
