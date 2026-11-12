import {
  botListSchema,
  botSummarySchema,
  deskBotsViewSchema,
  errorResponseSchema,
  goLiveViewSchema,
  meSchema,
  paperViewSchema,
  planViewSchema,
  riskViewSchema,
  suggestionViewSchema,
  type RecoMarket,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// AI Desk (DEC-105): Recommended một bot, bot paper chỉ chạy bằng tiền giả, dữ liệu paper không vào số liệu tiền thật.

let env: TestEnv;
const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const closes = Array.from({ length: 31 }, (_, i) =>
  (66000 * (1 + 0.04 * Math.sin(i / 2))).toFixed(2),
);
const MARKET: RecoMarket = {
  market: "vBTC_vUSDC",
  engine: "spot",
  asset: "BTC",
  quote: "vUSDC",
  lastPrice: "67000",
  sigma30: 0.025,
  p5: "62000",
  p95: "72000",
  trend: 0.1,
  rangeScore: 0.7,
  fundingAvg7d: null,
  fundingPos21: null,
  closes,
  rules: { tickSize: "0.01", stepSize: "0.0001", minQuantity: "0.0001", minNotional: "10" },
  maxLeverage: null,
};
const errorOf = (body: unknown) => errorResponseSchema.parse(body).error;

beforeAll(async () => {
  env = await startTestEnv();
  env.reco.markets = [MARKET];
  env.prices.set("vBTC_vUSDC", { price: "67000", at: env.clock.now.getTime() });
});
afterAll(async () => {
  await env.close();
});

async function deskUser(email: string, opts: { connect?: boolean; desk?: boolean } = {}) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  if (opts.desk !== false)
    await env.pool.query("update users set ai_desk = true where id = $1", [me.id]);
  if (opts.connect !== false) {
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
  }
  await client.request("PUT", "/api/v1/goals", {
    body: { goal: "range", capital: "8000", maxDrop: "10", assets: ["BTC", "ETH"] },
  });
  return { client, userId: me.id };
}
const deskPlan = async (client: TestClient) =>
  client.request("POST", "/api/v1/reco/plan", { body: { context: "desk" } });

describe("AI Desk recommended", () => {
  it("is off until the team turns it on", async () => {
    const { client } = await deskUser("desk-off@example.com", { desk: false });
    expect(errorOf((await deskPlan(client)).json()).code).toBe("FORBIDDEN");
    expect(errorOf((await client.request("GET", "/api/v1/desk/bots")).json()).code).toBe(
      "FORBIDDEN",
    );
    const features = (await client.request("GET", "/api/v1/features")).json<{ aiDesk: boolean }>();
    expect(features.aiDesk).toBe(false);
  });

  it("suggests from the answers on screen without overwriting saved goals (DEC-95)", async () => {
    const { client } = await deskUser("desk-live@example.com", { connect: false });
    const res = await client.request("POST", "/api/v1/reco/plan", {
      body: {
        context: "desk",
        goals: { goal: "range", capital: "3000", maxDrop: "10", assets: ["BTC", "ETH"] },
      },
    });
    expect(planViewSchema.parse(res.json()).best?.capital).toBe("3000");
    const saved = (await client.request("GET", "/api/v1/goals")).json<{
      goals: { capital: string };
    }>();
    expect(saved.goals.capital).toBe("8000");
  });

  it("suggests one bot with the whole capital, even before SoDEX is connected", async () => {
    const { client } = await deskUser("desk-plan@example.com", { connect: false });
    const plan = planViewSchema.parse((await deskPlan(client)).json());
    expect(plan.addOns).toEqual([]);
    expect(plan.best?.capital).toBe("8000");
    // Why this one đọc lại đúng dữ liệu đã lưu: lý do, mức chịu lỗ, chiến lược bị loại.
    const s = suggestionViewSchema.parse(
      (await client.request("GET", `/api/v1/reco/suggestions/${plan.best?.id ?? ""}`)).json(),
    );
    expect(s).toMatchObject({ maxDrop: "10", capital: "8000", basis: plan.best?.basis });
    expect(s.notSuggested).toEqual(plan.notSuggested);
    // Onboarding giữ nguyên: không có body thì vẫn là kế hoạch của onboarding.
    const onboarding = planViewSchema.parse(
      (await client.request("POST", "/api/v1/reco/plan")).json(),
    );
    expect(onboarding.best?.strategy).toBe(plan.best?.strategy);
  });
});

describe("fake-money tests", () => {
  it("starts a paper bot without 2FA or SoDEX checks, caps running tests at 3, and keeps it out of live data", async () => {
    const { client, userId } = await deskUser("desk-paper@example.com");
    const plan = planViewSchema.parse((await deskPlan(client)).json());
    const suggestionId = plan.best?.id ?? "";
    const start = () =>
      client.request("POST", "/api/v1/desk/paper", {
        body: { suggestionId, name: "Spot Grid · BTC" },
      });
    const first = await start();
    expect(first.statusCode).toBe(201);
    const bot = botSummarySchema.parse(first.json());
    expect(bot).toMatchObject({ mode: "paper", state: "starting" });
    expect((await start()).statusCode).toBe(201);
    expect((await start()).statusCode).toBe(201);
    const fourth = await start();
    expect(errorOf(fourth.json()).message).toContain("up to 3");

    // Luồng Start của bot thật không chạy bot paper; dừng bài thử không cần 2FA.
    const restart = await client.request("POST", `/api/v1/bots/${bot.id}/actions/start`, {
      body: { acknowledged: true },
    });
    expect(errorOf(restart.json()).code).toBe("BOT_STATE_CONFLICT");
    await env.pool.query("update bots set state = 'running' where id = $1", [bot.id]);
    const stop = await client.request("POST", `/api/v1/bots/${bot.id}/actions/stop`, { body: {} });
    expect(stop.statusCode).toBe(202);

    // Trang kết quả: chưa có fill thì quá sớm, không có số giả lập nào bị bịa.
    const view = paperViewSchema.parse(
      (await client.request("GET", `/api/v1/desk/paper/${bot.id}`)).json(),
    );
    expect(view).toMatchObject({ capital: "8000", fills: 0, verdict: "too_early", day: 1 });
    expect(view.reasons).toEqual([{ key: "noFills" }]);
    expect(view.lossLimit).toEqual({ kind: "limit", amount: "800" });

    // Dữ liệu paper: lệnh + fill giả không vào Portfolio / Risk / AI Analyst / Users / Platform Stats.
    const { rows } = await env.pool.query<{ id: string; sodex_account_id: string }>(
      "select id, sodex_account_id from bots where id = $1",
      [bot.id],
    );
    const acct = rows[0]?.sodex_account_id;
    const { rows: ord } = await env.pool.query<{ id: string }>(
      "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, price, status, tag, epoch, submitted_at) values (gen_random_uuid(), $1, $2, 'paper-1', 'vBTC_vUSDC', 'spot', 'buy', 'limit', 'GTC', 1, 0, 67000, 'open', 'x', 1, now()) returning id",
      [bot.id, acct],
    );
    await env.pool.query(
      "insert into paper_fills (id, bot_id, order_id, market, side, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, 'vBTC_vUSDC', 'buy', 67000, 1, 1, true, now())",
      [bot.id, ord[0]?.id],
    );
    await env.pool.query(
      "update bots set state = 'running' where user_id = $1 and mode = 'paper' and state = 'starting'",
      [userId],
    );
    const risk = riskViewSchema.parse(
      (await client.request("GET", "/api/v1/risk")).json<{ risk: unknown }>().risk,
    );
    expect(risk.halt).toMatchObject({ running: 0, paused: 0, openOrders: 0 });
    const pf = (await client.request("GET", "/api/v1/portfolio")).json<{
      portfolio: { pendingOrders: { count: number } } | null;
    }>().portfolio;
    expect(pf?.pendingOrders.count ?? 0).toBe(0);
    // Team: số bot của Platform Stats và Users chỉ tính bot thật.
    await env.pool.query("update users set role = 'team' where id = $1", [userId]);
    const stats = (await client.request("GET", "/api/v1/admin/stats?period=7")).json<{
      bots: { total: number; running: number };
    }>();
    const { rows: liveBots } = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from bots where mode = 'live' and archived_at is null",
    );
    expect(stats.bots.total).toBe(liveBots[0]?.n);
    const users = (await client.request("GET", "/api/v1/admin/users?q=desk-paper")).json<{
      items: { email: string; bots: { total: number; running: number } }[];
    }>();
    expect(users.items.find((u) => u.email === "desk-paper@example.com")?.bots).toEqual({
      total: 0,
      running: 0,
    });
    await env.pool.query("update users set role = 'user' where id = $1", [userId]);
    const analyst = (await client.request("GET", "/api/v1/analyst")).json<{ basis: string }>();
    expect(analyst.basis).toContain("0 bots");
    const real = await env.pool.query("select count(*)::int as n from fills");
    expect(real.rows[0]).toMatchObject({ n: 0 });

    // Danh sách bot vẫn hiện bài thử, có nhãn mode để UI gắn PAPER.
    const list = botListSchema.parse((await client.request("GET", "/api/v1/bots")).json());
    expect(list.items.filter((b) => b.mode === "paper")).toHaveLength(3);
    const desk = deskBotsViewSchema.parse(
      (await client.request("GET", "/api/v1/desk/bots")).json(),
    );
    expect(desk.notes).toEqual([]);
    expect(desk.paper).toHaveLength(3);
  });

  it("recalculates the settings for real money and lists what changed", async () => {
    const { client } = await deskUser("desk-golive@example.com");
    const plan = planViewSchema.parse((await deskPlan(client)).json());
    const bot = botSummarySchema.parse(
      (
        await client.request("POST", "/api/v1/desk/paper", {
          body: { suggestionId: plan.best?.id ?? "", name: "Spot Grid · BTC" },
        })
      ).json(),
    );
    // Giá thị trường đổi: khoảng grid tính lại khác bản đã thử.
    env.reco.markets = [{ ...MARKET, lastPrice: "70000", p5: "66000", p95: "76000" }];
    const view = goLiveViewSchema.parse(
      (await client.request("POST", `/api/v1/desk/paper/${bot.id}/go-live`)).json(),
    );
    env.reco.markets = [MARKET];
    expect(view).toMatchObject({ paperBotId: bot.id, strategy: "spot_grid", capital: "8000" });
    expect(view.live?.strategy).toBe("spot_grid");
    expect(view.changes.map((c) => c.key)).toEqual(
      expect.arrayContaining(["lowerPrice", "upperPrice"]),
    );
  });
});

describe("paper bots never need a 2FA setup", () => {
  it("works for a user without 2FA", async () => {
    const { client } = await deskUser("desk-no2fa@example.com");
    const plan = planViewSchema.parse((await deskPlan(client)).json());
    const res = await client.request("POST", "/api/v1/desk/paper", {
      body: { suggestionId: plan.best?.id ?? "", name: "Spot Grid · BTC" },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe("AI Adaptive DCA (DEC-107)", () => {
  const config = {
    market: "BTC-USD",
    leverage: 2,
    baseOrder: "100",
    safetyOrder: "100",
    maxExposure: "1000",
    maxLoss: "150",
  };
  it("is only available to accounts with AI Desk turned on", async () => {
    const off = await deskUser("adca-off@example.com", { desk: false });
    const denied = await off.client.request("POST", "/api/v1/bots", {
      body: { strategy: "adaptive_dca", name: "AI DCA", paramSource: "manual", config },
    });
    expect(errorOf(denied.json()).code).toBe("NOT_FOUND");
    const on = await deskUser("adca-on@example.com");
    const made = await on.client.request("POST", "/api/v1/bots", {
      body: { strategy: "adaptive_dca", name: "AI DCA", paramSource: "manual", config },
    });
    expect(made.statusCode).toBe(201);
    const id = botSummarySchema.parse(made.json()).id;
    // Vốn cần = trần vị thế / đòn bẩy.
    const list = botListSchema.parse((await on.client.request("GET", "/api/v1/bots")).json());
    expect(list.items.find((b) => b.id === id)).toMatchObject({
      strategy: "adaptive_dca",
      engine: "perps",
      capital: "500",
    });
  });
});

describe("Copy Trade (DEC-161)", () => {
  const LEADER = "0x1111111111111111111111111111111111111111";
  const config = {
    leaderAddress: LEADER,
    market: "BTC-USD",
    leverage: 2,
    fixedNotional: "100",
    maxNotionalPerTrade: "200",
    maxExposure: "1000",
    maxLoss: "150",
  };
  const create = (client: TestClient, c: Record<string, unknown>) =>
    client.request("POST", "/api/v1/bots", {
      body: { strategy: "copy_trade", name: "Copy", paramSource: "manual", config: c },
    });

  it("is only available to accounts with AI Desk turned on", async () => {
    const off = await deskUser("copy-off@example.com", { desk: false });
    expect(errorOf((await create(off.client, config)).json()).code).toBe("NOT_FOUND");
    const on = await deskUser("copy-on@example.com");
    const made = await create(on.client, config);
    expect(made.statusCode).toBe(201);
    const id = botSummarySchema.parse(made.json()).id;
    const list = botListSchema.parse((await on.client.request("GET", "/api/v1/bots")).json());
    // Vốn cần = trần vị thế / đòn bẩy.
    expect(list.items.find((b) => b.id === id)).toMatchObject({
      strategy: "copy_trade",
      engine: "perps",
      capital: "500",
    });
  });

  it("refuses the user's own wallet but accepts Hyperliquid traders (DEC-163)", async () => {
    const { client } = await deskUser("copy-rules@example.com");
    const own = errorOf((await create(client, { ...config, leaderAddress: ADDRESS })).json());
    expect(own.details).toMatchObject({
      fieldErrors: { leaderAddress: ["You can't copy your own wallet."] },
    });
    const hl = await create(client, { ...config, leaderSource: "hyperliquid" });
    expect(hl.statusCode).toBe(201);
  });
});
