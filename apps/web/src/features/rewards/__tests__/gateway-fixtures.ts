import { vi } from "vitest";

import { urlOf } from "./fetch-helpers";

// Gateway SoDEX rewards giả cho test component (#548, #549): trả fixture theo đường dẫn `/api/v1/...`. Dữ liệu mẫu, không
// phải dữ liệu thật; token trong test là chuỗi giả.

export const MASTER = "0x3f2a000000000000000000000000000000009c4e";
export const OTHER = "0x71b00000000000000000000000000000000022d1";
export const FAKE_TOKEN = "fake-test-value";

export type Reply =
  | { status?: number; body: unknown }
  | "network"
  | "pending"
  | ((url: URL, init: RequestInit | undefined) => Promise<Response>);

const ok = (data: unknown) => ({ body: { code: 0, msg: "ok", data } });

export const fixtures = {
  weekInfo: ok({
    weekNo: 13,
    weekName: "Week 13",
    weekStatus: "LIVE",
    weekPoolPoints: 1000000,
    nextWeekStartTime: 1764586800,
    distributionTime: 1764846000,
  }),
  volumeWeights: {
    body: {
      code: 0,
      message: "ok",
      data: {
        round: { round_id: 13, end_ts_ms: 1764586800000 },
        weights: [
          { market_type: "perps", symbol: "AAA-USD", coefficient: "1.1" },
          { market_type: "perps", symbol: "NVDA-USD", coefficient: "1.2" },
          { market_type: "perps", symbol: "GOOGL-USD", coefficient: "1.20" },
          { market_type: "perps", symbol: "BBB-USD", coefficient: "1.05" },
          { market_type: "perps", symbol: "CCC-USD", coefficient: "1.01" },
          { market_type: "perps", symbol: "DDD-USD", coefficient: "1.15" },
        ],
      },
    },
  },
  feed: ok({
    items: [
      {
        kind: "box_open",
        tsMs: 1764031620000,
        wallet: "0x67fc…c7a0",
        level: "Rare",
        tokenId: 188540,
        rewardUsd: "110.89",
        reward: {
          asset: { address: "0x1", symbol: "vANT", decimals: 18 },
          amount: "0.9945",
        },
      },
      {
        kind: "box_open",
        tsMs: 1764031000000,
        wallet: "0x05d8…389e",
        level: "Uncommon",
        tokenId: 188541,
        rewardUsd: "10.55",
        reward: {
          asset: { address: "0x1", symbol: "vANT", decimals: 18 },
          amount: "0.0946",
        },
        pfp: true,
      },
    ],
  }),
  // Hình dạng theo dữ liệu thật (2026-11-26, rewards-confirmed-fields); địa chỉ là ví giả của test.
  summary: ok({
    walletAddress: MASTER,
    totalPoints: 48210,
    referralPoints: 2140,
    currentTier: "EPIC",
    nextTier: "DIAMOND",
    nextTierPoints: 60000,
    rank: 1284,
    totalUser: 38902,
    weekPoolPoints: 1000000,
    distributionTime: 1764846000,
  }),
  weekList: ok([
    {
      weekNo: 12,
      weekName: "Week 12",
      status: "COMPLETED",
      isLive: false,
      weekStartTime: 1763337600,
      weekEndTime: 1763942400,
      distributionTime: 1764241200,
      spotVolume: 0,
      futuresVolume: 132050,
      points: 3420,
      referralPoints: 120,
      pointsStatus: "CONFIRMED",
      rank: 1188,
      totalUser: 36110,
      rankPercentile: "Top 3.29%",
      totalBonusPct: 15,
      futuresVolumeWeightDetails: [],
      vaultHolding: null,
      oi: null,
      accountValue: null,
      wealthTvl: 0,
      teamWeekVolume: 987654,
      teamWindowVolume: 1234567,
    },
    {
      weekNo: 13,
      weekName: "Week 13",
      status: "LIVE",
      isLive: true,
      weekStartTime: 1763942400,
      weekEndTime: 1764547200,
      distributionTime: 1764846000,
      spotVolume: 1920,
      futuresVolume: 84300,
      points: 2140,
      referralPoints: 0,
      pointsStatus: "PENDING",
      rank: 1410,
      totalUser: 38902,
      rankPercentile: "Top 3.62%",
      totalBonusPct: 15,
      futuresVolumeWeightDetails: [],
      vaultHolding: null,
      oi: null,
      accountValue: null,
      wealthTvl: 0,
      teamWeekVolume: 987654,
      teamWindowVolume: 1234567,
    },
  ]),
  treasures: ok({
    total: 3,
    bySource: { trade: 3 },
    maxPerOpen: 100,
    lifetime: { granted: 10, opened: 7, bySource: { campaign: 2, trade: 8 } },
  }),
  boxes: ok({
    total: 27,
    maxPerOpen: 30,
    byLevel: [
      { level: "Common", count: 20, mergeSize: 10, canMergeNow: true, mergesAvailable: 2 },
      { level: "Uncommon", count: 5, mergeSize: 10, canMergeNow: false, mergesAvailable: 0 },
      { level: "Rare", count: 2, mergeSize: 4, canMergeNow: false, mergesAvailable: 0 },
      { level: "SuperRare", count: 0, mergeSize: 0, canMergeNow: false, mergesAvailable: 0 },
    ],
    boxes: [
      { tokenId: 188540, level: "Common", source: "invitee", mintedAt: "2026-11-02T06:55:00Z" },
      { tokenId: 201640, level: "Common", source: "trade", mintedAt: "2026-11-26T02:14:00Z" },
      { tokenId: 200913, level: "Rare", source: "milestone", mintedAt: "2026-11-25T14:40:00Z" },
    ],
  }),
  jobs: ok({ jobs: [] }),
  // Ledger theo `kind` (dữ liệu thật 2026-11-26); địa chỉ from / to là ví giả.
  ledger: ok({
    total: 4,
    items: [
      {
        kind: "open",
        tsMs: 1764155100000,
        level: "Common",
        tokenId: 200510,
        requestId: 77,
        status: "revealed",
        rewardUsd: "5.07",
        reward: {
          asset: { address: "0x1", symbol: "vANT", decimals: 18 },
          amount: "0.0612",
          amountRaw: "61200000000000000",
        },
      },
      {
        kind: "merge",
        tsMs: 1764154920000,
        level: "Common",
        requestId: 76,
        status: "done",
        consumedTokenIds: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        resultTokenId: 201877,
        resultLevel: "Uncommon",
      },
      {
        kind: "treasure",
        tsMs: 1764123240000,
        level: "Common",
        tokenId: 201640,
        txHash: "0xabc",
        source: "trade",
        mintId: 5,
      },
      {
        kind: "transfer",
        tsMs: 1764049320000,
        level: "Common",
        tokenId: 190044,
        txHash: "0xdef",
        direction: "in",
        from: OTHER,
        to: MASTER,
        blockNumber: 123,
        reason: "lottery_prize",
        round: 10,
      },
    ],
  }),
  history: ok({
    total: 2,
    totalRewardUsd: "412.36",
    totalRewardByAsset: [
      {
        asset: { address: "0x1", symbol: "vANT", decimals: 18 },
        amount: "3.88412",
        amountRaw: "1",
      },
      {
        asset: { address: "0x2", symbol: "vsoUSDC", decimals: 6 },
        amount: "90.59",
        amountRaw: "2",
      },
    ],
    items: [],
  }),
  // Round 10 sau khi có kết quả (dữ liệu thật): `wins` là số, entries có won / prizeLevel.
  draw: ok({
    round: 10,
    status: "distributed",
    deadlineMs: 1764586800000,
    tickets: 3,
    boxes: 3,
    byLevel: [
      { level: "Common", count: 2 },
      { level: "Rare", count: 1 },
    ],
    total: 3,
    wins: 1,
    entries: [
      { tokenId: 188201, level: "Rare", won: true, prizeLevel: "Common" },
      { tokenId: 188202, level: "Common", won: false, prizeLevel: null },
      { tokenId: 188203, level: "Common", won: false, prizeLevel: null },
    ],
  }),
  pfps: ok({ total: 0, pfps: [], won: [] }),
  nonce: ok({ message: "Sign in to SoDEX rewards: nonce 1" }),
};

export type Route =
  | "sopoints/week/info"
  | "sopoints/volume-weights"
  | "lottery/feed"
  | "sopoints/summary"
  | "sopoints/week/list"
  | "lottery/treasures"
  | "lottery/boxes"
  | "lottery/jobs"
  | "lottery/ledger"
  | "lottery/history"
  | "lottery/draw/entries"
  | "lottery/pfps"
  | "cybereator/profile/2051"
  | "auth/nonce";

export function defaultRoutes(): Record<Route, Reply> {
  return {
    "sopoints/week/info": fixtures.weekInfo,
    "sopoints/volume-weights": fixtures.volumeWeights,
    "lottery/feed": fixtures.feed,
    "sopoints/summary": fixtures.summary,
    "sopoints/week/list": fixtures.weekList,
    "lottery/treasures": fixtures.treasures,
    "lottery/boxes": fixtures.boxes,
    "lottery/jobs": fixtures.jobs,
    "lottery/ledger": fixtures.ledger,
    "lottery/history": fixtures.history,
    "lottery/draw/entries": fixtures.draw,
    "lottery/pfps": fixtures.pfps,
    "cybereator/profile/2051": { body: { id: 2051, stage: "unopened" } },
    "auth/nonce": fixtures.nonce,
  };
}

/** `fetch` giả: trả theo `routes`, ghi lại URL + header Authorization của mỗi lần gọi. */
export function fakeGateway(routes: Partial<Record<Route, Reply>> = {}) {
  const table = { ...defaultRoutes(), ...routes };
  const calls: { path: string; url: string; auth: string | null }[] = [];
  const fn = vi.fn<typeof fetch>((input, init) => {
    const url = new URL(urlOf(input));
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path, url: url.href, auth: headers.Authorization ?? null });
    const reply = table[path as Route] as Reply | undefined;
    if (reply === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    if (reply === "network") return Promise.reject(new TypeError("Failed to fetch"));
    if (reply === "pending") return new Promise<Response>(() => undefined);
    if (typeof reply === "function") return reply(url, init);
    return Promise.resolve(
      new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
  return { fn, calls, table };
}
