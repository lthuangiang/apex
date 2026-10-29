import {
  bots,
  createDb,
  notifications,
  notificationSettings,
  runMigrations,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleNotify } from "../src/notify";

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

async function seed() {
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
      strategy: "spot_grid",
      market: "vBTC_vUSDC",
      engine: "spot",
      name: "Grid · BTC",
      state: "paused",
    })
    .returning();
  return { userId: u?.id ?? "", email: u?.email ?? "", accountId: a?.id ?? "", botId: b?.id ?? "" };
}

describe("jobs.notify", () => {
  it("always delivers bot errors in-app and by email, even if the user tried to turn them off", async () => {
    const { userId, email, accountId, botId } = await seed();
    await db
      .insert(notificationSettings)
      .values({ userId, type: "botErrors", channel: "email", enabled: false });
    const sent: string[] = [];
    await handleNotify(
      {
        db,
        sendEmail: (to, subject, text) =>
          Promise.resolve(void sent.push(`${to}|${subject}|${text}`)),
      },
      {
        sodexAccountId: accountId,
        type: "bot_paused",
        data: { botId, reasonCode: "RISK_DAILY_LOSS" },
      },
    );
    const rows = await db.select().from(notifications).where(eq(notifications.userId, userId));
    expect(rows.map((r) => r.channel).sort()).toEqual(["email", "in_app"]);
    expect(sent).toEqual([
      `${email}|DRIFT: Grid · BTC paused|Grid · BTC was paused: daily loss limit reached. Open orders were kept. Open DRIFT to review it.`,
    ]);
  });

  it("respects the user's settings for optional groups", async () => {
    const { userId } = await seed();
    const sent: string[] = [];
    const send = (to: string) => Promise.resolve(void sent.push(to));
    await handleNotify({ db, sendEmail: send }, { userId, type: "fill", data: {} });
    expect(
      await db.select().from(notifications).where(eq(notifications.userId, userId)),
    ).toHaveLength(0);
    await db
      .insert(notificationSettings)
      .values({ userId, type: "fills", channel: "in_app", enabled: true });
    await handleNotify({ db, sendEmail: send }, { userId, type: "fill", data: {} });
    expect(
      (await db.select().from(notifications).where(eq(notifications.userId, userId))).map(
        (r) => r.channel,
      ),
    ).toEqual(["in_app"]);
    expect(sent).toEqual([]);
  });
});
