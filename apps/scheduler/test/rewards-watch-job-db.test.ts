import {
  createDb,
  outbox,
  rewardsWatch,
  runMigrations,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import type { RewardsReadClient } from "@drift/sodex";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  purgeRewardsWatch,
  runRewardsWatchTick,
  type RewardsWatchJobDeps,
} from "../src/rewards-watch/job";
import type { RewardsDecryptResult } from "../src/rewards-watch/signer-decrypt";

// #558 PR4 (DEC-398): job báo box mới SoDEX rewards trên Postgres thật (Testcontainers, CI). Gateway và signer là giả;
// token là chuỗi giả có dấu hiệu nhận biết, không phải token thật. Địa chỉ ví là địa chỉ giả.

const TOKEN = "aaaa.TOKENMARKER.cccc";
const INTERVAL = 15 * 60_000;

type Reader = RewardsWatchJobDeps["reader"];
type Treasures = Awaited<ReturnType<RewardsReadClient["getTreasures"]>>;
type Ledger = Awaited<ReturnType<RewardsReadClient["getLedger"]>>;
type Draw = Awaited<ReturnType<RewardsReadClient["getDrawEntries"]>>;
type Weeks = Awaited<ReturnType<RewardsReadClient["getWeekList"]>>;
type Summary = Awaited<ReturnType<RewardsReadClient["getSopointsSummary"]>>;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

const state = {
  now: new Date("2026-11-26T08:00:00Z"),
  treasures: null as Treasures | null,
  ledger: null as Ledger | null,
  draw: null as Draw | null,
  decrypt: { kind: "ok", token: TOKEN } as RewardsDecryptResult,
  pausedUntil: null as number | null,
  calls: [] as string[],
  weeks: null as Weeks | null,
  summary: null as Summary | null,
};

const reader: Reader = {
  getTreasures: (token) => {
    state.calls.push(`treasures:${token === TOKEN ? "token" : "other"}`);
    return Promise.resolve(state.treasures ?? { kind: "error", code: "network" });
  },
  getLedger: (_token, q) => {
    state.calls.push(`ledger:${String(q?.offset ?? 0)}`);
    return Promise.resolve(state.ledger ?? { kind: "error", code: "network" });
  },
  getDrawEntries: (_token, q) => {
    state.calls.push(`draw:${String(q?.round ?? "")}`);
    return Promise.resolve(state.draw ?? { kind: "error", code: "network" });
  },
  // #567: tin tuần. Mặc định lỗi mạng: lượt tin tuần chỉ hẹn đọc lại, không gửi gì.
  getWeekList: () => {
    state.calls.push("weeks");
    return Promise.resolve(state.weeks ?? { kind: "error", code: "network" });
  },
  getSopointsSummary: () => {
    state.calls.push("summary");
    return Promise.resolve(state.summary ?? { kind: "error", code: "network" });
  },
};

function deps(): RewardsWatchJobDeps {
  return {
    db,
    now: () => state.now,
    reader,
    decrypt: () => {
      state.calls.push("decrypt");
      return Promise.resolve(state.decrypt);
    },
    pause: {
      get: () => Promise.resolve(state.pausedUntil),
      set: (until) => {
        state.pausedUntil = until;
        return Promise.resolve();
      },
    },
    intervalMs: INTERVAL,
    batch: 20,
  };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  await db.delete(rewardsWatch);
  await db.delete(outbox);
  state.treasures = {
    kind: "ok",
    data: { total: 0, maxPerOpen: 100, lifetime: { granted: 5, opened: 5 } },
  };
  state.ledger = { kind: "ok", data: { total: 0, items: [] } };
  state.draw = null;
  state.decrypt = { kind: "ok", token: TOKEN };
  state.pausedUntil = null;
  state.calls = [];
  state.weeks = null;
  state.summary = null;
});

let n = 0;
async function watcher(opts: { baseline?: boolean; expMs?: number } = {}) {
  n += 1;
  const [u] = await db
    .insert(users)
    .values({ email: `rw-job${String(n)}@x.test` })
    .returning();
  const [a] = await db
    .insert(sodexAccounts)
    .values({
      userId: u?.id ?? "",
      address: `0x${(0xb000 + n).toString(16).padStart(40, "0")}`,
      sodexAccountId: BigInt(9000 + n),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  const userId = u?.id ?? "";
  await db.insert(rewardsWatch).values({
    userId,
    sodexAccountId: a?.id ?? "",
    status: "active",
    tokenCiphertext: "vault:v1:test",
    kmsKeyRef: "vault-transit:drift-rewards",
    tokenExp: new Date(opts.expMs ?? state.now.getTime() + 10 * 24 * 3600_000),
    jti8: `jti${String(n)}`,
    baselinePending: opts.baseline ?? true,
    nextCheckAt: new Date(state.now.getTime() - 1000),
  });
  return { userId, accountId: a?.id ?? "" };
}

const rowOf = async (userId: string) =>
  (await db.select().from(rewardsWatch).where(eq(rewardsWatch.userId, userId)))[0];
const notices = async () =>
  (await db.select().from(outbox).where(eq(outbox.topic, "jobs.notify"))).map(
    (o) =>
      o.payload as {
        userId: string;
        type: string;
        data: Record<string, unknown>;
        dedupeKey: string;
      },
  );
const makeDue = (userId: string) =>
  db
    .update(rewardsWatch)
    .set({ nextCheckAt: new Date(state.now.getTime() - 1000) })
    .where(eq(rewardsWatch.userId, userId));

describe("rewards watch job", () => {
  it("first run only sets the marks (no notification for old history)", async () => {
    const w = await watcher();
    state.ledger = {
      kind: "ok",
      data: {
        total: 2,
        items: [
          {
            kind: "transfer",
            tsMs: 2000,
            tokenId: 2,
            direction: "in",
            reason: "lottery_prize",
            round: 9,
          },
          { kind: "transfer", tsMs: 1000, tokenId: 1, direction: "in" },
        ],
      },
    };
    const r = await runRewardsWatchTick(deps());
    expect(r).toMatchObject({ baselined: 1, notified: 0, stopped: null });
    expect(await notices()).toEqual([]);
    const row = await rowOf(w.userId);
    expect(row).toMatchObject({
      baselinePending: false,
      ledgerMarkTsMs: 2000,
      grantedMark: 5,
      drawRoundsSeen: [9],
      consecutiveErrors: 0,
    });
    expect(row?.nextCheckAt.getTime()).toBeGreaterThan(state.now.getTime());
    // Chỉ đọc trang đầu ledger ở lượt baseline.
    expect(state.calls.filter((c) => c.startsWith("ledger"))).toEqual(["ledger:0"]);
  });

  it("notifies new claimable, received and draw prize boxes once, in one transaction with the marks", async () => {
    const w = await watcher();
    // Ledger rỗng ở lượt đầu: mốc = giờ hiện tại; box nhận sau đó có tsMs lớn hơn.
    const T0 = state.now.getTime();
    await runRewardsWatchTick(deps());
    await makeDue(w.userId);
    state.treasures = {
      kind: "ok",
      data: { total: 3, maxPerOpen: 100, lifetime: { granted: 8, opened: 5 } },
    };
    state.ledger = {
      kind: "ok",
      data: {
        total: 3,
        items: [
          {
            kind: "transfer",
            tsMs: T0 + 5000,
            tokenId: 12,
            level: "Common",
            direction: "in",
            reason: "lottery_prize",
            round: 10,
          },
          { kind: "transfer", tsMs: T0 + 4000, tokenId: 11, level: "Uncommon", direction: "in" },
          { kind: "open", tsMs: T0 + 3000, tokenId: 10 },
        ],
      },
    };
    state.draw = {
      kind: "ok",
      data: { round: 10, status: "distributed", wins: 1, tickets: 27, entries: [] },
    };
    const r = await runRewardsWatchTick(deps());
    expect(r).toMatchObject({ checked: 1, notified: 3 });
    const sent = await notices();
    expect(sent.map((s) => s.type).sort()).toEqual([
      "rewards_box_received",
      "rewards_claimable",
      "rewards_draw_won",
    ]);
    expect(sent.find((s) => s.type === "rewards_claimable")?.data).toEqual({ count: 3 });
    expect(sent.find((s) => s.type === "rewards_box_received")?.data).toEqual({
      count: 1,
      levels: [{ level: "Uncommon", count: 1 }],
    });
    expect(sent.find((s) => s.type === "rewards_draw_won")?.data).toEqual({
      round: 10,
      boxes: 1,
      wins: 1,
      tickets: 27,
    });
    for (const s of sent) expect(s.dedupeKey).toMatch(/^rw:/);
    // Không có token / địa chỉ / txHash trong tin.
    expect(JSON.stringify(sent)).not.toContain("TOKENMARKER");
    expect(await rowOf(w.userId)).toMatchObject({
      ledgerMarkTsMs: T0 + 5000,
      grantedMark: 8,
      drawRoundsSeen: [10],
    });

    // Lượt sau không có gì mới: không báo lại.
    await makeDue(w.userId);
    await runRewardsWatchTick(deps());
    expect(await notices()).toHaveLength(3);
  });

  it("pauses on 401 and drops the ciphertext, telling the user once", async () => {
    const w = await watcher({ baseline: false });
    await db
      .update(rewardsWatch)
      .set({ ledgerMarkTsMs: 1, grantedMark: 5 })
      .where(eq(rewardsWatch.userId, w.userId));
    state.treasures = { kind: "unauthorized" };
    const r = await runRewardsWatchTick(deps());
    expect(r.paused).toBe(1);
    expect(await rowOf(w.userId)).toMatchObject({
      status: "paused",
      pauseReason: "unauthorized",
      tokenCiphertext: null,
    });
    const sent = await notices();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "rewards_watch_paused",
      data: { reason: "unauthorized" },
    });
    // Dòng đã tạm dừng không được đọc nữa.
    state.calls = [];
    await runRewardsWatchTick(deps());
    expect(state.calls).toEqual([]);
  });

  it("pauses an expired session without calling the signer or SoDEX", async () => {
    const w = await watcher({ expMs: state.now.getTime() + 30_000 });
    await runRewardsWatchTick(deps());
    expect(await rowOf(w.userId)).toMatchObject({
      status: "paused",
      pauseReason: "expired",
      tokenCiphertext: null,
    });
    expect(state.calls).toEqual([]);
    expect((await notices())[0]).toMatchObject({ data: { reason: "expired" } });
  });

  it("pauses when the signer cannot decrypt, and when the wallet changed", async () => {
    const a = await watcher();
    state.decrypt = { kind: "unusable" };
    await runRewardsWatchTick(deps());
    expect(await rowOf(a.userId)).toMatchObject({ status: "paused", pauseReason: "unauthorized" });
    state.decrypt = { kind: "ok", token: TOKEN };
    const b = await watcher();
    await db
      .update(sodexAccounts)
      .set({ status: "disconnected" })
      .where(eq(sodexAccounts.id, b.accountId));
    await runRewardsWatchTick(deps());
    expect(await rowOf(b.userId)).toMatchObject({
      status: "paused",
      pauseReason: "wallet_changed",
    });
  });

  it("stops the whole job on 429 until retryAfter, without touching the row", async () => {
    const w = await watcher();
    await watcher();
    state.treasures = { kind: "rate_limited", retryAfterMs: 42_000 };
    const r = await runRewardsWatchTick(deps());
    expect(r.stopped).toBe("rate_limited");
    expect(state.pausedUntil).toBe(state.now.getTime() + 42_000);
    // Chỉ một user được thử: lượt dừng ngay.
    expect(state.calls.filter((c) => c.startsWith("treasures"))).toHaveLength(1);
    expect(await rowOf(w.userId)).toMatchObject({ status: "active", consecutiveErrors: 0 });
    state.calls = [];
    const again = await runRewardsWatchTick(deps());
    expect(again.stopped).toBe("rate_limited");
    expect(state.calls).toEqual([]);
  });

  it("stops the tick when DeskLabs' own weight budget is used, leaving rows due", async () => {
    const w = await watcher();
    state.treasures = { kind: "budget", retryAfterMs: 5000 };
    const r = await runRewardsWatchTick(deps());
    expect(r.stopped).toBe("budget");
    const row = await rowOf(w.userId);
    expect(row?.nextCheckAt.getTime()).toBeLessThan(state.now.getTime());
    expect(row?.consecutiveErrors).toBe(0);
  });

  it("backs off on network errors and does not retry in the same tick", async () => {
    const w = await watcher();
    state.treasures = { kind: "error", code: "network" };
    const r = await runRewardsWatchTick(deps());
    expect(r.errors).toBe(1);
    expect(state.calls.filter((c) => c.startsWith("treasures"))).toHaveLength(1);
    const row = await rowOf(w.userId);
    expect(row).toMatchObject({ consecutiveErrors: 1, lastErrorCode: "network", status: "active" });
    expect(row?.nextCheckAt.getTime()).toBe(state.now.getTime() + 2 * INTERVAL);
  });

  it("purges paused rows older than 30 days", async () => {
    const w = await watcher();
    await db
      .update(rewardsWatch)
      .set({ status: "paused", pauseReason: "expired", tokenCiphertext: null })
      .where(eq(rewardsWatch.userId, w.userId));
    await db.execute(
      sql`update rewards_watch set updated_at = now() - interval '31 days' where user_id = ${w.userId}`,
    );
    const fresh = await watcher();
    expect(await purgeRewardsWatch(db, new Date())).toBe(1);
    expect(await rowOf(w.userId)).toBeUndefined();
    expect(await rowOf(fresh.userId)).toBeDefined();
  });
});

describe("weekly SoDEX messages (#567)", () => {
  const nowS = () => Math.floor(state.now.getTime() / 1000);
  const week = (over: Record<string, unknown> = {}) => ({
    weekNo: 13,
    weekName: "Week 13",
    status: "COMPLETED",
    isLive: false,
    weekStartTime: nowS() - 7 * 24 * 3600 - 2 * 3600,
    weekEndTime: nowS() - 2 * 3600,
    distributionTime: nowS() + 3 * 3600,
    spotVolume: 7.65,
    futuresVolume: 70722.87,
    oi: 17.62,
    accountValue: 208.33,
    vaultHolding: 0,
    wealthTvl: 2.57,
    points: 521,
    rank: 1410,
    totalUser: 226582,
    rankPercentile: "Top 0.06%",
    pointsStatus: "PENDING",
    futuresVolumeWeightDetails: [
      { symbol: "NVDA-USD", coefficient: "1.2" },
      { symbol: "GOOGL-USD", coefficient: "1.1" },
      { symbol: "AMZN-USD", coefficient: "1.05" },
    ],
    ...over,
  });
  const live = () => ({
    weekNo: 14,
    weekName: "Week 14",
    status: "LIVE",
    isLive: true,
    weekStartTime: nowS() - 2 * 3600,
    weekEndTime: nowS() + 7 * 24 * 3600 - 2 * 3600,
    distributionTime: nowS() + 10 * 24 * 3600,
  });
  const forceWeekly = (userId: string) =>
    db
      .update(rewardsWatch)
      .set({ weeklyCheckAt: new Date(state.now.getTime() - 1000) })
      .where(eq(rewardsWatch.userId, userId));
  const weeklyNotices = async () =>
    (await notices()).filter((n) => n.type.startsWith("rewards_week_"));

  it("sends the snapshot once after the week completed, with no squad fields or wallet", async () => {
    const w = await watcher();
    state.weeks = { kind: "ok", data: [week(), live()] };
    await runRewardsWatchTick(deps());
    const sent = await weeklyNotices();
    expect(sent.map((n) => n.type)).toEqual(["rewards_week_snapshot"]);
    expect(sent[0]?.dedupeKey).toBe("rw:snapshot:13");
    expect(sent[0]?.data).toMatchObject({
      weekNo: 13,
      futuresVolume: "70722.87",
      vaultHolding: "0",
      boosted: { symbol: "NVDA-USD", coefficient: "1.2", more: 2 },
      timeZone: "Asia/Ho_Chi_Minh",
    });
    expect(JSON.stringify(sent)).not.toMatch(/team|totalBonusPct|0x[0-9a-f]{40}/i);
    const row = await rowOf(w.userId);
    expect(row?.snapshotWeekSent).toBe(13);
    // Điểm chưa tới cửa sổ (3 giờ nữa): đọc lại 30 phút trước giờ chia điểm.
    expect(row?.weeklyCheckAt?.getTime()).toBe((nowS() + 3 * 3600) * 1000 - 30 * 60_000);
    await forceWeekly(w.userId);
    await runRewardsWatchTick(deps());
    expect(await weeklyNotices()).toHaveLength(1);
  });

  it("waits while the week is not completed, then sends", async () => {
    const w = await watcher();
    state.weeks = { kind: "ok", data: [week({ status: "SETTLING" }), live()] };
    await runRewardsWatchTick(deps());
    expect(await weeklyNotices()).toEqual([]);
    expect((await rowOf(w.userId))?.weeklyCheckAt?.getTime()).toBe(
      state.now.getTime() + 10 * 60_000,
    );
  });

  it("sends the points once they are CONFIRMED in the window, with totals from the summary", async () => {
    const w = await watcher();
    state.weeks = {
      kind: "ok",
      data: [week({ distributionTime: nowS() - 600, pointsStatus: "PENDING" }), live()],
    };
    await runRewardsWatchTick(deps());
    expect((await weeklyNotices()).map((n) => n.type)).toEqual(["rewards_week_snapshot"]);
    expect((await rowOf(w.userId))?.weeklyCheckAt?.getTime()).toBe(
      state.now.getTime() + 10 * 60_000,
    );

    state.weeks = {
      kind: "ok",
      data: [week({ distributionTime: nowS() - 600, pointsStatus: "CONFIRMED" }), live()],
    };
    state.summary = {
      kind: "ok",
      data: { totalPoints: 29556, currentTier: "DIAMOND", nextTier: "EPIC", nextTierPoints: 50000 },
    };
    await forceWeekly(w.userId);
    await runRewardsWatchTick(deps());
    const points = (await weeklyNotices()).filter((n) => n.type === "rewards_week_points");
    expect(points).toHaveLength(1);
    expect(points[0]?.dedupeKey).toBe("rw:points:13");
    expect(points[0]?.data).toMatchObject({
      points: "521",
      rank: "1410",
      totalUser: "226582",
      rankPercentile: "Top 0.06%",
      totalPoints: "29556",
      currentTier: "DIAMOND",
      nextTier: "EPIC",
      nextTierPoints: "50000",
    });
    expect((await rowOf(w.userId))?.pointsWeekSent).toBe(13);
    await forceWeekly(w.userId);
    await runRewardsWatchTick(deps());
    expect((await weeklyNotices()).filter((n) => n.type === "rewards_week_points")).toHaveLength(1);
  });

  it("gives up silently 6 hours after distributionTime", async () => {
    const w = await watcher();
    state.weeks = {
      kind: "ok",
      data: [week({ distributionTime: nowS() - 7 * 3600, pointsStatus: "PENDING" }), live()],
    };
    await runRewardsWatchTick(deps());
    expect((await weeklyNotices()).filter((n) => n.type === "rewards_week_points")).toEqual([]);
    expect((await rowOf(w.userId))?.pointsWeekSent).toBe(13);
  });

  it("401 on the week list: no message, paused like the box reads", async () => {
    const w = await watcher();
    state.weeks = { kind: "unauthorized" };
    await runRewardsWatchTick(deps());
    expect(await weeklyNotices()).toEqual([]);
    expect(await rowOf(w.userId)).toMatchObject({ status: "paused", pauseReason: "unauthorized" });
  });
});

describe("short intervals (#558: 1–2 minutes)", () => {
  it.each([1, 2])(
    "re-reads boxes every %i minute(s) while the weekly read keeps its own 10-minute retry",
    async (min) => {
      const interval = min * 60_000;
      const start = state.now;
      const d = { ...deps(), intervalMs: interval };
      try {
        const w = await watcher();
        await runRewardsWatchTick(d);
        const first = await rowOf(w.userId);
        const next = (first?.nextCheckAt.getTime() ?? 0) - start.getTime();
        expect(next).toBeGreaterThanOrEqual(interval * 0.9);
        expect(next).toBeLessThanOrEqual(interval * 1.1);
        // Tin tuần lỗi mạng (mặc định của reader giả): hẹn 10 phút, không theo chu kỳ box.
        expect(first?.weeklyCheckAt?.getTime()).toBe(start.getTime() + 10 * 60_000);
        expect(state.calls.filter((c) => c === "weeks")).toHaveLength(1);

        // Chưa tới hạn: không đọc gì.
        state.calls = [];
        state.now = new Date(start.getTime() + interval * 0.5);
        await runRewardsWatchTick(d);
        expect(state.calls).toEqual([]);

        // Tới hạn sau một chu kỳ: đọc box lại, chưa đọc tuần.
        state.now = new Date(start.getTime() + interval * 1.1 + 1);
        await runRewardsWatchTick(d);
        expect(state.calls).toContain("treasures:token");
        expect(state.calls).not.toContain("weeks");
        const second = await rowOf(w.userId);
        const after = (second?.nextCheckAt.getTime() ?? 0) - state.now.getTime();
        expect(after).toBeGreaterThanOrEqual(interval * 0.9);
        expect(after).toBeLessThanOrEqual(interval * 1.1);
        expect(second?.weeklyCheckAt?.getTime()).toBe(start.getTime() + 10 * 60_000);
      } finally {
        state.now = start;
      }
    },
  );

  it("backs off at least two short cycles after a network error", async () => {
    const d = { ...deps(), intervalMs: 60_000 };
    const w = await watcher({ baseline: false });
    state.treasures = { kind: "error", code: "network" };
    await runRewardsWatchTick(d);
    const row = await rowOf(w.userId);
    expect(row?.consecutiveErrors).toBe(1);
    expect(row?.nextCheckAt.getTime()).toBe(state.now.getTime() + 2 * 60_000);
  });
});
