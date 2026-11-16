import { randomUUID } from "node:crypto";

import {
  Decimal,
  errorResponseSchema,
  marketHoursViewSchema,
  meSchema,
  modelCostPerMillion,
  modelPnlBps,
  swingBps,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Market hours (docs/mockups/market-hours, DEC-283): giờ / ngày theo múi giờ người xem (Postgres
// AT TIME ZONE), kể cả múi giờ lệch 30 phút và ngày Mỹ đổi giờ; khối 3 từ fill thật; chỉ team. Dòng ước tính của mô
// hình Market Making (DEC-228) theo giờ.

let env: TestEnv;
const MARKET = `MH${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const EST_MARKET = `ME${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const EMPTY_MARKET = `MN${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const SHOCK_MARKET = `MS${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const CUT_MARKET = `MK${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const POS_MARKET = `MP${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;

beforeAll(async () => {
  env = await startTestEnv();
  // Tick size 0.01 (mock); MARKET cố ý không có trên SoDEX để kiểm "no_market_info".
  env.sodex.addPerpSymbol(EST_MARKET, { maxLeverage: 10 });
  env.sodex.addPerpSymbol(EMPTY_MARKET, { maxLeverage: 10 });
  env.sodex.addPerpSymbol(CUT_MARKET, { maxLeverage: 10 });
  env.sodex.addPerpSymbol(POS_MARKET, { maxLeverage: 10 });
  // Sau ngày Mỹ đổi giờ (Chủ nhật 2026-11-01): EDT (UTC−4) trước, EST (UTC−5) sau.
  env.clock.now = new Date("2026-11-02T23:00:00Z");
});
afterAll(async () => {
  await env.close();
});

async function teamUser() {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, `mh-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
  return { client, userId: me.id };
}

/**
 * Nến 1 phút từ 2026-10-30 00:00 đến 2026-11-02 23:59 UTC: range thường 10 bp; 13:00–13:29 UTC mỗi ngày range 100 bp
 * (nóng). 13:00 UTC = 09:00 New York trước đổi giờ, 08:00 sau đổi giờ; = 18:30 Kolkata (giờ địa phương 18).
 */
async function seedCandles() {
  await env.pool.query(
    `insert into candles_1m (market, ts, open, high, low, close, volume)
     select $1, ts, 100,
            case when extract(hour from ts at time zone 'UTC') = 13 and extract(minute from ts at time zone 'UTC') < 30
                 then 100.5 else 100.05 end,
            case when extract(hour from ts at time zone 'UTC') = 13 and extract(minute from ts at time zone 'UTC') < 30
                 then 99.5 else 99.95 end,
            100, 1
       from generate_series('2026-10-30T00:00:00Z'::timestamptz, '2026-11-02T22:59:00Z'::timestamptz, interval '1 minute') ts
     on conflict do nothing`,
    [MARKET],
  );
}

const view = async (client: TestClient, query: string) => {
  const r = await client.request(
    "GET",
    `/api/v1/admin/market-hours?market=${MARKET}&days=7${query}`,
  );
  expect(r.statusCode).toBe(200);
  return marketHoursViewSchema.parse(r.json());
};

describe("GET /api/v1/admin/market-hours", () => {
  it("is for the team only and rejects an unknown time zone with the standard error", async () => {
    const anon = new TestClient(env.app);
    expect((await anon.request("GET", "/api/v1/admin/market-hours")).statusCode).toBe(401);
    const user = new TestClient(env.app);
    await signIn(env, user, `mh-user-${randomUUID()}@drift.test`);
    const denied = await user.request("GET", "/api/v1/admin/market-hours");
    expect(denied.statusCode).toBe(403);
    // Kiểm quyền trước khi parse: người không thuộc team gửi tz sai vẫn nhận 403, không phải 400.
    const deniedBad = await user.request("GET", "/api/v1/admin/market-hours?tz=Mars%2FBase");
    expect(deniedBad.statusCode).toBe(403);
    expect(
      (await anon.request("GET", "/api/v1/admin/market-hours?tz=Mars%2FBase")).statusCode,
    ).toBe(401);
    const { client } = await teamUser();
    const bad = await client.request("GET", "/api/v1/admin/market-hours?tz=Mars%2FBase");
    expect(bad.statusCode).toBe(400);
    expect(errorOf(bad.body).code).toBe("VALIDATION_FAILED");
  });

  it("groups the hot window by the viewer's local hour, in UTC and in a half-hour zone", async () => {
    await seedCandles();
    const { client } = await teamUser();
    const utc = await view(client, "&tz=UTC");
    expect(utc.hours[13]?.volatility.hotPct).toBe(100);
    expect(utc.hours[12]?.volatility.hotPct).toBe(0);
    // Trung vị cả giờ 13 UTC: nửa giờ 100 bp, nửa giờ 10 bp → 55 bp.
    expect(utc.hours[13]?.volatility.medianBp).toBe("55");
    expect(utc.hours[12]?.volatility.medianBp).toBe("10");
    // Bước 5 phút: 13:00–13:29 là 100 bp, 13:30 trở đi 10 bp.
    expect(utc.hours[13]?.volatility.fiveMin.slice(4, 8)).toEqual(["100", "100", "10", "10"]);
    const kolkata = await view(client, "&tz=Asia%2FKolkata");
    // 13:00–13:29 UTC = 18:30–18:59 Kolkata: cả nửa giờ nóng rơi vào giờ địa phương 18.
    expect(kolkata.hours[18]?.volatility.fiveMin.slice(6, 12)).toEqual([
      "100",
      "100",
      "100",
      "100",
      "100",
      "100",
    ]);
    expect(kolkata.hours[19]?.volatility.medianBp).toBe("10");
    expect(kolkata.candlesSince).toBe("2026-10-30T00:00:00.000Z");
  });

  it("uses the viewer's local day and hour across the US clock change", async () => {
    const { client } = await teamUser();
    const ny = await view(client, "&tz=America%2FNew_York");
    const cell = (date: string, h: number) => ny.heatmap.find((d) => d.date === date)?.cells[h];
    // 31/10 (EDT): 13:00 UTC = 09:00 địa phương. 2/11 (EST): 13:00 UTC = 08:00 địa phương.
    expect(Number(cell("2026-10-31", 9)?.ratio)).toBeGreaterThan(2);
    expect(Number(cell("2026-10-31", 8)?.ratio)).toBeLessThan(2);
    expect(Number(cell("2026-11-02", 8)?.ratio)).toBeGreaterThan(2);
    expect(Number(cell("2026-11-02", 9)?.ratio)).toBeLessThan(2);
  });

  it("computes the bot block from real fills, with the one-minute markout and bot-hours", async () => {
    const { client, userId } = await teamUser();
    const { rows: acc } = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [userId, "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db", Math.floor(Math.random() * 1e9)],
    );
    const bot = async (mode: string) => {
      const { rows } = await env.pool.query<{ id: string }>(
        "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_maker', $3, 'perps', 'MH', 'running', $4) returning id",
        [userId, acc[0]?.id, MARKET, mode],
      );
      return rows[0]?.id ?? "";
    };
    const live = await bot("live");
    const paper = await bot("paper");
    let n = 0;
    const fill = async (botId: string, side: string, price: string, at: string, createdAt = at) => {
      n += 1;
      const { rows } = await env.pool.query<{ id: string }>(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', 1, 'filled', 'vm', 1, $6) returning id",
        [botId, acc[0]?.id, `mh-${String(n)}-${randomUUID().slice(0, 8)}`, MARKET, side, createdAt],
      );
      await env.pool.query(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, 1, 0.01, true, $4)",
        [rows[0]?.id, Math.floor(Math.random() * 1e12), price, at],
      );
    };
    // 2/11 10:00 UTC: mua 1 @ 100.02 (nến 10:01 đóng 100: lỗ giá 0.02) và bán 1 @ 99.99 (lỗ giá 0.01); phí 0.02.
    await fill(live, "buy", "100.02", "2026-11-02T10:00:10Z");
    await fill(live, "sell", "99.99", "2026-11-02T10:00:40Z");
    // Bot paper không bao giờ được tính.
    await fill(paper, "buy", "50", "2026-11-02T10:00:20Z");
    // Lệnh tạo sớm nhất có fill (09:00) nằm chờ tới 12:00 mới khớp: fillsSince vẫn phải là fill sớm nhất (10:00:10).
    await fill(live, "buy", "100", "2026-11-02T12:00:00Z", "2026-11-02T09:00:00Z");
    const v = await view(client, "&tz=UTC&strategy=volume_maker");
    const h = v.hours[10]?.bots;
    expect(h?.volume).toBe("200.01");
    expect(h?.fees).toBe("0.02");
    // (0.02 + 0.03) ÷ 200.01 × 1e6 ≈ 249.99
    expect(h?.costPerMillion).toBe("249.99");
    expect(h?.botHours).toBe(1);
    expect(h?.thin).toBe(true);
    // Giờ không có fill: không có số (không bao giờ 0).
    expect(v.hours[11]?.bots).toMatchObject({ costPerMillion: null, volume: null, botHours: 0 });
    expect(v.fillsSince).toBe("2026-11-02T10:00:10.000Z");
  });

  it("estimates the cost per $1M for each hour from the candles with the latest model coefficients", async () => {
    const { client } = await teamUser();
    // Một giờ (05:00–05:59 UTC ngày 2/11) giá đóng xen kẽ 100.1 / 100, kết thúc ở 100 → bước = 0.01 ÷ 100 = 1 bp.
    const closes = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? "100.1" : "100"));
    const values = closes.map(
      (c, i) =>
        `('${EST_MARKET}', '2026-11-02T05:${String(i).padStart(2, "0")}:00Z', 100, 100.1, 100, ${c}, 1)`,
    );
    await env.pool.query(
      `insert into candles_1m (market, ts, open, high, low, close, volume) values ${values.join(",")}`,
    );
    await env.pool.query(
      "insert into mm_market_hourly (market, hour, notional, markout_notional, trades, spread_ticks) values ($1, '2026-11-02T05:00:00Z', 100, 0, 1, '{}')",
      [EST_MARKET],
    );
    const { rows } = await env.pool.query<{ version: number }>(
      "insert into mm_model_coefs (a, k, points, day) values (0.2, 0.1, 5, '2026-11-01') returning version",
    );
    const r = await client.request(
      "GET",
      `/api/v1/admin/market-hours?market=${EST_MARKET}&days=7&tz=UTC`,
    );
    const v = marketHoursViewSchema.parse(r.json());
    // Phí = maker SoDEX cơ bản 1.2 bp (mock không có makerFee) + builder fee Market Making 0.3 bp.
    // Chi phí cắt: mock không có takerFee → phí taker perps cơ bản 4 bp; chưa có lệnh cắt thật → chỉ phí taker.
    expect(v.estimate).toEqual({
      feesBp: "1.5",
      stepBp: "1",
      modelVersion: rows[0]?.version,
      unavailable: null,
      shockBp: 15,
      cutTakerBp: "4",
      cutSlippageBp: null,
      cutCostBp: "4",
      cuts: 0,
      cutNotional: null,
      // Không có bot Market Making đọc được order size (bot của test trước không có cấu hình): R = 2 và F = 80 mặc
      // định → phần cắt 2 ÷ 80; C mặc định 1.0.
      positionRatio: "2",
      positionRatioSource: "default",
      fillsPerBotHour: "80",
      cutShare: "0.025",
      cutScope: { source: "default", botHours: 0, marketBotHours: 0, markets: [] },
      calibration: "1",
      calibrationScope: { source: "default", botHours: 0, marketBotHours: 0, markets: [] },
      calibrationHours: 0,
    });
    const swing = swingBps(closes);
    expect(swing).not.toBeNull();
    if (swing === null) return;
    // Chi phí = (1.5 + max(0, −(0.2 × 1 − 0.1 × dao động))) × 100, dao động ≈ 10.08 bp → ≈ $230.8.
    const expected = modelCostPerMillion(
      new Decimal("1.5"),
      modelPnlBps(new Decimal(1), swing, "0.2", "0.1"),
    );
    const h5 = v.hours[5]?.volatility;
    expect(h5?.swingBp).toBe(swing.toDecimalPlaces(2).toString());
    expect(h5?.estCostPerMillion).toBe(expected.toDecimalPlaces(2).toString());
    expect(Number(h5?.estCostPerMillion)).toBeCloseTo(230.8, 0);
    // Một ngày, không sốc (biến động 15 phút 10 bp < 15): "incl. shock days" = ngày điển hình.
    // C = 1.0 (mặc định): "calibrated" = "incl. shock days".
    expect(h5).toMatchObject({
      estShockCostPerMillion: h5?.estCostPerMillion,
      estCalibratedCostPerMillion: h5?.estCostPerMillion,
      estDays: 1,
      shockDays: 0,
    });
    // Giờ không có nến: null ("n/a"), không bao giờ 0.
    expect(v.hours[6]?.volatility).toMatchObject({
      swingBp: null,
      estCostPerMillion: null,
      estShockCostPerMillion: null,
      estCalibratedCostPerMillion: null,
      estDays: null,
      shockDays: null,
    });
  });

  it("averages the model cost over every day and adds a position cut on shock days, measured from real cuts", async () => {
    const { client, userId } = await teamUser();
    const market = CUT_MARKET;
    // 05:00–05:59 UTC hai ngày, close xen kẽ 100.1 / 100 (biến động 15 phút 10 bp). Ngày 2/11 có 05:30 close 100.3:
    // biến động 15 phút 30 bp ≥ 15 → ngày sốc.
    const dayCloses = (shock: boolean) =>
      Array.from({ length: 60 }, (_, i) =>
        shock && i === 30 ? "100.3" : i % 2 === 0 ? "100.1" : "100",
      );
    const values = (["2026-11-01", "2026-11-02"] as const).flatMap((d, k) =>
      dayCloses(k === 1).map(
        (c, i) =>
          `('${market}', '${d}T05:${String(i).padStart(2, "0")}:00Z', ${c}, ${c} + 0.05, ${c} - 0.05, ${c}, 1)`,
      ),
    );
    await env.pool.query(
      `insert into candles_1m (market, ts, open, high, low, close, volume) values ${values.join(",")}`,
    );
    const { rows: coefs } = await env.pool.query<{ version: number }>(
      "insert into mm_model_coefs (a, k, points, day) values (0.2, 0.1, 5, '2026-11-02') returning version",
    );
    // 3 bot Market Making thật, 5 lệnh "Position cut" (market IOC reduce-only) lúc 05:10 ngày 2/11: bán 1 @ 99.98, giá
    // tham chiếu = close nến 05:09 = 100 → trượt 2 bp. 3 bot-hour ở giờ 05, volume 5 × 99.98.
    const { rows: acc } = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [userId, "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db", Math.floor(Math.random() * 1e9)],
    );
    const bots: string[] = [];
    for (let b = 0; b < 3; b++) {
      const { rows } = await env.pool.query<{ id: string }>(
        "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_maker', $3, 'perps', 'MK', 'running', 'live') returning id",
        [userId, acc[0]?.id, market],
      );
      const botId = rows[0]?.id ?? "";
      // Order size $50: mỗi lệnh cắt $99.98 ≈ 2× order size.
      const { rows: ver } = await env.pool.query<{ id: string }>(
        "insert into bot_versions (id, bot_id, version, config, param_source, status) values (gen_random_uuid(), $1, 1, $2, 'manual', 'active') returning id",
        [botId, JSON.stringify({ market, orderSize: "50", maxOrders: 1, distanceBp: "1" })],
      );
      await env.pool.query("update bots set active_version_id = $1 where id = $2", [
        ver[0]?.id,
        botId,
      ]);
      bots.push(botId);
    }
    for (const [i, botId] of [bots[0], bots[0], bots[1], bots[1], bots[2]].entries()) {
      const at = `2026-11-02T05:10:${String(10 + i).padStart(2, "0")}Z`;
      const { rows } = await env.pool.query<{ id: string }>(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch, reduce_only, created_at) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', 'sell', 'market', 'IOC', 1, 'filled', $5, 1, true, $6) returning id",
        [
          botId,
          acc[0]?.id,
          `mk-${String(i)}-${randomUUID().slice(0, 8)}`,
          market,
          `vm:${String(i)}:cut:close`,
          at,
        ],
      );
      await env.pool.query(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, 99.98, 1, 0.04, false, $3)",
        [rows[0]?.id, Math.floor(Math.random() * 1e12), at],
      );
    }
    const v = marketHoursViewSchema.parse(
      (
        await client.request("GET", `/api/v1/admin/market-hours?market=${market}&days=7&tz=UTC`)
      ).json(),
    );
    expect(v.estimate).toMatchObject({
      modelVersion: coefs[0]?.version,
      stepBp: "1",
      cutTakerBp: "4",
      cutSlippageBp: "2",
      cutCostBp: "6",
      cuts: 5,
      cutNotional: "99.98",
      // Đủ lệnh cắt thật: R = trung bình (notional lệnh cắt ÷ order size) = 99.98 ÷ 50 = 1.9996 thay cho R của bot.
      // Volume một bot-hour theo order size = (5 × 99.98 ÷ 50) ÷ 3 bot-hour; phần cắt = R ÷ số đó = 0.6.
      positionRatio: "2",
      positionRatioSource: "cuts",
      fillsPerBotHour: "3.33",
      cutShare: "0.6",
      cutScope: { source: "market", botHours: 3, marketBotHours: 3, markets: [] },
      // Chỉ một ô (giờ 05) có ≥ 3 bot-hour ở mọi market: không đủ để hiệu chỉnh → C mặc định.
      calibration: "1",
      calibrationScope: { source: "default", botHours: 0, marketBotHours: 3, markets: [] },
      calibrationHours: 0,
    });
    const h5 = v.hours[5];
    expect(h5?.bots.botHours).toBe(3);
    const fees = new Decimal("1.5");
    const one = new Decimal(1);
    const cost = (closes: string[]) => {
      const s = swingBps(closes);
      if (s === null) throw new Error("no swing");
      return modelCostPerMillion(fees, modelPnlBps(one, s, "0.2", "0.1"));
    };
    // Cỡ một lần cắt ÷ volume một bot-hour = 99.98 ÷ (5 × 99.98 ÷ 3) = 0.6. Ngày sốc cộng 6 bp × 0.6 × 100 = $360.
    // Trung bình cộng hai ngày: (chi phí ngày 1/11 + chi phí ngày 2/11 + 360) ÷ 2.
    const expected = cost(dayCloses(false))
      .add(cost(dayCloses(true)))
      .add(360)
      .div(2);
    expect(h5?.volatility).toMatchObject({
      estDays: 2,
      shockDays: 1,
      estShockCostPerMillion: expected.toDecimalPlaces(2).toString(),
    });
    // Ngày điển hình vẫn dùng dao động trung vị (không có phần cắt) nên thấp hơn.
    expect(Number(h5?.volatility.estCostPerMillion)).toBeLessThan(Number(expected));
    // Biến động 15 phút lớn nhất của giờ vẫn là ngày sốc (cửa sổ sớm nhất chứa 05:30).
    expect(h5?.volatility.maxMove15Bp).toBe("30");
    expect(h5?.volatility.maxMove15At).toBe("2026-11-02T05:16:00.000Z");
  });

  it("sizes a cut as R × order size from the bots' largest position when there are too few real cuts", async () => {
    const { client, userId } = await teamUser();
    const market = POS_MARKET;
    // Một ngày, 05:00–05:59 UTC ngày 2/11, có biến động 15 phút 30 bp → ngày sốc.
    const closes = Array.from({ length: 60 }, (_, i) =>
      i === 30 ? "100.3" : i % 2 === 0 ? "100.1" : "100",
    );
    const values = closes.map(
      (c, i) =>
        `('${market}', '2026-11-02T05:${String(i).padStart(2, "0")}:00Z', ${c}, ${c} + 0.05, ${c} - 0.05, ${c}, 1)`,
    );
    await env.pool.query(
      `insert into candles_1m (market, ts, open, high, low, close, volume) values ${values.join(",")}`,
    );
    const { rows: coefs } = await env.pool.query<{ version: number }>(
      "insert into mm_model_coefs (a, k, points, day) values (0.2, 0.1, 5, '2026-11-02') returning version",
    );
    const { rows: acc } = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [userId, "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db", Math.floor(Math.random() * 1e9)],
    );
    // Một bot Market Making thật, order size $20. Lệnh maker ở giờ 05 (mua 1 @ 100) và 06 (bán 1 @ 100): 2 bot-hour,
    // vị thế lớn nhất 1 × 100 = $100 → R = 5; volume $200 ÷ $20 ÷ 2 bot-hour = 5 order size một bot-hour. Không có
    // lệnh cắt.
    const { rows: bot } = await env.pool.query<{ id: string }>(
      "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_maker', $3, 'perps', 'MP', 'running', 'live') returning id",
      [userId, acc[0]?.id, market],
    );
    const botId = bot[0]?.id ?? "";
    const { rows: ver } = await env.pool.query<{ id: string }>(
      "insert into bot_versions (id, bot_id, version, config, param_source, status) values (gen_random_uuid(), $1, 1, $2, 'manual', 'active') returning id",
      [botId, JSON.stringify({ market, orderSize: "20", maxOrders: 1, distanceBp: "1" })],
    );
    await env.pool.query("update bots set active_version_id = $1 where id = $2", [
      ver[0]?.id,
      botId,
    ]);
    for (const [i, at] of ["2026-11-02T05:20:00Z", "2026-11-02T06:20:00Z"].entries()) {
      const { rows } = await env.pool.query<{ id: string }>(
        "insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, price, size, status, tag, epoch, created_at) values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', 100, 1, 'filled', $6, 1, $7) returning id",
        [
          botId,
          acc[0]?.id,
          `mp-${String(i)}-${randomUUID().slice(0, 8)}`,
          market,
          i === 0 ? "buy" : "sell",
          `vm:${String(i)}:${i === 0 ? "bid" : "ask"}`,
          at,
        ],
      );
      await env.pool.query(
        "insert into fills (id, order_id, sodex_trade_id, price, size, fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, 100, 1, 0.015, true, $3)",
        [rows[0]?.id, Math.floor(Math.random() * 1e12), at],
      );
    }
    const v = marketHoursViewSchema.parse(
      (
        await client.request("GET", `/api/v1/admin/market-hours?market=${market}&days=7&tz=UTC`)
      ).json(),
    );
    expect(v.estimate).toMatchObject({
      modelVersion: coefs[0]?.version,
      cuts: 0,
      cutSlippageBp: null,
      cutCostBp: "4",
      cutNotional: null,
      positionRatio: "5",
      positionRatioSource: "market",
      fillsPerBotHour: "5",
      cutShare: "1",
      cutScope: { source: "market", botHours: 2, marketBotHours: 2, markets: [] },
    });
    const s = swingBps(closes);
    if (s === null) throw new Error("no swing");
    // Phần cắt = R ÷ số fill một bot-hour = 5 ÷ 5 = 1. Ngày sốc cộng 4 bp (chỉ phí taker) × 1 × 100 = $400.
    const expected = modelCostPerMillion(
      new Decimal("1.5"),
      modelPnlBps(new Decimal(1), s, "0.2", "0.1"),
    ).add(400);
    expect(v.hours[5]?.volatility).toMatchObject({
      estDays: 1,
      shockDays: 1,
      estShockCostPerMillion: expected.toDecimalPlaces(2).toString(),
    });
  });

  it("finds each hour's largest 1-minute range and largest 15-minute move, in the viewer's local hour", async () => {
    const { client } = await teamUser();
    // 2026-11-01 07:00–08:59 UTC: range thường 10 bp, close 100. Nến 07:20 range 200 bp (close vẫn 100). Chuỗi tăng dần
    // trong nhiều phút: close 07:40–07:44 = 100.3 … 101.5, giữ 101.5 tới 08:02, từ 08:03 về 100.
    const at = (m: number) => new Date(Date.parse("2026-11-01T07:00:00Z") + m * 60_000);
    const values = Array.from({ length: 120 }, (_, m) => {
      const close =
        m >= 40 && m <= 44
          ? (100 + (m - 39) * 0.3).toFixed(1)
          : m > 44 && m <= 62
            ? "101.5"
            : "100";
      const h = m === 20 ? "101" : (Number(close) + 0.05).toFixed(2);
      const l = m === 20 ? "99" : (Number(close) - 0.05).toFixed(2);
      return `('${SHOCK_MARKET}', '${at(m).toISOString()}', ${close}, ${h}, ${l}, ${close}, 1)`;
    });
    await env.pool.query(
      `insert into candles_1m (market, ts, open, high, low, close, volume) values ${values.join(",")}`,
    );
    const get = async (tz: string) =>
      marketHoursViewSchema.parse(
        (
          await client.request(
            "GET",
            `/api/v1/admin/market-hours?market=${SHOCK_MARKET}&days=7&tz=${tz}`,
          )
        ).json(),
      );
    const utc = await get("UTC");
    expect(utc.hours[7]?.volatility).toMatchObject({
      maxRangeBp: "200",
      maxRangeAt: "2026-11-01T07:20:00.000Z",
      // Cửa sổ sớm nhất chứa cả close 100 (07:30) và 101.5 (07:44): (101.5 − 100) ÷ 100 × 1e4.
      maxMove15Bp: "150",
      maxMove15At: "2026-11-01T07:30:00.000Z",
    });
    // Cửa sổ bắt đầu 08:00 vắt sang 08:03 (giảm về 100) được tính cho giờ bắt đầu (08).
    expect(utc.hours[8]?.volatility.maxMove15Bp).toBe("150");
    expect(utc.hours[8]?.volatility.maxMove15At).toBe("2026-11-01T08:00:00.000Z");
    // Range 1 phút của 08:xx: (101.55 − 101.45) ÷ 101.5 × 1e4 ≈ 9.85 bp (close 101.5) là lớn nhất.
    expect(utc.hours[8]?.volatility.maxRangeBp).toBe("10");
    // Giờ không có nến: null ("n/a"), không bao giờ 0.
    expect(utc.hours[9]?.volatility).toMatchObject({
      maxRangeBp: null,
      maxRangeAt: null,
      maxMove15Bp: null,
      maxMove15At: null,
    });
    // Kolkata (+5:30): nến 07:20 UTC = 12:50 → giờ 12; cửa sổ 07:30 UTC = 13:00 → giờ 13.
    const kolkata = await get("Asia%2FKolkata");
    expect(kolkata.hours[12]?.volatility.maxRangeBp).toBe("200");
    expect(kolkata.hours[13]?.volatility.maxMove15At).toBe("2026-11-01T07:30:00.000Z");
    expect(kolkata.hours[13]?.volatility.maxRangeBp).toBe("10");
  });

  it("shows the estimate as unavailable, with the reason, when there are no candles or no market info", async () => {
    const { client } = await teamUser();
    await env.pool.query(
      "insert into mm_market_hourly (market, hour, notional, markout_notional, trades, spread_ticks) values ($1, '2026-11-02T05:00:00Z', 100, 0, 1, '{}')",
      [EMPTY_MARKET],
    );
    const empty = marketHoursViewSchema.parse(
      (
        await client.request(
          "GET",
          `/api/v1/admin/market-hours?market=${EMPTY_MARKET}&days=7&tz=UTC`,
        )
      ).json(),
    );
    expect(empty.estimate).toMatchObject({ stepBp: null, unavailable: "no_candles" });
    expect(empty.hours.every((h) => h.volatility.estCostPerMillion === null)).toBe(true);
    // "calibrated" là n/a chỉ khi không có nến: C vẫn có (mặc định), không bao giờ 0.
    expect(empty.hours.every((h) => h.volatility.estCalibratedCostPerMillion === null)).toBe(true);
    expect(empty.estimate.calibration).toBe("1");
    // MARKET có nến nhưng SoDEX không có market đó (không có tick size) → cả dòng n/a.
    const noInfo = await view(client, "&tz=UTC");
    expect(noInfo.estimate).toMatchObject({ stepBp: null, unavailable: "no_market_info" });
    expect(noInfo.hours[12]?.volatility.swingBp).not.toBeNull();
    expect(noInfo.hours.every((h) => h.volatility.estCostPerMillion === null)).toBe(true);
  });
});
