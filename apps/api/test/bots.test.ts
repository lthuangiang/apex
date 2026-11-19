import { randomUUID } from "node:crypto";

import {
  adminUserDetailSchema,
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
  volumeAnalyticsSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateTotp } from "../src/lib/totp";
import { analystBots } from "../src/modules/account/service";

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
        // Cross: test này kiểm trần đòn bẩy, không kiểm stop trước giá thanh lý (chỉ chặn với isolated).
        marginMode: "cross",
        direction: "short",
        lowerPrice: "90",
        upperPrice: "110",
        gridLevels: 4,
        spacing: "arithmetic",
        margin: "20",
        stopBelow: "80",
        stopAbove: "120",
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
      stopAbove: "120",
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

  it("shows Rebalancing Initial buy progress while it buys in hourly parts (DEC-222)", async () => {
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

  it("keeps a Funding Arb bot's spot leg and asset locked on edit (#223)", async () => {
    const { client } = await connectedUser("bots-arb-lock@example.com");
    const arb = {
      asset: "BTC",
      spotMarket: "vBTC_vUSDC",
      perpMarket: "BTC-USD",
      leverage: 1,
      investment: "1000",
      enterFundingPct: "0.01",
      exitFundingPct: "0",
      maxGapPct: "0.5",
      minMarginRatioPct: "30",
      maxLoss: "100",
    };
    const created = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "funding_arb", name: "Arb", paramSource: "manual", config: arb },
    });
    expect(created.statusCode).toBe(201);
    const id =
      botListSchema.parse((await client.request("GET", "/api/v1/bots")).json()).items[0]?.id ?? "";
    const ok = await client.request("POST", `/api/v1/bots/${id}/versions`, {
      body: { paramSource: "manual", config: { ...arb, maxLoss: "150" } },
    });
    expect(ok.statusCode).toBe(202);
    for (const change of [{ spotMarket: "vETH_vUSDC" }, { asset: "ETH" }]) {
      const res = await client.request("POST", `/api/v1/bots/${id}/versions`, {
        body: { paramSource: "manual", config: { ...arb, maxLoss: "150", ...change } },
      });
      expect(errorOf(res.body).code).toBe("VALIDATION_FAILED");
    }
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

  it("shows the team the same cost per $1M as the bot page, only for Market Making and Volume Farm bots", async () => {
    const { client } = await connectedUser("cpm-user@example.com");
    const me = meSchema.parse((await client.request("GET", "/api/v1/me")).json());
    const make = async (strategy: string, name: string, config: unknown) => {
      const res = await client.request("POST", "/api/v1/bots", {
        body: { strategy, name, paramSource: "manual", config },
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    };
    const mm = await make("volume_maker", "MM", vmConfig);
    const idle = await make("volume_maker", "MM idle", vmConfig);
    const empty = await make("volume_maker", "MM empty", vmConfig);
    const gridId = await make("spot_grid", "Grid", grid);
    const farm = await make("volume_farm", "Farm", farmConfig);
    const runtime = async (id: string, state: unknown) => {
      const { rows } = await env.pool.query<{ active_version_id: string }>(
        "select active_version_id from bots where id = $1",
        [id],
      );
      await env.pool.query(
        "insert into bot_runtime (bot_id, version_id, state, epoch) values ($1, $2, $3, 1)",
        [id, rows[0]?.active_version_id, JSON.stringify(state)],
      );
    };
    const ledger = (fees: string, realized: string) => ({
      position: "0",
      avgCost: "0",
      realized,
      fees,
      funding: "0",
      invested: "0",
    });
    // Phí 3 + lỗ đã chốt 2 = 5 trên khối lượng 20,000 → 250 trên $1M.
    await runtime(mm, {
      mid: null,
      volume: "20000",
      makerVolume: "15000",
      ledger: ledger("3", "-2"),
      selfTradeBlocked: 0,
    });
    await runtime(empty, {
      mid: null,
      volume: "0",
      makerVolume: "0",
      ledger: ledger("0", "0"),
      selfTradeBlocked: 0,
    });
    await runtime(gridId, { ledger: ledger("1", "5") });
    // Volume Farm: lãi giá 1 − phí 4 = −3 trên khối lượng 10,000 → 300 trên $1M.
    await runtime(farm, { volume: "10000", trades: 1, wins: 0, ledger: ledger("4", "1") });
    const farmPage = botDetailSchema.parse(
      (await client.request("GET", `/api/v1/bots/${farm}`)).json(),
    ).volumeFarm?.session.costPerMillion;
    expect(farmPage).toBe("300");
    await env.pool.query("update bots set state = 'running' where id = $1", [mm]);
    const fromBotPage = botDetailSchema.parse(
      (await client.request("GET", `/api/v1/bots/${mm}`)).json(),
    ).volumeMaker?.costPerMillion;
    expect(fromBotPage).toBe("250");

    const admin = new TestClient(env.app);
    const am = meSchema.parse((await signIn(env, admin, "cpm-admin@example.com")).json());
    await env.pool.query("update users set role = 'team' where id = $1", [am.id]);
    const detail = adminUserDetailSchema.parse(
      (await admin.request("GET", `/api/v1/admin/users/${me.id}`)).json(),
    );
    const cpm = (id: string) => detail.bots.find((b) => b.id === id)?.costPerMillion;
    expect(cpm(mm)).toBe(fromBotPage);
    expect(cpm(farm)).toBe(farmPage);
    // Chưa chạy (không có state) hoặc chưa có khối lượng: null, không phải 0.
    expect(cpm(idle)).toBeNull();
    expect(cpm(empty)).toBeNull();
    expect(cpm(gridId)).toBeNull();
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

  it("supersedes a version still pending when the bot stopped, and runs again with it (DEC-304)", async () => {
    const { client, secret } = await connectedUser("again-pending@example.com");
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Pending", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    await env.pool.query("update bots set state = 'stopped' where id = $1", [id]);
    await env.pool.query(
      `insert into bot_versions (id, bot_id, version, config, param_source, status)
       select gen_random_uuid(), bot_id, 2, config || '{"gridLevels":4}'::jsonb, 'manual', 'pending' from bot_versions
       where bot_id = $1 and version = 1`,
      [id],
    );
    env.sodex.setBuilder(ADDRESS, Number(TEST_BUILDER_ID), 50);
    const code = nextTotp(secret);
    env.prices.set("vBTC_vUSDC", { price: "100", at: env.clock.now.getTime() });
    const start = await client.request("POST", `/api/v1/bots/${id}/actions/start`, {
      body: { acknowledged: true, twoFactorCode: code },
    });
    expect(start.statusCode, start.body).toBe(202);
    const rows = await env.pool.query<{ version: number; status: string; levels: number }>(
      "select version, status, (config->>'gridLevels')::int as levels from bot_versions where bot_id = $1 order by version",
      [id],
    );
    expect(rows.rows.map((r) => `${String(r.version)}:${r.status}`)).toEqual([
      "1:superseded",
      "2:superseded",
      "3:active",
    ]);
    expect(rows.rows[2]?.levels).toBe(4);
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
    await env.pool.query("update bots set state = 'running' where id = $1", [id]);
    // Vị thế thật trên SoDEX lệch sổ cái (engine đã cảnh báo): không hiện lãi / lỗ (quy tắc 1.8); khớp lại thì hiện lại.
    await env.pool.query("update bots set position_mismatch = $2 where id = $1", [
      id,
      JSON.stringify({
        vBTC_vUSDC: { real: "3", ledger: "2", since: env.clock.now.toISOString() },
      }),
    ]);
    expect(await net()).toBeNull();
    const listed = botListSchema.parse((await client.request("GET", "/api/v1/bots")).json());
    const row = listed.items.find((b) => b.id === id);
    expect(row).toBeDefined();
    expect(row?.netPnl).toBeNull();
    // Cờ riêng: Needs attention hiện khi needs_attention HOẶC lệch vị thế (grid "back in range" tắt needs_attention không
    // tắt cảnh báo lệch vị thế).
    expect(row?.needsAttention).toBe(true);
    // AI Desk / AI Analyst cũng không hiện lãi / lỗ (M4).
    const { rows: owner } = await env.pool.query<{ user_id: string }>(
      "select user_id from bots where id = $1",
      [id],
    );
    const analyst = (await analystBots(env.db, owner[0]?.user_id ?? "")).find((b) => b.id === id);
    expect(analyst?.netPnl).toBeNull();
    expect(analyst?.needsAttention).toBe(true);
    await env.pool.query("update bots set position_mismatch = null where id = $1", [id]);
    expect(await net()).toBe("24");
    expect(
      botListSchema
        .parse((await client.request("GET", "/api/v1/bots")).json())
        .items.find((b) => b.id === id)?.needsAttention,
    ).toBe(false);
    expect(
      (await analystBots(env.db, owner[0]?.user_id ?? "")).find((b) => b.id === id)?.netPnl,
    ).not.toBeNull();
    // Bot đã dừng không còn quản lý vị thế: cờ không còn tác dụng (M6).
    await env.pool.query(
      "update bots set position_mismatch = $2, state = 'stopped' where id = $1",
      [
        id,
        JSON.stringify({
          vBTC_vUSDC: { real: "3", ledger: "2", since: env.clock.now.toISOString() },
        }),
      ],
    );
    expect(await net()).toBe("4");
    await env.pool.query("update bots set position_mismatch = null where id = $1", [id]);
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

  it("gives each decision the result of its real orders and counts real refusals (BD-02, BD-05)", async () => {
    const { client } = await connectedUser(`result-${randomUUID()}@drift.test`);
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Results", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const { rows } = await env.pool.query<{ acc: string }>(
      "select sodex_account_id as acc from bots where id = $1",
      [id],
    );
    const acc = rows[0]?.acc ?? "";
    const at = env.clock.now;
    const order = (clOrdId: string, status: string, filled: string, rejectCode: string | null) =>
      env.pool.query(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, reject_code, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, 'vBTC_vUSDC', 'spot', 'buy', 'limit', 'GTX', 1, $4, $5, $6, 'grid', 1, $7)",
        [id, acc, clOrdId, filled, status, rejectCode, at],
      );
    const decision = (name: string, ids: string[] | null, ago: number) =>
      env.pool.query(
        "insert into bot_events (id, bot_id, type, decision, payload, occurred_at) values (gen_random_uuid(), $1, 'decision', $2, $3, $4)",
        [
          id,
          name,
          JSON.stringify(ids === null ? {} : { orders: ids }),
          new Date(at.getTime() - ago),
        ],
      );
    const tag = randomUUID().slice(0, 8);
    await order(`f-${tag}`, "filled", "1", null);
    await order(`c-${tag}`, "cancelled", "0", null);
    await order(`p-${tag}`, "rejected", "0", "PostOnly");
    await order(`x-${tag}`, "rejected", "0", "-1");
    await order(`r-${tag}`, "rejected", "0", "RISK_PER_TRADE");
    await decision("Bought at level 1", [`f-${tag}`], 4_000);
    await decision("Bought at level 2", [`c-${tag}`], 3_000);
    await decision("Bought at level 3", [`p-${tag}`], 2_000);
    await decision("Price left the grid range", null, 1_000);
    const detail = botDetailSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}`)).json(),
    );
    const outcome = (d: string) => detail.events.find((e) => e.decision === d)?.outcome;
    expect(outcome("Bought at level 1")).toBe("filled");
    expect(outcome("Bought at level 2")).toBe("cancelled");
    expect(outcome("Bought at level 3")).toBe("rejected");
    // Quyết định không đặt lệnh: không có kết quả (không đoán).
    expect(outcome("Price left the grid range")).toBeNull();
    // Pill Result link tới đúng lệnh (clOrdID); Orders lọc được theo lệnh đó.
    const order_ = (d: string) => detail.events.find((e) => e.decision === d)?.order;
    expect(order_("Bought at level 1")).toBe(`f-${tag}`);
    expect(order_("Price left the grid range")).toBeNull();
    const one = orderListSchema.parse(
      (await client.request("GET", `/api/v1/orders?botId=${id}&order=c-${tag}`)).json(),
    );
    expect(one.items.map((o) => o.clOrdId)).toEqual([`c-${tag}`]);
    // Người khác dán clOrdID của A vào `?order=` (có hoặc không kèm botId của A): không thấy dòng nào.
    const other = await connectedUser(`result-other-${randomUUID()}@drift.test`);
    for (const url of [
      `/api/v1/orders?order=c-${tag}`,
      `/api/v1/orders?botId=${id}&order=c-${tag}`,
    ]) {
      const res = await other.client.request("GET", url);
      expect(res.statusCode).toBe(200);
      expect(orderListSchema.parse(res.json()).items).toEqual([]);
    }
    // Post-only cross là bình thường; giới hạn rủi ro của DeskLabs đếm riêng, không gọi là SoDEX từ chối.
    expect(detail.refusedRecently).toBe(1);
    expect(detail.blockedByRiskRecently).toBe(1);
  });

  it("tells Decisions which entry try of a round each Enter decision is, its reject code and fill price (DEC-307)", async () => {
    const { client } = await connectedUser(`vb-tries-${randomUUID()}@drift.test`);
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Tries", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const { rows } = await env.pool.query<{ acc: string }>(
      "select sodex_account_id as acc from bots where id = $1",
      [id],
    );
    const acc = rows[0]?.acc ?? "";
    const at = env.clock.now;
    const tag = randomUUID().slice(0, 8);
    const order = (
      clOrdId: string,
      orderTag: string,
      status: string,
      filled: string,
      avg: string | null,
      rejectCode: string | null,
    ) =>
      env.pool.query(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, avg_price, status, reject_code, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, 'ETH-USD', 'perps', 'buy', 'limit', 'GTX', 1, $4, $5, $6, $7, $8, 1, $9)",
        [id, acc, clOrdId, filled, avg, status, rejectCode, orderTag, at],
      );
    const decision = (name: string, ids: string[], ago: number) =>
      env.pool.query(
        "insert into bot_events (id, bot_id, type, decision, payload, occurred_at) values (gen_random_uuid(), $1, 'decision', $2, $3, $4)",
        [id, name, JSON.stringify({ orders: ids }), new Date(at.getTime() - ago)],
      );
    await order(`a-${tag}`, "vf:7:in:0", "rejected", "0", null, "PostOnly");
    await order(`b-${tag}`, "vf:8:in:1", "cancelled", "0", null, null);
    await order(`c-${tag}`, "vf:9:in:2", "filled", "1", "1800.7", null);
    await order(`d-${tag}`, "vf:9:out:0", "filled", "1", "1801.2", null);
    await decision("Enter long", [`a-${tag}`], 3_000);
    await decision("Enter short", [`b-${tag}`], 2_000);
    await decision("Enter long", [`c-${tag}`], 1_000);
    await decision("Closed long", [`d-${tag}`], 500);
    const detail = botDetailSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}`)).json(),
    );
    const pick = (o: string) => {
      const e = detail.events.find((x) => x.order === o);
      return e === undefined ? null : [e.entryTry, e.rejectCode, e.fillPrice];
    };
    expect(pick(`a-${tag}`)).toEqual([0, "PostOnly", null]);
    expect(pick(`b-${tag}`)).toEqual([1, null, null]);
    expect(pick(`c-${tag}`)?.slice(0, 2)).toEqual([2, null]);
    expect(Number(pick(`c-${tag}`)?.[2])).toBe(1800.7);
    // Lệnh không phải lệnh vào: không có số lần thử (giá khớp vẫn có).
    expect(pick(`d-${tag}`)?.[0]).toBeNull();
  });

  it("never sends the Volume Farm signal snapshot of a decision to the browser (#221)", async () => {
    const { client } = await connectedUser(`vb-snap-${randomUUID()}@drift.test`);
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Snapshot", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const { rows } = await env.pool.query<{ acc: string }>(
      "select sodex_account_id as acc from bots where id = $1",
      [id],
    );
    const tag = randomUUID().slice(0, 8);
    await env.pool.query(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, avg_price, status, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, 'ETH-USD', 'perps', 'buy', 'limit', 'GTX', 1, 1, 1800.5, 'filled', 'vf:3:in:0', 1, $4)",
      [id, rows[0]?.acc ?? "", `s-${tag}`, env.clock.now],
    );
    const signal = {
      v: 1,
      direction: "long",
      side: "long",
      score: 0.61,
      confidence: 0.55,
      regime: "SIDEWAY",
      components: {
        candleMomentum: 0.7,
        wickRejection: 0.52,
        volumeAcceleration: 0.6,
        tradePressure: 0.5,
        orderbookImbalance: 0.54,
      },
      spreadBps: 0.6,
      reason: "LONG: score 0.610, regime SIDEWAY",
      reversed: false,
      balanced: false,
      price: {
        bid: "1800.4",
        ask: "1800.6",
        mid: "1800.5",
        last: null,
        mark: null,
        bookAgeMs: 0,
        chg1mBps: 3.1,
        chg3mBps: 5.2,
        chg5mBps: 8,
      },
      order: {
        clOrdID: `s-${tag}`,
        price: "1800.5",
        size: "1",
        usd: "1800.50",
        holdSecs: 140,
        entryTry: 0,
        taker: false,
      },
    };
    await env.pool.query(
      "insert into bot_events (id, bot_id, type, decision, payload, occurred_at) values (gen_random_uuid(), $1, 'decision', 'Enter long', $2, $3)",
      [id, JSON.stringify({ orders: [`s-${tag}`], signal }), env.clock.now],
    );
    const res = await client.request("GET", `/api/v1/bots/${id}`);
    expect(res.statusCode).toBe(200);
    // Kết quả từ `payload.orders` vẫn có (BD-02), snapshot thì không (tên thành phần tín hiệu là logic chiến lược).
    const detail = botDetailSchema.parse(res.json());
    const ev = detail.events.find((e) => e.decision === "Enter long");
    expect(ev).toMatchObject({ order: `s-${tag}`, outcome: "filled", entryTry: 0 });
    expect(ev).not.toHaveProperty("payload");
    expect(ev).not.toHaveProperty("signal");
    for (const marker of ["candleMomentum", "wickRejection", "volumeAcceleration", "chg1mBps"])
      expect(res.body).not.toContain(marker);
  });

  it("never sends the Market Making quote snapshot of a decision to the browser (#230)", async () => {
    const { client } = await connectedUser(`mm-snap-${randomUUID()}@drift.test`);
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Quote snapshot", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const { rows } = await env.pool.query<{ acc: string }>(
      "select sodex_account_id as acc from bots where id = $1",
      [id],
    );
    const tag = randomUUID().slice(0, 8);
    await env.pool.query(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, avg_price, status, tag, epoch, created_at, context) values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', 'sell', 'market', 'IOC', 0.005, 0.005, 99839.9, 'filled', 'vm:9:cut:close', 1, $4, $5)",
      [
        id,
        rows[0]?.acc ?? "",
        `q-${tag}`,
        env.clock.now,
        // Bối cảnh lúc đặt (#233): cột `orders.context` cũng không bao giờ tới trình duyệt.
        JSON.stringify({
          v: 1,
          reason: "cut",
          mid: "99999.95",
          bid: "99999.9",
          ask: "100000",
          fair: "99839.9",
          fairAgeMs: 0,
          level: 0,
          bp: null,
          fairBp: null,
          pos: "0.005",
          smart: true,
          sig: "buy:2|sell:pull",
          fastPause: false,
        }),
      ],
    );
    const quote = {
      v: 1,
      reason: "cut",
      sides: ["sell"],
      fair: { price: "99839.9", ageMs: 40, used: true, clampBp: 0.5, clamps: 0 },
      book: { bid: "99999.9", ask: "100000", mid: "99999.95", ageMs: 120, last: "100000" },
      quote: { level: 0, distanceBp: null },
      inv: {
        position: "0.005",
        entry: "99999.9",
        notional: "500.00",
        maxUsd: "2000",
        maxOrders: null,
      },
      smart: { on: true, sig: "buy:2|sell:pull", fastPause: false },
      orders: [
        {
          id: `q-${tag}`,
          side: "sell",
          role: "close",
          st: "new",
          price: null,
          size: "0.005",
          bp: null,
          fairBp: null,
        },
      ],
    };
    await env.pool.query(
      "insert into bot_events (id, bot_id, type, decision, payload, occurred_at) values (gen_random_uuid(), $1, 'decision', 'Position cut', $2, $3)",
      [id, JSON.stringify({ orders: [`q-${tag}`], quote }), env.clock.now],
    );
    const res = await client.request("GET", `/api/v1/bots/${id}`);
    expect(res.statusCode).toBe(200);
    // Kết quả từ `payload.orders` vẫn có (BD-02), snapshot báo giá thì không.
    const detail = botDetailSchema.parse(res.json());
    const ev = detail.events.find((e) => e.decision === "Position cut");
    expect(ev).toMatchObject({ order: `q-${tag}`, outcome: "filled" });
    expect(ev).not.toHaveProperty("payload");
    expect(ev).not.toHaveProperty("quote");
    for (const marker of ["fairBp", "clampBp", "fastPause", "fairAgeMs", "buy:2|sell:pull"])
      expect(res.body).not.toContain(marker);
    // Danh sách lệnh và fill của bot cũng không gửi `orders.context`.
    for (const path of [`/api/v1/orders?botId=${id}`, `/api/v1/bots/${id}/fills`]) {
      const r = await client.request("GET", path);
      expect(r.statusCode).toBe(200);
      for (const marker of ["fairBp", "fairAgeMs", "fastPause", "buy:2|sell:pull"])
        expect(r.body).not.toContain(marker);
    }
    const list = await client.request("GET", `/api/v1/orders?botId=${id}`);
    expect(list.body).toContain(`q-${tag}`);
  });

  it("splits post-only misses from other rejects and counts rounds that filled (DEC-300)", async () => {
    const { client } = await connectedUser(`vb-rounds-${randomUUID()}@drift.test`);
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Rounds", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const { rows } = await env.pool.query<{ acc: string; created: Date }>(
      "select sodex_account_id as acc, created_at as created from bots where id = $1",
      [id],
    );
    const acc = rows[0]?.acc ?? "";
    // Trong kỳ "all" (từ lúc tạo bot tới giờ của API).
    const at = new Date(
      Math.min(env.clock.now.getTime(), (rows[0]?.created ?? env.clock.now).getTime() + 1_000),
    );
    await env.pool.query("update bots set created_at = $2 where id = $1", [
      id,
      new Date(at.getTime() - 60_000),
    ]);
    const order = (
      tag: string,
      type: "limit" | "market",
      status: string,
      filled: string,
      rejectCode: string | null,
    ) =>
      env.pool.query(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, reject_code, tag, epoch, created_at, submitted_at) values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', 'buy', $4, 'GTX', 1, $5, $6, $7, $8, 1, $9, $9)",
        [id, acc, `${tag}-${randomUUID().slice(0, 8)}`, type, filled, status, rejectCode, tag, at],
      );
    // Lượt 1: post-only bị từ chối hai lần rồi khớp. Lượt 2: hết giờ, huỷ. Lượt 3: bị từ chối vì lý do khác, chưa khớp.
    await order("vf:1:in:0", "limit", "rejected", "0", "PostOnly");
    await order("vf:2:in:1", "limit", "rejected", "0", "PostOnly");
    await order("vf:3:in:2", "limit", "filled", "1", null);
    await order("vf:4:in:0", "limit", "cancelled", "0", null);
    await order("vf:5:in:1", "limit", "rejected", "0", "-1");
    // Lệnh thoát và stop loss trên sàn không phải lượt vào.
    await order("vf:3:out:0", "limit", "filled", "1", null);
    await order("vf:3:sl", "market", "cancelled", "0", null);
    const read = async () =>
      volumeAnalyticsSchema.parse(
        (await client.request("GET", `/api/v1/bots/${id}/volume-analytics?period=all`)).json(),
      ).totals;
    // Không phải Volume Farm: không có số lượt ("Not available").
    let tot = await read();
    expect(tot.rounds).toBeNull();
    expect(tot.roundsFilled).toBeNull();
    await env.pool.query("update bots set strategy = 'volume_farm' where id = $1", [id]);
    tot = await read();
    expect(tot.ordersRejected).toBe(3);
    expect(tot.rejectedSplit.postOnly).toBe(2);
    expect(tot.rounds).toBe(2);
    expect(tot.roundsFilled).toBe(1);
  });

  it("ends the last run of a stopped bot at its first pause or stop after Running (BD-06)", async () => {
    const { client } = await connectedUser(`runtime-end-${randomUUID()}@drift.test`);
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Ended", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    const now = env.clock.now.getTime();
    const ev = (decision: string, ago: number) =>
      env.pool.query(
        "insert into bot_events (id, bot_id, type, decision, occurred_at) values (gen_random_uuid(), $1, 'state', $2, $3)",
        [id, decision, new Date(now - ago)],
      );
    await ev("Running", 3 * 3_600_000);
    await ev("Paused", 2 * 3_600_000);
    await ev("Stopped", 3_600_000);
    await env.pool.query("update bots set state = 'stopped' where id = $1", [id]);
    const detail = botDetailSchema.parse(
      (await client.request("GET", `/api/v1/bots/${id}`)).json(),
    );
    expect(Date.parse(detail.runningSince ?? "")).toBe(now - 3 * 3_600_000);
    // Lần chạy dừng ở lần pause (2 giờ trước), không phải lúc Stop sau đó.
    expect(Date.parse(detail.runningUntil ?? "")).toBe(now - 2 * 3_600_000);
  });

  it("clears the old pause reason when the user stops a paused bot (BD-06)", async () => {
    const { client } = await connectedUser(`stop-clears-${randomUUID()}@drift.test`);
    const made = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Paused", paramSource: "manual", config: grid },
    });
    const id = made.json<{ id: string }>().id;
    await env.pool.query(
      "update bots set state = 'paused', reason_code = 'BOT_MAX_LOSS' where id = $1",
      [id],
    );
    const stop = await client.request("POST", `/api/v1/bots/${id}/actions/stop`, { body: {} });
    expect(stop.statusCode).toBe(202);
    const { rows } = await env.pool.query<{ state: string; reason_code: string | null }>(
      "select state, reason_code from bots where id = $1",
      [id],
    );
    // Engine sẽ ghi "Stopped" với STOPPED_BY_USER ("Stopped by you"), không phải BOT_MAX_LOSS.
    expect(rows[0]).toEqual({ state: "stopping", reason_code: null });
  });
});

describe("Idempotency-Key is bound to the bot it was used on (#314)", () => {
  const made = async (client: TestClient, name: string, state: string) => {
    const res = await client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name, paramSource: "manual", config: grid },
    });
    const id = res.json<{ id: string }>().id;
    await env.pool.query("update bots set state = $2 where id = $1", [id, state]);
    return id;
  };
  const stateOf = async (id: string) =>
    (await env.pool.query<{ state: string }>("select state from bots where id = $1", [id])).rows[0]
      ?.state;

  it("never replays a stop of one bot for another bot with the same key and body", async () => {
    const { client } = await connectedUser(`idem-stop-${randomUUID()}@drift.test`);
    const a = await made(client, "A", "paused");
    const b = await made(client, "B", "paused");
    const key = randomUUID();
    const stopA = await client.request("POST", `/api/v1/bots/${a}/actions/stop`, {
      body: {},
      idempotencyKey: key,
    });
    expect(stopA.statusCode).toBe(202);
    expect(stopA.json()).toMatchObject({ id: a });

    // Trước #314: trả lại response của bot A (202) và bot B không dừng.
    const stopB = await client.request("POST", `/api/v1/bots/${b}/actions/stop`, {
      body: {},
      idempotencyKey: key,
    });
    expect(stopB.statusCode).toBe(409);
    expect(errorOf(stopB.body).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(stopB.headers["idempotent-replayed"]).toBeUndefined();
    expect(await stateOf(b)).toBe("paused");

    // Cùng key, cùng bot, cùng body: phát lại đúng response cũ.
    const again = await client.request("POST", `/api/v1/bots/${a}/actions/stop`, {
      body: {},
      idempotencyKey: key,
    });
    expect(again.statusCode).toBe(202);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(again.json()).toEqual(stopA.json());

    // Cùng key, khác action trên cùng bot: cũng là request khác.
    const pause = await client.request("POST", `/api/v1/bots/${a}/actions/pause`, {
      body: {},
      idempotencyKey: key,
    });
    expect(errorOf(pause.body).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("never replays a start of one bot for another, and keeps keys of different users apart", async () => {
    const { client, secret } = await connectedUser(`idem-start-${randomUUID()}@drift.test`);
    env.sodex.setBuilder(ADDRESS, Number(TEST_BUILDER_ID), 50);
    // Nhập mã 2FA một lần để phiên được tin 2 giờ (DEC-115): các lần Start sau có cùng body.
    const first = await made(client, "First", "stopped");
    const code = nextTotp(secret);
    env.prices.set("vBTC_vUSDC", { price: "100", at: env.clock.now.getTime() });
    const trusted = await client.request("POST", `/api/v1/bots/${first}/actions/start`, {
      body: { acknowledged: true, twoFactorCode: code },
    });
    expect(trusted.statusCode, trusted.body).toBe(202);
    env.prices.set("vBTC_vUSDC", { price: "100", at: env.clock.now.getTime() });

    const a = await made(client, "A", "stopped");
    const b = await made(client, "B", "stopped");
    const key = randomUUID();
    const body = { acknowledged: true };
    const startA = await client.request("POST", `/api/v1/bots/${a}/actions/start`, {
      body,
      idempotencyKey: key,
    });
    expect(startA.statusCode, startA.body).toBe(202);
    const startB = await client.request("POST", `/api/v1/bots/${b}/actions/start`, {
      body,
      idempotencyKey: key,
    });
    expect(errorOf(startB.body).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
    expect(await stateOf(b)).toBe("stopped");
    const replay = await client.request("POST", `/api/v1/bots/${a}/actions/start`, {
      body,
      idempotencyKey: key,
    });
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(startA.json());

    // Người dùng khác dùng đúng key đó: độc lập, xử lý bình thường.
    const other = await connectedUser(`idem-other-${randomUUID()}@drift.test`);
    const c = await made(other.client, "C", "paused");
    const stopC = await other.client.request("POST", `/api/v1/bots/${c}/actions/stop`, {
      body: {},
      idempotencyKey: key,
    });
    expect(stopC.statusCode).toBe(202);
    expect(stopC.headers["idempotent-replayed"]).toBeUndefined();
    expect(await stateOf(c)).toBe("stopping");
  });

  it("refuses a key stored with the old route-only fingerprint until it expires", async () => {
    const { client } = await connectedUser(`idem-legacy-${randomUUID()}@drift.test`);
    const a = await made(client, "A", "paused");
    const me = meSchema.parse((await client.request("GET", "/api/v1/me")).json());
    const key = randomUUID();
    // Dòng ghi trước #314: hash không có tiền tố "v2:", không biết thuộc bot nào.
    await env.pool.query(
      `insert into idempotency_keys (id, key, user_id, request_hash, status_code, response, expires_at)
       values (gen_random_uuid(), $1, $2, repeat('a', 64), 202, '{"id":"other"}'::jsonb, $3)`,
      [key, me.id, new Date(env.clock.now.getTime() + 3_600_000)],
    );
    const stop = () =>
      client.request("POST", `/api/v1/bots/${a}/actions/stop`, { body: {}, idempotencyKey: key });
    const refused = await stop();
    expect(errorOf(refused.body)).toMatchObject({
      code: "IDEMPOTENCY_KEY_CONFLICT",
      details: { reason: "fingerprint_outdated" },
    });
    expect(await stateOf(a)).toBe("paused");

    // Hết 24 h thì key được giải phóng: request chạy bình thường.
    await env.pool.query("update idempotency_keys set expires_at = $2 where key = $1", [
      key,
      new Date(env.clock.now.getTime() - 1),
    ]);
    const done = await stop();
    expect(done.statusCode).toBe(202);
    expect(done.headers["idempotent-replayed"]).toBeUndefined();
    expect(await stateOf(a)).toBe("stopping");
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
