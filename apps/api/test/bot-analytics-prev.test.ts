import { randomUUID } from "node:crypto";

import { botAnalyticsSchema, meSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Strategy Analytics: "vs previous" chỉ khi kỳ trước có lượt đóng. Kỳ trước không có lượt nào (kể cả khi bot chưa tồn
// tại) → `prevNet` null, không phải 0 (quy tắc 1.8); UI ẩn "vs previous" khi null.

let env: TestEnv;
const NOW = new Date("2026-11-18T12:00:00Z");
const DAY = 86_400_000;

beforeAll(async () => {
  env = await startTestEnv();
  env.clock.now = NOW;
});
afterAll(async () => {
  await env.close();
});

let seq = 0;
const TRADE_ID_BASE = Date.now() * 1000 + Math.floor(Math.random() * 1000);

describe("Strategy Analytics previous period", () => {
  it("returns prevNet null when the previous period has no closed trade, and the net when it has one", async () => {
    const client = new TestClient(env.app);
    const me = meSchema.parse(
      (await signIn(env, client, `sa-prev-${randomUUID()}@drift.test`)).json(),
    );
    const acc = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [
        me.id,
        `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`,
        Math.floor(Math.random() * 1e9),
      ],
    );
    const accId = acc.rows[0]?.id ?? "";
    const market = `SA${randomUUID().slice(0, 5).toUpperCase()}-USD`;
    const b = await env.pool.query<{ id: string }>(
      `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode, created_at)
       values (gen_random_uuid(), $1, $2, 'volume_farm', $3, 'perps', 'VB', 'running', 'live', $4) returning id`,
      [me.id, accId, market, new Date(NOW.getTime() - 30 * DAY)],
    );
    const botId = b.rows[0]?.id ?? "";
    /** Một lượt: mua 100, bán `exit`, phí 0.05 mỗi fill. */
    const trade = async (cycle: number, at: number, exit: number) => {
      for (const [leg, side, price, t] of [
        ["in", "buy", 100, at],
        ["out", "sell", exit, at + 60_000],
      ] as const) {
        seq += 1;
        const o = await env.pool.query<{ id: string }>(
          `insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, filled_size, status, tag, epoch, created_at)
           values (gen_random_uuid(), $1, $2, $3, $4, 'perps', $5, 'limit', 'GTX', 1, 1, 'filled', $6, 1, $7) returning id`,
          [
            botId,
            accId,
            `sa-${String(seq)}-${randomUUID().slice(0, 8)}`,
            market,
            side,
            `vf:${String(cycle)}:${leg}:0`,
            new Date(t),
          ],
        );
        await env.pool.query(
          "insert into fills (id, order_id, sodex_trade_id, price, size, fee, builder_fee, is_maker, filled_at) values (gen_random_uuid(), $1, $2, $3, 1, 0.05, 0.01, true, $4)",
          [o.rows[0]?.id, String(TRADE_ID_BASE + seq), price, new Date(t)],
        );
      }
    };
    const get = async () =>
      botAnalyticsSchema.parse(
        (await client.request("GET", `/api/v1/bots/${botId}/analytics?period=d7`)).json(),
      );

    // Chỉ có lượt trong kỳ này.
    await trade(1, NOW.getTime() - 2 * DAY, 101);
    const only = await get();
    expect(only.summary.trades).toBe(1);
    expect(only.summary.net).toBe(0.9);
    expect(only.summary.prevNet).toBeNull();

    // Thêm một lượt trong kỳ trước [now − 14d, now − 7d): lãi 2 − phí 0.1.
    await trade(0, NOW.getTime() - 10 * DAY, 102);
    const both = await get();
    expect(both.summary.prevNet).toBe(1.9);
  });
});
