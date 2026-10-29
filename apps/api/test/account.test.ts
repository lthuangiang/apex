import { randomUUID } from "node:crypto";

import {
  adminUsersViewSchema,
  builderRevenueViewSchema,
  notificationSettingsSchema,
  errorResponseSchema,
  overviewViewSchema,
  meSchema,
  portfolioResponseSchema,
  riskViewSchema,
  twoFactorSetupSchema,
  watchlistSchema,
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

  it("stores limits, reports them with who enforces them, and halts every bot with 2FA", async () => {
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
    const noCode = await client.request("POST", "/api/v1/risk/halt", { body: {} });
    expect(errorOf(noCode.body).code).toBe("TWO_FACTOR_REQUIRED");
    env.clock.now = new Date(env.clock.now.getTime() + 30_000);
    const res = await client.request("POST", "/api/v1/risk/halt", {
      body: { twoFactorCode: generateTotp(setup.secret, env.clock.now) },
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

  it("shows builder revenue only to the DRIFT team, with reconciled totals", async () => {
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

  it("lists users only to the DRIFT team, read-only, with search", async () => {
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

  it("keeps markets without a price in the overview", async () => {
    const { client } = await connected(`wl2-${randomUUID()}@drift.test`);
    await client.request("PUT", "/api/v1/watchlist", {
      body: { items: [{ market: "vBTC_vUSDC", engine: "spot" }] },
    });
    const ov = overviewViewSchema.parse((await client.request("GET", "/api/v1/overview")).json());
    expect(ov.watchlist.map((w) => [w.market, w.engine])).toEqual([["vBTC_vUSDC", "spot"]]);
  });
});
