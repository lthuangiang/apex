import { randomUUID } from "node:crypto";

import { featuresSchema, notificationSettingsSchema, wealthWatchStateSchema } from "@drift/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { WealthReader } from "../src/modules/us-market/service";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #594 (DEC-404): công tắc "Alerts" của SoDEX Wealth: GET / POST / DELETE /api/v1/wealth/watch, `/features.wealthAlerts`,
// nhóm thông báo `wealth` và các luồng xoá. Địa chỉ ví là địa chỉ giả; route này không gọi SoDEX.

const np = () => Promise.resolve({ kind: "not_provided" as const, reason: "network" as const });
const wealth: WealthReader = {
  getFunds: np,
  getTradingStatus: np,
  getPositions: np,
  getPnl: np,
  getInFlight: np,
  getFundDetails: np,
  getRecurringBuys: np,
  getPnlHistory: np,
};

const state = { usMarket: true, enabled: true };

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv({
    usMarket: { enabled: () => state.usMarket, wealth, rest: {} as never },
    wealthWatchEnabled: () => state.enabled,
  });
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  state.usMarket = true;
  state.enabled = true;
});

let n = 0;
async function trader(opts: { team?: boolean; connected?: boolean } = {}) {
  n += 1;
  const client = new TestClient(env.app);
  const email = `ww-${randomUUID()}@example.com`;
  await signIn(env, client, email);
  const user = await env.pool.query<{ id: string }>("select id from users where email = $1", [
    email,
  ]);
  const userId = user.rows[0]?.id ?? "";
  if (opts.team === true)
    await env.pool.query("update users set role = 'team' where id = $1", [userId]);
  let accountId = "";
  if (opts.connected !== false) {
    const acc = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
      [userId, `0x${(0xd000 + n).toString(16).padStart(40, "0")}`, 700000 + n],
    );
    accountId = acc.rows[0]?.id ?? "";
  }
  return { client, userId, accountId };
}

async function rowCount(userId: string): Promise<number> {
  const r = await env.pool.query<{ n: number }>(
    "select count(*)::int as n from wealth_watch where user_id = $1",
    [userId],
  );
  return r.rows[0]?.n ?? 0;
}
const state0 = async (t: { client: TestClient }) =>
  wealthWatchStateSchema.parse((await t.client.request("GET", "/api/v1/wealth/watch")).json());
const features = async (t: { client: TestClient }) =>
  featuresSchema.parse((await t.client.request("GET", "/api/v1/features")).json());
const groups = async (t: { client: TestClient }) =>
  notificationSettingsSchema
    .parse((await t.client.request("GET", "/api/v1/notifications/settings")).json())
    .groups.map((g) => g.group);

describe("/api/v1/wealth/watch", () => {
  it("turns on and off; state comes from the backend; turning off deletes the stored marks", async () => {
    const t = await trader();
    expect(await state0(t)).toEqual({ status: "off", lastCheckedAt: null, delayed: false });
    const on = await t.client.request("POST", "/api/v1/wealth/watch");
    expect(on.statusCode).toBe(200);
    expect(wealthWatchStateSchema.parse(on.json()).status).toBe("active");
    expect(await rowCount(t.userId)).toBe(1);
    const row = await env.pool.query<{ baseline_pending: boolean }>(
      "select baseline_pending from wealth_watch where user_id = $1",
      [t.userId],
    );
    expect(row.rows[0]?.baseline_pending).toBe(true);
    expect((await state0(t)).status).toBe("active");

    expect((await t.client.request("DELETE", "/api/v1/wealth/watch")).statusCode).toBe(204);
    expect(await rowCount(t.userId)).toBe(0);
    expect((await state0(t)).status).toBe("off");
    // Idempotent: tắt lần nữa vẫn 204.
    expect((await t.client.request("DELETE", "/api/v1/wealth/watch")).statusCode).toBe(204);
  });

  it("needs an Idempotency-Key; the same key replays without a second row or audit", async () => {
    const t = await trader();
    const missing = await t.client.request("POST", "/api/v1/wealth/watch", {
      idempotencyKey: false,
    });
    expect(missing.statusCode).toBe(400);
    const key = randomUUID();
    const a = await t.client.request("POST", "/api/v1/wealth/watch", { idempotencyKey: key });
    const b = await t.client.request("POST", "/api/v1/wealth/watch", { idempotencyKey: key });
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    const audits = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from audit_log where user_id = $1 and action = 'wealth.watch_enabled'",
      [t.userId],
    );
    expect(audits.rows[0]?.n).toBe(1);
    // Bật lại khi đã bật: giữ mốc cũ (không quay lại lượt đầu).
    await env.pool.query("update wealth_watch set baseline_pending = false where user_id = $1", [
      t.userId,
    ]);
    await t.client.request("POST", "/api/v1/wealth/watch");
    const row = await env.pool.query<{ baseline_pending: boolean }>(
      "select baseline_pending from wealth_watch where user_id = $1",
      [t.userId],
    );
    expect(row.rows[0]?.baseline_pending).toBe(false);
  });

  it("only acts on the signed-in user", async () => {
    const a = await trader();
    const b = await trader();
    await a.client.request("POST", "/api/v1/wealth/watch");
    await b.client.request("DELETE", "/api/v1/wealth/watch");
    expect(await rowCount(a.userId)).toBe(1);
    expect((await state0(b)).status).toBe("off");
  });

  it("needs a connected SoDEX account", async () => {
    const t = await trader({ connected: false });
    const res = await t.client.request("POST", "/api/v1/wealth/watch");
    expect(res.statusCode).toBe(422);
    expect(await rowCount(t.userId)).toBe(0);
  });

  it("switch off: hidden for regular users (404, no feature, no group); the team still sees it", async () => {
    state.enabled = false;
    const user = await trader();
    expect((await user.client.request("GET", "/api/v1/wealth/watch")).statusCode).toBe(404);
    expect((await user.client.request("POST", "/api/v1/wealth/watch")).statusCode).toBe(404);
    expect((await features(user)).wealthAlerts).toBe(false);
    expect(await groups(user)).not.toContain("wealth");
    const put = await user.client.request("PUT", "/api/v1/notifications/settings", {
      body: { group: "wealth", channel: "telegram", enabled: false },
    });
    expect(put.statusCode).toBe(403);

    const team = await trader({ team: true });
    expect((await features(team)).wealthAlerts).toBe(true);
    expect((await team.client.request("POST", "/api/v1/wealth/watch")).statusCode).toBe(200);
    expect(await groups(team)).toContain("wealth");
  });

  it("switch on: everyone sees it; US Market off hides it for all", async () => {
    const t = await trader();
    expect((await features(t)).wealthAlerts).toBe(true);
    const settings = notificationSettingsSchema.parse(
      (await t.client.request("GET", "/api/v1/notifications/settings")).json(),
    );
    // DEC-404 mục 5: in-app bật, Telegram bật, email tắt.
    expect(settings.groups.find((g) => g.group === "wealth")).toMatchObject({
      in_app: true,
      email: false,
      telegram: true,
    });
    state.usMarket = false;
    expect((await features(t)).wealthAlerts).toBe(false);
    expect((await t.client.request("GET", "/api/v1/wealth/watch")).statusCode).toBe(404);
  });

  it("disconnecting SoDEX deletes it", async () => {
    const t = await trader();
    await t.client.request("POST", "/api/v1/wealth/watch");
    await env.pool.query(
      `insert into api_keys (id, sodex_account_id, name, public_key, ciphertext, kms_key_ref, last4, permissions_mask, expires_at, status)
       values (gen_random_uuid(), $1, 'drift-test', $2, 'vault:v1:test', 'test', 'abcd', 14, now() + interval '30 days', 'active')`,
      [t.accountId, `0x${(0xe000 + n).toString(16).padStart(40, "0")}`],
    );
    const res = await t.client.request("POST", "/api/v1/sodex/disconnection", { body: {} });
    expect(res.statusCode).toBe(201);
    expect(await rowCount(t.userId)).toBe(0);
  });

  it("deleting the account deletes it", async () => {
    const t = await trader();
    await t.client.request("POST", "/api/v1/wealth/watch");
    await env.pool.query("update sodex_accounts set status = 'disconnected' where id = $1", [
      t.accountId,
    ]);
    const res = await t.client.request("DELETE", "/api/v1/account", { body: {} });
    expect(res.statusCode).toBe(204);
    expect(await rowCount(t.userId)).toBe(0);
  });
});
