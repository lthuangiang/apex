// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import messages from "../../../../messages/en.json";
import { SignOutButton } from "../../../components/sign-out";
import { RewardsError, resetRewardsRateLimit } from "../client";
import { readRewardsToken, saveRewardsToken } from "../token-store";
import { useRewardsAuth } from "../use-rewards-auth";

// Hook đăng nhập rewards (#547): token bị xoá khi SoDEX trả 401, khi đổi ví, khi Sign out of rewards và khi đăng xuất
// DeskLabs. wagmi và kết nối SoDEX là giả.

const MASTER = "0x3f2a000000000000000000000000000000009c4e";
const OTHER = "0x71b00000000000000000000000000000000022d1";

const wallet = vi.hoisted(() => ({ address: undefined as string | undefined }));

vi.mock("wagmi", () => ({
  useConfig: () => ({}),
  useConnection: () => ({ address: wallet.address, isConnected: wallet.address !== undefined }),
  useSignMessage: () => ({ mutateAsync: vi.fn() }),
  useDisconnect: () => ({ mutateAsync: () => Promise.resolve() }),
}));
vi.mock("wagmi/actions", () => ({ getConnection: () => ({ address: wallet.address }) }));
vi.mock("@/lib/queries", () => ({
  useSodexConnection: () => ({
    isPending: false,
    data: { connection: { address: MASTER, status: "connected" } },
  }),
}));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: () => Promise.resolve(null),
}));

beforeEach(() => {
  localStorage.clear();
  wallet.address = undefined;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
});

describe("useRewardsAuth", () => {
  it("HTTP 401 from SoDEX clears the token and marks the sign-in expired", async () => {
    saveRewardsToken(MASTER, "fake-test-value");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("{}", { status: 401 }))),
    );
    const { result } = renderHook(() => useRewardsAuth());
    expect(result.current.signedIn).toBe(true);
    await act(async () => {
      await expect(
        result.current.authed({ path: "sopoints/summary", schema: z.unknown() }),
      ).rejects.toBeInstanceOf(RewardsError);
    });
    expect(readRewardsToken(MASTER)).toBeNull();
    expect(result.current.signedIn).toBe(false);
    expect(result.current.expired).toBe(true);
  });

  it("switching the wallet to another address clears the token", async () => {
    saveRewardsToken(MASTER, "fake-test-value");
    wallet.address = MASTER;
    const { result, rerender } = renderHook(() => useRewardsAuth());
    expect(result.current.signedIn).toBe(true);
    wallet.address = OTHER;
    rerender();
    await waitFor(() => {
      expect(readRewardsToken(MASTER)).toBeNull();
    });
  });

  it("drops tokens of any other wallet left in this tab", () => {
    saveRewardsToken(OTHER, "fake-test-value");
    renderHook(() => useRewardsAuth());
    expect(readRewardsToken(OTHER)).toBeNull();
  });

  it("Sign out of rewards clears the token", () => {
    saveRewardsToken(MASTER, "fake-test-value");
    const { result } = renderHook(() => useRewardsAuth());
    act(() => {
      result.current.signOut();
    });
    expect(readRewardsToken(MASTER)).toBeNull();
  });
});

describe("DeskLabs sign out", () => {
  it("clears every rewards token in the tab", async () => {
    saveRewardsToken(MASTER, "fake-test-value");
    const assign = vi.fn();
    vi.stubGlobal("location", { pathname: "/", assign });
    const wrap = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          {children}
        </NextIntlClientProvider>
      </QueryClientProvider>
    );
    render(<SignOutButton />, { wrapper: wrap });
    await userEvent.setup().click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/signin");
    });
    expect(readRewardsToken(MASTER)).toBeNull();
  });
});
