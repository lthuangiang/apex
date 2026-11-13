import { randomUUID } from "node:crypto";

import {
  botDetailSchema,
  botListSchema,
  candleListSchema,
  liquidationMapSchema,
  marketLastSchema,
  errorResponseSchema,
  meSchema,
  botFillListSchema,
  orderListSchema,
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

    // Mã đúng ở lần Start trước còn hiệu lực 2 giờ (DEC-115); quá 2 giờ thì hỏi lại.
    env.clock.now = new Date(env.clock.now.getTime() + 2 * 3600_000 + 60_000);
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
    // Nhập đúng mã một lần: phiên này không bị hỏi lại trong 2 giờ (DEC-115).
    const trusted = meSchema.parse((await client.request("GET", "/api/v1/me")).json());
    expect(trusted.twoFactorTrustedUntil).toBe(
      new Date(env.clock.now.getTime() + 2 * 3600_000).toISOString(),
    );
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

  it("labels a Rebalancing bot by its basket and gives TWAP its size in base (UI_REVIEW N2)", async () => {
    const { client } = await connectedUser("bots-labels@example.com");
    const create = async (strategy: string, name: string, config: Record<string, unknown>) => {
      const res = await client.request("POST", "/api/v1/bots", {
        body: { strategy, name, paramSource: "manual", config },
      });
      expect(res.statusCode).toBe(201);
    };
    await create("rebalancing", "Basket", {
      quoteAsset: "USDC",
      assets: [
        { asset: "BTC", market: "vBTC_vUSDC", weightPct: "60" },
        { asset: "USDC", weightPct: "40" },
      ],
      rebalanceWhen: "threshold",
      thresholdPct: "5",
      investment: "300",
      maxTradePct: "25",
    });
    await create("twap", "Slices", {
      market: "vBTC_vUSDC",
      engine: "spot",
      side: "buy",
      totalSize: "0.5",
      durationMinutes: 60,
      slices: 6,
      maxSlippagePct: "0.5",
      onSkip: "leave_unfilled",
    });
    const list = botListSchema.parse((await client.request("GET", "/api/v1/bots")).json());
    const basket = list.items.find((b) => b.name === "Basket");
    expect(basket).toMatchObject({
      market: "vBTC_vUSDC",
      marketLabel: "BTC · USDC",
      capital: "300",
      capitalUnit: "quote",
    });
    const twap = list.items.find((b) => b.name === "Slices");
    expect(twap).toMatchObject({ marketLabel: null, capital: "0.5", capitalUnit: "base" });
  });

  it("shows Rebalancing Initial buy progress while it buys in hourly parts (DEC-TBD-rebalancing-initial-buy)", async () => {
    const { client } = await connectedUser("rebal-initial@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: {
        strategy: "rebalancing",
        name: "Spread",
        paramSource: "manual",
        config: {
          quoteAsset: "USDC",
          assets: [
            { asset: "BTC", market: "vBTC_vUSDC", weightPct: "60" },
            { asset: "USDC", weightPct: "40" },
          ],
          rebalanceWhen: "threshold",
          thresholdPct: "5",
          investment: "300",
          maxTradePct: "25",
          initialBuy: "over_hours",
          initialBuyHours: 4,
        },
      },
    });
    expect(made.statusCode).toBe(201);
    const id = made.json<{ id: string }>().id;
    const detail = async () =>
      botDetailSchema.parse((await client.request("GET", `/api/v1/bots/${id}`)).json());
    // Chưa chạy: chưa có tiến độ.
    expect((await detail()).initialBuy).toBeNull();
    const { rows } = await env.pool.query<{ active_version_id: string }>(
      "select active_version_id from bots where id = $1",
      [id],
    );
    await env.pool.query(
      "insert into bot_runtime (bot_id, version_id, state, epoch) values ($1, $2, $3, 1)",
      [id, rows[0]?.active_version_id, JSON.stringify({ building: { startedAt: 1, part: 2 } })],
    );
    expect((await detail()).initialBuy).toEqual({ done: 2, total: 4 });
    await env.pool.query("update bot_runtime set state = $2 where bot_id = $1", [
      id,
      JSON.stringify({ building: null }),
    ]);
    expect((await detail()).initialBuy).toBeNull();
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

describe("Volume bots per user (DEC-80)", () => {
  const vmConfig = {
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
  const farmConfig = {
    market: "BTC-USD",
    leverage: 5,
    marginMode: "cross",
    orderSizeMinUsd: "100",
    orderSizeMaxUsd: "200",
    minHoldSecs: 120,
    maxHoldSecs: 180,
    tpUsd: "0.5",
    slPct: "5",
    earlyProfitUsd: "0.15",
    maxLoss: "20",
  };

  it("offers Market Making, Volume Farming and AI Desk to new accounts, and hides the volume bots once the team turns them off", async () => {
    const { client } = await connectedUser("vm-flag@example.com");
    expect((await client.request("GET", "/api/v1/features")).json()).toMatchObject({
      volumeMaker: true,
      volumeFarm: true,
      aiDesk: true,
    });
    await env.pool.query(
      "update users set volume_bots = false where email = 'vm-flag@example.com'",
    );
    expect((await client.request("GET", "/api/v1/features")).json()).toMatchObject({
      volumeMaker: false,
      volumeFarm: false,
      aiDesk: true,
    });
    for (const [strategy, config] of [
      ["volume_maker", vmConfig],
      ["volume_farm", farmConfig],
    ] as const) {
      const bot = await client.request("POST", "/api/v1/bots", {
        body: { strategy, name: "V", paramSource: "manual", config },
      });
      expect(errorOf(bot.body).code).toBe("NOT_FOUND");
      const bt = await client.request("POST", "/api/v1/backtests", {
        body: { strategy, config, periodDays: 30 },
      });
      expect(errorOf(bt.body).code).toBe("NOT_FOUND");
    }
  });

  it("runs Market Making on any perp SoDEX lists, and rejects one it does not (DEC-157)", async () => {
    const { client } = await connectedUser("vm-any@example.com");
    const make = (market: string) =>
      client.request("POST", "/api/v1/bots", {
        body: {
          strategy: "volume_maker",
          name: "MM",
          paramSource: "manual",
          config: { ...vmConfig, market },
        },
      });
    // Mock SoDEX chỉ có perp BTC-USD; DOGE-USD không có trên SoDEX.
    expect(errorOf((await make("DOGE-USD")).body)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fieldErrors: { leverage: ["Market not found on SoDEX."] } },
    });
    expect((await make("BTC-USD")).statusCode).toBe(201);
  });

  it("lets the team set a builder fee per strategy for one user (DEC-159)", async () => {
    const { client } = await connectedUser("fee-user@example.com");
    const me = meSchema.parse((await client.request("GET", "/api/v1/me")).json());
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "volume_maker", name: "MM", paramSource: "manual", config: vmConfig },
    });
    expect(made.statusCode).toBe(201);
    const botId = made.json<{ id: string }>().id;
    await env.pool.query("update bots set state = 'running' where id = $1", [botId]);

    const admin = new TestClient(env.app);
    const am = meSchema.parse((await signIn(env, admin, "fee-admin@example.com")).json());
    const path = `/api/v1/admin/users/${me.id}/builder-fees`;
    const put = (body: unknown) => admin.request("PUT", path, { body });
    expect(errorOf((await put({ strategy: "volume_maker", rate: 10 })).body).code).toBe(
      "FORBIDDEN",
    );
    await env.pool.query("update users set role = 'team' where id = $1", [am.id]);
    expect(errorOf((await put({ strategy: "volume_maker", rate: 11 })).body)).toMatchObject({
      code: "VALIDATION_FAILED",
      details: { fieldErrors: { rate: ["too_big"] } },
    });

    const set = (await put({ strategy: "volume_maker", rate: 10 })).json<{
      builderFees: { strategy: string; defaultRate: number; rate: number; custom: boolean }[];
      notified: number;
    }>();
    expect(set.notified).toBe(1);
    expect(set.builderFees.find((r) => r.strategy === "volume_maker")).toEqual({
      strategy: "volume_maker",
      defaultRate: 3,
      rate: 10,
      custom: true,
    });
    expect(
      (await client.request("GET", "/api/v1/features")).json<{
        builderFees: Record<string, number>;
      }>().builderFees,
    ).toMatchObject({ volume_maker: 10, volume_farm: 5, spot_grid: 10 });
    const { rows: ev } = await env.pool.query<{ why: string }>(
      "select why from bot_events where bot_id = $1 and decision = 'Builder fee changed'",
      [botId],
    );
    expect(ev.map((e) => e.why)).toEqual([
      "The team set your builder fee for this strategy to 0.01% (was 0.003%). New orders use it.",
    ]);
    const detail = (await admin.request("GET", `/api/v1/admin/users/${me.id}`)).json<{
      builderFees: { strategy: string; rate: number }[];
    }>();
    expect(detail.builderFees.find((r) => r.strategy === "volume_maker")?.rate).toBe(10);

    // Về mặc định: bot đang chạy được báo lần nữa; đặt lại đúng mức đang có thì không báo.
    const reset = (await put({ strategy: "volume_maker", rate: null })).json<{
      builderFees: { strategy: string; rate: number; custom: boolean }[];
      notified: number;
    }>();
    expect(reset.notified).toBe(1);
    expect(reset.builderFees.find((r) => r.strategy === "volume_maker")).toMatchObject({
      rate: 3,
      custom: false,
    });
    expect((await put({ strategy: "volume_maker", rate: 3 })).json()).toMatchObject({
      notified: 0,
    });
    const { rows: log } = await env.pool.query<{ n: string }>(
      "select count(*)::text as n from audit_log where action = 'admin.builder_fee' and target = $1",
      [me.id],
    );
    expect(log[0]?.n).toBe("3");
  });

  it("lets only the team switch them, and pauses running volume bots when switched off", async () => {
    const { client } = await connectedUser("vf-user@example.com");
    const me = meSchema.parse((await client.request("GET", "/api/v1/me")).json());
    const admin = new TestClient(env.app);
    const am = meSchema.parse((await signIn(env, admin, "vf-admin@example.com")).json());
    const path = `/api/v1/admin/users/${me.id}/volume-bots`;
    expect(
      errorOf((await admin.request("POST", path, { body: { enabled: true } })).body).code,
    ).toBe("FORBIDDEN");
    await env.pool.query("update users set role = 'team' where id = $1", [am.id]);
    const on = await admin.request("POST", path, { body: { enabled: true } });
    expect(on.json()).toEqual({ volumeBots: true, paused: 0 });
    expect((await client.request("GET", "/api/v1/features")).json()).toMatchObject({
      volumeMaker: true,
      volumeFarm: true,
      aiDesk: true,
    });
    const created = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "volume_farm", name: "Farm", paramSource: "manual", config: farmConfig },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    // Đòn bẩy vượt trần SoDEX của market → lỗi field như mọi bot Perps.
    const tooHigh = await client.request("POST", "/api/v1/bots", {
      body: {
        strategy: "volume_farm",
        name: "Farm 2",
        paramSource: "manual",
        config: { ...farmConfig, leverage: 1000 },
      },
    });
    expect(errorOf(tooHigh.body).details).toMatchObject({
      fieldErrors: { leverage: [expect.any(String)] },
    });
    // Isolated: stop loss phải chạy trước thanh lý (5× ≈ 20%, trần 18%); cross không có mức cố định.
    const late = await client.request("POST", "/api/v1/bots/checks", {
      body: {
        strategy: "volume_farm",
        config: { ...farmConfig, marginMode: "isolated", slPct: "18" },
      },
    });
    expect(errorOf(late.body).details).toMatchObject({
      fieldErrors: { slPct: [expect.any(String)] },
    });
    const safe = await client.request("POST", "/api/v1/bots/checks", {
      body: {
        strategy: "volume_farm",
        config: { ...farmConfig, marginMode: "isolated", slPct: "17" },
      },
    });
    expect(safe.statusCode).toBe(200);

    await env.pool.query("update bots set state = 'running' where id = $1", [id]);
    const off = await admin.request("POST", path, { body: { enabled: false } });
    expect(off.json()).toEqual({ volumeBots: false, paused: 1 });
    const { rows } = await env.pool.query<{ state: string }>(
      "select state from bots where id = $1",
      [id],
    );
    expect(rows[0]?.state).toBe("pausing");
    const { rows: log } = await env.pool.query<{ n: string }>(
      "select count(*)::text as n from audit_log where action = 'admin.volume_bots' and target = $1",
      [me.id],
    );
    expect(log[0]?.n).toBe("2");
  });
});

describe("Start again and Archive (DEC-84, DEC-86)", () => {
  it("restarts a stopped bot in place with a new version, and archives it on request", async () => {
    const { client, secret } = await connectedUser("again@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Mine", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const archive = () => client.request("POST", `/api/v1/bots/${id}/actions/archive`);
    expect(errorOf((await archive()).body).code).toBe("BOT_STATE_CONFLICT");

    await env.pool.query("update bots set state = 'stopped', close_on_stop = true where id = $1", [
      id,
    ]);
    env.sodex.setBuilder(ADDRESS, Number(TEST_BUILDER_ID), 50);
    const code = nextTotp(secret);
    env.prices.set("vBTC_vUSDC", { price: "100", at: env.clock.now.getTime() });
    const start = await client.request("POST", `/api/v1/bots/${id}/actions/start`, {
      body: { acknowledged: true, twoFactorCode: code },
    });
    expect(start.statusCode, start.body).toBe(202);
    const rows = await env.pool.query<{ version: number; status: string }>(
      "select version, status from bot_versions where bot_id = $1 order by version",
      [id],
    );
    expect(rows.rows).toEqual([
      { version: 1, status: "superseded" },
      { version: 2, status: "active" },
    ]);
    const list = botListSchema.parse((await client.request("GET", "/api/v1/bots")).json());
    expect(list.items.filter((b) => b.name === "Mine")).toHaveLength(1);
    expect(list.items.find((b) => b.id === id)?.state).toBe("starting");

    await env.pool.query("update bots set state = 'stopped' where id = $1", [id]);
    expect((await archive()).statusCode).toBe(202);
    const ids = async (path: string) =>
      botListSchema.parse((await client.request("GET", path)).json()).items.map((b) => b.id);
    expect(await ids("/api/v1/bots")).not.toContain(id);
    expect(await ids("/api/v1/bots?archived=true")).toContain(id);
    const restored = await client.request("POST", `/api/v1/bots/${id}/actions/unarchive`);
    expect(restored.json()).toMatchObject({ id, state: "stopped" });
    expect(await ids("/api/v1/bots")).toContain(id);
  });

  it("counts open profit at the current price, and shows nothing without a price", async () => {
    const { client } = await connectedUser("live-pnl@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Live", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const { rows } = await env.pool.query<{ active_version_id: string }>(
      "select active_version_id from bots where id = $1",
      [id],
    );
    await env.pool.query(
      "insert into bot_runtime (bot_id, version_id, state, epoch) values ($1, $2, $3, 1)",
      [
        id,
        rows[0]?.active_version_id,
        JSON.stringify({
          ledger: {
            position: "2",
            avgCost: "100",
            realized: "5",
            fees: "1",
            funding: "0",
            invested: "200",
          },
        }),
      ],
    );
    const net = async () =>
      botDetailSchema.parse((await client.request("GET", `/api/v1/bots/${id}`)).json()).bot.netPnl;
    env.prices.delete("vBTC_vUSDC");
    expect(await net()).toBeNull();
    env.prices.set("vBTC_vUSDC", { price: "110", at: env.clock.now.getTime() });
    // 5 đã chốt + 2 × 10 chưa chốt − 1 phí.
    expect(await net()).toBe("24");
    const detail = botDetailSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}`)).json(),
    );
    expect(Date.parse(detail.serverTime)).toBe(env.clock.now.getTime());
    // Bot đã dừng không còn quản lý vị thế: chỉ tính phần đã chốt, không chạy theo giá.
    await env.pool.query("update bots set state = 'stopped' where id = $1", [id]);
    expect(await net()).toBe("4");
  });

  it("returns when the bot started running even when it has many newer events", async () => {
    const { client } = await connectedUser("runtime@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Busy", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    await env.pool.query("update bots set state = 'running' where id = $1", [id]);
    const started = new Date(env.clock.now.getTime() - 3_600_000);
    await env.pool.query(
      "insert into bot_events (id, bot_id, type, decision, occurred_at) values (gen_random_uuid(), $1, 'state', 'Running', $2)",
      [id, started],
    );
    await env.pool.query(
      `insert into bot_events (id, bot_id, type, decision, occurred_at)
       select gen_random_uuid(), $1, 'decision', 'Entered', $2::timestamptz + (n || ' seconds')::interval
       from generate_series(1, 60) n`,
      [id, started],
    );
    const detail = botDetailSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}`)).json(),
    );
    expect(detail.events.some((e) => e.decision === "Running")).toBe(false);
    expect(Date.parse(detail.runningSince ?? "")).toBe(started.getTime());
  });
});

describe("Waiting for price (IMP-01, DEC-91)", () => {
  it("shows what a running bot waits for, and nothing once it is not running", async () => {
    const { client } = await connectedUser(`waiting-${randomUUID()}@drift.test`);
    const made = await client.request("POST", "/api/v1/bots", {
      body: {
        strategy: "spot_grid",
        name: "Waits",
        paramSource: "manual",
        config: { ...grid, entry: "in_range", entryLow: "95", entryHigh: "100" },
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    const id = made.json<{ id: string }>().id;
    const { rows } = await env.pool.query<{ active_version_id: string }>(
      "select active_version_id from bots where id = $1",
      [id],
    );
    // State cũ, thiếu trường mới: chỉ có phase.
    await env.pool.query(
      "insert into bot_runtime (bot_id, version_id, state, epoch) values ($1, $2, $3, 1)",
      [id, rows[0]?.active_version_id, JSON.stringify({ phase: "waiting_trigger" })],
    );
    await env.pool.query("update bots set state = 'running' where id = $1", [id]);
    const waiting = async () =>
      botListSchema
        .parse((await client.request("GET", "/api/v1/bots")).json())
        .items.find((b) => b.id === id)?.waiting;
    expect(await waiting()).toEqual({
      kind: "entry",
      condition: { type: "in_range", low: "95", high: "100" },
    });
    await env.pool.query("update bots set state = 'paused' where id = $1", [id]);
    expect(await waiting()).toBeNull();
  });
});

describe("Orders counts (DEC-90)", () => {
  it("counts every order on the server, past the 200-row list limit", async () => {
    const { client } = await connectedUser("counts@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Counts", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const { rows } = await env.pool.query<{ sodex_account_id: string }>(
      "select sodex_account_id from bots where id = $1",
      [id],
    );
    const insert = (n: number, status: string, code: string | null, at: Date, tag: string) =>
      env.pool.query(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, reject_code, tag, epoch, submitted_at) select gen_random_uuid(), $1, $2, $5 || i, 'vBTC_vUSDC', 'spot', 'buy', 'limit', 'GTC', 1, $3, $4, 'x', 1, $6 from generate_series(1, $7::int) i",
        [id, rows[0]?.sodex_account_id, status, code, tag, at, n],
      );
    const now = env.clock.now;
    await insert(205, "rejected", "-1", now, "r");
    await insert(3, "filled", null, now, "f");
    await insert(2, "open", null, now, "o");
    await insert(4, "rejected", "-1", new Date(now.getTime() - 3 * 86_400_000), "old");
    const res = orderListSchema.parse((await client.request("GET", "/api/v1/orders")).json());
    expect(res.items).toHaveLength(200);
    expect(res.counts).toMatchObject({
      open: 2,
      filledToday: 3,
      rejectedToday: 205,
      lastRejectCode: "-1",
      total: 214,
    });
  });
});

describe("Bot fills", () => {
  it("lists the bot's SoDEX fills newest first, with value, liquidity and close flag", async () => {
    const { client } = await connectedUser("fills@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Fills", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, reduce_only, tag, epoch) select gen_random_uuid(), $1, sodex_account_id, 'fills-' || $2, 'vBTC_vUSDC', 'spot', $2, 'limit', 'GTX', 1, 'filled', $3, 'x', 1 from bots where id = $1 returning id",
      [id, "buy", false],
    );
    const { rows: closeRows } = await env.pool.query<{ id: string }>(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, reduce_only, tag, epoch) select gen_random_uuid(), $1, sodex_account_id, 'fills-' || $2, 'vBTC_vUSDC', 'spot', $2, 'limit', 'GTX', 1, 'cancelled', $3, 'x', 1 from bots where id = $1 returning id",
      [id, "sell", true],
    );
    const fill = (
      orderId: string | undefined,
      trade: number,
      price: string,
      size: string,
      maker: boolean | null,
      at: string,
    ) =>
      env.pool.query(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, $4, '0.01', $5, $6)",
        [orderId, 880_000 + trade, price, size, maker, at],
      );
    await fill(rows[0]?.id, 1, "100", "0.5", true, "2026-11-04T01:00:00Z");
    await fill(closeRows[0]?.id, 2, "101", "0.2", null, "2026-11-04T02:00:00Z");
    const res = botFillListSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}/fills`)).json(),
    );
    expect(res.items.map((f) => [f.side, f.value, f.liquidity, f.close])).toEqual([
      ["sell", "20.2", null, true],
      ["buy", "50", "maker", false],
    ]);
    expect(res).toMatchObject({ page: 1, pageSize: 10, total: 2 });
    // 13 lần khớp nữa (tổng 15): trang 2 có 5 dòng, cũ nhất nằm cuối.
    for (let i = 0; i < 13; i += 1)
      await fill(rows[0]?.id, 10 + i, "100", "1", true, `2026-11-03T00:${String(10 + i)}:00Z`);
    const page2 = botFillListSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}/fills?page=2`)).json(),
    );
    expect(page2.total).toBe(15);
    expect(page2.items).toHaveLength(5);
    expect(page2.items.at(-1)?.filledAt).toBe("2026-11-03T00:10:00Z");
    const other = await connectedUser("fills-other@example.com");
    expect((await other.client.request("GET", `/api/v1/bots/${id}/fills`)).statusCode).toBe(404);
  });
});

describe("Volume Farm stats (DEC-83)", () => {
  it("reports volume by period from real fills and the session from engine state", async () => {
    const { client } = await connectedUser("vf-stats@example.com");
    const me = meSchema.parse((await client.request("GET", "/api/v1/me")).json());
    await env.pool.query("update users set volume_bots = true where id = $1", [me.id]);
    const created = await client.request("POST", "/api/v1/bots", {
      body: {
        strategy: "volume_farm",
        name: "Farm",
        paramSource: "manual",
        config: {
          market: "BTC-USD",
          leverage: 5,
          marginMode: "cross",
          orderSizeMinUsd: "100",
          orderSizeMaxUsd: "200",
          minHoldSecs: 120,
          maxHoldSecs: 180,
          tpUsd: "0.5",
          slPct: "5",
          earlyProfitUsd: "0.15",
          maxLoss: "20",
        },
      },
    });
    const id = created.json<{ id: string }>().id;
    const detail = () =>
      client.request("GET", `/api/v1/bots/${id}`).then((r) => botDetailSchema.parse(r.json()));
    const empty = (await detail()).volumeFarm;
    expect(empty).toMatchObject({ volumeTotal: "0", makerSharePct: null });
    expect(empty?.session).toMatchObject({ volume: "0", trades: 0, costPerMillion: null });

    const { rows } = await env.pool.query<{ id: string; sodex_account_id: string }>(
      "select id, sodex_account_id from bots where id = $1",
      [id],
    );
    const account = rows[0]?.sodex_account_id;
    const { rows: ord } = await env.pool.query<{ id: string }>(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch) values (gen_random_uuid(), $1, $2, 'vf-1', 'BTC-USD', 'perps', 'buy', 'limit', 'GTX', 1, 'filled', 'vf', 1) returning id",
      [id, account],
    );
    const fill = (trade: number, hoursAgo: number, notional: number, maker: boolean) =>
      env.pool.query(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, 1, 0, $4, $5)",
        [
          ord[0]?.id,
          trade + Math.floor(Math.random() * 1e9),
          notional,
          maker,
          new Date(env.clock.now.getTime() - hoursAgo * 3_600_000),
        ],
      );
    await fill(1, 0.5, 100, true);
    await fill(2, 5, 200, true);
    await fill(3, 48, 300, false);
    await fill(4, 24 * 10, 400, false);
    const v = (await detail()).volumeFarm;
    expect(v).toMatchObject({
      volume1h: "100",
      volume24h: "300",
      volume7d: "600",
      volumeTotal: "1000",
      makerSharePct: "30",
    });
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

describe("GET /api/v1/markets/:market/candles and /liquidations (IMP-05)", () => {
  it("returns SoDEX candles oldest first and validates the query", async () => {
    const { client } = await connectedUser(`candles-${randomUUID()}@drift.test`);
    const res = await client.request(
      "GET",
      "/api/v1/markets/BTC-USD/candles?engine=perps&interval=1h",
    );
    expect(res.statusCode).toBe(200);
    const body = candleListSchema.parse(res.json());
    expect(body.items.length).toBeGreaterThan(1);
    const ts = body.items.map((c) => c.t);
    expect(ts).toEqual([...ts].sort((a, b) => a - b));
    expect(
      (await client.request("GET", "/api/v1/markets/BTC-USD/candles?engine=perps&interval=2h"))
        .statusCode,
    ).toBe(400);
    expect(
      (await client.request("GET", "/api/v1/markets/BTC-USD/candles?interval=1h")).statusCode,
    ).toBe(400);
  });

  it("reports the liquidation map as unavailable when no provider is configured", async () => {
    const { client } = await connectedUser(`liq-${randomUUID()}@drift.test`);
    const res = await client.request("GET", "/api/v1/markets/BTC-USD/liquidations?interval=1h");
    expect(liquidationMapSchema.parse(res.json())).toMatchObject({ available: false, bands: [] });
  });

  it("needs a session", async () => {
    const anon = new TestClient(env.app);
    expect(
      (await anon.request("GET", "/api/v1/markets/BTC-USD/candles?engine=perps&interval=1h"))
        .statusCode,
    ).toBe(401);
    expect(
      (await anon.request("GET", "/api/v1/markets/BTC-USD/liquidations?interval=1h")).statusCode,
    ).toBe(401);
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

describe("Funding Arb asset stats (DEC-160)", () => {
  it("returns past funding per perp and 24-hour spot volume", async () => {
    const { client } = await connectedUser("arb-stats@example.com");
    const now = env.clock.now.getTime();
    // Mock SoDEX: BTC-USD trả funding mỗi 8 giờ. 22 kỳ, kỳ thứ 6 âm.
    for (let i = 0; i <= 21; i += 1)
      await env.pool.query(
        "insert into funding_rates (market, funding_time, rate) values ('BTC-USD', $1, $2)",
        [new Date(now - i * 8 * 3_600_000 - 60_000), i === 5 ? "-0.0001" : "0.0001"],
      );
    for (const [i, v] of [
      [1, "2"],
      [2, "3"],
    ] as const)
      await env.pool.query(
        `insert into candles_1m (market, ts, open, high, low, close, volume)
         values ('vBTC_vUSDC', $1, 100, 100, 100, 100, $2)`,
        [new Date(now - i * 60_000), v],
      );
    const r = await client.request("GET", "/api/v1/markets/funding");
    expect(r.statusCode).toBe(200);
    const body = r.json<{
      perps: {
        market: string;
        intervalHours: number;
        avg7dPct: string | null;
        periods7d: number;
        positive21: number | null;
      }[];
      spotVolume24h: Record<string, string>;
    }>();
    const btc = body.perps.find((p) => p.market === "BTC-USD");
    expect(btc).toMatchObject({ intervalHours: 8, periods7d: 21, positive21: 20 });
    // (20 × 0.01% − 0.01%) / 21 kỳ.
    expect(Number(btc?.avg7dPct)).toBeCloseTo(0.009048, 6);
    expect(body.spotVolume24h).toEqual({ vBTC_vUSDC: "500" });
  });
});
