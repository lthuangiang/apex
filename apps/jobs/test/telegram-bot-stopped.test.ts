import {
  botEvents,
  botRuntime,
  bots,
  botVersions,
  createDb,
  notifications,
  runMigrations,
  sodexAccounts,
  telegramLinks,
  users,
  type Db,
} from "@drift/db";
import type { SendMessage } from "@drift/runtime";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleNotify } from "../src/notify";
import { loadStoppedRun } from "../src/stopped-run";
import { COLLECT_MS, handleTelegram, type TelegramWorkerDeps } from "../src/telegram";

// Tin bot dừng đúng kế hoạch đọc số liệu phiên từ Postgres thật (#566): cùng fact với Trading Agent. Bot API và Redis giả.

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

const H = 3_600_000;
let chatSeq = 70_000;

/** Bot Market Making đã dừng vì chạm cost limit sau 6h 12m, cost 25 USDC trên 1.24M volume. */
async function seedStoppedMm(state: "stopped" | "running" = "stopped") {
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
  const [b] = await db
    .insert(bots)
    .values({
      userId,
      sodexAccountId: a?.id ?? "",
      strategy: "volume_maker",
      market: "ETH-USD",
      engine: "perps",
      name: "ETH Market Making",
      state,
      reasonCode: state === "stopped" ? "BUDGET_DONE" : null,
    })
    .returning();
  const botId = b?.id ?? "";
  const [v] = await db
    .insert(botVersions)
    .values({
      botId,
      version: 1,
      config: { market: "ETH-USD", costBudget: "25" },
      paramSource: "manual",
      status: "active",
      appliedAt: new Date(),
    })
    .returning();
  await db
    .update(bots)
    .set({ activeVersionId: v?.id ?? null })
    .where(eq(bots.id, botId));
  await db.insert(botRuntime).values({
    botId,
    versionId: v?.id ?? "",
    epoch: 1,
    state: {
      mid: null,
      volume: "1240000",
      makerVolume: "1000000",
      ledger: { position: "0", avgCost: "0", realized: "-5", fees: "20", funding: "0" },
    },
  });
  const start = new Date(Date.now() - 7 * H);
  await db.insert(botEvents).values([
    { botId, type: "state", decision: "Running", occurredAt: start },
    {
      botId,
      type: "state",
      decision: "Stopped",
      why: "BUDGET_DONE",
      occurredAt: new Date(start.getTime() + 6 * H + 12 * 60_000),
    },
  ]);
  chatSeq += 1;
  await db
    .insert(telegramLinks)
    .values({ userId, chatId: chatSeq, status: "active", connectedAt: new Date() });
  return { userId, botId };
}

function fakeDeps() {
  const sent: SendMessage[] = [];
  const deps: TelegramWorkerDeps = {
    db,
    counter: { incr: () => Promise.resolve(1) },
    botApi: {
      sendMessage: (m) => {
        sent.push(m);
        return Promise.resolve({ ok: true });
      },
    },
    appUrl: "https://desklabs.test",
    now: () => new Date(Date.now() + COLLECT_MS + 1_000),
    warn: () => undefined,
  };
  return { deps, sent };
}

async function sendStopped(userId: string, botId: string) {
  await handleNotify(
    { db, sendEmail: null, telegramEnabled: true },
    { userId, type: "bot_stopped", data: { botId, reasonCode: "BUDGET_DONE" } },
  );
  const [n] = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.channel, "telegram")));
  const { deps, sent } = fakeDeps();
  await handleTelegram(deps, { notificationId: n?.id }, true);
  return sent;
}

describe("bot_stopped planned stop with run facts (#566)", () => {
  it("sends the approved message with the Trading Agent's numbers", async () => {
    const s = await seedStoppedMm();
    const sent = await sendStopped(s.userId, s.botId);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(
      [
        "✅ <b>ETH Market Making stopped: cost limit reached</b>",
        "",
        "<pre>Volume   $1.24M",
        "Cost     −25.00 USDC ▼ (limit 25.00)",
        "CPM      20.16 per $1M",
        "Ran      6h 12m</pre>",
      ].join("\n"),
    );
    expect(sent[0]?.reply_markup?.inline_keyboard[0][0]).toEqual({
      text: "Open Trading Agent",
      url: `https://desklabs.test/agent/${s.botId}`,
    });
  });

  it("no numbers when the bot no longer is stopped with that reason (restarted while waiting)", async () => {
    const s = await seedStoppedMm("running");
    expect(await loadStoppedRun(db, s.userId, s.botId, "BUDGET_DONE")).toBeNull();
    const sent = await sendStopped(s.userId, s.botId);
    expect(sent[0]?.text).toBe("✅ <b>ETH Market Making stopped: budget used</b>");
  });

  it("never reads another user's bot", async () => {
    const s = await seedStoppedMm();
    const other = await seedStoppedMm();
    expect(await loadStoppedRun(db, other.userId, s.botId, "BUDGET_DONE")).toBeNull();
  });
});
