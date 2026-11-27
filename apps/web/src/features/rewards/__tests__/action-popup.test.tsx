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
import { ActionHost } from "../components/action-popup";
import { BoxesTab } from "../components/boxes-tab";
import { saveRewardsToken } from "../token-store";
import { useRewardsAuth } from "../use-rewards-auth";

import { FAKE_TOKEN, MASTER, OTHER, fakeGateway, type Reply } from "./gateway-fixtures";

// Popup Claim / Open / Merge (#551, bản phác 15–18): xác nhận → ví ký (giả) → xử lý theo job → kết quả → lỗi; box cũ
// trước, gửi tăng dần; POST không rõ không gửi lại; job trước còn chạy; job failed → Try again lấy sign-params mới; đóng
// popup giữa chừng → dải "xong". Ví, chữ ký và gateway SoDEX đều giả; không có chữ ký hay giao dịch thật.

const state = vi.hoisted<{
  master: string | null;
  wallet: string | undefined;
  /** Ví đọc lúc bấm ký (getConnection); khác `wallet` để thử ví vừa đổi sang địa chỉ khác. */
  signer: string | undefined;
}>(() => ({ master: null, wallet: undefined, signer: undefined }));
const signMessage = vi.hoisted(() => vi.fn(() => Promise.resolve("0xsig")));
const connect = vi.hoisted(() => vi.fn(() => Promise.resolve({})));
const signTyped = vi.hoisted(() =>
  vi.fn<(td: unknown) => Promise<string>>(() => Promise.resolve("0xsig")),
);

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
  useSignTypedData: () => ({ mutateAsync: signTyped }),
}));
vi.mock("@/lib/wagmi", () => ({ valueChain: { id: 286623 } }));
vi.mock("wagmi/actions", () => ({
  getConnection: () => ({ address: state.signer ?? state.wallet, chainId: 286623 }),
}));

let gw: ReturnType<typeof fakeGateway>;
function gateway(routes: Partial<Record<string, Reply>> = {}) {
  gw = fakeGateway(routes);
  vi.stubGlobal("fetch", gw.fn);
}

function Tab() {
  const auth = useRewardsAuth();
  return (
    <>
      <BoxesTab session={auth} tz="UTC" />
      <ActionHost auth={auth} />
    </>
  );
}

function show() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
        <Tab />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
}

const ok = (data: unknown) => ({ body: { code: 0, msg: "ok", data } });
const SIGN_DATA = {
  chainId: 286623,
  verifyingContract: "0x00000000000000000000000000000000000000aa",
  domainName: "TreasureBox",
  domainVersion: "1",
  primaryType: "RequestOpen",
  nonce: "7",
  deadline: 1764600000,
};
const SIGN = ok(SIGN_DATA);
const posts = (path: string) => gw.calls.filter((c) => c.path === path && c.method === "POST");

/** Job đọc lần lượt theo `statuses` (lần cuối giữ nguyên). */
function jobRoute(base: Record<string, unknown>, statuses: string[]): Reply {
  let i = 0;
  return () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    return Promise.resolve(
      new Response(JSON.stringify({ code: 0, data: { ...base, status } }), { status: 200 }),
    );
  };
}

beforeEach(() => {
  sessionStorage.clear();
  state.master = MASTER;
  state.wallet = MASTER;
  state.signer = undefined;
  signTyped.mockClear();
  saveRewardsToken(MASTER, FAKE_TOKEN);
  gateway();
});
afterEach(() => {
  cleanup();
  resetActions();
  vi.unstubAllGlobals();
  resetRewardsRateLimit();
});

async function openCommon(user: ReturnType<typeof userEvent.setup>, n: number) {
  const card = (await screen.findAllByText(/Merge 10 → 1/))[0]?.closest("li") as HTMLElement;
  for (let i = 1; i < n; i++)
    await user.click(within(card).getByRole("button", { name: "More boxes to open" }));
  await user.click(within(card).getByRole("button", { name: `Open ${String(n)}` }));
}

describe("Claim (mockup 15)", () => {
  it("confirm → treasure/open with count, no wallet signature → job → boxes claimed", async () => {
    gateway({
      "lottery/treasure/open": ok({ jobId: 900, kind: "treasure", status: "submitting" }),
      "lottery/job/900": jobRoute(
        {
          jobId: 900,
          kind: "treasure",
          minted: [
            { tokenId: 201640, level: "Common" },
            { tokenId: 201641, level: "Common" },
            { tokenId: 201642, level: "Uncommon" },
          ],
        },
        ["pending", "revealed"],
      ),
    });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Claim all 3" }));
    const dialog = await screen.findByRole("dialog", { name: "Claim 3 boxes" });
    expect(
      within(dialog).getByText(
        "They go into your backpack and SoDEX shows each level. No wallet signature needed.",
      ),
    ).toBeInTheDocument();
    expect((await axe.run(dialog)).violations).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "Claim 3" }));
    expect(await screen.findByRole("dialog", { name: "Claiming 3 boxes" })).toBeInTheDocument();
    expect(screen.getByText("Job #900")).toBeInTheDocument();
    expect(screen.getByText("Minting your boxes").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(
      await screen.findByRole("dialog", { name: "3 boxes claimed" }, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("#201642")).toBeInTheDocument();
    expect(signTyped).not.toHaveBeenCalled();
    expect(posts("lottery/treasure/open").map((c) => JSON.parse(c.body) as unknown)).toEqual([
      { count: 3 },
    ]);
  }, 15_000);

  it("failed claim: SoDEX said … and no resend", async () => {
    gateway({
      "lottery/treasure/open": { body: { code: 3, msg: "no treasure available" } },
    });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Claim 1" }));
    await user.click(await screen.findByRole("button", { name: "Claim 1" }));
    expect(await screen.findByRole("dialog", { name: "Claim failed" })).toBeInTheDocument();
    expect(screen.getByText("SoDEX said: “no treasure available”")).toBeInTheDocument();
    expect(
      screen.getByText("Nothing was claimed. Your count refreshes from SoDEX."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(posts("lottery/treasure/open")).toHaveLength(1);
  });
});

describe("Open (mockup 16)", () => {
  it("picks the oldest boxes, signs RequestOpen once, sends token IDs ascending, reveals rewards", async () => {
    gateway({
      "lottery/box/sign-params": SIGN,
      "lottery/box/open": ok({ jobId: 88231, kind: "open", status: "submitting" }),
      "lottery/job/88231": jobRoute(
        {
          jobId: 88231,
          kind: "open",
          boxes: [
            {
              tokenId: 188540,
              rewardUsd: "5.07",
              reward: { asset: { address: "0x1", symbol: "vANT", decimals: 18 }, amount: "0.0612" },
            },
            {
              tokenId: 201640,
              rewardUsd: "12.40",
              reward: {
                asset: { address: "0x2", symbol: "vsoUSDC", decimals: 6 },
                amount: "12.40",
              },
            },
          ],
        },
        ["revealed"],
      ),
    });
    const user = userEvent.setup();
    show();
    await openCommon(user, 2);
    const dialog = await screen.findByRole("dialog", { name: "Open 2 Common boxes" });
    expect(within(dialog).getByText("Uses your oldest Common boxes first.")).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByText(/^#\d+$/)
        .map((e) => e.textContent),
    ).toEqual(["#188540", "#201640"]);
    expect(
      within(dialog).getByText("What's inside is decided by SoDEX when the box opens."),
    ).toBeInTheDocument();
    // Fixture meta không có rewardBands → không có dòng Reward range (#575).
    expect(within(dialog).queryByText("Reward range · set by SoDEX")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Sign and open" }));
    expect(
      await screen.findByRole("dialog", { name: "2 boxes opened" }, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(signTyped).toHaveBeenCalledTimes(1);
    const td = signTyped.mock.calls[0]?.[0] as { primaryType: string; message: unknown };
    expect(td.primaryType).toBe("RequestOpen");
    expect(td.message).toEqual({
      owner: MASTER,
      tokenIds: [188540n, 201640n],
      nonce: 7n,
      deadline: 1764600000n,
    });
    expect(posts("lottery/box/open").map((c) => JSON.parse(c.body) as unknown)).toEqual([
      { tokenIds: [188540, 201640], nonce: "7", deadline: 1764600000, signature: "0xsig" },
    ]);
    expect(screen.getByText("0.0612 vANT")).toBeInTheDocument();
    expect(
      await screen.findByText(
        "USD values are at open time, from SoDEX. Rewards were paid to your SoDEX account.",
        undefined,
        { timeout: 3000 },
      ),
    ).toBeInTheDocument();
    // Reduced motion: thẻ chỉ mờ dần.
    expect(screen.getByText("0.0612 vANT").closest("li")?.className).toContain(
      "motion-reduce:animate-[rw-fade",
    );
  });

  it("signs only when verifyingContract matches lottery/meta contracts.treasureBox (any case)", async () => {
    gateway({
      "lottery/box/sign-params": SIGN,
      "lottery/box/open": ok({ jobId: 62, kind: "open", status: "submitting" }),
      "lottery/job/62": jobRoute({ jobId: 62, kind: "open" }, ["pending"]),
    });
    const user = userEvent.setup();
    show();
    await openCommon(user, 1);
    await user.click(await screen.findByRole("button", { name: "Sign and open" }));
    expect(await screen.findByText("Job #62")).toBeInTheDocument();
    expect(signTyped).toHaveBeenCalledTimes(1);
  });

  for (const [name, meta] of [
    [
      "a different contract",
      ok({
        contracts: { treasureBox: "0x00000000000000000000000000000000000000ff" },
        rules: { mergeSize: {}, limits: { maxTreasureOpen: 1, maxBoxOpen: 1 } },
      }),
    ],
    [
      "no treasureBox in meta",
      ok({ rules: { mergeSize: {}, limits: { maxTreasureOpen: 1, maxBoxOpen: 1 } } }),
    ],
    ["meta unreachable", "network"],
  ] as const) {
    it(`does not sign or send with ${name}`, async () => {
      gateway({ "lottery/box/sign-params": SIGN, "lottery/meta": meta });
      const user = userEvent.setup();
      show();
      await openCommon(user, 1);
      await user.click(await screen.findByRole("button", { name: "Sign and open" }));
      expect(await screen.findByRole("dialog", { name: "Open failed" })).toBeInTheDocument();
      expect(screen.getByText("SoDEX couldn't do that.")).toBeInTheDocument();
      expect(signTyped).not.toHaveBeenCalled();
      expect(posts("lottery/box/open")).toHaveLength(0);
    });
  }

  it("wallet rejection goes back to confirm, nothing sent", async () => {
    signTyped.mockImplementationOnce(() =>
      Promise.reject(
        Object.assign(new Error("User rejected"), { name: "UserRejectedRequestError" }),
      ),
    );
    gateway({ "lottery/box/sign-params": SIGN });
    const user = userEvent.setup();
    show();
    await openCommon(user, 1);
    await user.click(await screen.findByRole("button", { name: "Sign and open" }));
    expect(await screen.findByRole("button", { name: "Sign and open" })).toBeInTheDocument();
    expect(posts("lottery/box/open")).toHaveLength(0);
  });

  it("wrong wallet: says so, asks nothing from SoDEX, signs nothing", async () => {
    state.signer = OTHER;
    const user = userEvent.setup();
    show();
    await openCommon(user, 1);
    await user.click(await screen.findByRole("button", { name: "Sign and open" }));
    expect(await screen.findByText("This wallet isn't your SoDEX account")).toBeInTheDocument();
    expect(gw.calls.some((c) => c.path === "lottery/box/sign-params")).toBe(false);
    expect(signTyped).not.toHaveBeenCalled();
  });

  it("network error / timeout on POST: no resend, follows the job from jobs?active=true", async () => {
    gateway({
      "lottery/box/sign-params": SIGN,
      "lottery/box/open": "network",
      "lottery/jobs": ok({ jobs: [{ jobId: 77, kind: "open", status: "pending" }] }),
      "lottery/job/77": jobRoute({ jobId: 77, kind: "open" }, ["pending"]),
    });
    const user = userEvent.setup();
    show();
    await openCommon(user, 1);
    await user.click(await screen.findByRole("button", { name: "Sign and open" }));
    expect(await screen.findByText("Job #77")).toBeInTheDocument();
    expect(posts("lottery/box/open")).toHaveLength(1);
    expect(signTyped).toHaveBeenCalledTimes(1);
  });

  it("unknown outcome and no running job: not sure, no Try again, no resend", async () => {
    gateway({
      "lottery/box/sign-params": SIGN,
      "lottery/box/open": "network",
      "lottery/jobs": ok({ jobs: [] }),
    });
    const user = userEvent.setup();
    show();
    await openCommon(user, 1);
    await user.click(await screen.findByRole("button", { name: "Sign and open" }));
    expect(await screen.findByText("Not sure the open went through")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Checking SoDEX for the job before doing anything else. We won't send it again.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(posts("lottery/box/open")).toHaveLength(1);
  });

  it("previous job still in progress: follows that job instead of sending a new open", async () => {
    gateway({
      "lottery/box/sign-params": SIGN,
      "lottery/box/open": { body: { code: 9, msg: "previous open still in progress (job 55)" } },
      "lottery/job/55": jobRoute({ jobId: 55, kind: "open" }, ["pending"]),
    });
    const user = userEvent.setup();
    show();
    await openCommon(user, 1);
    await user.click(await screen.findByRole("button", { name: "Sign and open" }));
    expect(await screen.findByText("An open is already running")).toBeInTheDocument();
    expect(screen.getByText("Job #55")).toBeInTheDocument();
    expect(posts("lottery/box/open")).toHaveLength(1);
  });

  it("failed job: shows SoDEX's error; Try again fetches new sign-params and signs again", async () => {
    gateway({
      "lottery/box/sign-params": SIGN,
      "lottery/box/open": ok({ jobId: 60, kind: "open", status: "submitting" }),
      "lottery/job/60": jobRoute({ jobId: 60, kind: "open", error: "signature deadline expired" }, [
        "failed",
      ]),
    });
    const user = userEvent.setup();
    show();
    await openCommon(user, 1);
    await user.click(await screen.findByRole("button", { name: "Sign and open" }));
    expect(await screen.findByRole("dialog", { name: "Open failed" })).toBeInTheDocument();
    expect(screen.getByText("SoDEX said: “signature deadline expired”")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(gw.calls.filter((c) => c.path === "lottery/box/sign-params")).toHaveLength(2);
    });
    expect(signTyped).toHaveBeenCalledTimes(2);
  });

  it("closing during the job keeps it running; when it finishes, See results reopens the result", async () => {
    gateway({
      "lottery/box/sign-params": SIGN,
      "lottery/box/open": ok({ jobId: 61, kind: "open", status: "submitting" }),
      "lottery/job/61": jobRoute(
        {
          jobId: 61,
          kind: "open",
          boxes: [
            {
              tokenId: 188540,
              reward: { asset: { address: "0x1", symbol: "vANT", decimals: 18 }, amount: "0.5" },
            },
          ],
        },
        ["pending", "revealed"],
      ),
    });
    const user = userEvent.setup();
    show();
    await openCommon(user, 1);
    await user.click(await screen.findByRole("button", { name: "Sign and open" }));
    await screen.findByText("Job #61");
    expect(
      screen.getByText("You can close this. It keeps going and shows on Overview."),
    ).toBeInTheDocument();
    const close = screen.getAllByRole("button", { name: "Close" })[0];
    if (close === undefined) throw new Error("no Close");
    await user.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    const see = await screen.findByRole("button", { name: "See results" }, { timeout: 4000 });
    expect(screen.getByText("1 box opened")).toBeInTheDocument();
    await user.click(see);
    expect(await screen.findByRole("dialog", { name: "1 box opened" })).toBeInTheDocument();
    expect(posts("lottery/box/open")).toHaveLength(1);
  });
});

describe("Restoring a running job after reload (mockup 18)", () => {
  it("jobs?active=true shows the job line; View opens the popup following it, nothing sent", async () => {
    gateway({
      "lottery/jobs": ok({
        jobs: [
          {
            jobId: 88231,
            kind: "open",
            status: "pending",
            boxes: [{ tokenId: 1 }, { tokenId: 2 }],
          },
        ],
      }),
      "lottery/job/88231": jobRoute({ jobId: 88231, kind: "open" }, ["pending"]),
    });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "View" }));
    const dialog = await screen.findByRole("dialog", { name: "Opening 2 boxes" });
    expect(
      within(dialog).getByText("Picked up an open that was still running"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Recording on-chain").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect((await axe.run(dialog)).violations).toEqual([]);
    expect(gw.calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("Reward range in the Open confirm (#575, DEC-400)", () => {
  it("shows one line from rules.rewardBands for the level", async () => {
    gateway({
      "lottery/meta": ok({
        contracts: { treasureBox: "0x00000000000000000000000000000000000000aa" },
        rules: {
          mergeSize: {},
          limits: { maxTreasureOpen: 100, maxBoxOpen: 30 },
          rewardBands: [{ level: "Common", minUsd: 1, maxUsd: 8 }],
        },
      }),
    });
    const user = userEvent.setup();
    show();
    await openCommon(user, 1);
    const dialog = await screen.findByRole("dialog", { name: "Open 1 Common box" });
    expect(await within(dialog).findByText("$1.00 – $8.00")).toBeInTheDocument();
    expect(within(dialog).getByText("Reward range · set by SoDEX")).toBeInTheDocument();
  });
});

describe("Merge (mockup 17)", () => {
  const rare = (id: number, day: number) => ({
    tokenId: id,
    level: "Rare",
    source: "trade",
    mintedAt: `2026-11-${String(day).padStart(2, "0")}T00:00:00Z`,
  });

  it("uses exactly mergeSize oldest boxes of one level, ascending, then shows the new box", async () => {
    gateway({
      "lottery/boxes": ok({
        total: 5,
        maxPerOpen: 30,
        byLevel: [{ level: "Rare", count: 5, mergeSize: 4, canMergeNow: true, mergesAvailable: 1 }],
        boxes: [rare(950, 1), rare(910, 3), rare(990, 2), rare(905, 9), rare(920, 4)],
      }),
      "lottery/box/sign-params": ok({ ...SIGN_DATA, primaryType: "RequestMerge" }),
      "lottery/box/merge": ok({ jobId: 70, kind: "merge", status: "submitting" }),
      "lottery/job/70": jobRoute(
        {
          jobId: 70,
          kind: "merge",
          result: { tokenId: 201877, level: "SuperRare", consumedTokenIds: [910, 920, 950, 990] },
        },
        ["revealed"],
      ),
    });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Merge 4" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge 4 Rare boxes" });
    expect(
      within(dialog).getByText(
        "These 4 boxes are used up and SoDEX gives you one new box. Its level shows when it's done.",
      ),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Sign and merge" }));
    expect(
      await screen.findByRole("dialog", { name: "Merge done" }, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByText("#201877")).toBeInTheDocument();
    expect(screen.getByText("Used 4 Rare boxes")).toBeInTheDocument();
    expect(
      posts("lottery/box/merge").map(
        (c) => (JSON.parse(c.body) as { tokenIds: number[] }).tokenIds,
      ),
    ).toEqual([[910, 920, 950, 990]]);
    const td = signTyped.mock.calls[0]?.[0] as { primaryType: string };
    expect(td.primaryType).toBe("RequestMerge");
  });

  it("Merge is disabled when fewer free boxes than mergeSize", async () => {
    show();
    const card = (await screen.findAllByText(/Merge 10 → 1/))[0]?.closest("li") as HTMLElement;
    expect(within(card).getByRole("button", { name: "Merge 10" })).toBeDisabled();
  });

  it("long token lists show 4 + and N more, with Show all", async () => {
    const commons = Array.from({ length: 10 }, (_, i) => ({
      tokenId: 100 + i,
      level: "Common",
      source: "trade",
      mintedAt: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    gateway({
      "lottery/boxes": ok({
        total: 10,
        maxPerOpen: 30,
        byLevel: [
          { level: "Common", count: 10, mergeSize: 10, canMergeNow: true, mergesAvailable: 1 },
        ],
        boxes: commons,
      }),
    });
    const user = userEvent.setup();
    show();
    await user.click(await screen.findByRole("button", { name: "Merge 10" }));
    const dialog = await screen.findByRole("dialog", { name: "Merge 10 Common boxes" });
    expect(within(dialog).getByText("and 6 more")).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Show all" }));
    expect(within(dialog).getAllByText(/^#\d+$/)).toHaveLength(10);
    expect(within(dialog).getByRole("button", { name: "Show less" })).toBeInTheDocument();
  });
});
