import { errorResponseSchema, meSchema, twoFactorSetupSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateTotp } from "../src/lib/totp";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

let env: TestEnv;
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function withTwoFactor(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  const setup = twoFactorSetupSchema.parse(
    (await client.request("POST", "/api/v1/security/2fa/setup")).json(),
  );
  await client.request("POST", "/api/v1/security/2fa/enable", {
    body: { code: generateTotp(setup.secret, env.clock.now) },
  });
  const code = () => {
    env.clock.now = new Date(env.clock.now.getTime() + 30_000);
    return generateTotp(setup.secret, env.clock.now);
  };
  return { client, userId: me.id, code };
}

describe("profile and trading defaults", () => {
  it("saves preferences and rejects unknown time zones", async () => {
    const { client } = await withTwoFactor("pref@example.com");
    expect(
      (
        await client.request("PUT", "/api/v1/me/preferences", {
          body: {
            timezone: "Europe/Berlin",
            numberFormat: "de-DE",
            defaultMaxLossPct: "10",
            displayName: "Lan",
          },
        })
      ).statusCode,
    ).toBe(204);
    expect(meSchema.parse((await client.request("GET", "/api/v1/me")).json())).toMatchObject({
      timezone: "Europe/Berlin",
      numberFormat: "de-DE",
      defaultMaxLossPct: "10",
      displayName: "Lan",
    });
    const bad = await client.request("PUT", "/api/v1/me/preferences", {
      body: { timezone: "Mars/Olympus" },
    });
    expect(errorOf(bad.body).code).toBe("VALIDATION_FAILED");
  });

  it("exports orders as CSV", async () => {
    const { client } = await withTwoFactor("csv@example.com");
    const res = await client.request("GET", "/api/v1/account/export.csv");
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.body.split("\n")[0]).toBe(
      "submitted_at,bot,market,side,type,price,size,status,client_order_id,fill_at,fill_price,fill_size,fee,builder_fee",
    );
  });

  it("deletes the account only with 2FA, every bot stopped and SoDEX disconnected", async () => {
    const { client, userId, code } = await withTwoFactor("del@example.com");
    const noCode = await client.request("DELETE", "/api/v1/account", { body: {} });
    expect(errorOf(noCode.body).code).toBe("TWO_FACTOR_REQUIRED");
    const { rows } = await env.pool.query<{ id: string }>(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, '0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db', $2, 'mainnet', 'connected') returning id",
      [userId, Math.floor(Math.random() * 1e9)],
    );
    await env.pool.query(
      "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state) values (gen_random_uuid(), $1, $2, 'spot_grid', 'm', 'spot', 'G', 'running')",
      [userId, rows[0]?.id],
    );
    const busy = await client.request("DELETE", "/api/v1/account", {
      body: { twoFactorCode: code() },
    });
    expect(errorOf(busy.body)).toMatchObject({
      code: "STATE_CONFLICT",
      details: { reason: "bots_active" },
    });
    await env.pool.query("update bots set state = 'stopped' where user_id = $1", [userId]);
    const linked = await client.request("DELETE", "/api/v1/account", {
      body: { twoFactorCode: code() },
    });
    expect(errorOf(linked.body)).toMatchObject({
      code: "STATE_CONFLICT",
      details: { reason: "sodex_connected" },
    });
    await env.pool.query("update sodex_accounts set status = 'disconnected' where user_id = $1", [
      userId,
    ]);
    const ok = await client.request("DELETE", "/api/v1/account", {
      body: { twoFactorCode: code() },
    });
    expect(ok.statusCode).toBe(204);
    expect((await client.request("GET", "/api/v1/me")).statusCode).toBe(401);
    const { rows: u } = await env.pool.query<{
      email: string;
      deleted_at: Date | null;
      twofa_secret: string | null;
    }>("select email, deleted_at, twofa_secret from users where id = $1", [userId]);
    expect(u[0]?.email).toBe(`deleted-${userId}@deleted.invalid`);
    expect(u[0]?.deleted_at).not.toBeNull();
    expect(u[0]?.twofa_secret).toBeNull();
  });
});
