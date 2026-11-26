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
  summary: ok({
    totalPoints: 48210,
    basePoints: 41880,
    boostPoints: 4190,
    referralPoints: 2140,
    currentTier: 3,
    nextTier: 4,
    nextTierPoints: 60000,
    rank: 1284,
    totalUser: 38902,
  }),
  weekList: ok([
    {
      weekNo: 12,
      weekName: "Week 12",
      weekStartTime: 1763337600,
      weekEndTime: 1763942400,
      spotVolume: 0,
      futuresVolume: 132050,
      rank: 1188,
      points: 3420,
      pointsStatus: "CONFIRMED",
    },
    {
      weekNo: 13,
      weekName: "Week 13",
      weekStartTime: 1763942400,
      weekEndTime: 1764547200,
      spotVolume: 1920,
      futuresVolume: 84300,
      rank: 1410,
      points: 2140,
      pointsStatus: "PENDING",
    },
  ]),
  treasures: ok({ total: 3, maxPerOpen: 30, lifetime: { granted: 10, opened: 7 } }),
  boxes: ok({ total: 27, maxPerOpen: 30, byLevel: [], boxes: [] }),
  jobs: ok({ jobs: [] }),
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
