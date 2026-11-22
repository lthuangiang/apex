import { randomUUID } from "node:crypto";

import { botAnalyticsSchema, meSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #472: bot Signal Research (`news_signal`) đi qua các route chung của bot. Strategy Analytics chỉ có cho Market Making /
// Volume Builder: bot news trả `supported: false` (web hiện "Not available"), không lỗi 500. Export chạy được với bot news
// (CSV fills, không có fill thì chỉ có dòng tiêu đề), không lỗi 500.

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function newsBot() {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, `nb-${randomUUID()}@drift.test`)).json());
  const acc = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [
      me.id,
      `0x${randomUUID().replace(/-/g, "").padEnd(40, "0").slice(0, 40)}`,
      Math.floor(Math.random() * 1e9),
    ],
  );
  const b = await env.pool.query<{ id: string }>(
    `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode)
     values (gen_random_uuid(), $1, $2, 'news_signal', '', 'perps', 'Stock Monitor', 'running', 'live') returning id`,
    [me.id, acc.rows[0]?.id],
  );
  return { client, botId: b.rows[0]?.id ?? "" };
}

describe("news bots on the shared bot routes (#472)", () => {
  it("analytics answers supported: false instead of an error", async () => {
    const { client, botId } = await newsBot();
    const r = await client.request("GET", `/api/v1/bots/${botId}/analytics`);
    expect(r.statusCode).toBe(200);
    expect(botAnalyticsSchema.parse(r.json()).supported).toBe(false);
  });

  it("export works for a news bot (no 500)", async () => {
    const { client, botId } = await newsBot();
    const r = await client.request("GET", `/api/v1/bots/${botId}/export`);
    expect(r.statusCode).toBe(200);
  });
});
