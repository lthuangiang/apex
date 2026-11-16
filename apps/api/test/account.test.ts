import { randomUUID } from "node:crypto";

import {
  adminUserDetailSchema,
  adminUsersViewSchema,
  builderRevenueViewSchema,
  notificationSettingsSchema,
  errorResponseSchema,
  overviewViewSchema,
  meSchema,
  platformStatsSchema,
  teamOpsViewSchema,
  portfolioResponseSchema,
  riskViewSchema,
  twoFactorSetupSchema,
  watchlistSchema,
  change24hPct,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { generateTotp } from "../src/lib/totp";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

let env: TestEnv;
const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;
const riskResponse = z.object({ risk: riskViewSchema.nullable() });

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function connected(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  const accountID = Math.floor(Math.random() * 1e9);
  env.sodex.addUser(ADDRESS, accountID);
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [me.id, ADDRESS, accountID],
  );
  return { client, userId: me.id, accountId: rows[0]?.id ?? "" };
}

describe("portfolio, risk and notifications", () => {
  it("values the account from SoDEX balances and perps state", async () => {
    const { client } = await connected("acct1@example.com");
    const pf = portfolioResponseSchema.parse(
      (await client.request("GET", "/api/v1/portfolio")).json(),
    ).portfolio;
    // mock: 100,000 vUSDC Spot + Perps av 100,000.
    expect(pf?.equity).toBe("200000");
    expect(pf?.available).toBe("200000");
    expect(pf?.unpriced).toEqual([]);
  });

  it("stores limits, reports them with who enforces them, and halts every bot without asking for 2FA (DEC-115)", async () => {
    const { client, userId, accountId } = await connected("acct2@example.com");
    const set = await client.request("PUT", "/api/v1/risk/limits", {
      body: { key: "dailyLossPct", value: "3" },
    });
    expect(set.statusCode).toBe(200);
    const r = riskResponse.parse((await client.request("GET", "/api/v1/risk")).json()).risk;
    expect(r?.limits.dailyLossPct).toBe("3");
    expect(r?.enforced).toMatchObject({ dailyLoss: true, maxLeverage: false });
    const bad = await client.request("PUT", "/api/v1/risk/limits", {
      body: { key: "perTradePct", value: "150" },
    });
    expect(errorOf(bad.body).code).toBe("VALIDATION_FAILED");

    await env.pool.query(
      "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state) values (gen_random_uuid(), $1, $2, 'spot_grid', 'vBTC_vUSDC', 'spot', 'Grid', 'running')",
      [userId, accountId],
    );
    const setup = twoFactorSetupSchema.parse(
      (await client.request("POST", "/api/v1/security/2fa/setup")).json(),
    );
    await client.request("POST", "/api/v1/security/2fa/enable", {
      body: { code: generateTotp(setup.secret, env.clock.now) },
    });
    // 2FA đã bật nhưng Emergency halt chỉ giảm rủi ro nên không hỏi mã.
    const res = await client.request("POST", "/api/v1/risk/halt", {
      body: {},
      idempotencyKey: randomUUID(),
    });
    expect(res.json()).toEqual({ stopping: 1 });
    const { rows } = await env.pool.query<{ state: string; reason_code: string }>(
      "select state, reason_code from bots where sodex_account_id = $1",
      [accountId],
    );
    expect(rows[0]).toEqual({ state: "stopping", reason_code: "EMERGENCY_HALT" });
  });

  it("keeps bot error notifications always on and lists unread in-app notifications", async () => {
    const { client, userId } = await connected("acct3@example.com");
    const off = await client.request("PUT", "/api/v1/notifications/settings", {
      body: { group: "botErrors", channel: "email", enabled: false },
    });
    expect(errorOf(off.body).code).toBe("VALIDATION_FAILED");
    const on = await client.request("PUT", "/api/v1/notifications/settings", {
      body: { group: "fills", channel: "in_app", enabled: true },
    });
    expect(
      notificationSettingsSchema.parse(on.json()).groups.find((g) => g.group === "fills"),
    ).toEqual({
      group: "fills",
      alwaysOn: false,
      in_app: true,
      email: false,
      telegram: false,
    });
    await env.pool.query(
      "insert into notifications (id, user_id, type, payload, channel) values (gen_random_uuid(), $1, 'bot_paused', '{}', 'in_app')",
      [userId],
    );
    const list = (await client.request("GET", "/api/v1/notifications")).json<{ unread: number }>();
    expect(list.unread).toBe(1);
    await client.request("POST", "/api/v1/notifications/all/read");
    expect(
      (await client.request("GET", "/api/v1/notifications")).json<{ unread: number }>().unread,
    ).toBe(0);
  });

  it("shows builder revenue only to the DeskLabs team, with reconciled totals", async () => {
    const { client, userId } = await connected("acct4@example.com");
    expect(
      errorOf((await client.request("GET", "/api/v1/admin/builder-revenue?period=2026-10")).body)
        .code,
    ).toBe("FORBIDDEN");
    await env.pool.query("update users set role = 'team' where id = $1", [userId]);
    await env.pool.query(
      "insert into builder_revenue_daily (date, engine, from_fills, fills, notional, balance_delta, difference, status) values ('2026-10-23', 'perps', 85.02, 10, 100000, 85.02, 0, 'matched'), ('2026-10-24', 'perps', 77.90, 9, 90000, 79.10, 1.20, 'pending'), ('2026-10-24', 'spot', 5, 2, 10000, null, null, 'pending')",
    );
    const v = builderRevenueViewSchema.parse(
      (await client.request("GET", "/api/v1/admin/builder-revenue?period=2026-10")).json(),
    );
    // Pending: chỉ ghi nhận phần giải thích được (77.90); spot thiếu số dư → 0.
    expect(v.totals).toMatchObject({ perps: "162.92", spot: "0", recognized: "162.92", fills: 21 });
    expect(v.days.map((d) => d.status)).toEqual(["pending", "pending", "matched"]);
  });

  it("lists users only to the DeskLabs team, read-only, with search", async () => {
    const { client, userId } = await connected("acct5@example.com");
    const other = new TestClient(env.app);
    await signIn(env, other, "plain_user5@example.com");
    expect(errorOf((await client.request("GET", "/api/v1/admin/users")).body).code).toBe(
      "FORBIDDEN",
    );
    await env.pool.query("update users set role = 'team' where id = $1", [userId]);
    const all = adminUsersViewSchema.parse(
      (await client.request("GET", "/api/v1/admin/users")).json(),
    );
    const me = all.items.find((u) => u.email === "acct5@example.com");
    expect(me).toMatchObject({ role: "team", sodex: { status: "connected" } });
    expect(me?.builderFee).not.toBeNull();
    const plain = all.items.find((u) => u.email === "plain_user5@example.com");
    expect(plain).toMatchObject({ sodex: null, builderFee: null, bots: { running: 0, total: 0 } });
    // `%` và `_` trong ô tìm kiếm là ký tự thường, không phải wildcard.
    const found = adminUsersViewSchema.parse(
      (await client.request("GET", "/api/v1/admin/users?q=n_user5")).json(),
    );
    expect(found.items.map((u) => u.email)).toEqual(["plain_user5@example.com"]);
    const none = adminUsersViewSchema.parse(
      (await client.request("GET", "/api/v1/admin/users?q=acct_%25")).json(),
    );
    expect(none.items).toHaveLength(0);
    expect((await client.request("POST", "/api/v1/admin/users")).statusCode).toBe(404);
  });

  it("shows team members one user's stats, bots and orders, and audits each view", async () => {
    const { client, userId } = await connected("acct6@example.com");
    const other = new TestClient(env.app);
    const plainId = meSchema.parse((await signIn(env, other, "plain_user6@example.com")).json()).id;
    const path = `/api/v1/admin/users/${plainId}`;
    expect(errorOf((await other.request("GET", path)).body).code).toBe("FORBIDDEN");
    await env.pool.query("update users set role = 'team' where id = $1", [userId]);
    const view = adminUserDetailSchema.parse((await client.request("GET", path)).json());
    expect(view.user.email).toBe("plain_user6@example.com");
    expect(view.stats).toMatchObject({ volumeAll: "0", fills: 0, equityAt: null });
    expect(view.bots).toEqual([]);
    expect(view.orders).toEqual([]);
    const audits = await env.pool.query(
      "select 1 from audit_log where user_id = $1 and action = 'admin.user_viewed' and target = $2",
      [userId, plainId],
    );
    expect(audits.rowCount).toBe(1);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect(errorOf((await client.request("GET", `/api/v1/admin/users/${missing}`)).body).code).toBe(
      "NOT_FOUND",
    );
  });
});

describe("connect SoDEX telemetry (DEC-114)", () => {
  it("records browser steps, rejects bad bodies and shows them to the team", async () => {
    const { client, userId } = await connected("acct7@example.com");
    const user = new TestClient(env.app);
    const plainId = meSchema.parse((await signIn(env, user, "plain_user7@example.com")).json()).id;
    const attemptId = randomUUID();
    const send = (body: unknown) => user.request("POST", "/api/v1/sodex/connect-events", { body });
    expect(
      (
        await send({
          attemptId,
          type: "view",
          data: { device: "mobile", os: "iOS", walletsDetected: [], walletConnect: true },
        })
      ).statusCode,
    ).toBe(204);
    expect((await send({ attemptId, type: "picker_opened" })).statusCode).toBe(204);
    expect(
      (
        await send({
          attemptId,
          type: "wallet_failed",
          data: { wallet: "WalletConnect", reason: "wc_not_started" },
        })
      ).statusCode,
    ).toBe(204);
    // Loại bước lạ, attempt sai, dữ liệu lồng nhau: từ chối.
    expect((await send({ attemptId, type: "hacked" })).statusCode).toBe(400);
    expect((await send({ attemptId: "x", type: "view" })).statusCode).toBe(400);
    expect((await send({ attemptId, type: "view", data: { a: { b: 1 } } })).statusCode).toBe(400);
    // Chưa đăng nhập: không ghi.
    const anon = new TestClient(env.app);
    expect(
      (
        await anon.request("POST", "/api/v1/sodex/connect-events", {
          body: { attemptId, type: "view" },
        })
      ).statusCode,
    ).toBe(401);

    await env.pool.query("update users set role = 'team' where id = $1", [userId]);
    const view = adminUserDetailSchema.parse(
      (await client.request("GET", `/api/v1/admin/users/${plainId}`)).json(),
    );
    expect(view.connect.events.map((e) => e.type)).toEqual([
      "wallet_failed",
      "picker_opened",
      "view",
    ]);
    expect(view.connect.events[0]?.data).toMatchObject({ reason: "wc_not_started" });
    expect(view.connect.requests).toEqual([]);

    // Mục MCP (DEC-225): 0 lượt trong 24h → tỷ lệ null ("Not available"), không phải 0%.
    const before = platformStatsSchema.parse(
      (await client.request("GET", "/api/v1/admin/stats?period=7")).json(),
    );
    expect(before.mcp).toMatchObject({ calls24h: 0, deniedPct24h: null, rateLimitedPct24h: null });
    const at = (agoMs: number) => new Date(env.clock.now.getTime() - agoMs);
    for (const [tool, status, ago] of [
      ["list_bots", "ok", 60_000],
      ["list_bots", "ok", 60_000],
      ["list_bots", "error", 60_000],
      ["get_bot", "ok", 60_000],
      ["-", "denied", 60_000],
      ["limit:per_minute", "rate_limited", 60_000],
      ["get_bot", "error", 2 * 86_400_000],
    ] as const)
      await env.pool.query(
        "insert into mcp_calls (id, endpoint, tool, status, created_at) values (gen_random_uuid(), 'user', $1, $2, $3)",
        [tool, status, at(ago)],
      );
    const stats = platformStatsSchema.parse(
      (await client.request("GET", "/api/v1/admin/stats?period=7")).json(),
    );
    expect(stats.mcp).toEqual({
      connectedUsers: 0,
      calls24h: 4,
      byTool24h: [
        { tool: "list_bots", calls: 3, errors: 1 },
        { tool: "get_bot", calls: 1, errors: 0 },
      ],
      deniedPct24h: "16.7",
      rateLimitedPct24h: "16.7",
    });
    expect(
      stats.connect.steps.find((s) => s.type === "picker_opened")?.users,
    ).toBeGreaterThanOrEqual(1);
    expect(
      stats.connect.failures.find(
        (f) => f.type === "wallet_failed" && f.reason === "wc_not_started",
      )?.users,
    ).toBeGreaterThanOrEqual(1);
    expect(stats.connect.devices.find((d) => d.device === "mobile")?.users).toBeGreaterThanOrEqual(
      1,
    );
  });
});

describe("GET /api/v1/overview", () => {
  it("accepts the All period and starts it at the first snapshot", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, `ov-${randomUUID()}@drift.test`);
    const all = overviewViewSchema.parse(
      (await client.request("GET", "/api/v1/overview?period=all")).json(),
    );
    expect(all.realizedSince).toBe(0);
    expect(all.portfolio).toBeNull();
    const day = overviewViewSchema.parse(
      (await client.request("GET", "/api/v1/overview?period=1")).json(),
    );
    expect(day.realizedSince).toBe(env.clock.now.getTime() - 86_400_000);
    const bad = await client.request("GET", "/api/v1/overview?period=90");
    expect(bad.statusCode).toBe(400);
  });
});

describe("watchlist", () => {
  it("seeds once from goals, then replaces, reorders, empties and validates", async () => {
    const client = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, client, `wl-${randomUUID()}@drift.test`)).json());
    await env.pool.query(
      "insert into goals (user_id, goal, capital, max_drop, markets) values ($1, 'automate', '100', '5', $2)",
      [me.id, ["BTC", "NOPE"]],
    );
    const get = async () =>
      watchlistSchema.parse((await client.request("GET", "/api/v1/watchlist")).json()).items;
    const put = (items: unknown) => client.request("PUT", "/api/v1/watchlist", { body: { items } });

    // Seed: perps `<X>-USD`, bỏ market SoDEX không có (mock chỉ có BTC-USD và vBTC_vUSDC).
    expect(await get()).toEqual([{ market: "BTC-USD", engine: "perps" }]);

    const two = [
      { market: "vBTC_vUSDC", engine: "spot" },
      { market: "BTC-USD", engine: "perps" },
    ];
    expect((await put(two)).statusCode).toBe(200);
    expect(await get()).toEqual(two);
    expect((await put([...two].reverse())).statusCode).toBe(200);
    expect((await get())[0]?.market).toBe("BTC-USD");

    // Market không tồn tại, sai engine, trùng, quá 8 → VALIDATION_FAILED, danh sách giữ nguyên.
    for (const bad of [
      [{ market: "ETH-USD", engine: "perps" }],
      [{ market: "BTC-USD", engine: "spot" }],
      [two[1], two[1]],
      Array.from({ length: 9 }, (_, i) => ({ market: `M${String(i)}-USD`, engine: "perps" })),
    ]) {
      const r = await put(bad);
      expect(r.statusCode).toBe(400);
      expect(errorOf(r.body).code).toBe("VALIDATION_FAILED");
    }
    expect((await get()).length).toBe(2);

    // Bỏ hết thì vẫn rỗng: không seed lại từ goals.
    expect((await put([])).statusCode).toBe(200);
    expect(await get()).toEqual([]);
    const ov = overviewViewSchema.parse((await client.request("GET", "/api/v1/overview")).json());
    expect(ov.watchlist).toEqual([]);
  });

  it("computes the 24h change from the oldest hourly candle, not the newest (SoDEX returns newest first)", async () => {
    const { client } = await connected(`wl3-${randomUUID()}@drift.test`);
    await client.request("PUT", "/api/v1/watchlist", {
      body: { items: [{ market: "BTC-USD", engine: "perps" }] },
    });
    const ov = overviewViewSchema.parse((await client.request("GET", "/api/v1/overview")).json());
    const w = ov.watchlist[0];
    if (w === undefined) throw new Error("watchlist row missing");
    // Cùng nến mà server đọc từ SoDEX mock (mới nhất trước): giá mở của nến cũ nhất là mốc 24h.
    const res = await env.sodex.fetch(
      `https://mainnet-gw.sodex.dev/api/v1/perps/markets/BTC-USD/klines?interval=1h&limit=24&startTime=${String(env.clock.now.getTime() - 24 * 3_600_000)}&endTime=${String(env.clock.now.getTime())}`,
      { method: "GET" },
    );
    const k = z
      .object({ data: z.array(z.object({ t: z.number(), o: z.string(), c: z.string() })) })
      .parse(await res.json()).data;
    expect(k[0]?.t).toBeGreaterThan(k.at(-1)?.t ?? 0);
    expect(w.change24hPct).toBe(change24hPct(w.price, k));
    expect(w.change24hPct).not.toBe(change24hPct(w.price, [k[0] ?? { t: 0, o: "0" }]));
    // Sparkline theo thời gian tăng dần.
    expect(w.spark).toEqual([...k].reverse().map((c) => c.c));
  });

  it("keeps markets without a price in the overview", async () => {
    const { client } = await connected(`wl2-${randomUUID()}@drift.test`);
    await client.request("PUT", "/api/v1/watchlist", {
      body: { items: [{ market: "vBTC_vUSDC", engine: "spot" }] },
    });
    const ov = overviewViewSchema.parse((await client.request("GET", "/api/v1/overview")).json());
    expect(ov.watchlist.map((w) => [w.market, w.engine])).toEqual([["vBTC_vUSDC", "spot"]]);
  });
});

describe("GET /api/v1/admin/ops (DEC-TBD-ops-page)", () => {
  it("is for the team only: 401 signed out, 403 for users, 200 with bots for the team", async () => {
    const anon = new TestClient(env.app);
    expect((await anon.request("GET", "/api/v1/admin/ops")).statusCode).toBe(401);
    const client = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, client, `ops-${randomUUID()}@drift.test`)).json());
    const denied = await client.request("GET", "/api/v1/admin/ops");
    expect(denied.statusCode).toBe(403);
    expect(errorOf(denied.body).code).toBe("FORBIDDEN");
    await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
    const ok = await client.request("GET", "/api/v1/admin/ops");
    expect(ok.statusCode).toBe(200);
    const view = teamOpsViewSchema.parse(ok.json());
    // Không có bot Market Making / Volume Farm nào trong 24 giờ: danh sách rỗng, không có hàng 0 giả.
    expect(Array.isArray(view.bots)).toBe(true);
    for (const b of view.bots) expect(b.volumeHour).not.toBe("0");
  });

  it("computes each column from seeded fills, events and invariant alerts", async () => {
    const client = new TestClient(env.app);
    const me = meSchema.parse(
      (await signIn(env, client, `ops-data-${randomUUID()}@drift.test`)).json(),
    );
    await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
    const now = env.clock.now.getTime();
    const at = (ago: number) => new Date(now - ago);
    const { rows: acc } = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [me.id, "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db", Math.floor(Math.random() * 1e9)],
    );
    const accountId = acc[0]?.id ?? "";
    const bot = async (name: string, state: string) => {
      const { rows } = await env.pool.query<{ id: string }>(
        "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state) values (gen_random_uuid(), $1, $2, 'volume_maker', 'BTC-USD', 'perps', $3, $4) returning id",
        [me.id, accountId, name, state],
      );
      return rows[0]?.id ?? "";
    };
    const live = await bot("Ops MM live", "running");
    const recent = await bot("Ops MM stopped today", "stopped");
    const old = await bot("Ops MM stopped long ago", "stopped");
    let n = 0;
    const fill = async (side: string, size: string, isMaker: boolean | null, ago: number) => {
      n += 1;
      const { rows } = await env.pool.query<{ id: string }>(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', $4, 'limit', 'GTX', $5, 'filled', 'vm', 1, $6) returning id",
        [live, accountId, `ops-${String(n)}-${randomUUID().slice(0, 8)}`, side, size, at(ago)],
      );
      await env.pool.query(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, 100000, $3, 0, $4, $5)",
        [rows[0]?.id, Math.floor(Math.random() * 1e12), size, isMaker, at(ago)],
      );
    };
    // Trong 1 giờ: maker 1,000 + taker 500 + chưa biết maker / taker 200 = 1,700. Fill cũ hơn 1 giờ không tính.
    await fill("buy", "0.01", true, 10 * 60_000);
    await fill("sell", "0.005", false, 20 * 60_000);
    await fill("buy", "0.002", null, 30 * 60_000);
    await fill("sell", "0.05", true, 2 * 3_600_000);
    const event = (botId: string, decision: string, why: string | null, ago: number) =>
      env.pool.query(
        "insert into bot_events (bot_id, type, decision, why, occurred_at) values ($1, 'log', $2, $3, $4)",
        [botId, decision, why, at(ago)],
      );
    await event(
      live,
      "Order requests",
      "Last 60 s: 40 requests to SoDEX (place 20, cancel 20). Longest gap between quotes: 3.5 s.",
      60_000,
    );
    await event(
      live,
      "Order requests",
      "Last 60 s: 30 requests to SoDEX (place 15, cancel 15). Longest gap between quotes: 7.25 s.",
      30 * 60_000,
    );
    await event(live, "Position cut", null, 2 * 3_600_000);
    await event(live, "Cancelled 2 untracked orders", null, 3 * 3_600_000);
    await event(live, "Position cut", null, 25 * 3_600_000);
    const outbox = (topic: string, payload: object, ago: number) =>
      env.pool.query("insert into outbox (topic, payload, created_at) values ($1, $2, $3)", [
        topic,
        JSON.stringify(payload),
        at(ago),
      ]);
    await outbox(
      "jobs.team_ops",
      { type: "team_invariant", invariant: "P1", status: "failing", botId: live, detail: "older" },
      2 * 3_600_000,
    );
    await outbox(
      "jobs.team_ops",
      {
        type: "team_invariant",
        invariant: "P5",
        status: "failing",
        botId: live,
        detail: "no quote for 40 s",
      },
      3_600_000,
    );
    await outbox(`user.${accountId}.bot`, { botId: recent, state: "stopped" }, 2 * 3_600_000);
    await outbox(`user.${accountId}.bot`, { botId: old, state: "stopped" }, 3 * 86_400_000);

    const view = teamOpsViewSchema.parse((await client.request("GET", "/api/v1/admin/ops")).json());
    const mine = view.bots.filter((b) => b.userId === me.id);
    expect(mine.map((b) => b.name).sort()).toEqual(["Ops MM live", "Ops MM stopped today"]);
    expect(mine.find((b) => b.botId === live)).toMatchObject({
      volumeHour: "1700",
      // Maker share chỉ tính fill biết maker / taker: 1,000 / 1,500.
      makerSharePct: "66.7",
      requestsPerMinute: "40",
      maxQuoteGapSec: "7.25",
      positionCuts: 1,
      untrackedCancels: 2,
      latestInvariant: { invariant: "P5", detail: "no quote for 40 s" },
    });
    // Bot dừng hôm nay không có số: "Not available" (null), không phải 0.
    expect(mine.find((b) => b.botId === recent)).toMatchObject({
      volumeHour: null,
      makerSharePct: null,
      requestsPerMinute: null,
      maxQuoteGapSec: null,
      latestInvariant: null,
    });
  });
});
