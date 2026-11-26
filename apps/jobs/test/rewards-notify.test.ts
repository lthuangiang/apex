import {
  createDb,
  notifications,
  outbox,
  runMigrations,
  telegramLinks,
  users,
  type Db,
} from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleNotify } from "../src/notify";
import { TELEGRAM_SUBJECT } from "../src/telegram";

// #558 (DEC-398, chủ sản phẩm chốt 2026-11-26): nhóm `rewards` mặc định in-app bật, Telegram bật khi đã kết nối, email
// tắt. Postgres thật qua Testcontainers (CI).

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

let chat = 5000;
async function user(telegram: boolean) {
  const [u] = await db
    .insert(users)
    .values({ email: `rw-notify-${String(Math.random())}@x.test` })
    .returning();
  const userId = u?.id ?? "";
  chat += 1;
  if (telegram)
    await db
      .insert(telegramLinks)
      .values({ userId, chatId: chat, status: "active", connectedAt: new Date() });
  return userId;
}

const emails: string[] = [];
// `db` gán trong beforeAll: mỗi lần gọi truyền `{ ...deps, db }`.
const deps = {
  sendEmail: (to: string) => {
    emails.push(to);
    return Promise.resolve();
  },
  telegramEnabled: true,
};

const channels = async (userId: string) =>
  (await db.select().from(notifications).where(eq(notifications.userId, userId)))
    .map((n) => n.channel)
    .sort();

describe("rewards notification defaults", () => {
  it("sends in-app and Telegram by default when Telegram is connected, no email", async () => {
    const userId = await user(true);
    await handleNotify(
      { ...deps, db },
      { userId, type: "rewards_claimable", data: { count: 3 }, dedupeKey: "rw:claim:8" },
    );
    expect(await channels(userId)).toEqual(["in_app", "telegram"]);
    expect(emails).toEqual([]);
    const queued = await db.select().from(outbox).where(eq(outbox.topic, TELEGRAM_SUBJECT));
    expect(queued.length).toBeGreaterThan(0);
  });

  it("sends in-app only when Telegram is not connected", async () => {
    const userId = await user(false);
    await handleNotify(
      { ...deps, db },
      {
        userId,
        type: "rewards_box_received",
        data: { count: 1, levels: [] },
        dedupeKey: "rw:recv:1",
      },
    );
    expect(await channels(userId)).toEqual(["in_app"]);
    expect(emails).toEqual([]);
  });

  it("does not resend the same event (dedupeKey)", async () => {
    const userId = await user(true);
    const payload = {
      userId,
      type: "rewards_draw_won",
      data: { round: 10, boxes: 1, wins: 1, tickets: 27 },
      dedupeKey: "rw:prize:10:1",
    };
    await handleNotify({ ...deps, db }, payload);
    await handleNotify({ ...deps, db }, payload);
    expect(await channels(userId)).toEqual(["in_app", "telegram"]);
  });
});
