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

  it("sends MCP alerts to the team with masked emails only (DEC-225)", async () => {
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

  it("sends a new SoDEX market alert with the market names and asset map version only (#311)", async () => {
    const lead = await user({ role: "team", telegram: "active" });
    expect(
      await handleTeamOps(
        { db, telegramEnabled: true },
        {
          type: "team_sr_new_market",
          markets: ["XYZ-USD", "ABC-USD"],
          total: 14,
          assetMapVersion: "assets-2026-11-19a",
        },
      ),
    ).toBeGreaterThan(0);
    const row = (await queuedFor([lead])).find((r) => r.type === "team_sr_new_market");
    expect(row?.payload).toEqual({
      markets: "XYZ-USD, ABC-USD",
      total: 14,
      version: "assets-2026-11-19a",
    });
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

describe("team incidents (#241)", () => {
  /** Redis giả: khoá chặn lặp có hạn, bộ đếm. */
  const memoryStore = (now: () => number) => {
    const keys = new Map<string, number>();
    const counts = new Map<string, number>();
    return {
      keys,
      counts,
      store: {
        claim: (key: string, ms: number) => {
          const until = keys.get(key);
          if (until !== undefined && until > now()) return Promise.resolve(false);
          keys.set(key, now() + ms);
          return Promise.resolve(true);
        },
        release: (key: string) => {
          keys.delete(key);
          return Promise.resolve();
        },
        incr: (key: string) => {
          counts.set(key, (counts.get(key) ?? 0) + 1);
          return Promise.resolve();
        },
      },
    };
  };

  it("sends a critical incident once per bot per 10 minutes, counts every one, and never adds PII", async () => {
    const lead = await user({ role: "team", telegram: "active" });
    const customer = await user({ email: "secret.person@example.com" });
    const live = await bot(customer, "live");
    let clock = Date.parse("2026-11-18T03:00:00Z");
    const mem = memoryStore(() => clock);
    const deps = { db, telegramEnabled: true, incidents: mem.store, now: () => clock };
    const e = {
      type: "team_incident" as const,
      kind: "close_failed" as const,
      botId: live,
      market: "BTC-USD",
      detail: "BTC-USD position still open · close order not sent (timeout)",
    };
    expect(await handleTeamOps(deps, e)).toBeGreaterThan(0);
    // Lặp trong 10 phút: không gửi, vẫn đếm.
    clock += 5 * 60_000;
    expect(await handleTeamOps(deps, e)).toBe(0);
    // Bot khác / market khác: không bị chặn chung.
    const other = await bot(customer, "live");
    expect(await handleTeamOps(deps, { ...e, botId: other })).toBeGreaterThan(0);
    clock += 6 * 60_000;
    expect(await handleTeamOps(deps, e)).toBeGreaterThan(0);
    const hour = Math.floor(Date.parse("2026-11-18T03:00:00Z") / 3_600_000);
    expect(mem.counts.get(`team:incident_count:${String(hour)}:close_failed`)).toBe(4);

    const rows = (await queuedFor([lead])).filter((r) => r.type === "team_incident");
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => (r.payload as { botId: string }).botId === live)?.payload).toEqual({
      kind: "close_failed",
      severity: "critical",
      botId: live,
      userId: customer,
      strategy: "futures_grid",
      market: "BTC-USD",
      detail: "BTC-USD position still open · close order not sent (timeout)",
    });
    const text = JSON.stringify(rows.map((r) => r.payload));
    expect(text).not.toContain("secret.person");
    expect(text.toLowerCase()).not.toContain(WALLET.toLowerCase());
    expect(text).not.toContain("BTC <Grid>");
  });

  it("never throttles position mismatch / matched: mismatch → matched → mismatch within 10 minutes all go out", async () => {
    const lead = await user({ role: "team", telegram: "active" });
    const customer = await user({});
    const live = await bot(customer, "live");
    let clock = Date.parse("2026-11-18T04:00:00Z");
    const mem = memoryStore(() => clock);
    const deps = { db, telegramEnabled: true, incidents: mem.store, now: () => clock };
    const base = { type: "team_incident" as const, botId: live, market: "BTC-USD" };
    const seq = [
      { ...base, kind: "position_mismatch" as const, detail: "real 5 vs ledger 2 · cause trades" },
      { ...base, kind: "position_matched" as const, detail: "real 2 matches the ledger" },
      { ...base, kind: "position_mismatch" as const, detail: "real 3 vs ledger 2 · cause trades" },
    ];
    for (const e of seq) {
      expect(await handleTeamOps(deps, e)).toBeGreaterThan(0);
      clock += 2 * 60_000;
    }
    expect(mem.keys.size).toBe(0);
    const rows = (await queuedFor([lead]))
      .filter((r) => (r.payload as { botId?: string }).botId === live)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    expect(rows.map((r) => (r.payload as { detail: string }).detail)).toEqual(
      seq.map((e) => e.detail),
    );
  });

  it("throttles warnings per type for 30 minutes and releases the claim when the fan-out fails", async () => {
    await user({ role: "team", telegram: "active" });
    let clock = Date.parse("2026-11-18T05:00:00Z");
    const mem = memoryStore(() => clock);
    const deps = { db, telegramEnabled: true, incidents: mem.store, now: () => clock };
    const slow = { type: "team_incident" as const, kind: "tick_slow" as const, detail: "3 slow" };
    expect(await handleTeamOps(deps, slow)).toBeGreaterThan(0);
    clock += 29 * 60_000;
    expect(await handleTeamOps(deps, slow)).toBe(0);
    // Loại khác không bị chặn chung.
    expect(
      await handleTeamOps(deps, { ...slow, kind: "shard_lost", detail: "1 shard lost" }),
    ).toBeGreaterThan(0);
    clock += 2 * 60_000;
    // Fan-out lỗi: khoá được nhả để lần giao lại vẫn gửi.
    const broken = {
      ...deps,
      db: {
        select: () => {
          throw new Error("db down");
        },
      } as unknown as Db,
    };
    await expect(handleTeamOps(broken, slow)).rejects.toThrow("db down");
    expect(mem.keys.has("team:incident:tick_slow")).toBe(false);
    expect(await handleTeamOps(deps, slow)).toBeGreaterThan(0);
  });

  it("still sends when Redis fails, and counts but sends nothing when Telegram is off", async () => {
    const lead = await user({ role: "team", telegram: "active" });
    const failing = {
      claim: () => Promise.reject(new Error("redis down")),
      release: () => Promise.resolve(),
      incr: () => Promise.reject(new Error("redis down")),
    };
    const warned: string[] = [];
    const e = { type: "team_incident" as const, kind: "ws_closes" as const, detail: "12 closes" };
    expect(
      await handleTeamOps(
        { db, telegramEnabled: true, incidents: failing, warn: (m) => warned.push(m) },
        e,
      ),
    ).toBeGreaterThan(0);
    expect(warned).toEqual(["team incident count failed", "team incident throttle failed"]);
    const mem = memoryStore(() => 0);
    const before = (await queuedFor([lead])).length;
    expect(await handleTeamOps({ db, telegramEnabled: false, incidents: mem.store }, e)).toBe(0);
    expect(mem.counts.size).toBe(1);
    expect(await queuedFor([lead])).toHaveLength(before);
  });

  it("sends the digest counts as they are", async () => {
    const lead = await user({ role: "team", telegram: "active" });
    await handleTeamOps(
      { db, telegramEnabled: true },
      { type: "team_incident_digest", counts: { tick_slow: 3, late_fill: 1 } },
    );
    const [d] = (await queuedFor([lead])).filter((r) => r.type === "team_incident_digest");
    expect(d?.payload).toEqual({ tick_slow: 3, late_fill: 1 });
  });
});
