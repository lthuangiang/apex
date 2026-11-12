import {
  createDb,
  leaderEvents,
  leaderFollows,
  leaderStatsDaily,
  leaderWallets,
  leaderboardRuns,
  runMigrations,
  users,
  type Db,
} from "@drift/db";
import type { HlFill, HlLeaderboardRow } from "@drift/hyperliquid";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runLeaderboard, type LeaderboardDeps } from "../src/leaderboard";

const NOW = Date.parse("2026-11-11T02:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

const row = (address: string, pnl: string): HlLeaderboardRow => ({
  ethAddress: address,
  accountValue: "1000000",
  displayName: null,
  windowPerformances: [
    ["week", { pnl: "100", roi: "0.01", vlm: "1" }],
    ["month", { pnl, roi: "0.1", vlm: "1" }],
  ],
});

/** `n` episode long BTC, mỗi cái giữ 2 giờ, lãi 10 (giữ đủ lâu và đủ nhiều để vào Steady). */
function steadyFills(n: number): HlFill[] {
  return Array.from({ length: n }, (_, i) => {
    const t = NOW - (i + 1) * 20 * HOUR;
    const base = {
      coin: "BTC",
      px: "100",
      sz: "1",
      dir: "",
      fee: "0",
      tid: String(i),
      liquidation: null,
    };
    return [
      { ...base, side: "B" as const, time: t, startPosition: "0", closedPnl: "0" },
      {
        ...base,
        side: "A" as const,
        time: t + 2 * HOUR,
        startPosition: "1",
        closedPnl: "10",
        tid: `${String(i)}c`,
      },
    ];
  }).flat();
}

function deps(
  over: Partial<LeaderboardDeps["hl"]> = {},
): LeaderboardDeps & { roleCalls: string[] } {
  const roleCalls: string[] = [];
  const hl: LeaderboardDeps["hl"] = {
    leaderboard: () =>
      Promise.resolve([
        row("0xAAA0000000000000000000000000000000000001", "50000"),
        row("0xbbb0000000000000000000000000000000000002", "-5"),
      ]),
    fillsSince: () => Promise.resolve({ fills: steadyFills(25), capped: false }),
    fundingSince: () => Promise.resolve([]),
    isVault: (user) => {
      roleCalls.push(user);
      return Promise.resolve(false);
    },
    ...over,
  };
  return { db, hl, sodexMarkets: () => Promise.resolve(["BTC-USD"]), now: () => NOW, roleCalls };
}

describe("runLeaderboard", () => {
  it("keeps profitable leaderboard wallets, computes stats from fills, and caches the vault check", async () => {
    const d = deps();
    const r = await runLeaderboard(d);
    expect(r).toMatchObject({ status: "ok", candidates: 1, computed: 1 });
    const [s] = await db.select().from(leaderStatsDaily);
    expect(s).toMatchObject({
      address: "0xaaa0000000000000000000000000000000000001",
      date: "2026-11-11",
      tabs: ["steady", "top", "long", "all"],
      hidden: [],
    });
    expect(s?.typicalHoldMs).toBe(2 * HOUR);
    // Sự kiện cho Trader profile: 25 lần mở + 25 lần đóng, giữ 50 gần nhất.
    expect(await db.select().from(leaderEvents)).toHaveLength(50);
    // Lần chạy sau không hỏi userRole lại (weight 60) và không ghi trùng sự kiện.
    await runLeaderboard(d);
    expect(d.roleCalls).toHaveLength(1);
    expect(await db.select().from(leaderEvents)).toHaveLength(50);
  });

  it("keeps the last good list when the leaderboard fails", async () => {
    const before = await db.select().from(leaderStatsDaily);
    const d = {
      ...deps({ leaderboard: () => Promise.reject(new Error("down")) }),
      now: () => NOW + DAY,
    };
    const r = await runLeaderboard(d);
    expect(r.status).toBe("failed");
    const [run] = await db
      .select()
      .from(leaderboardRuns)
      .where(eq(leaderboardRuns.date, "2026-11-12"));
    expect(run).toMatchObject({ status: "failed", error: "down" });
    expect(await db.select().from(leaderStatsDaily)).toEqual(before);
  });

  it("also recomputes followed wallets that fell off the leaderboard, and survives one wallet failing", async () => {
    const [u] = await db
      .insert(users)
      .values({ email: "f@example.com" })
      .returning({ id: users.id });
    const followed = "0xccc0000000000000000000000000000000000003";
    await db
      .insert(leaderFollows)
      .values({ userId: u?.id ?? "", source: "hyperliquid", address: followed });
    const d = {
      ...deps({
        fillsSince: (user: string) =>
          user === followed
            ? Promise.reject(new Error("429"))
            : Promise.resolve({ fills: steadyFills(25), capped: false }),
      }),
      now: () => NOW + 2 * DAY,
    };
    const r = await runLeaderboard(d);
    expect(r).toMatchObject({ status: "ok", candidates: 2, computed: 1, failed: [followed] });
    const w = await db.select().from(leaderWallets).where(eq(leaderWallets.address, followed));
    expect(w).toHaveLength(1);
  });

  it("puts capped history only under All", async () => {
    const d = {
      ...deps({ fillsSince: () => Promise.resolve({ fills: steadyFills(25), capped: true }) }),
      now: () => NOW + 3 * DAY,
    };
    await runLeaderboard(d);
    const [s] = await db
      .select()
      .from(leaderStatsDaily)
      .where(eq(leaderStatsDaily.date, "2026-11-14"));
    expect(s?.tabs).toEqual(["all"]);
  });
});
