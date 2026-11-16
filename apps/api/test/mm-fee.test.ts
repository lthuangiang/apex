import { featuresSchema, meSchema, type MmFee } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Thẻ builder fee Market Making ở GET /api/v1/features (DEC-258, DEC-TBD-mm-fee-card).

let env: TestEnv;
const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const DAY = 86_400_000;

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function user(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [me.id, ADDRESS, Math.floor(Math.random() * 1e9)],
  );
  return { client, userId: me.id, accountId: rows[0]?.id ?? "" };
}

async function mmBot(u: { userId: string; accountId: string }, mode: "live" | "paper" = "live") {
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_maker', 'BTC-USD', 'perps', 'MM', 'running', $3) returning id",
    [u.userId, u.accountId, mode],
  );
  return rows[0]?.id ?? "";
}

/** Một fill notional `usd` (giá 100 000) của bot, `daysAgo` ngày trước giờ của API. */
async function fill(botId: string, usd: number, daysAgo: number, side: "buy" | "sell" = "buy") {
  const size = String(usd / 100_000);
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch) select gen_random_uuid(), $1, sodex_account_id, $2, 'BTC-USD', 'perps', $3, 'limit', 'GTX', $4, 'filled', 'vm', 1 from bots where id = $1 returning id",
    [botId, `c-${String(Math.random())}`, side, size],
  );
  await env.pool.query(
    "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, 100000, $3, 0, true, $4)",
    [
      rows[0]?.id ?? "",
      Math.floor(Math.random() * 1e12),
      size,
      new Date(env.clock.now.getTime() - daysAgo * DAY),
    ],
  );
}

async function mmFee(client: TestClient): Promise<MmFee | null> {
  return featuresSchema.parse((await client.request("GET", "/api/v1/features")).json()).mmFee;
}

describe("GET /api/v1/features · mmFee", () => {
  it("is null when signed out", async () => {
    expect(await mmFee(new TestClient(env.app))).toBeNull();
  });

  it("default with no real-money Market Making bot: no volume (never $0), next tier at 200K", async () => {
    const u = await user("mmfee-none@example.com");
    // Bot tiền giả không tính (DEC-105).
    await fill(await mmBot(u, "paper"), 500_000, 1);
    expect(await mmFee(u.client)).toEqual({
      rate: 3,
      source: "default",
      volume30d: null,
      nextVolume: "200000",
      nextRate: 2,
    });
  });

  it("default with a bot: 0 when nothing filled, then buys and sells of the last 30 days", async () => {
    const u = await user("mmfee-default@example.com");
    const bot = await mmBot(u);
    expect((await mmFee(u.client))?.volume30d).toBe("0");
    await fill(bot, 40_000, 1, "buy");
    await fill(bot, 10_000.5, 2, "sell");
    await fill(bot, 900_000, 31);
    expect(await mmFee(u.client)).toEqual({
      rate: 3,
      source: "default",
      volume30d: "50000.5",
      nextVolume: "200000",
      nextRate: 2,
    });
  });

  it("tier: the rate the job set, live volume, and the next tier at 1M", async () => {
    const u = await user("mmfee-tier@example.com");
    await fill(await mmBot(u), 300_000, 3);
    await env.pool.query(
      "insert into user_fee_tiers (user_id, strategy, rate, volume, computed_at) values ($1, 'volume_maker', 2, 300000, now())",
      [u.userId],
    );
    expect(await mmFee(u.client)).toEqual({
      rate: 2,
      source: "tier",
      volume30d: "300000",
      nextVolume: "1000000",
      nextRate: 1,
    });
  });

  it("custom: a rate the team set wins over the tier, with no next tier", async () => {
    const u = await user("mmfee-custom@example.com");
    await fill(await mmBot(u), 300_000, 3);
    await env.pool.query(
      "insert into user_fee_tiers (user_id, strategy, rate, volume, computed_at) values ($1, 'volume_maker', 2, 300000, now())",
      [u.userId],
    );
    await env.pool.query(
      "insert into user_builder_fees (user_id, strategy, rate, updated_by) values ($1, 'volume_maker', 5, $1)",
      [u.userId],
    );
    expect(await mmFee(u.client)).toEqual({
      rate: 5,
      source: "custom",
      volume30d: "300000",
      nextVolume: null,
      nextRate: null,
    });
  });

  it("top tier: no next tier", async () => {
    const u = await user("mmfee-top@example.com");
    await fill(await mmBot(u), 1_200_000, 3);
    await env.pool.query(
      "insert into user_fee_tiers (user_id, strategy, rate, volume, computed_at) values ($1, 'volume_maker', 1, 1200000, now())",
      [u.userId],
    );
    expect(await mmFee(u.client)).toEqual({
      rate: 1,
      source: "tier",
      volume30d: "1200000",
      nextVolume: null,
      nextRate: null,
    });
  });
});
