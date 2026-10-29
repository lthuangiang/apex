import { randomUUID } from "node:crypto";

import {
  botDetailSchema,
  botListSchema,
  marketLastSchema,
  errorResponseSchema,
  meSchema,
  sodexConnectionSchema,
  startChecksSchema,
  twoFactorSetupSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateTotp } from "../src/lib/totp";

import { signIn, startTestEnv, TEST_BUILDER_ID, TestClient, type TestEnv } from "./helpers";

let env: TestEnv;
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;
const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const grid = {
  market: "vBTC_vUSDC",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 5,
  spacing: "arithmetic",
  investment: "500",
  maxLoss: "100",
  onStop: "keep_base",
};

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function connectedUser(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  const accountID = Math.floor(Math.random() * 1e9);
  env.sodex.addUser(ADDRESS, accountID);
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [me.id, ADDRESS, accountID],
  );
  await env.pool.query(
    "insert into api_keys (id, sodex_account_id, name, public_key, ciphertext, kms_key_ref, last4, permissions_mask, expires_at, status) values (gen_random_uuid(), $1, 'DRIFT', $2, 'x', 'x', '5508', 14, now() + interval '100 days', 'active')",
    [rows[0]?.id, ADDRESS],
  );
  const setup = twoFactorSetupSchema.parse(
    (await client.request("POST", "/api/v1/security/2fa/setup")).json(),
  );
  await client.request("POST", "/api/v1/security/2fa/enable", {
    body: { code: generateTotp(setup.secret, env.clock.now) },
  });
  return { client, secret: setup.secret };
}

const nextTotp = (secret: string) => {
  env.clock.now = new Date(env.clock.now.getTime() + 30_000);
  return generateTotp(secret, env.clock.now);
};

describe("bots API", () => {
  it("validates the strategy config with the documented messages", async () => {
    const { client } = await connectedUser("bots1@example.com");
    const res = await client.request("POST", "/api/v1/bots", {
      body: {
        strategy: "spot_grid",
        name: "Grid",
        paramSource: "manual",
        config: { ...grid, lowerPrice: "120" },
      },
    });
    expect(errorOf(res.body)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fieldErrors: { lowerPrice: ["Must be lower than the upper price."] } },
    });
  });

  it("refuses leverage above the market maximum or the account's Max leverage limit", async () => {
    const { client } = await connectedUser("bots-lev@example.com");
    const futures = (leverage: number) => ({
      strategy: "futures_grid",
      name: "Futures Grid · BTC",
      paramSource: "manual",
      config: {
        market: "BTC-USD",
        leverage,
        marginMode: "isolated",
        direction: "short",
        lowerPrice: "90",
        upperPrice: "110",
        gridLevels: 4,
        spacing: "arithmetic",
        margin: "20",
        stopBelow: "80",
        maxLoss: "2",
        onStop: "close_at_market",
      },
    });
    // Mock SoDEX: BTC-USD maxLeverage = 20.
    const tooHigh = await client.request("POST", "/api/v1/bots", { body: futures(40) });
    expect(errorOf(tooHigh.body)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: {
        fieldErrors: { leverage: ["Above the SoDEX maximum of 20× for this market."] },
      },
    });
    expect((await client.request("POST", "/api/v1/bots", { body: futures(20) })).statusCode).toBe(
      201,
    );
    await env.pool.query(
      "insert into risk_limits (sodex_account_id, max_leverage, enforced) select id, 3, '{}' from sodex_accounts where user_id = (select id from users where email = 'bots-lev@example.com')",
    );
    const aboveCap = await client.request("POST", "/api/v1/bots", { body: futures(5) });
    expect(errorOf(aboveCap.body)).toMatchObject({
      details: { fieldErrors: { leverage: ["Above your 3.0× account cap."] } },
    });
  });

  it("checks perps margin by margin mode and leverage conflicts on the symbol (DEC-58)", async () => {
    const { client } = await connectedUser("bots-perps@example.com");
    const config = {
      market: "BTC-USD",
      leverage: 2,
      marginMode: "isolated",
      direction: "short",
      lowerPrice: "90",
      upperPrice: "110",
      gridLevels: 4,
      spacing: "arithmetic",
      margin: "150",
      stopBelow: "80",
      maxLoss: "2",
      onStop: "close_at_market",
    };
    const dry = async () =>
      startChecksSchema.parse(
        (
          await client.request("POST", "/api/v1/bots/checks", {
            body: { strategy: "futures_grid", config },
          })
        ).json(),
      );
    const check = async (key: string) => (await dry()).checks.find((c) => c.key === key);

    // Isolated chỉ dùng USDC (`ami`): 150 > 101.62 → ✕ dù `am` đủ.
    env.sodex.setHistory(ADDRESS, {
      accountValue: "300",
      availableMargin: "200",
      availableIsolated: "101.62",
    });
    expect(await check("balance")).toMatchObject({
      ok: false,
      data: { available: "101.62", usableMargin: "200", marginMode: "isolated" },
    });

    // Chỉ khác cài đặt, không có vị thế: ✓ kèm dữ liệu cảnh báo.
    env.sodex.setHistory(ADDRESS, { symbolSettings: [{ s: "BTC-USD", l: 40, m: "CROSS" }] });
    expect(await check("leverage_conflict")).toMatchObject({
      ok: true,
      detail: "changes",
      data: { currentLeverage: "40", currentMode: "cross", leverage: "2", marginMode: "isolated" },
    });

    // Có vị thế mở với thiết lập khác: chặn.
    env.sodex.setHistory(ADDRESS, {
      openPositions: [
        {
          i: 1,
          s: "BTC-USD",
          m: "CROSS",
          sz: "-0.0012",
          iw: null,
          ep: "80676",
          ur: "0",
          l: 40,
          lp: "0",
        },
      ],
    });
    expect(await check("leverage_conflict")).toMatchObject({ ok: false, detail: "position" });
    env.sodex.setHistory(ADDRESS, { openPositions: [], symbolSettings: [] });
  });

  it("creates a draft, runs the start checks and starts it with 2FA", async () => {
    const { client, secret } = await connectedUser("bots2@example.com");
    const created = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Grid · BTC", paramSource: "manual", config: grid },
    });
    expect(created.statusCode).toBe(201);
    const list = botListSchema.parse((await client.request("GET", "/api/v1/bots")).json());
    const bot = list.items[0];
    expect(bot).toMatchObject({
      state: "draft",
      market: "vBTC_vUSDC",
      activeVersion: 1,
      capital: "500",
    });
    const id = bot?.id ?? "";

    // Phí chưa approve và chưa có giá: chưa đạt.
    let checks = startChecksSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}/checks`)).json(),
    );
    expect(checks.allOk).toBe(false);
    expect(
      checks.checks
        .filter((c) => !c.ok)
        .map((c) => c.key)
        .sort(),
    ).toEqual(["builder_fee", "fresh_price", "min_size"]);
    const blocked = await client.request("POST", `/api/v1/bots/${id}/actions/start`, {
      body: { acknowledged: true, twoFactorCode: nextTotp(secret) },
    });
    expect(errorOf(blocked.body).code).toBe("BUILDER_FEE_NOT_APPROVED");

    env.sodex.setBuilder(ADDRESS, Number(TEST_BUILDER_ID), 50);
    env.prices.set("vBTC_vUSDC", { price: "100", at: env.clock.now.getTime() });
    checks = startChecksSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}/checks`)).json(),
    );
    expect(checks.allOk).toBe(true);

    // Dry run (form chưa lưu, UI_REVIEW H2) trả đúng kết quả của draft đã lưu cùng config.
    const dry = startChecksSchema.parse(
      (
        await client.request("POST", "/api/v1/bots/checks", {
          body: { strategy: "spot_grid", config: grid },
        })
      ).json(),
    );
    expect(dry).toEqual(checks);
    const tiny = startChecksSchema.parse(
      (
        await client.request("POST", "/api/v1/bots/checks", {
          body: { strategy: "spot_grid", config: { ...grid, investment: "5", maxLoss: "1" } },
        })
      ).json(),
    );
    const min = tiny.checks.find((c) => c.key === "min_size");
    expect(min?.ok).toBe(false);
    expect(min?.data).toMatchObject({ capitalField: "investment" });
    expect(Number(min?.data?.suggestedCapital)).toBeGreaterThan(5);

    // Key còn active và còn hạn nhưng signer không giải mã được: check ✕, kết nối báo `unusable` (UI_REVIEW H1).
    const { rows: keyRows } = await env.pool.query<{ id: string }>(
      "select k.id from api_keys k join sodex_accounts a on a.id = k.sodex_account_id join users u on u.id = a.user_id where u.email = 'bots2@example.com'",
    );
    const keyId = keyRows[0]?.id ?? "";
    env.unusableKeys.add(keyId);
    checks = startChecksSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}/checks`)).json(),
    );
    expect(checks.checks.find((c) => c.key === "api_key")).toMatchObject({
      ok: false,
      detail: "unusable",
    });
    const conn = sodexConnectionSchema.parse(
      (await client.request("GET", "/api/v1/sodex/connection")).json(),
    );
    expect(conn.connection?.apiKey?.status).toBe("unusable");
    env.unusableKeys.delete(keyId);

    const noCode = await client.request("POST", `/api/v1/bots/${id}/actions/start`, {
      body: { acknowledged: true },
    });
    expect(errorOf(noCode.body).code).toBe("TWO_FACTOR_REQUIRED");
    const key = randomUUID();
    const code = nextTotp(secret);
    env.prices.set("vBTC_vUSDC", { price: "100", at: env.clock.now.getTime() });
    const started = await client.request("POST", `/api/v1/bots/${id}/actions/start`, {
      body: { acknowledged: true, twoFactorCode: code },
      idempotencyKey: key,
    });
    expect(started.statusCode).toBe(202);
    const detail = botDetailSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}`)).json(),
    );
    expect(detail.bot.state).toBe("starting");
    // Vốn giống danh sách (UI_REVIEW F7).
    expect(detail.bot.capital).toBe("500");
    const { rows } = await env.pool.query<{ payload: { state: string } }>(
      "select payload from outbox where topic like 'user.%.bot' and payload->>'botId' = $1",
      [id],
    );
    expect(rows.map((r) => r.payload.state)).toContain("starting");

    // Đang starting: chưa pause được (chỉ engine xác nhận Running).
    const pause = await client.request("POST", `/api/v1/bots/${id}/actions/pause`);
    expect(errorOf(pause.body).code).toBe("BOT_STATE_CONFLICT");
  });

  it("keeps a fee-revoked bot paused until the fee is approved again", async () => {
    const { client } = await connectedUser("bots3@example.com");
    const created = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Grid", paramSource: "manual", config: grid },
    });
    const id =
      botListSchema.parse((await client.request("GET", "/api/v1/bots")).json()).items[0]?.id ?? "";
    expect(created.statusCode).toBe(201);
    await env.pool.query(
      "update bots set state = 'paused', reason_code = 'BUILDER_FEE_REVOKED' where id = $1",
      [id],
    );
    env.sodex.setBuilder(ADDRESS, Number(TEST_BUILDER_ID), 0);
    const res = await client.request("POST", `/api/v1/bots/${id}/actions/resume`);
    expect(errorOf(res.body).code).toBe("BOT_STATE_CONFLICT");
    env.sodex.setBuilder(ADDRESS, Number(TEST_BUILDER_ID), 50);
    expect((await client.request("POST", `/api/v1/bots/${id}/actions/resume`)).statusCode).toBe(
      202,
    );
  });

  it("saves edits as a pending version and keeps the market locked", async () => {
    const { client } = await connectedUser("bots4@example.com");
    await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Grid", paramSource: "manual", config: grid },
    });
    const id =
      botListSchema.parse((await client.request("GET", "/api/v1/bots")).json()).items[0]?.id ?? "";
    await env.pool.query("update bots set state = 'running' where id = $1", [id]);
    const v2 = await client.request("POST", `/api/v1/bots/${id}/versions`, {
      body: { paramSource: "manual", config: { ...grid, gridLevels: 7 } },
    });
    expect(v2.statusCode).toBe(202);
    expect(v2.json()).toEqual({ version: 2, status: "pending" });
    const locked = await client.request("POST", `/api/v1/bots/${id}/versions`, {
      body: { paramSource: "manual", config: { ...grid, market: "vETH_vUSDC" } },
    });
    expect(errorOf(locked.body).code).toBe("VALIDATION_FAILED");
  });
});

describe("Volume Maker flag", () => {
  it("treats Volume Maker as unavailable while VOLUME_MAKER_ENABLED is off", async () => {
    const client = new TestClient(env.app);
    await signIn(env, client, "vm-flag@example.com");
    expect((await client.request("GET", "/api/v1/features")).json()).toEqual({
      volumeMaker: false,
    });
    const config = {
      market: "BTC-USD",
      leverage: 1,
      volumeTarget: "100000",
      orderSize: "500",
      distanceBp: "1",
      maxInventory: "2000",
      refreshSeconds: 3,
      runUntil: "target_or_budget",
      costBudget: "300",
      inventoryLossStop: "60",
      onStop: "close_inventory",
    };
    const bot = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "volume_maker", name: "VM", paramSource: "manual", config },
    });
    expect(errorOf(bot.body).code).toBe("NOT_FOUND");
    const bt = await client.request("POST", "/api/v1/backtests", {
      body: { strategy: "volume_maker", config, periodDays: 30 },
    });
    expect(errorOf(bt.body).code).toBe("NOT_FOUND");
  });
});

describe("DRIFT's own builder account (DEC-47)", () => {
  it("needs no builder fee approval and passes the fee check without one", async () => {
    const client = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, client, "builder-self@example.com")).json());
    env.sodex.addUser(ADDRESS, Number(TEST_BUILDER_ID));
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [me.id, ADDRESS, TEST_BUILDER_ID.toString()],
    );
    await env.pool.query(
      "insert into api_keys (id, sodex_account_id, name, public_key, ciphertext, kms_key_ref, last4, permissions_mask, expires_at, status) values (gen_random_uuid(), $1, 'DRIFT', $2, 'x', 'x', '5508', 14, now() + interval '100 days', 'active')",
      [rows[0]?.id, ADDRESS],
    );
    const conn = (await client.request("GET", "/api/v1/sodex/connection")).json<{
      connection: { builderFee: { approved: boolean; exempt: boolean } | null };
    }>();
    expect(conn.connection.builderFee).toMatchObject({ approved: true, exempt: true });
    await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Grid", paramSource: "manual", config: grid },
    });
    const id =
      botListSchema.parse((await client.request("GET", "/api/v1/bots")).json()).items[0]?.id ?? "";
    const checks = startChecksSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}/checks`)).json(),
    );
    expect(checks.checks.find((c) => c.key === "builder_fee")).toEqual({
      key: "builder_fee",
      ok: true,
      detail: "exempt",
    });
  });
});

describe("GET /api/v1/markets/:market/last", () => {
  it("returns the latest price, or null when marketdata has none", async () => {
    const { client } = await connectedUser(`last-${randomUUID()}@drift.test`);
    env.prices.set("vETH_vUSDC", { price: "2753.92", at: 1_793_000_000_000 });
    expect(
      marketLastSchema.parse(
        (await client.request("GET", "/api/v1/markets/vETH_vUSDC/last")).json(),
      ),
    ).toEqual({ market: "vETH_vUSDC", price: "2753.92", at: 1_793_000_000_000 });
    expect(
      marketLastSchema.parse(
        (await client.request("GET", "/api/v1/markets/vSOL_vUSDC/last")).json(),
      ),
    ).toEqual({ market: "vSOL_vUSDC", price: null, at: null });
    expect((await client.request("GET", "/api/v1/markets/bad%20name/last")).statusCode).toBe(400);
  });

  it("needs a session", async () => {
    const res = await new TestClient(env.app).request("GET", "/api/v1/markets/vETH_vUSDC/last");
    expect(res.statusCode).toBe(401);
  });
});
