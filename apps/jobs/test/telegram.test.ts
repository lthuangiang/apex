import {
  bots,
  createDb,
  notifications,
  notificationSettings,
  outbox,
  runMigrations,
  sodexAccounts,
  telegramLinks,
  users,
  type Db,
} from "@drift/db";
import { DeferError, type BotApiResult, type SendMessage } from "@drift/runtime";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleNotify } from "../src/notify";
import {
  COLLECT_MS,
  handleTelegram,
  MAX_FAILURES,
  TELEGRAM_ALERT_SUBJECT,
  type Counter,
  type TelegramWorkerDeps,
} from "../src/telegram";

// Worker gửi Telegram với Postgres thật (docs/NOTIFICATIONS.md mục 5, 6; DEC-170). Bot API và Redis là giả.

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

let chatSeq = 9000;
async function seed(linked: "active" | "blocked" | null = "active") {
  const [u] = await db
    .insert(users)
    .values({ email: `${String(Math.random())}@x.test` })
    .returning();
  const userId = u?.id ?? "";
  const [a] = await db
    .insert(sodexAccounts)
    .values({
      userId,
      address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
      sodexAccountId: BigInt(Math.floor(Math.random() * 1e9)),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  const botIds: string[] = [];
  for (const name of ["Grid · BTC", "Grid · ETH", "DCA · SOL"]) {
    const [b] = await db
      .insert(bots)
      .values({
        userId,
        sodexAccountId: a?.id ?? "",
        strategy: "spot_grid",
        market: "vBTC_vUSDC",
        engine: "spot",
        name,
        state: "paused",
      })
      .returning();
    botIds.push(b?.id ?? "");
  }
  chatSeq += 1;
  if (linked !== null)
    await db
      .insert(telegramLinks)
      .values({ userId, chatId: chatSeq, status: linked, connectedAt: new Date() });
  return { userId, botIds, chatId: chatSeq };
}

function fakeDeps(results: BotApiResult[] = [], offsetMs = COLLECT_MS + 1_000) {
  const sent: SendMessage[] = [];
  const counts = new Map<string, number>();
  const counter: Counter = {
    incr(key) {
      const v = (counts.get(key) ?? 0) + 1;
      counts.set(key, v);
      return Promise.resolve(v);
    },
  };
  const deps: TelegramWorkerDeps = {
    db,
    counter,
    botApi: {
      sendMessage: (m) => {
        sent.push(m);
        return Promise.resolve(results.shift() ?? { ok: true });
      },
    },
    appUrl: "https://desklabs.test",
    // created_at là giờ của Postgres; lệch thêm để đã qua cửa sổ gom.
    now: () => new Date(Date.now() + offsetMs),
    warn: () => undefined,
  };
  return { deps, sent };
}

async function enqueued(userId: string) {
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.channel, "telegram")));
  const jobs = await db.select().from(outbox);
  const ids = new Set(rows.map((r) => r.id));
  return {
    rows,
    jobs: jobs.filter((j) => ids.has((j.payload as { notificationId: string }).notificationId)),
  };
}

describe("jobs.notify → Telegram queue", () => {
  it("queues bot problems on the priority subject for an active chat", async () => {
    const s = await seed();
    await handleNotify(
      { db, sendEmail: null, telegramEnabled: true },
      {
        userId: s.userId,
        type: "bot_paused",
        data: { botId: s.botIds[0], reasonCode: "STOP_LOSS" },
      },
    );
    const q = await enqueued(s.userId);
    expect(q.rows).toHaveLength(1);
    expect(q.rows[0]?.deliveryStatus).toBe("queued");
    expect(q.jobs.map((j) => j.topic)).toEqual([TELEGRAM_ALERT_SUBJECT]);
  });

  it("does not queue when Telegram is off, the chat is blocked or missing, or the group is off", async () => {
    const off = await seed();
    await handleNotify(
      { db, sendEmail: null, telegramEnabled: false },
      { userId: off.userId, type: "bot_paused", data: {} },
    );
    expect((await enqueued(off.userId)).rows).toHaveLength(0);
    const blocked = await seed("blocked");
    await handleNotify(
      { db, sendEmail: null, telegramEnabled: true },
      { userId: blocked.userId, type: "bot_paused", data: {} },
    );
    expect((await enqueued(blocked.userId)).rows).toHaveLength(0);
    const none = await seed(null);
    await handleNotify(
      { db, sendEmail: null, telegramEnabled: true },
      { userId: none.userId, type: "bot_paused", data: {} },
    );
    expect((await enqueued(none.userId)).rows).toHaveLength(0);
    // `fills` mặc định tắt trên Telegram (mục 4).
    const fills = await seed();
    await handleNotify(
      { db, sendEmail: null, telegramEnabled: true },
      { userId: fills.userId, type: "fill", data: {} },
    );
    expect((await enqueued(fills.userId)).rows).toHaveLength(0);
  });

  it("queues a copy bot alert once per dedupe key (DEC-TBD-copy-bot-alerts)", async () => {
    const s = await seed();
    await db
      .insert(notificationSettings)
      .values({ userId: s.userId, type: "copyTrading", channel: "telegram", enabled: true });
    const msg = {
      userId: s.userId,
      type: "copy_bot_opened",
      data: { botId: s.botIds[0], clOrdID: "c1", market: "BTC-USD" },
      dedupeKey: `copy_bot_opened:${s.botIds[0] ?? ""}:c1`,
    };
    await handleNotify({ db, sendEmail: null, telegramEnabled: true }, msg);
    await handleNotify({ db, sendEmail: null, telegramEnabled: true }, msg);
    const q = await enqueued(s.userId);
    expect(q.rows).toHaveLength(1);
    expect(q.jobs).toHaveLength(1);
  });

  it("bot problems still go to Telegram when the user tried to turn them off", async () => {
    const s = await seed();
    await pool.query(
      "insert into notification_settings (user_id, type, channel, enabled) values ($1, 'botErrors', 'telegram', false)",
      [s.userId],
    );
    await handleNotify(
      { db, sendEmail: null, telegramEnabled: true },
      { userId: s.userId, type: "unknown_order", data: {} },
    );
    expect((await enqueued(s.userId)).rows).toHaveLength(1);
  });
});

describe("handleTelegram", () => {
  async function queueThree(s: Awaited<ReturnType<typeof seed>>) {
    for (const botId of s.botIds)
      await handleNotify(
        { db, sendEmail: null, telegramEnabled: true },
        {
          userId: s.userId,
          type: "bot_paused",
          data: { botId, reasonCode: "BUILDER_FEE_REVOKED" },
        },
      );
    return (await enqueued(s.userId)).rows;
  }

  it("waits for the 5 s collect window, then sends one merged message and marks all sent", async () => {
    const s = await seed();
    const rows = await queueThree(s);
    const early = fakeDeps([], 0);
    await expect(
      handleTelegram(early.deps, { notificationId: rows[0]?.id }, true),
    ).rejects.toBeInstanceOf(DeferError);
    expect(early.sent).toHaveLength(0);

    const { deps, sent } = fakeDeps();
    await handleTelegram(deps, { notificationId: rows[0]?.id }, true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chat_id).toBe(s.chatId);
    expect(sent[0]?.text).toBe("🔴 <b>3 bots paused: builder fee approval is 0.</b>");
    expect(sent[0]?.reply_markup?.inline_keyboard[0][0].url).toBe("https://desklabs.test/agent");
    const after = (await enqueued(s.userId)).rows;
    expect(after.every((r) => r.deliveryStatus === "sent")).toBe(true);

    // Các message còn lại của cùng gói: đã gửi trong tin gộp, không gửi lại (idempotent).
    for (const r of rows.slice(1)) await handleTelegram(deps, { notificationId: r.id }, true);
    expect(sent).toHaveLength(1);
  });

  it("holds the next event of the same group until the 60 s window ends", async () => {
    const s = await seed();
    const rows = await queueThree(s);
    const { deps } = fakeDeps();
    await handleTelegram(deps, { notificationId: rows[0]?.id }, true);
    await handleNotify(
      { db, sendEmail: null, telegramEnabled: true },
      { userId: s.userId, type: "bot_stopped", data: { botId: s.botIds[0] } },
    );
    const next = (await enqueued(s.userId)).rows.find((r) => r.deliveryStatus === "queued");
    await expect(handleTelegram(deps, { notificationId: next?.id }, true)).rejects.toBeInstanceOf(
      DeferError,
    );
  });

  it("403 marks the chat blocked, stops, and tells the user in the app once", async () => {
    const s = await seed();
    const rows = await queueThree(s);
    const { deps } = fakeDeps([
      {
        ok: false,
        status: 403,
        description: "Forbidden: bot was blocked by the user",
        retryAfterSec: null,
      },
    ]);
    await handleTelegram(deps, { notificationId: rows[0]?.id }, true);
    const [link] = await db.select().from(telegramLinks).where(eq(telegramLinks.userId, s.userId));
    expect(link?.status).toBe("blocked");
    expect(link?.blockedAt).not.toBeNull();
    const after = (await enqueued(s.userId)).rows;
    expect(after.every((r) => r.deliveryStatus === "failed")).toBe(true);
    const notes = await db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, s.userId), eq(notifications.type, "telegram_blocked")));
    expect(notes.map((n) => n.channel)).toEqual(["in_app"]);
  });

  it("429 waits retry_after and keeps the messages queued", async () => {
    const s = await seed();
    const rows = await queueThree(s);
    const { deps } = fakeDeps([
      { ok: false, status: 429, description: "Too Many Requests: retry after 7", retryAfterSec: 7 },
    ]);
    const err = await handleTelegram(deps, { notificationId: rows[0]?.id }, true).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DeferError);
    expect((err as DeferError).delayMs).toBe(7_000);
    expect((await enqueued(s.userId)).rows.every((r) => r.deliveryStatus === "queued")).toBe(true);
  });

  it("5xx retries up to 5 times, then marks failed", async () => {
    const s = await seed();
    const rows = await queueThree(s);
    const fail = {
      ok: false,
      status: 502,
      description: "Bad Gateway",
      retryAfterSec: null,
    } as const;
    const { deps } = fakeDeps(Array.from({ length: MAX_FAILURES }, () => fail));
    for (let i = 1; i < MAX_FAILURES; i += 1) {
      // Mỗi lần thử ở một giây khác để không vướng giới hạn 1 tin/giây/chat.
      const at = Date.now() + COLLECT_MS + 1_000 + i * 1_100;
      await expect(
        handleTelegram({ ...deps, now: () => new Date(at) }, { notificationId: rows[0]?.id }, true),
      ).rejects.toThrow(/telegram send failed/);
    }
    const last = Date.now() + COLLECT_MS + 1_000 + MAX_FAILURES * 1_100;
    await handleTelegram(
      { ...deps, now: () => new Date(last) },
      { notificationId: rows[0]?.id },
      true,
    );
    expect((await enqueued(s.userId)).rows.every((r) => r.deliveryStatus === "failed")).toBe(true);
  });

  it("never sends the system group (telegram_*) to Telegram", async () => {
    const s = await seed();
    await handleNotify(
      { db, sendEmail: null, telegramEnabled: true },
      { userId: s.userId, type: "telegram_connected", data: {} },
    );
    expect((await enqueued(s.userId)).rows).toHaveLength(0);
  });
});
