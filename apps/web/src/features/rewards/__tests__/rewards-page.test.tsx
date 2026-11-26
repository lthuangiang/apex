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
import { resetRewardsRateLimit } from "../client";
import { RewardsPage, resolveRewardsTab } from "../components/rewards-page";
import { readRewardsToken, saveRewardsToken } from "../token-store";

import { FAKE_TOKEN, MASTER, OTHER, fakeGateway, type Route, type Reply } from "./gateway-fixtures";

// Trang /rewards (#548, bản phác 08–09, trạng thái 18): công tắc tắt = Not found; chưa ký vẫn có dữ liệu công khai và
// không tự bật ví; tab SoPoints; hết hạn, đang tải, rỗng, lỗi mạng, 429, lỗi nghiệp vụ, sai ví. Gateway SoDEX, wagmi và
// API DeskLabs đều giả; không ký ví thật, không gọi endpoint thật.

const state = vi.hoisted<{
  rewards: boolean;
  master: string | null;
  wallet: string | undefined;
  tab: string;
}>(() => ({ rewards: true, master: null, wallet: undefined, tab: "" }));
const signMessage = vi.hoisted(() => vi.fn(() => Promise.resolve("0xsig")));
const connect = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const notFound = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  notFound,
  useSearchParams: () => new URLSearchParams(state.tab === "" ? "" : `tab=${state.tab}`),
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
  PageHead: ({
    title,
    subtitle,
    action,
  }: {
    title: string;
    subtitle: string;
    action?: ReactNode;
  }) => (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      {action}
    </header>
  ),
}));
vi.mock("@/lib/queries", () => ({
  useFeatures: () => ({ data: { sodexRewards: state.rewards } }),
  useMe: () => ({ data: { role: "user" } }),
  useSodexConnection: () => ({
    isPending: false,
    data: {
      connection: state.master === null ? null : { address: state.master, status: "connected" },
    },
  }),
}));
vi.mock("@/lib/api", () => ({
  ApiError: class extends Error {},
  api: () => Promise.resolve(null),
}));
vi.mock("wagmi", () => ({
  useConfig: () => ({}),
  useConnection: () => ({ address: state.wallet, isConnected: state.wallet !== undefined }),
  useSignMessage: () => ({ mutateAsync: signMessage }),
  useConnect: () => ({ mutateAsync: connect }),
  useDisconnect: () => ({ mutateAsync: () => Promise.resolve() }),
  useConnectors: () => [],
}));
vi.mock("wagmi/actions", () => ({ getConnection: () => ({ address: state.wallet }) }));

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`missing item ${String(i)}`);
  return x;
}

let gw: ReturnType<typeof fakeGateway>;
function gateway(routes: Partial<Record<Route, Reply>> = {}) {
  gw = fakeGateway(routes);
  vi.stubGlobal("fetch", gw.fn);
}

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <RewardsPage />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  state.rewards = true;
  state.master = MASTER;
  state.wallet = undefined;
  state.tab = "";
  signMessage.mockClear();
  connect.mockClear();
  notFound.mockClear();
  gateway();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
});

describe("Rewards page switch (DEC-397)", () => {
  it("switch off: the route is Not found and nothing is read from SoDEX", () => {
    state.rewards = false;
    show();
    expect(notFound).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "Rewards" })).toBeNull();
    expect(gw.fn).not.toHaveBeenCalled();
  });

  it("switch on: the page renders and is not Not found", async () => {
    show();
    expect(notFound).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: "Rewards", level: 1 })).toBeInTheDocument();
  });
});

describe("Rewards page, not signed in (mockup 08)", () => {
  it("shows the sign-in block, the This sign-in table and public data, without opening a wallet", async () => {
    show();
    expect(
      await screen.findByRole("heading", { name: "Sign in to see your SoDEX rewards" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Wallet:")).toBeInTheDocument();
    expect(screen.getByText("0x3f2a…9c4e")).toBeInTheDocument();
    for (const row of [
      "Costs gas",
      "Places trades or changes bots",
      "Withdraws or transfers funds",
      "Sent to DeskLabs servers",
    ])
      expect(screen.getByText(row)).toBeInTheDocument();
    expect(screen.getByText("Your points, tier and rank")).toBeInTheDocument();
    // Dữ liệu công khai vẫn hiện.
    const week = screen.getByRole("region", { name: "This week on SoDEX" });
    expect(await within(week).findByText("1,000,000")).toBeInTheDocument();
    expect(within(week).getByText("Week 13")).toBeInTheDocument();
    expect(within(week).getByText("LIVE")).toBeInTheDocument();
    const feed = screen.getByRole("region", { name: "Live feed" });
    expect(await within(feed).findByText("0.9945 vANT")).toBeInTheDocument();
    expect(within(feed).getByText("$110.89")).toBeInTheDocument();
    expect(within(feed).getByText("PFP")).toBeInTheDocument();
    // Không tự bật ví, không ký, không gọi endpoint cần ví, không gửi Authorization.
    expect(connect).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
    expect(gw.calls.some((c) => c.path.startsWith("sopoints/summary"))).toBe(false);
    expect(gw.calls.every((c) => c.auth === null)).toBe(true);
    // Tab Blind Boxes ẩn tới #550.
    expect(screen.queryByText("Blind Boxes")).toBeNull();
  });

  it("lists volume multipliers highest first, ties in API order, with Show all", async () => {
    const user = userEvent.setup();
    show();
    const card = screen.getByRole("region", { name: "Markets with a volume multiplier" });
    await within(card).findByText("NVDA-USD");
    const names = () =>
      within(card)
        .getAllByRole("listitem")
        .map((li) => li.querySelector("b")?.textContent);
    expect(names()).toEqual(["NVDA-USD", "GOOGL-USD", "DDD-USD", "AAA-USD"]);
    expect(within(card).getAllByText("×1.2")).toHaveLength(2);
    expect(within(card).getByText(/Set by SoDEX for round 13/)).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Show all 6 markets" }));
    expect(names()).toEqual(["NVDA-USD", "GOOGL-USD", "DDD-USD", "AAA-USD", "BBB-USD", "CCC-USD"]);
    expect(within(card).getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });

  it("not connected to SoDEX: asks to connect, public data still shows", async () => {
    state.master = null;
    show();
    expect(
      await screen.findByText("Connect your SoDEX account to see its rewards."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect SoDEX" })).toHaveAttribute(
      "href",
      "/onboarding/connect",
    );
    expect(screen.queryByRole("button", { name: "Sign with wallet" })).toBeNull();
    const week = screen.getByRole("region", { name: "This week on SoDEX" });
    expect(await within(week).findByText("1,000,000")).toBeInTheDocument();
  });

  it("no wallet connected: Sign with wallet opens the wallet list, it never auto-connects", async () => {
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Sign with wallet" }));
    expect(await screen.findByText("MetaMask")).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("wrong wallet: says so and signs nothing", async () => {
    state.wallet = OTHER;
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Sign with wallet" }));
    expect(await screen.findByText("This wallet isn't your SoDEX account")).toBeInTheDocument();
    expect(
      screen.getByText(/Connected: 0x71b0…22d1 · SoDEX account: 0x3f2a…9c4e\./),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose another wallet" })).toBeInTheDocument();
    expect(signMessage).not.toHaveBeenCalled();
    expect(gw.calls.some((c) => c.path === "auth/nonce")).toBe(false);
  });

  it("links Rules on SoDEX in a new tab", async () => {
    show();
    const link = await screen.findByRole("link", { name: "Rules on SoDEX ↗" });
    expect(link).toHaveAttribute("href", "https://sodex.com/documentation/sopoints/layer-1-season");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("LIVE only for weekStatus LIVE (any case); other values show as SoDEX sent them", async () => {
    const week = (weekStatus: string) => ({
      body: {
        code: 0,
        data: {
          weekNo: 13,
          weekName: "Week 13",
          weekStatus,
          weekPoolPoints: 1000000,
          nextWeekStartTime: 1764586800,
          distributionTime: 1764846000,
        },
      },
    });
    gateway({ "sopoints/week/info": week("live") });
    show();
    let card = screen.getByRole("region", { name: "This week on SoDEX" });
    expect(await within(card).findByText("LIVE")).toBeInTheDocument();
    cleanup();
    gateway({ "sopoints/week/info": week("ongoing") });
    show();
    card = screen.getByRole("region", { name: "This week on SoDEX" });
    expect(await within(card).findByText("ongoing")).toBeInTheDocument();
    expect(within(card).queryByText("LIVE")).toBeNull();
  });

  it("empty feed and no multipliers: say so", async () => {
    gateway({
      "lottery/feed": { body: { code: 0, data: { items: [] } } },
      "sopoints/volume-weights": {
        body: { code: 0, data: { round: { round_id: 13, end_ts_ms: 1764586800000 }, weights: [] } },
      },
    });
    show();
    expect(await screen.findByText("No big opens to show right now.")).toBeInTheDocument();
    expect(
      await screen.findByText("SoDEX lists no markets with a volume multiplier right now."),
    ).toBeInTheDocument();
  });

  it("passes axe", async () => {
    const { container } = show();
    const week = screen.getByRole("region", { name: "This week on SoDEX" });
    await within(week).findByText("1,000,000");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("Rewards page, signed in: SoPoints (mockup 09)", () => {
  beforeEach(() => {
    saveRewardsToken(MASTER, FAKE_TOKEN);
  });

  it("shows the summary, tier, rank, week tiles and weekly performance from SoDEX", async () => {
    show();
    expect(await screen.findByText("48,210")).toBeInTheDocument();
    // SoDEX không trả basePoints / boostPoints: không có Base / Boost; Referral khi có.
    expect(screen.queryByText("Base")).toBeNull();
    expect(screen.queryByText(/Boost/)).toBeNull();
    expect(screen.getByText("2,140", { selector: "b" })).toBeInTheDocument();
    // Tier là tên, hiện nguyên; nextTierPoints là ngưỡng tổng.
    expect(screen.getByText("Current tier: EPIC")).toBeInTheDocument();
    expect(screen.getByText("Next: DIAMOND at 60,000")).toBeInTheDocument();
    expect(screen.getByText("11,790 points to DIAMOND")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "80");
    expect(screen.getByText("1,284")).toBeInTheDocument();
    expect(screen.getByText("of 38,902")).toBeInTheDocument();
    expect(await screen.findByText("SoPoints shared this week")).toBeInTheDocument();
    // Weekly performance: tuần mới nhất trước; CONFIRMED → Confirmed, giá trị khác → Not final.
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((r) => within(r).getAllByRole("cell")[0]?.querySelector("b")?.textContent),
    ).toEqual(["Week 13", "Week 12"]);
    expect(within(at(rows, 0)).getByText("Not final")).toBeInTheDocument();
    expect(within(at(rows, 1)).getByText("Confirmed")).toBeInTheDocument();
    expect(within(at(rows, 0)).getByText("$84,300")).toBeInTheDocument();
    // Tuần đang chạy theo isLive; không hiện số squad (team*, totalBonusPct).
    expect(within(at(rows, 0)).getByText("LIVE")).toBeInTheDocument();
    expect(within(at(rows, 1)).queryByText("LIVE")).toBeNull();
    expect(screen.queryByText(/987,654|1,234,567/)).toBeNull();
    // Không còn khối mời ký; chip đăng nhập + Sign out of rewards.
    expect(screen.queryByRole("button", { name: "Sign with wallet" })).toBeNull();
    expect(screen.getByText("Signed in as 0x3f2a…9c4e")).toBeInTheDocument();
    // JWT chỉ đi tới gateway SoDEX trong header Authorization, không bao giờ trong URL.
    const authed = gw.calls.filter((c) => c.auth !== null);
    expect(authed.map((c) => c.path).sort()).toEqual(["sopoints/summary", "sopoints/week/list"]);
    expect(authed.every((c) => c.url.startsWith("https://mainnet-gw.sodex.dev/api/v1/"))).toBe(
      true,
    );
    expect(gw.calls.some((c) => c.url.includes(FAKE_TOKEN))).toBe(false);
    // Live feed chỉ ở trang chưa ký (tab Blind Boxes có feed ở #550).
    expect(gw.calls.some((c) => c.path === "lottery/feed")).toBe(false);
  });

  it("?tab=boxes falls back to SoPoints while Blind Boxes is hidden (#550)", async () => {
    state.tab = "boxes";
    show();
    expect(await screen.findByText("48,210")).toBeInTheDocument();
    expect(screen.queryByText("Blind Boxes")).toBeNull();
    expect(resolveRewardsTab("boxes")).toBe("sopoints");
    expect(resolveRewardsTab(null)).toBe("sopoints");
    expect(resolveRewardsTab("sopoints")).toBe("sopoints");
  });

  it("no progress bar when nextTierPoints is missing or not above the total", async () => {
    gateway({
      "sopoints/summary": {
        body: {
          code: 0,
          data: {
            totalPoints: 70000,
            currentTier: "DIAMOND",
            nextTier: "LEGEND",
            nextTierPoints: 60000,
          },
        },
      },
    });
    show();
    expect(await screen.findByText("Current tier: DIAMOND")).toBeInTheDocument();
    expect(screen.getByText("Next: LEGEND")).toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/points to/)).toBeNull();
  });

  it("missing fields show Not available, never 0", async () => {
    gateway({
      "sopoints/summary": {
        body: { code: 0, data: { totalPoints: 1200, rank: null, currentTier: null } },
      },
      "sopoints/week/list": {
        body: {
          code: 0,
          data: [
            {
              weekNo: 13,
              weekName: "Week 13",
              weekStartTime: 1763942400,
              weekEndTime: 1764547200,
            },
          ],
        },
      },
    });
    show();
    expect(await screen.findByText("1,200")).toBeInTheDocument();
    const table = await screen.findByRole("table");
    const cells = within(at(within(table).getAllByRole("row"), 1)).getAllByRole("cell");
    for (const c of cells.slice(1)) expect(c).toHaveTextContent("Not available");
    expect(screen.getAllByText("Not available").length).toBeGreaterThan(4);
    expect(screen.queryByText("0")).toBeNull();
  });

  it("no weeks yet: empty state", async () => {
    gateway({ "sopoints/week/list": { body: { code: 0, data: [] } } });
    show();
    expect(await screen.findByText("No weekly points yet")).toBeInTheDocument();
    expect(
      screen.getByText("Weeks appear after SoDEX takes its weekly snapshot."),
    ).toBeInTheDocument();
  });

  it("loading: skeleton, no numbers and no Not available", () => {
    gateway({ "sopoints/summary": "pending", "sopoints/week/list": "pending" });
    const { container } = show();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText("Not available")).toBeNull();
  });

  it("network error: Couldn't reach SoDEX rewards, Try again reads again", async () => {
    gateway({ "sopoints/summary": "network" });
    const user = userEvent.setup();
    show();
    expect(await screen.findByText("Couldn't reach SoDEX rewards.")).toBeInTheDocument();
    expect(screen.getByText("Nothing was changed. Try again in a moment.")).toBeInTheDocument();
    const before = gw.calls.filter((c) => c.path === "sopoints/summary").length;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(gw.calls.filter((c) => c.path === "sopoints/summary").length).toBeGreaterThan(before);
    });
  });

  it("429 with retryAfter: busy with a countdown, Try again disabled", async () => {
    gateway({
      "sopoints/summary": { status: 429, body: { code: 429, data: { retryAfter: 42 } } },
    });
    show();
    expect(
      await screen.findByText(/^SoDEX rewards is busy\. Try again in 4[12] s\.$/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("SoDEX limits how often one connection can ask. Auto refresh is paused."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Try again in 4[12] s$/ })).toBeDisabled();
  });

  it("429 without retryAfter: pauses but shows no number", async () => {
    gateway({ "sopoints/summary": { status: 429, body: { code: 429, msg: "busy" } } });
    show();
    expect(await screen.findByText("SoDEX rewards is busy.")).toBeInTheDocument();
    const btn = screen.getByRole("button", { name: "Try again" });
    expect(btn).toBeDisabled();
    expect(screen.queryByText(/Try again in/)).toBeNull();
    expect(screen.queryByText(/60/)).toBeNull();
  });

  it("business error: SoDEX said …", async () => {
    gateway({ "sopoints/summary": { body: { code: 1001, msg: "activity not started" } } });
    show();
    expect(await screen.findByText("SoDEX couldn't do that.")).toBeInTheDocument();
    expect(screen.getByText("SoDEX said: “activity not started”")).toBeInTheDocument();
  });

  it("expired (401): clears the token and asks to sign again", async () => {
    gateway({ "sopoints/summary": { status: 401, body: {} } });
    show();
    expect(await screen.findByText("Your rewards sign-in expired.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign again" })).toBeInTheDocument();
    expect(readRewardsToken(MASTER)).toBeNull();
  });

  it("Sign out of rewards clears the token and goes back to the sign-in block", async () => {
    const user = userEvent.setup();
    show();
    await screen.findByText("48,210");
    await user.click(screen.getByRole("button", { name: "Sign out of rewards" }));
    expect(readRewardsToken(MASTER)).toBeNull();
    expect(
      await screen.findByRole("heading", { name: "Sign in to see your SoDEX rewards" }),
    ).toBeInTheDocument();
  });

  it("passes axe", async () => {
    const { container } = show();
    await screen.findByText("48,210");
    await screen.findByRole("table");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
