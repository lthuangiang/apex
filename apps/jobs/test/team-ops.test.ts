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
import type { SendMessage } from "@drift/runtime";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { handleTeamOps } from "../src/team-ops";
import { COLLECT_MS, handleTelegram, type TelegramWorkerDeps } from "../src/telegram";

// Báo team qua Telegram (docs/NOTIFICATIONS.md mục 13, DEC-184) với Postgres thật; Bot API giả.

const WALLET = "0x3e9a4c7b1d2e3f405162738495a6b7c8d9e011fd";

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

let chatSeq = 7000;
async function user(opts: {
  role?: "user" | "team";
  email?: string;
  telegram?: "active" | "blocked" | null;
}) {
  const [u] = await db
    .insert(users)
    .values({
      email: opts.email ?? `${String(Math.random())}@x.test`,
      role: opts.role ?? "user",
    })
    .returning();
  const id = u?.id ?? "";
  chatSeq += 1;
  if (opts.telegram !== null && opts.telegram !== undefined)
    await db
      .insert(telegramLinks)
      .values({ userId: id, chatId: chatSeq, status: opts.telegram, connectedAt: new Date() });
  return id;
}

async function account(userId: string) {
  const [a] = await db
    .insert(sodexAccounts)
    .values({
      userId,
      address: WALLET,
      sodexAccountId: BigInt(Math.floor(Math.random() * 1e9)),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  return a?.id ?? "";
}

async function bot(userId: string, mode: "live" | "paper") {
  const [b] = await db
    .insert(bots)
    .values({
      userId,
      sodexAccountId: await account(userId),
      strategy: "futures_grid",
      market: "BTC-USD",
      engine: "perps",
      name: "BTC <Grid>",
      state: "running",
      mode,
    })
    .returning();
  return b?.id ?? "";
}

const queuedFor = async (userIds: string[]) =>
  db
    .select()
    .from(notifications)
    .where(and(inArray(notifications.userId, userIds), eq(notifications.channel, "telegram")));

describe("team ops fan-out", () => {
  it("tells only active team members who keep it on, with masked email and wallet", async () => {
    const lead = await user({ role: "team", telegram: "active" });
    const quiet = await user({ role: "team", telegram: "active" });
    await db
      .insert(notificationSettings)
      .values({ userId: quiet, type: "teamOps", channel: "telegram", enabled: false });
    const blocked = await user({ role: "team", telegram: "blocked" });
    const customer = await user({ telegram: "active" });
    const newcomer = await user({ email: "giang.le@gmail.com" });
    const acct = await account(newcomer);

    expect(
      await handleTeamOps({ db, telegramEnabled: true }, { type: "team_signup", userId: newcomer }),
    ).toBeGreaterThan(0);
    await handleTeamOps(
      { db, telegramEnabled: true },
      { type: "team_sodex_connected", userId: newcomer, sodexAccountId: acct },
    );
    const rows = await queuedFor([lead, quiet, blocked, customer]);
    expect(rows.map((r) => r.userId).every((id) => id === lead)).toBe(true);
    expect(rows.map((r) => r.type).sort()).toEqual(["team_signup", "team_sodex_connected"]);
    const payloads = JSON.stringify(rows.map((r) => r.payload));
    expect(payloads).toContain("gi···@gmail.com");
    expect(payloads).toContain("0x3e9a…11fd");
    // Không bao giờ email hay địa chỉ ví đầy đủ.
    expect(payloads).not.toContain("giang.le@gmail.com");
    expect(payloads.toLowerCase()).not.toContain(WALLET.toLowerCase());
    expect(rows.every((r) => r.deliveryStatus === "queued")).toBe(true);
    const jobs = await db.select().from(outbox);
    const ids = new Set(rows.map((r) => r.id));
    expect(
      jobs.filter((j) => ids.has((j.payload as { notificationId: string }).notificationId)),
    ).toHaveLength(2);
  });

  it("sends MCP alerts to the team with masked emails only (DEC-TBD-mcp-monitoring)", async () => {
    const lead = await user({ role: "team", telegram: "active" });
    const heavy = await user({ email: "heavy.user@example.com" });
    const other = await user({ email: "second@example.com" });
    const teamer = await user({ role: "team", email: "ops@desklabs.test" });
    expect(
      await handleTeamOps(
        { db, telegramEnabled: true },
        { type: "team_mcp_daily_limit", userIds: [heavy, other, teamer] },
      ),
    ).toBeGreaterThan(0);
    await handleTeamOps(
      { db, telegramEnabled: true },
      { type: "team_mcp_tool_errors", calls: 25, errors: 5, pct: "20", tool: "get_bot" },
    );
    const rows = await queuedFor([lead]);
    const daily = rows.find((r) => r.type === "team_mcp_daily_limit");
    expect(daily?.payload).toMatchObject({ count: 2 });
    const text = JSON.stringify(rows.map((r) => r.payload));
    expect(text).toContain("he···@example.com");
    expect(text).not.toContain("heavy.user@example.com");
    // Tài khoản team không bao giờ được nêu.
    expect(text).not.toContain("ops@");
    expect(rows.find((r) => r.type === "team_mcp_tool_errors")?.payload).toEqual({
      calls: 25,
      errors: 5,
      pct: "20",
      tool: "get_bot",
    });
    // Chỉ user team chạm giới hạn: không báo.
    expect(
      await handleTeamOps(
        { db, telegramEnabled: true },
        { type: "team_mcp_daily_limit", userIds: [teamer] },
      ),
    ).toBe(0);
  });

  it("does not report team accounts, fake-money bots, or anything when Telegram is off", async () => {
    const lead = await user({ role: "team", telegram: "active" });
    const teammate = await user({ role: "team" });
    const customer = await user({});
    const paperBot = await bot(customer, "paper");
    const teamBot = await bot(teammate, "live");
    for (const e of [
      { type: "team_signup" as const, userId: teammate },
      { type: "team_bot_started" as const, botId: paperBot, capital: "200", capitalAsset: "USDC" },
      { type: "team_bot_started" as const, botId: teamBot, capital: "200", capitalAsset: "USDC" },
    ])
      expect(await handleTeamOps({ db, telegramEnabled: true }, e)).toBe(0);
    expect(
      await handleTeamOps(
        { db, telegramEnabled: false },
        { type: "team_signup", userId: customer },
      ),
    ).toBe(0);
    expect(await queuedFor([lead])).toEqual([]);
  });

  it("sends a started real-money bot with its name escaped, and re-checks the team role when sending", async () => {
    const lead = await user({ role: "team", telegram: "active" });
    const customer = await user({ email: "maria@example.com" });
    const live = await bot(customer, "live");
    await handleTeamOps(
      { db, telegramEnabled: true },
      { type: "team_bot_started", botId: live, capital: "200", capitalAsset: "USDC" },
    );
    const [n] = await queuedFor([lead]);
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
    await handleTelegram(deps, { notificationId: n?.id }, false);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toBe(
      "▶️ <b>Bot started</b> · ma···@example.com · BTC &lt;Grid&gt; · Futures Grid · BTC-USD · 200 USDC",
    );
    expect(sent[0]?.reply_markup?.inline_keyboard[0]?.[0]).toEqual({
      text: "Open Users",
      url: "https://desklabs.test/admin/users",
    });

    // Bị gỡ role team trong lúc chờ: không gửi nữa.
    await handleTeamOps({ db, telegramEnabled: true }, { type: "team_signup", userId: customer });
    await db.update(users).set({ role: "user" }).where(eq(users.id, lead));
    const queued = (await queuedFor([lead])).find((r) => r.deliveryStatus === "queued");
    await handleTelegram(deps, { notificationId: queued?.id }, false);
    expect(sent).toHaveLength(1);
    const [after] = await db
      .select()
      .from(notifications)
      .where(eq(notifications.id, queued?.id ?? ""));
    expect(after?.deliveryStatus).toBe("failed");
  });
});
