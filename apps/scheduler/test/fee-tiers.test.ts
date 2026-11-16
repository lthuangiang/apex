import {
  botEvents,
  bots,
  builderFeeOverridesOf,
  createDb,
  fills,
  orders,
  outbox,
  runMigrations,
  sodexAccounts,
  userBuilderFees,
  userFeeTiers,
  users,
  type Db,
} from "@drift/db";
import { builderFeeRateFor } from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { feeTierDedupeKey, refreshFeeTiers } from "../src/fee-tiers";

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
const NOW = Date.parse("2026-11-16T10:00:00Z");
const DAY = 86_400_000;

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

/** User có một bot (mặc định Market Making tiền thật, đang chạy). */
async function seed(strategy = "volume_maker", mode: "live" | "paper" = "live") {
  const [u] = await db
    .insert(users)
    .values({ email: `${String(Math.random())}@x.test` })
    .returning();
  const [a] = await db
    .insert(sodexAccounts)
    .values({
      userId: u?.id ?? "",
      address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
      sodexAccountId: BigInt(Math.floor(Math.random() * 1e9)),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  const [b] = await db
    .insert(bots)
    .values({
      userId: u?.id ?? "",
      sodexAccountId: a?.id ?? "",
      strategy,
      market: "BTC-USD",
      engine: "perps",
      name: "MM",
      state: "running",
      mode,
    })
    .returning();
  return { userId: u?.id ?? "", accountId: a?.id ?? "", botId: b?.id ?? "" };
}

/** Một fill có notional `usd` (giá 100 000), `daysAgo` ngày trước NOW. */
async function fill(s: { accountId: string; botId: string }, usd: number, daysAgo: number) {
  const [o] = await db
    .insert(orders)
    .values({
      botId: s.botId,
      sodexAccountId: s.accountId,
      clOrdId: `c-${String(Math.random())}`,
      market: "BTC-USD",
      engine: "perps",
      side: "buy",
      type: "limit",
      timeInForce: "GTX",
      size: String(usd / 100_000),
      status: "filled",
      tag: "vm",
      epoch: 1,
    })
    .returning();
  await db.insert(fills).values({
    orderId: o?.id ?? "",
    sodexTradeId: BigInt(Math.floor(Math.random() * 1e12)),
    price: "100000",
    size: String(usd / 100_000),
    fee: "0",
    isMaker: true,
    filledAt: new Date(NOW - daysAgo * DAY),
  });
}

const rateOf = async (userId: string, strategy = "volume_maker") =>
  builderFeeRateFor(strategy, (await builderFeeOverridesOf(db, [userId])).get(userId));
const events = async (botId: string) =>
  (await db.select().from(botEvents).where(eq(botEvents.botId, botId))).filter(
    (e) => e.decision === "Builder fee changed",
  );

/** Thông báo `jobs.notify` đã ghi vào outbox cho user. */
const notices = async (userId: string) =>
  (
    await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(and(eq(outbox.topic, "jobs.notify"), sql`${outbox.payload}->>'userId' = ${userId}`))
  ).map((r) => r.payload);

describe("builder fee tiers (DEC-258)", () => {
  it("puts Market Making volume into tiers: under 200K 0.3 bp, from 200K 0.2 bp, from 1M 0.1 bp", async () => {
    const small = await seed();
    await fill(small, 199_000, 1);
    const mid = await seed();
    await fill(mid, 150_000, 2);
    await fill(mid, 50_000, 3);
    const big = await seed();
    await fill(big, 1_000_000, 5);
    await refreshFeeTiers(db, NOW);
    expect(await rateOf(small.userId)).toBe(3);
    expect(await rateOf(mid.userId)).toBe(2);
    expect(await rateOf(big.userId)).toBe(1);
    // Mặc định không có dòng; bậc thấp hơn có dòng kèm volume.
    expect(
      await db.select().from(userFeeTiers).where(eq(userFeeTiers.userId, small.userId)),
    ).toEqual([]);
    const [row] = await db.select().from(userFeeTiers).where(eq(userFeeTiers.userId, mid.userId));
    expect(Number(row?.volume)).toBe(200_000);
    expect((await events(mid.botId))[0]?.why).toBe(
      "Your 30-day Market Making volume reached 200,000 USDC, so the rate is now 0.002% (was 0.003%). New orders use it.",
    );
    expect(await events(small.botId)).toEqual([]);
  });

  it("counts only the last 30 days of real-money Market Making volume", async () => {
    const old = await seed();
    await fill(old, 500_000, 31);
    const paper = await seed("volume_maker", "paper");
    await fill(paper, 500_000, 1);
    const grid = await seed("futures_grid");
    await fill(grid, 500_000, 1);
    await refreshFeeTiers(db, NOW);
    expect(await rateOf(old.userId)).toBe(3);
    expect(await rateOf(paper.userId)).toBe(3);
    expect(await rateOf(grid.userId, "futures_grid")).toBe(10);
  });

  it("drops back to the default when volume falls, and tells the running bot", async () => {
    const s = await seed();
    await fill(s, 300_000, 25);
    await refreshFeeTiers(db, NOW);
    expect(await rateOf(s.userId)).toBe(2);
    // 10 ngày sau, fill cũ ra khỏi cửa sổ 30 ngày.
    await refreshFeeTiers(db, NOW + 10 * DAY);
    expect(await rateOf(s.userId)).toBe(3);
    expect(await db.select().from(userFeeTiers).where(eq(userFeeTiers.userId, s.userId))).toEqual(
      [],
    );
    expect((await events(s.botId)).map((e) => e.why)).toContain(
      "Your 30-day Market Making volume fell to 0 USDC, so the rate is now 0.003% (was 0.002%). New orders use it.",
    );
  });

  it("keeps a rate the team set by hand and does not announce tier changes for it (DEC-159)", async () => {
    const s = await seed();
    await db
      .insert(userBuilderFees)
      .values({ userId: s.userId, strategy: "volume_maker", rate: 5, updatedBy: s.userId });
    await fill(s, 2_000_000, 1);
    await refreshFeeTiers(db, NOW);
    expect(await rateOf(s.userId)).toBe(5);
    expect(await events(s.botId)).toEqual([]);
    // Mức đặt tay (source = custom): không bao giờ gửi thông báo bậc.
    expect(await notices(s.userId)).toEqual([]);
  });

  it("does nothing new on a second run with the same volume", async () => {
    const s = await seed();
    await fill(s, 250_000, 1);
    await refreshFeeTiers(db, NOW);
    await refreshFeeTiers(db, NOW + 60_000);
    expect(await events(s.botId)).toHaveLength(1);
  });

  it("tells the user once when the tier changes, in the same run, with a per-day dedupe key", async () => {
    const s = await seed();
    await fill(s, 250_000.7, 1);
    await refreshFeeTiers(db, NOW);
    await refreshFeeTiers(db, NOW + 60_000);
    expect(await notices(s.userId)).toEqual([
      {
        userId: s.userId,
        type: "fee_tier_changed",
        data: {
          strategy: "volume_maker",
          rate: 2,
          previousRate: 3,
          volume: "250000.7",
          droppedBelow: null,
        },
        dedupeKey: "fee_tier_changed:volume_maker:2026-11-16",
      },
    ]);
    expect(feeTierDedupeKey("volume_maker", NOW)).toBe("fee_tier_changed:volume_maker:2026-11-16");
  });

  it("names the tier the user fell out of when the rate goes back up", async () => {
    const s = await seed();
    await fill(s, 1_200_000, 25);
    await fill(s, 300_000, 1);
    await refreshFeeTiers(db, NOW);
    expect(await rateOf(s.userId)).toBe(1);
    // 10 ngày sau: fill 1,2M ra khỏi cửa sổ, còn 300K → bậc 0.2 bp.
    await refreshFeeTiers(db, NOW + 10 * DAY);
    expect(await rateOf(s.userId)).toBe(2);
    const raised = (await notices(s.userId)).find(
      (p) => (p as { data: { rate: number } }).data.rate === 2,
    );
    expect(raised).toMatchObject({
      data: { rate: 2, previousRate: 1, volume: "300000", droppedBelow: "1000000" },
      dedupeKey: "fee_tier_changed:volume_maker:2026-11-26",
    });
  });

  it("tells a user with no running bot too, since the next bot uses the new rate", async () => {
    const s = await seed();
    await db.update(bots).set({ state: "stopped" }).where(eq(bots.id, s.botId));
    await fill(s, 250_000, 1);
    await refreshFeeTiers(db, NOW);
    expect(await events(s.botId)).toEqual([]);
    expect(await notices(s.userId)).toHaveLength(1);
  });
});
