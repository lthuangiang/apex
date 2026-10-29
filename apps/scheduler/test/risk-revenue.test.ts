import {
  bots,
  builderBalanceSnapshots,
  builderRevenueDaily,
  createDb,
  equitySnapshots,
  fills,
  orders,
  outbox,
  riskAlerts,
  riskLimits,
  runMigrations,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileDay } from "../src/builder-revenue";
import { snapshotAndCheck } from "../src/risk";

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
const NOW = Date.parse("2026-10-28T10:00:00Z");

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

async function seed() {
  const [u] = await db
    .insert(users)
    .values({ email: `${String(Math.random())}@x.test`, timezone: "Asia/Ho_Chi_Minh" })
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
      strategy: "spot_grid",
      market: "vBTC_vUSDC",
      engine: "spot",
      name: "Grid",
      state: "running",
    })
    .returning();
  return { userId: u?.id ?? "", accountId: a?.id ?? "", botId: b?.id ?? "" };
}

const rest = (usdc: string) => ({
  getSpotBalances: () => Promise.resolve([{ coin: "vUSDC", total: usdc, locked: "0" }]),
  getPerpsAccountState: () =>
    Promise.resolve({ av: "0", am: "0", ami: null, im: "0", cm: "0", B: [], P: [], S: [] }),
});

describe("risk engine", () => {
  it("snapshots equity and pauses running bots once the daily loss limit is reached", async () => {
    const { accountId, botId } = await seed();
    await db
      .insert(riskLimits)
      .values({ sodexAccountId: accountId, dailyLossPct: "3", maxDrawdownPct: "10", enforced: {} });
    // Đầu ngày (UTC+7) equity 10,000; giờ còn 9,650 → lỗ 3.5% ≥ 3%.
    await db.insert(equitySnapshots).values({
      sodexAccountId: accountId,
      at: new Date(Date.parse("2026-10-27T16:59:00Z")),
      equity: "10000",
    });
    const r = await snapshotAndCheck({
      db,
      rest: rest("9650"),
      prices: () => Promise.resolve({}),
      now: () => NOW,
    });
    expect(r.paused).toBe(1);
    const [b] = await db.select().from(bots).where(eq(bots.id, botId));
    expect(b).toMatchObject({ state: "paused", reasonCode: "RISK_DAILY_LOSS" });
    const alerts = await db
      .select()
      .from(riskAlerts)
      .where(eq(riskAlerts.sodexAccountId, accountId));
    expect(alerts.map((x) => x.kind)).toEqual(["daily_loss"]);
    const notes = (await db.select().from(outbox)).filter((o) => o.topic === "jobs.notify");
    expect(notes.length).toBeGreaterThan(0);
    // Chạy lại: không tạo alert trùng.
    await snapshotAndCheck({
      db,
      rest: rest("9650"),
      prices: () => Promise.resolve({}),
      now: () => NOW + 60_000,
    });
    expect(
      await db.select().from(riskAlerts).where(eq(riskAlerts.sodexAccountId, accountId)),
    ).toHaveLength(1);
  });

  it("leaves coins without a price out of equity instead of guessing", async () => {
    const { accountId } = await seed();
    await snapshotAndCheck({
      db,
      rest: {
        ...rest("100"),
        getSpotBalances: () =>
          Promise.resolve([
            { coin: "vUSDC", total: "100", locked: "0" },
            { coin: "WSOSO", total: "5", locked: "0" },
          ]),
      },
      prices: () => Promise.resolve({}),
      now: () => NOW + 120_000,
    });
    const rows = await db
      .select()
      .from(equitySnapshots)
      .where(eq(equitySnapshots.sodexAccountId, accountId));
    expect(rows.map((r) => Number(r.equity))).toEqual([100]);
  });
});

describe("builder revenue reconciliation", () => {
  it("matches fill builder fees with the builder balance change and holds differences pending", async () => {
    const { botId, accountId } = await seed();
    const mk = async (
      engine: "spot" | "perps",
      clOrdId: string,
      tradeId: bigint,
      builderFee: string,
      at: string,
    ) => {
      const [o] = await db
        .insert(orders)
        .values({
          botId,
          sodexAccountId: accountId,
          clOrdId,
          market: "m",
          engine,
          side: "sell",
          type: "limit",
          timeInForce: "GTC",
          size: "1",
          status: "filled",
          reduceOnly: false,
          tag: "t",
          epoch: 1,
        })
        .returning();
      await db.insert(fills).values({
        orderId: o?.id ?? "",
        sodexTradeId: tradeId,
        price: "100",
        size: "1",
        fee: "0.1",
        builderFee,
        filledAt: new Date(at),
      });
    };
    await mk("perps", "a1", 1n, "40.00", "2026-10-24T03:00:00Z");
    await mk("perps", "a2", 2n, "37.90", "2026-10-24T20:00:00Z");
    await mk("spot", "a3", 3n, "5.00", "2026-10-24T05:00:00Z");
    await db.insert(builderBalanceSnapshots).values([
      { date: "2026-10-24", engine: "perps", balance: "1000", takenAt: new Date() },
      { date: "2026-10-25", engine: "perps", balance: "1079.10", takenAt: new Date() },
      { date: "2026-10-24", engine: "spot", balance: "200", takenAt: new Date() },
      { date: "2026-10-25", engine: "spot", balance: "205", takenAt: new Date() },
    ]);
    await reconcileDay(db, "2026-10-24");
    const rows = await db.select().from(builderRevenueDaily);
    const perps = rows.find((r) => r.engine === "perps");
    const spot = rows.find((r) => r.engine === "spot");
    expect(perps).toMatchObject({ status: "pending", fills: 2 });
    expect(Number(perps?.fromFills)).toBe(77.9);
    expect(Number(perps?.difference)).toBeCloseTo(1.2, 10);
    expect(spot).toMatchObject({ status: "matched", fills: 1 });
    expect(Number(spot?.difference)).toBe(0);
  });
});
