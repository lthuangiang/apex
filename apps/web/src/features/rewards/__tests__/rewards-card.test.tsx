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
import { RewardsCard } from "../components/rewards-card";
import { readRewardsToken, saveRewardsToken } from "../token-store";

import { FAKE_TOKEN, MASTER, OTHER, fakeGateway, type Reply, type Route } from "./gateway-fixtures";

// Thẻ SoDEX rewards trên Overview (#549, bản phác 02–06): chưa ký, đã ký, dòng job, hết hạn, lỗi mạng, 429, đang tải.
// Claim mở popup tại chỗ (#551). Gateway SoDEX, wagmi và API DeskLabs đều giả; không ký ví thật.

const state = vi.hoisted<{ master: string | null; wallet: string | undefined }>(() => ({
  master: null,
  wallet: undefined,
}));
const signMessage = vi.hoisted(() => vi.fn(() => Promise.resolve("0xsig")));
const connect = vi.hoisted(() => vi.fn(() => Promise.resolve({})));

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/queries", () => ({
  useSodexConnection: () => ({
    isPending: false,
    data: {
      connection: state.master === null ? null : { address: state.master, status: "connected" },
    },
  }),
  // #558: thông báo server (nguồn popup khi watch active); api giả trả null = tính năng tắt.
  useNotifications: () => ({ data: undefined }),
  NOTIFICATIONS_KEY: ["notifications"],
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
  useSwitchChain: () => ({ mutateAsync: () => Promise.resolve() }),
  useSignTypedData: () => ({ mutateAsync: () => Promise.reject(new Error("not in this test")) }),
}));
vi.mock("@/lib/wagmi", () => ({ valueChain: { id: 286623 } }));
vi.mock("wagmi/actions", () => ({ getConnection: () => ({ address: state.wallet }) }));

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
        <RewardsCard />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const card = () => screen.getByRole("region", { name: "SoDEX rewards" });

beforeEach(() => {
  localStorage.clear();
  state.master = MASTER;
  state.wallet = undefined;
  signMessage.mockClear();
  connect.mockClear();
  gateway();
});
afterEach(() => {
  cleanup();
  resetActions();
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
});

describe("SoDEX rewards card, not signed in (mockup 02)", () => {
  it("shows week, LIVE, pool, next distribution, the top multiplier and the sign-in row", async () => {
    show();
    expect(await within(card()).findByText("Week 13")).toBeInTheDocument();
    expect(within(card()).getByText("LIVE")).toBeInTheDocument();
    expect(within(card()).getByText("Weekly pool 1,000,000 SoPoints")).toBeInTheDocument();
    expect(within(card()).getByText("Next distribution")).toBeInTheDocument();
    // Hệ số cao nhất trước, bằng nhau theo thứ tự API: NVDA (1.2) trước GOOGL (1.20).
    expect(await within(card()).findByText("NVDA-USD ×1.2")).toBeInTheDocument();
    expect(within(card()).getByText("+5 more")).toBeInTheDocument();
    expect(within(card()).getByText("Sign in to see your points and boxes")).toBeInTheDocument();
    expect(
      within(card()).getByText("One signature, no gas. It can't trade, withdraw or transfer."),
    ).toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: "Sign with wallet" })).toBeInTheDocument();
    expect(within(card()).getByRole("link", { name: "Go to Rewards →" })).toHaveAttribute(
      "href",
      "/rewards",
    );
    expect(connect).not.toHaveBeenCalled();
    expect(gw.calls.every((c) => c.auth === null)).toBe(true);
  });

  it("Sign with wallet without a wallet opens the wallet list, never auto-connects", async () => {
    const user = userEvent.setup();
    show();
    await user.click(await within(card()).findByRole("button", { name: "Sign with wallet" }));
    expect(await within(card()).findByText("MetaMask")).toBeInTheDocument();
    expect(connect).not.toHaveBeenCalled();
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("wrong wallet: says so, signs nothing", async () => {
    state.wallet = OTHER;
    const user = userEvent.setup();
    show();
    await user.click(await within(card()).findByRole("button", { name: "Sign with wallet" }));
    expect(
      await within(card()).findByText("This wallet isn't your SoDEX account"),
    ).toBeInTheDocument();
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("loading: skeleton only", () => {
    gateway({ "sopoints/week/info": "pending" });
    const { container } = show();
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText("Not available")).toBeNull();
  });

  it("network error: Couldn't reach SoDEX rewards with Try again", async () => {
    gateway({ "sopoints/week/info": "network" });
    const user = userEvent.setup();
    show();
    expect(await within(card()).findByText("Couldn't reach SoDEX rewards.")).toBeInTheDocument();
    const before = gw.calls.filter((c) => c.path === "sopoints/week/info").length;
    await user.click(within(card()).getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(gw.calls.filter((c) => c.path === "sopoints/week/info").length).toBeGreaterThan(
        before,
      );
    });
  });

  it("passes axe", async () => {
    const { container } = show();
    await within(card()).findByText("NVDA-USD ×1.2");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});

describe("SoDEX rewards card, signed in (mockups 03, 04, 06)", () => {
  beforeEach(() => {
    saveRewardsToken(MASTER, FAKE_TOKEN);
  });

  it("shows points, tier, rank, boxes to claim (number only), backpack, this week and Open Rewards", async () => {
    show();
    expect(await within(card()).findByText("48,210")).toBeInTheDocument();
    expect(within(card()).getByText("EPIC · Rank 1,284 of 38,902")).toBeInTheDocument();
    const row = (label: string) => within(card()).getByText(label).closest("li") as HTMLElement;
    await waitFor(() => {
      expect(row("Blind Boxes to claim")).toHaveTextContent("3");
    });
    // Claim mở popup tại chỗ (bản phác 07, #551).
    expect(
      within(row("Blind Boxes to claim")).getByRole("button", { name: "Claim" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(row("Boxes in backpack")).toHaveTextContent("27");
    });
    // Hình box 26 px cạnh nhãn (#575 PR 3/3, bản phác polish 08): box chờ claim = Mystery; backpack = cấp cao nhất đang có.
    const claimArt = row("Blind Boxes to claim").querySelector("svg.bx");
    expect(claimArt?.getAttribute("data-kind")).toBe("mystery");
    expect(claimArt).toHaveAttribute("width", "26");
    const bagArt = row("Boxes in backpack").querySelector("svg.bx");
    expect(bagArt).toHaveAttribute("width", "26");
    expect(bagArt?.getAttribute("data-kind")).toBe("rare");
    expect(bagArt).toHaveAttribute("aria-hidden", "true");
    // #601: tuần đang chạy hiện hai số riêng Spot / Perps (không cộng), không điểm, không chip.
    await waitFor(() => {
      expect(row("This week")).toHaveTextContent("Spot $1,920.00");
    });
    expect(row("This week")).toHaveTextContent("Perps $84,300.00");
    expect(row("This week")).not.toHaveTextContent("$86,220.00");
    expect(row("This week").querySelector("svg.bx")).toBeNull();
    expect(row("This week")).not.toHaveTextContent("2,140");
    expect(within(card()).queryByText("In progress")).toBeNull();
    expect(within(card()).getByRole("link", { name: "Open Rewards" })).toHaveAttribute(
      "href",
      "/rewards",
    );
    expect(gw.calls.find((c) => c.path === "lottery/jobs")?.url).toContain("active=true");
    expect(gw.calls.some((c) => c.url.includes(FAKE_TOKEN))).toBe(false);
  });

  it("next box (#601 / DEC-405): with 0 boxes to claim, shows Trade {amount} more from lottery/progress on the lottery host", async () => {
    gateway({
      "lottery/treasures": {
        body: {
          code: 0,
          msg: "ok",
          data: { total: 0, maxPerOpen: 100, bySource: {}, lifetime: null },
        },
      },
    });
    show();
    expect(
      await within(card()).findByText("Trade $1,234.50 more to unlock your next Blind Box"),
    ).toBeInTheDocument();
    const call = gw.calls.find((c) => c.path === "lottery/progress");
    expect(call?.url.startsWith("https://mainnet-lottery.sodex.dev/")).toBe(true);
    expect(call?.auth).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it("next box: hidden while there are boxes to claim (not even read)", async () => {
    show();
    const row = (label: string) => within(card()).getByText(label).closest("li") as HTMLElement;
    await waitFor(() => {
      expect(row("Blind Boxes to claim")).toHaveTextContent("3");
    });
    expect(within(card()).queryByText(/more to unlock your next Blind Box/)).toBeNull();
    expect(gw.calls.some((c) => c.path === "lottery/progress")).toBe(false);
  });

  it.each([
    ["an HTTP error", { status: 500, body: {} }],
    ["a business error", { body: { code: 7, msg: "nope" } }],
    ["a missing toNextBoxU", { body: { code: 0, msg: "ok", data: { effectiveU: "10" } } }],
    ["a malformed toNextBoxU", { body: { code: 0, msg: "ok", data: { toNextBoxU: "soon" } } }],
  ])("next box: hidden on %s, never 0 or an old number", async (_name, reply) => {
    gateway({
      "lottery/treasures": {
        body: {
          code: 0,
          msg: "ok",
          data: { total: 0, maxPerOpen: 100, bySource: {}, lifetime: null },
        },
      },
      "lottery/progress": reply,
    });
    show();
    await waitFor(() => {
      expect(gw.calls.some((c) => c.path === "lottery/progress")).toBe(true);
    });
    expect(within(card()).queryByText(/more to unlock your next Blind Box/)).toBeNull();
    expect(within(card()).queryByText(/\$0\.00 more/)).toBeNull();
  });

  it("this week: a missing field shows Not provided for that field only", async () => {
    gateway({
      "sopoints/week/list": {
        body: {
          code: 0,
          msg: "ok",
          data: [
            {
              weekNo: 13,
              weekName: "Week 13",
              status: "LIVE",
              isLive: true,
              weekStartTime: 1763942400,
              weekEndTime: 1764547200,
              spotVolume: 0,
              futuresVolume: null,
              points: 0,
              pointsStatus: "PENDING",
            },
          ],
        },
      },
    });
    show();
    const row = (label: string) => within(card()).getByText(label).closest("li") as HTMLElement;
    await waitFor(() => {
      expect(row("This week")).toHaveTextContent("Spot $0.00");
    });
    expect(row("This week")).toHaveTextContent("Perps Not provided");
  });

  it("job line: newest running job, +1 more, View reopens the popup", async () => {
    gateway({
      "lottery/jobs": {
        body: {
          code: 0,
          data: {
            jobs: [
              { jobId: 88230, kind: "box_merge", status: "pending" },
              { jobId: 88231, kind: "box_open", status: "pending" },
              { jobId: 88229, kind: "box_open", status: "revealed" },
            ],
          },
        },
      },
    });
    show();
    expect(await within(card()).findByText("Job #88231 · recording on-chain")).toBeInTheDocument();
    expect(within(card()).getByText("+1 more")).toBeInTheDocument();
    // View mở lại popup ở bước job (#551).
    await userEvent.setup().click(within(card()).getByRole("button", { name: "View" }));
    expect(await screen.findByRole("dialog", { name: "Opening boxes…" })).toBeInTheDocument();
    expect(screen.getByText("Picked up an open that was still running")).toBeInTheDocument();
  });

  it("job line uses the singular for one box", async () => {
    gateway({
      "lottery/jobs": {
        body: {
          code: 0,
          data: {
            jobs: [{ jobId: 9, kind: "box_open", status: "pending", boxes: [{ tokenId: 1 }] }],
          },
        },
      },
    });
    show();
    expect(await within(card()).findByText("Opening 1 box…")).toBeInTheDocument();
    expect(within(card()).queryByText(/\+\d+ more/)).toBeNull();
    cleanup();
    gateway({
      "lottery/jobs": {
        body: {
          code: 0,
          data: {
            jobs: [
              {
                jobId: 10,
                kind: "treasure_open",
                status: "submitting",
                minted: [
                  { tokenId: 1, level: "Common" },
                  { tokenId: 2, level: "Common" },
                ],
              },
            ],
          },
        },
      },
    });
    show();
    expect(await screen.findByText("Claiming 2 boxes…")).toBeInTheDocument();
    expect(screen.getByText("Job #10 · sent to SoDEX")).toBeInTheDocument();
  });

  it("no job: no job line", async () => {
    show();
    await within(card()).findByText("48,210");
    expect(within(card()).queryByRole("button", { name: "View" })).toBeNull();
  });

  it("missing fields show Not available, never 0", async () => {
    gateway({
      "sopoints/summary": { body: { code: 0, data: { totalPoints: 48210 } } },
      "lottery/treasures": "network",
    });
    show();
    expect(await within(card()).findByText("48,210")).toBeInTheDocument();
    const row = within(card()).getByText("Blind Boxes to claim").closest("li") as HTMLElement;
    await waitFor(() => {
      expect(row).toHaveTextContent("Not available");
    });
    expect(within(row).queryByText("0")).toBeNull();
  });

  it("429 with retryAfter: busy, countdown, Try again disabled", async () => {
    gateway({ "sopoints/summary": { status: 429, body: { code: 429, data: { retryAfter: 42 } } } });
    show();
    expect(
      await within(card()).findByText(/^SoDEX rewards is busy\. Try again in 4[12] s\.$/),
    ).toBeInTheDocument();
    expect(
      within(card()).getByText(
        "SoDEX limits how often one connection can ask. Auto refresh is paused.",
      ),
    ).toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: /^Try again in 4[12] s$/ })).toBeDisabled();
  });

  it("429 without retryAfter: no number", async () => {
    gateway({ "sopoints/summary": { status: 429, body: { code: 429 } } });
    show();
    expect(await within(card()).findByText("SoDEX rewards is busy.")).toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: "Try again" })).toBeDisabled();
    expect(within(card()).queryByText(/Try again in/)).toBeNull();
  });

  it("network error with nothing to show: Couldn't reach SoDEX rewards", async () => {
    gateway({ "sopoints/summary": "network" });
    show();
    expect(await within(card()).findByText("Couldn't reach SoDEX rewards.")).toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("expired (401): token cleared, banner, Sign again and Go to Rewards (mockup 05)", async () => {
    gateway({ "lottery/boxes": { status: 401, body: {} } });
    show();
    // Thẻ vẽ lại (đã ký → chưa ký): đọc lại vùng sau khi đổi, không giữ phần tử cũ.
    expect(await screen.findByText("Your rewards sign-in expired.")).toBeInTheDocument();
    expect(within(card()).getByRole("button", { name: "Sign again" })).toBeInTheDocument();
    expect(within(card()).getByRole("link", { name: "Go to Rewards →" })).toBeInTheDocument();
    expect(readRewardsToken(MASTER)).toBeNull();
  });

  it("passes axe", async () => {
    const { container } = show();
    await within(card()).findByText("48,210");
    await within(card()).findByText("Spot $1,920.00");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
