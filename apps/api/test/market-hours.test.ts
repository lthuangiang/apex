import { randomUUID } from "node:crypto";

import { errorResponseSchema, marketHoursViewSchema, meSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Market hours (docs/mockups/market-hours, DEC-TBD-market-hours): giờ / ngày theo múi giờ người xem (Postgres
// AT TIME ZONE), kể cả múi giờ lệch 30 phút và ngày Mỹ đổi giờ; khối 3 từ fill thật; chỉ team.

let env: TestEnv;
const MARKET = `MH${randomUUID().slice(0, 6).toUpperCase()}-USD`;
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;

beforeAll(async () => {
  env = await startTestEnv();
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
});
