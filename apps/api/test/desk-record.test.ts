import {
  botSummarySchema,
  deskRecordViewSchema,
  errorResponseSchema,
  meSchema,
  switchBackViewSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// AI Desk B+ M4 (DEC-166): trang Thành tích và Switch back. Kết quả đo được ghi thẳng vào `desk_applies` như worker.

let env: TestEnv;
const ADDRESS = "0x6c3C8b7a1F2D3C4B5A69788766554433221100Cd";
const errorOf = (body: unknown) => errorResponseSchema.parse(body).error;
const farm = {
  market: "BTC-USD",
  leverage: 20,
  marginMode: "isolated",
  orderSizeMinUsd: "100",
  orderSizeMaxUsd: "200",
  minHoldSecs: 120,
  maxHoldSecs: 180,
  tpUsd: "0.5",
  slMarginPct: "80",
  earlyProfitUsd: "0.15",
  maxLoss: "20",
};

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

/** Bot Volume Farm 20× + một lần Apply "lower_leverage" 20× → 10× (version 2 đang dùng). */
async function applied(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  await env.pool.query("update users set ai_desk = true where id = $1", [me.id]);
  const accountID = Math.floor(Math.random() * 1e9);
  env.sodex.addUser(ADDRESS, accountID);
  await env.pool.query(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected')",
    [me.id, ADDRESS, accountID],
  );
  const made = await client.request("POST", "/api/v1/bots", {
    body: { strategy: "volume_farm", name: "BTC Farm", paramSource: "manual", config: farm },
  });
  const botId = botSummarySchema.parse(made.json()).id;
  const q = async (sql: string, p: unknown[]) =>
    (await env.pool.query<{ id: string }>(sql, p)).rows[0]?.id ?? "";
  const v2 = await q(
    "insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at) values (gen_random_uuid(), $1, 2, $2, 'ai', 'active', now() - interval '8 days') returning id",
    [botId, JSON.stringify({ ...farm, leverage: 10 })],
  );
  await env.pool.query("update bots set active_version_id = $2 where id = $1", [botId, v2]);
  const item = await q(
    "insert into desk_items (id, user_id, bot_id, rule, severity, facts, fingerprint, badness, last_seen_at, resolved_at) values (gen_random_uuid(), $1, $2, 'liquidation_before_stop', 3, '[]', 'f', '0', now(), now()) returning id",
    [me.id, botId],
  );
  const options = [
    { key: "keep", patch: {}, outcome: null, unavailable: null },
    { key: "lower_leverage", patch: { leverage: 10 }, outcome: null, unavailable: null },
  ];
  const whatif = await q(
    "insert into desk_whatifs (id, item_id, user_id, bot_id, bot_version, item_fingerprint, status, options, window_from, window_to) values (gen_random_uuid(), $1, $2, $3, 1, 'f', 'done', $4, now(), now()) returning id",
    [item, me.id, botId, JSON.stringify(options)],
  );
  const applyId = await q(
    "insert into desk_applies (id, whatif_id, user_id, bot_id, rule, option, from_version, to_version, baseline_config, applied_at) values (gen_random_uuid(), $1, $2, $3, 'liquidation_before_stop', 'lower_leverage', 1, 2, $4, now() - interval '8 days') returning id",
    [whatif, me.id, botId, JSON.stringify(farm)],
  );
  return { client, botId, applyId };
}

const record = async (client: TestClient) =>
  deskRecordViewSchema.parse((await client.request("GET", "/api/v1/desk/record")).json());

async function measured(applyId: string, verdict: string, after: string, old: string) {
  await env.pool.query(
    "update desk_applies set record_status = 'done', verdict = $2, record = $3, checked_at = now() where id = $1",
    [
      applyId,
      verdict,
      JSON.stringify({
        source: "replay",
        after,
        old,
        trades: 40,
        from: new Date(Date.now() - 8 * 86_400_000).toISOString(),
        to: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    ],
  );
}

describe("track record", () => {
  it("shows a fix as still measuring with the change in words, then its result", async () => {
    const { client, applyId } = await applied("record-measuring@example.com");
    const first = await record(client);
    expect(first.counts).toEqual({ helped: 0, madeWorse: 0, noClearEffect: 0, measuring: 1 });
    expect(first.rows[0]).toMatchObject({
      id: applyId,
      botName: "BTC Farm",
      status: "measuring",
      verdict: null,
      after: null,
      old: null,
      changes: [{ key: "leverage", from: "20", to: "10" }],
      canSwitchBack: false,
    });
    await measured(applyId, "helped", "-3.90", "-6.20");
    const done = await record(client);
    expect(done.counts.helped).toBe(1);
    expect(done.rows[0]).toMatchObject({
      status: "done",
      verdict: "helped",
      after: "-3.90",
      old: "-6.20",
    });
    expect(done.rows[0]?.canSwitchBack).toBe(false);
  });

  it("switches back to the old settings once, only when the fix made it worse", async () => {
    const { client, botId, applyId } = await applied("record-worse@example.com");
    const early = await client.request("POST", `/api/v1/desk/applies/${applyId}/switch-back`);
    expect(errorOf(early.json()).details).toMatchObject({ reason: "not_worse" });

    await measured(applyId, "made_worse", "0.60", "1.80");
    expect((await record(client)).rows[0]?.canSwitchBack).toBe(true);
    const back = await client.request("POST", `/api/v1/desk/applies/${applyId}/switch-back`);
    expect(back.statusCode).toBe(201);
    expect(switchBackViewSchema.parse(back.json())).toMatchObject({ botId, version: 3 });
    const { rows } = await env.pool.query<{
      config: Record<string, unknown>;
      param_source: string;
    }>("select config, param_source from bot_versions where bot_id = $1 and version = 3", [botId]);
    expect(rows[0]).toMatchObject({ param_source: "manual", config: { leverage: 20 } });
    const after = await record(client);
    expect(after.rows[0]).toMatchObject({ canSwitchBack: false, switchedBackVersion: 3 });
    const twice = await client.request("POST", `/api/v1/desk/applies/${applyId}/switch-back`);
    expect(errorOf(twice.json()).details).toMatchObject({ reason: "switched_back" });
  });

  it("hides fixes of other users", async () => {
    const { applyId } = await applied("record-owner@example.com");
    const other = new TestClient(env.app);
    const me = meSchema.parse((await signIn(env, other, "record-other@example.com")).json());
    await env.pool.query("update users set ai_desk = true where id = $1", [me.id]);
    expect((await record(other)).rows).toEqual([]);
    const r = await other.request("POST", `/api/v1/desk/applies/${applyId}/switch-back`);
    expect(errorOf(r.json()).code).toBe("NOT_FOUND");
  });
});
