import { randomUUID } from "node:crypto";

import { deskPerformanceSchema, meSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BotDeps } from "../src/modules/bots/service";
import { deskPerformance } from "../src/modules/desk/performance";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// AI Desk "How your bots performed" (#245): một lần quét fill cho cả hai kỳ. Vị thế mở qua cả hai mốc kỳ, fill đúng
// trên mốc, giá đầu / cuối kỳ từ nến 1 phút, giá live (Redis) và khi đọc giá live lỗi. Số tính tay theo `periodNetPnl`:
// net = tiền trong kỳ + vị thế cuối × giá cuối − vị thế đầu × giá đầu − phí; phần giá = −net − phí.

let env: TestEnv;
const NOW = new Date("2026-11-18T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Kỳ 7d: [FROM, NOW), kỳ trước [PREV_FROM, FROM). */
const FROM = NOW.getTime() - 7 * DAY;
const PREV_FROM = FROM - 7 * DAY;

beforeAll(async () => {
  env = await startTestEnv();
  env.clock.now = NOW;
});
afterAll(async () => {
  await env.close();
});

async function user() {
  const client = new TestClient(env.app);
  const me = meSchema.parse(
    (await signIn(env, client, `perf-p-${randomUUID()}@drift.test`)).json(),
  );
  await env.pool.query("update users set ai_desk = true where id = $1", [me.id]);
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [
      me.id,
      `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`,
      Math.floor(Math.random() * 1e9),
    ],
  );
  const acc = rows[0]?.id ?? "";
  const market = `PP${randomUUID().slice(0, 5).toUpperCase()}-USD`;
  const b = await env.pool.query<{ id: string }>(
    `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode)
     values (gen_random_uuid(), $1, $2, 'volume_maker', $3, 'perps', 'MM', 'running', 'live') returning id`,
    [me.id, acc, market],
  );
  return { client, userId: me.id, acc, market, botId: b.rows[0]?.id ?? "" };
}

let seq = 0;
const TRADE_ID_BASE = Date.now() * 1000 + Math.floor(Math.random() * 1000);
async function fill(
  u: { botId: string; acc: string; market: string },
  side: "buy" | "sell",
  price: number,
  at: number,
  fee = 0.05,
  builder = 0.01,
) {
  seq += 1;
  const o = await env.pool.query<{ id: string }>(
    `insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, tag, epoch, created_at)
     values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', 1, 1, 'filled', 'vm', 1, $6) returning id`,
    [u.botId, u.acc, `pp-${String(seq)}-${randomUUID().slice(0, 8)}`, u.market, side, new Date(at)],
  );
  await env.pool.query(
    "insert into fills (id, order_id, sodex_trade_id, price, size, fee, builder_fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, 1, $4, $5, true, $6)",
    [o.rows[0]?.id, String(TRADE_ID_BASE + seq), price, fee, builder, new Date(at)],
  );
}

async function candle(market: string, at: number, close: number) {
  await env.pool.query(
    "insert into candles_1m (market, ts, open, high, low, close, volume) values ($1, $2, $3, $3, $3, $3, 1)",
    [market, new Date(at), close],
  );
}

/**
 * Vị thế long 1 mở trước PREV_FROM và còn mở tới cuối kỳ này:
 * - trước kỳ: mua 100;
 * - kỳ trước: bán 101 ĐÚNG lúc PREV_FROM, mua 102;
 * - kỳ này: bán 104 ĐÚNG lúc FROM, mua 103, rồi 30 fill mua / bán 103 không phí (đủ 30 fill cho card).
 */
async function seedOpenPosition(u: { botId: string; acc: string; market: string }) {
  await fill(u, "buy", 100, PREV_FROM - HOUR);
  await fill(u, "sell", 101, PREV_FROM);
  await fill(u, "buy", 102, PREV_FROM + HOUR);
  await fill(u, "sell", 104, FROM);
  await fill(u, "buy", 103, FROM + HOUR);
  for (let i = 0; i < 15; i++) {
    await fill(u, "buy", 103, FROM + 2 * HOUR + i * MIN, 0, 0);
    await fill(u, "sell", 103, FROM + 2 * HOUR + i * MIN + 30_000, 0, 0);
  }
}

/** Gọi thẳng service với `prices` lỗi (Redis không đọc được). */
function failingPrices(userId: string) {
  const deps = {
    db: env.db,
    now: () => NOW,
    prices: () => Promise.reject(new Error("redis down")),
  } as unknown as BotDeps;
  return deskPerformance(deps, userId, { period: "7d", tz: "UTC" });
}

describe("How your bots performed: both periods from one fill scan", () => {
  it("prices a position held across both period boundaries, with fills on the boundaries", async () => {
    const u = await user();
    await seedOpenPosition(u);
    await candle(u.market, PREV_FROM, 100.5);
    await candle(u.market, FROM, 103);
    await candle(u.market, NOW.getTime() - MIN, 105);
    env.prices.set(u.market, { price: "106", at: NOW.getTime() });
    try {
      const v = deskPerformanceSchema.parse(
        (await u.client.request("GET", "/api/v1/desk/performance?period=7d&tz=UTC")).json(),
      );
      expect(v.state).toBe("ready");
      // Kỳ trước: tiền 101 − 102 = −1; vị thế 1 → 1; giá 100.5 → 103 (close lúc FROM, dùng chung với đầu kỳ này).
      // net = −1 + 103 − 100.5 − 0.1 = 1.4; phần giá = −1.4 − 0.1 = −1.5; chi phí = max(0, −1.4) = 0.
      const prev = {
        volume: "203",
        fills: 2,
        cost: "0",
        sodexFee: "0.08",
        builderFee: "0.02",
        priceMove: "-1.5",
      };
      expect(v.previous).toMatchObject(prev);
      // Kỳ này: tiền 104 − 103 = 1; vị thế 1 → 1; giá 103 → 106 (giá live).
      // net = 1 + 106 − 103 − 0.1 = 3.9; phần giá = −3.9 − 0.1 = −4.
      const cur = {
        volume: "3297",
        fills: 32,
        cost: "0",
        sodexFee: "0.08",
        builderFee: "0.02",
        priceMove: "-4",
      };
      expect(v.current).toMatchObject(cur);
      expect(v.bots).toHaveLength(1);
      expect(v.bots[0]?.current).toMatchObject(cur);
      expect(v.bots[0]?.previous).toMatchObject(prev);
    } finally {
      env.prices.delete(u.market);
    }
  });

  it("falls back to the candle close when the live price lookup fails", async () => {
    const u = await user();
    await seedOpenPosition(u);
    await candle(u.market, PREV_FROM, 100.5);
    await candle(u.market, FROM, 103);
    await candle(u.market, NOW.getTime() - MIN, 105);
    const v = await failingPrices(u.userId);
    expect(v.state).toBe("ready");
    // Giá cuối kỳ = close 105: net = 1 + 105 − 103 − 0.1 = 2.9; phần giá = −3. Kỳ trước không đổi.
    expect(v.current).toMatchObject({ cost: "0", priceMove: "-3" });
    expect(v.previous).toMatchObject({ priceMove: "-1.5" });
  });

  it("shows Not available (null), never 0, when neither a live price nor a candle exists", async () => {
    const u = await user();
    await seedOpenPosition(u);
    const v = await failingPrices(u.userId);
    expect(v.state).toBe("ready");
    expect(v.current.cost).toBeNull();
    expect(v.current.priceMove).toBeNull();
    expect(v.current.perMillion.cost).toBeNull();
    // Phí vẫn có.
    expect(v.current.sodexFee).toBe("0.08");
    expect(v.previous?.cost).toBeNull();
  });
});
