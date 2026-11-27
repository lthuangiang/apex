// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import messages from "../../../../messages/en.json";
import { resetActions } from "../action-store";
import { resetRewardsRateLimit } from "../client";
import { RewardsPage } from "../components/rewards-page";
import { RewardsAlertsCard } from "../components/watch-ui";
import { saveRewardsToken } from "../token-store";

import { FAKE_TOKEN, MASTER, fakeGateway } from "./gateway-fixtures";

// #558 PR5 (DEC-398; bản phác docs/mockups/rewards/server-token/): khối đồng ý trên màn ký (mặc định bật), dải trạng thái
// active / paused / off, thẻ Settings. API DeskLabs, gateway SoDEX và wagmi đều giả; token là chuỗi giả.

interface WatchState {
  status: "off" | "active" | "paused";
  reason: string | null;
  expiresAt: string | null;
  lastCheckedAt: string | null;
  delayed: boolean;
}

const server = vi.hoisted(() => ({
  watch: null as WatchState | null | "missing",
  calls: [] as { method: string; path: string; body?: unknown; key?: string | undefined }[],
  enableFails: null as string | null,
}));
const signMessage = vi.hoisted(() => vi.fn(() => Promise.resolve("0xsig")));
const state = vi.hoisted(() => ({ wallet: undefined as string | undefined }));

vi.mock("next/navigation", () => ({
  notFound: vi.fn(),
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ replace: () => undefined, push: () => undefined }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/components/workspace", () => ({
  Workspace: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  PageHead: ({ title, action }: { title: string; action?: ReactNode }) => (
    <header>
      <h1>{title}</h1>
      {action}
    </header>
  ),
}));
vi.mock("@/lib/queries", () => ({
  useFeatures: () => ({ data: { sodexRewards: true } }),
  useMe: () => ({ data: { role: "user" } }),
  useSodexConnection: () => ({
    isPending: false,
    data: { connection: { address: MASTER, status: "connected" } },
  }),
  useNotifications: () => ({ data: { items: [], unread: 0 } }),
  NOTIFICATIONS_KEY: ["notifications"],
}));
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
    api: (
      method: string,
      path: string,
      _schema: unknown,
      options: { body?: unknown; idempotencyKey?: string } = {},
    ) => {
      server.calls.push({ method, path, body: options.body, key: options.idempotencyKey });
      if (path !== "/api/v1/rewards/watch") return Promise.resolve(null);
      if (server.watch === "missing") return Promise.reject(new ApiError("NOT_FOUND", 404));
      if (method === "POST") {
        if (server.enableFails !== null)
          return Promise.reject(new ApiError(server.enableFails, 422));
        server.watch = {
          status: "active",
          reason: null,
          expiresAt: "2026-12-11T07:02:00.000Z",
          lastCheckedAt: null,
          delayed: false,
        };
      }
      if (method === "DELETE") {
        server.watch = {
          status: "off",
          reason: null,
          expiresAt: null,
          lastCheckedAt: null,
          delayed: false,
        };
        return Promise.resolve(null);
      }
      return Promise.resolve(server.watch);
    },
  };
});
vi.mock("wagmi", () => ({
  useConfig: () => ({}),
  useConnection: () => ({ address: state.wallet, isConnected: state.wallet !== undefined }),
  useSignMessage: () => ({ mutateAsync: signMessage }),
  useConnect: () => ({ mutateAsync: () => Promise.resolve({}) }),
  useDisconnect: () => ({ mutateAsync: () => Promise.resolve() }),
  useConnectors: () => [],
  useSwitchChain: () => ({ mutateAsync: () => Promise.resolve() }),
  useSignTypedData: () => ({ mutateAsync: () => Promise.reject(new Error("not in this test")) }),
}));
vi.mock("@/lib/wagmi", () => ({
  valueChain: { id: 286623, blockExplorers: { default: { url: "https://scan.test" } } },
}));
vi.mock("wagmi/actions", () => ({ getConnection: () => ({ address: state.wallet }) }));

const OFF: WatchState = {
  status: "off",
  reason: null,
  expiresAt: null,
  lastCheckedAt: null,
  delayed: false,
};

function show(node: ReactNode = <RewardsPage />) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        {node}
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

function thisSignIn(): HTMLElement {
  const el = screen.getByRole("heading", { name: "This sign-in" }).parentElement;
  if (el === null) throw new Error("no This sign-in table");
  return el;
}

const watchCalls = () => server.calls.filter((c) => c.path === "/api/v1/rewards/watch");

beforeEach(() => {
  localStorage.clear();
  localStorage.clear();
  server.watch = OFF;
  server.calls = [];
  server.enableFails = null;
  state.wallet = undefined;
  signMessage.mockClear();
  vi.stubGlobal(
    "fetch",
    fakeGateway({
      "auth/verify": { body: { code: 0, msg: "success", data: { accessToken: FAKE_TOKEN } } },
    }).fn,
  );
});
afterEach(() => {
  cleanup();
  resetActions();
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
});

describe("sign-in consent (mockups 01 / 02)", () => {
  it("is on by default, explains what is kept and shows Yes for Sent to DeskLabs servers", async () => {
    show();
    const toggle = await screen.findByRole("switch", { name: "Tell me about new boxes" });
    expect(toggle).toBeChecked();
    expect(
      screen.getByText(/DeskLabs only uses it to read\. It never claims, opens or merges boxes\./),
    ).toBeInTheDocument();
    const table = thisSignIn();
    expect(within(table).getByText("Yes")).toBeInTheDocument();
    expect(
      within(table).getByText("Used only to read, to tell you about new boxes"),
    ).toBeInTheDocument();
  });

  it("turning it off before signing keeps the token in this browser only", async () => {
    const user = userEvent.setup();
    state.wallet = MASTER;
    show();
    await user.click(await screen.findByRole("switch", { name: "Tell me about new boxes" }));
    expect(screen.getByText(/Only this browser keeps the sign-in/)).toBeInTheDocument();
    const table = thisSignIn();
    expect(within(table).getAllByText("No")).toHaveLength(4);
    await user.click(screen.getByRole("button", { name: "Sign with wallet" }));
    await waitFor(() => {
      expect(signMessage).toHaveBeenCalled();
    });
    await screen.findByRole("tab", { name: /SoPoints/ });
    expect(watchCalls().filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("signing with it on sends the sign-in to DeskLabs once (POST with an Idempotency-Key), then shows On", async () => {
    const user = userEvent.setup();
    state.wallet = MASTER;
    show();
    await screen.findByRole("switch", { name: "Tell me about new boxes" });
    await user.click(screen.getByRole("button", { name: "Sign with wallet" }));
    await waitFor(() => {
      expect(watchCalls().filter((c) => c.method === "POST")).toHaveLength(1);
    });
    const post = watchCalls().find((c) => c.method === "POST");
    expect(post?.body).toEqual({ token: FAKE_TOKEN, address: MASTER });
    expect(post?.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await screen.findByText(/DeskLabs checks SoDEX for new boxes until/),
    ).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "New box alerts" })).toBeChecked();
    // Token chỉ tới DeskLabs trong đúng POST đó.
    const others = server.calls.filter((c) => c !== post);
    expect(JSON.stringify(others)).not.toContain(FAKE_TOKEN);
  });

  it("a failed POST keeps rewards working in this browser and says nothing was kept", async () => {
    const user = userEvent.setup();
    state.wallet = MASTER;
    server.enableFails = "REWARDS_WALLET_MISMATCH";
    show();
    await screen.findByRole("switch", { name: "Tell me about new boxes" });
    await user.click(screen.getByRole("button", { name: "Sign with wallet" }));
    expect(await screen.findByText("This sign-in is for another wallet.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /SoPoints/ })).toBeInTheDocument();
  });

  it("feature off on the server (404): no consent, Sent to DeskLabs servers stays No", async () => {
    server.watch = "missing";
    show();
    await screen.findByRole("button", { name: "Sign with wallet" });
    await waitFor(() => {
      expect(watchCalls().length).toBeGreaterThan(0);
    });
    expect(screen.queryByRole("switch", { name: "Tell me about new boxes" })).toBeNull();
    const table = thisSignIn();
    expect(within(table).getAllByText("No")).toHaveLength(4);
  });
});

describe("status strip (mockups 03 / 04 / 05)", () => {
  it("active: date from exp, settings link; turning off calls DELETE and shows Off", async () => {
    const user = userEvent.setup();
    saveRewardsToken(MASTER, FAKE_TOKEN);
    server.watch = {
      status: "active",
      reason: null,
      expiresAt: "2026-12-11T07:02:00.000Z",
      lastCheckedAt: null,
      delayed: false,
    };
    show();
    expect(
      await screen.findByText(/until Dec 11, \d\d:\d\d, when this sign-in expires/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Notification settings" })).toHaveAttribute(
      "href",
      "/settings?tab=notifications",
    );
    await user.click(screen.getByRole("switch", { name: "New box alerts" }));
    expect(
      await screen.findByText(/Off\. Nothing is kept on DeskLabs servers\. Turn on/),
    ).toBeInTheDocument();
    expect(watchCalls().filter((c) => c.method === "DELETE")).toHaveLength(1);
  });

  it("off while signed in: turning on posts the token from this tab", async () => {
    const user = userEvent.setup();
    saveRewardsToken(MASTER, FAKE_TOKEN);
    show();
    await user.click(await screen.findByRole("switch", { name: "New box alerts" }));
    await waitFor(() => {
      expect(watchCalls().filter((c) => c.method === "POST")).toHaveLength(1);
    });
  });

  it("paused: Notifications paused: sign in again, also before signing", async () => {
    server.watch = {
      status: "paused",
      reason: "expired",
      expiresAt: "2026-12-11T07:02:00.000Z",
      lastCheckedAt: null,
      delayed: false,
    };
    show();
    expect(await screen.findByText("Notifications paused: sign in again")).toBeInTheDocument();
    expect(
      screen.getByText(/expired on Dec 11, \d\d:\d\d, so DeskLabs stopped checking/),
    ).toBeInTheDocument();
  });

  it("Sign out of rewards also deletes the stored sign-in", async () => {
    const user = userEvent.setup();
    saveRewardsToken(MASTER, FAKE_TOKEN);
    server.watch = {
      status: "active",
      reason: null,
      expiresAt: "2026-12-11T07:02:00.000Z",
      lastCheckedAt: null,
      delayed: false,
    };
    show();
    await screen.findByText(/DeskLabs checks SoDEX/);
    // Sign out nằm trong menu của chip tài khoản (#575 PR 3/3).
    await user.click(screen.getByRole("button", { name: /Rewards sign-in/ }));
    await user.click(screen.getByRole("button", { name: "Sign out of rewards" }));
    await waitFor(() => {
      expect(watchCalls().filter((c) => c.method === "DELETE")).toHaveLength(1);
    });
  });

  it("has no serious axe violations (active strip)", async () => {
    saveRewardsToken(MASTER, FAKE_TOKEN);
    server.watch = {
      status: "active",
      reason: null,
      expiresAt: "2026-12-11T07:02:00.000Z",
      lastCheckedAt: null,
      delayed: false,
    };
    const { container } = show();
    await screen.findByText(/DeskLabs checks SoDEX/);
    const r = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(r.violations.filter((v) => v.impact === "serious" || v.impact === "critical")).toEqual(
      [],
    );
  });
});

describe("Settings › Notifications card (mockups 07 / 08 / 09)", () => {
  it("active: kept for the wallet, expiry, last check Not available, Turn off and delete", async () => {
    server.watch = {
      status: "active",
      reason: null,
      expiresAt: "2026-12-11T07:02:00.000Z",
      lastCheckedAt: null,
      delayed: false,
    };
    show(<RewardsAlertsCard master={MASTER} />);
    expect(await screen.findByText("Watching")).toBeInTheDocument();
    expect(screen.getByText(/keeps your rewards sign-in for 0x3f2a…9c4e/)).toBeInTheDocument();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn off and delete" })).toBeInTheDocument();
  });

  it("paused and off", async () => {
    server.watch = {
      status: "paused",
      reason: "expired",
      expiresAt: "2026-12-11T07:02:00.000Z",
      lastCheckedAt: null,
      delayed: false,
    };
    const { unmount } = show(<RewardsAlertsCard master={MASTER} />);
    expect(await screen.findByText("Paused · sign-in expired")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in again on Rewards" })).toHaveAttribute(
      "href",
      "/rewards",
    );
    unmount();
    server.watch = OFF;
    show(<RewardsAlertsCard master={MASTER} />);
    expect(
      await screen.findByText("Off. Nothing is kept on DeskLabs servers."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Turn on from Rewards" })).toBeInTheDocument();
  });

  it("renders nothing when the feature is off on the server", async () => {
    server.watch = "missing";
    const { container } = show(<RewardsAlertsCard master={MASTER} />);
    await waitFor(() => {
      expect(watchCalls().length).toBeGreaterThan(0);
    });
    expect(container).toBeEmptyDOMElement();
  });
});
