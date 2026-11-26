import { randomUUID } from "node:crypto";

import { errorResponseSchema, rewardsWatchStateSchema } from "@drift/shared";
import type { RewardsReadClient } from "@drift/sodex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { RewardsTokenSigner } from "../src/modules/rewards-watch/service";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #558 PR3 (DEC-398): POST / GET / DELETE /api/v1/rewards/watch và các luồng xoá phiên rewards lưu ở server. Reader
// (gateway) và signer là giả; token là chuỗi giả dạng JWT, không phải token thật. Địa chỉ ví là địa chỉ giả.

type Summary = Awaited<ReturnType<RewardsReadClient["getSopointsSummary"]>>;

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

const state = {
  enabled: true,
  audAllow: ["rewards"] as string[],
  summary: null as Summary | null,
  signerDown: false,
  summaryCalls: 0,
  encrypted: [] as string[],
};

const reader: Pick<RewardsReadClient, "getSopointsSummary"> = {
  getSopointsSummary: () => {
    state.summaryCalls += 1;
    return Promise.resolve(state.summary ?? { kind: "error", code: "network" });
  },
};
const signer: RewardsTokenSigner = {
  encrypt: (token) => {
    if (state.signerDown) return Promise.resolve(null);
    state.encrypted.push(token);
    return Promise.resolve({
      ciphertext: `vault:v1:${String(state.encrypted.length)}`,
      keyRef: "vault-transit:drift-rewards",
    });
  },
};

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv({
    rewardsWatch: {
      enabled: () => state.enabled,
      get audAllow() {
        return state.audAllow;
      },
      reader,
      signer,
    },
  });
});
afterAll(async () => {
  await env.close();
});

let n = 0;
function fakeAddress(): string {
  n += 1;
  return `0x${n.toString(16).padStart(40, "0")}`;
}

/** Token giả dạng JWT, đánh dấu riêng để quét log / response. */
function fakeToken(extra: Record<string, unknown> = {}): string {
  const nowS = Math.floor(env.clock.now.getTime() / 1000);
  return `${b64url({ alg: "none" })}.${b64url({
    exp: nowS + 15 * 24 * 3600,
    iat: nowS,
    aud: ["rewards"],
    iss: "gw-test",
    jti: `marker${randomUUID().replace(/-/g, "")}`,
    ...extra,
  })}.c2lnLXRlc3Q`;
}

async function trader() {
  const client = new TestClient(env.app);
  const email = `rw-${randomUUID()}@example.com`;
  await signIn(env, client, email);
  const user = await env.pool.query<{ id: string }>("select id from users where email = $1", [
    email,
  ]);
  const userId = user.rows[0]?.id ?? "";
  const address = fakeAddress();
  const acc = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [userId, address, Math.floor(Math.random() * 1e9)],
  );
  return { client, userId, address, accountId: acc.rows[0]?.id ?? "" };
}

const code = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;

async function rowCount(userId: string): Promise<number> {
  const r = await env.pool.query<{ n: number }>(
    "select count(*)::int as n from rewards_watch where user_id = $1",
    [userId],
  );
  return r.rows[0]?.n ?? 0;
}

beforeEach(() => {
  state.enabled = true;
  state.audAllow = ["rewards"];
  state.summary = null;
  state.signerDown = false;
  state.summaryCalls = 0;
});

describe("/api/v1/rewards/watch", () => {
  it("is 404 while REWARDS_WATCH_ENABLED is off", async () => {
    const t = await trader();
    state.enabled = false;
    expect((await t.client.request("GET", "/api/v1/rewards/watch")).statusCode).toBe(404);
    expect(
      (
        await t.client.request("POST", "/api/v1/rewards/watch", {
          body: { token: fakeToken(), address: t.address },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("turns alerts on: checks the wallet, encrypts, stores only ciphertext and exp", async () => {
    const t = await trader();
    expect(
      rewardsWatchStateSchema.parse(
        (await t.client.request("GET", "/api/v1/rewards/watch")).json(),
      ),
    ).toMatchObject({ status: "off" });
    state.summary = {
      kind: "ok",
      data: { totalPoints: 1, walletAddress: t.address.toUpperCase().replace("0X", "0x") },
    };
    const token = fakeToken();
    const res = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token, address: t.address },
    });
    expect(res.statusCode).toBe(200);
    const body = rewardsWatchStateSchema.parse(res.json());
    expect(body).toMatchObject({ status: "active", reason: null, delayed: false });
    expect(body.expiresAt).not.toBeNull();
    expect(res.body).not.toContain(token);
    const row = await env.pool.query<{
      token_ciphertext: string;
      status: string;
      token_aud: unknown;
      jti8: string;
      baseline_pending: boolean;
    }>(
      "select token_ciphertext, status, token_aud, jti8, baseline_pending from rewards_watch where user_id = $1",
      [t.userId],
    );
    expect(row.rows[0]).toMatchObject({
      status: "active",
      token_aud: ["rewards"],
      baseline_pending: true,
    });
    expect(row.rows[0]?.token_ciphertext.startsWith("vault:")).toBe(true);
    // Token không nằm trong DB (mọi bảng liên quan), log hay audit.
    const marker = token.split(".")[1] ?? "";
    for (const table of ["rewards_watch", "audit_log", "idempotency_keys"]) {
      const dump = await env.pool.query<{ t: string }>(
        `select row_to_json(x)::text as t from ${table} x`,
      );
      for (const r of dump.rows) {
        expect(r.t).not.toContain(token);
        expect(r.t).not.toContain(marker);
      }
    }
    expect(env.logs.join("")).not.toContain(marker);
    const audit = await env.pool.query<{ action: string; metadata: Record<string, unknown> }>(
      "select action, metadata from audit_log where user_id = $1 and action like 'rewards.%'",
      [t.userId],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(["rewards.watch_enabled"]);
    expect(Object.keys(audit.rows[0]?.metadata ?? {}).sort()).toEqual(["exp", "jti8"]);
  });

  it("replays the same Idempotency-Key and rejects it for a different body", async () => {
    const t = await trader();
    state.summary = { kind: "ok", data: { totalPoints: 1, walletAddress: t.address } };
    const token = fakeToken();
    const key = randomUUID();
    const first = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token, address: t.address },
      idempotencyKey: key,
    });
    expect(first.statusCode).toBe(200);
    const again = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token, address: t.address },
      idempotencyKey: key,
    });
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(state.summaryCalls).toBe(1);
    // Fingerprint không băm token: cùng claim, khác chữ ký (token khác) vẫn là cùng request → phát lại.
    const [h, p] = token.split(".");
    const resigned = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token: `${h ?? ""}.${p ?? ""}.b3RoZXItc2ln`, address: t.address },
      idempotencyKey: key,
    });
    expect(resigned.headers["idempotent-replayed"]).toBe("true");
    const stored = await env.pool.query<{ request_hash: string }>(
      "select request_hash from idempotency_keys where user_id = $1 and key = $2",
      [t.userId, key],
    );
    expect(stored.rows[0]?.request_hash).not.toContain(p ?? "");
    const other = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token: fakeToken(), address: t.address },
      idempotencyKey: key,
    });
    expect(code(other.body).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("rejects another wallet (body address or the token's wallet) and stores nothing", async () => {
    const t = await trader();
    const encryptedBefore = state.encrypted.length;
    const wrongBody = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token: fakeToken(), address: fakeAddress() },
    });
    expect(code(wrongBody.body).code).toBe("REWARDS_WALLET_MISMATCH");
    expect(state.summaryCalls).toBe(0);
    state.summary = { kind: "ok", data: { totalPoints: 1, walletAddress: fakeAddress() } };
    const wrongToken = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token: fakeToken(), address: t.address },
    });
    expect(code(wrongToken.body)).toMatchObject({
      code: "REWARDS_WALLET_MISMATCH",
      details: { reason: "token_wallet" },
    });
    expect(state.encrypted.length).toBe(encryptedBefore);
    expect(await rowCount(t.userId)).toBe(0);
  });

  it("rejects aud values outside REWARDS_JWT_AUD_ALLOW, and everything when the list is empty", async () => {
    const t = await trader();
    state.summary = { kind: "ok", data: { totalPoints: 1, walletAddress: t.address } };
    const trade = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token: fakeToken({ aud: ["rewards", "trade"] }), address: t.address },
    });
    expect(code(trade.body)).toMatchObject({
      code: "REWARDS_TOKEN_INVALID",
      details: { reason: "aud_not_allowed" },
    });
    state.audAllow = [];
    const empty = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token: fakeToken(), address: t.address },
    });
    expect(code(empty.body)).toMatchObject({ details: { reason: "aud_not_allowed" } });
    expect(state.summaryCalls).toBe(0);
    expect(await rowCount(t.userId)).toBe(0);
  });

  it("maps gateway 401 to REWARDS_TOKEN_INVALID and signer failure to REWARDS_WATCH_UNAVAILABLE", async () => {
    const t = await trader();
    state.summary = { kind: "unauthorized" };
    const unauthorized = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token: fakeToken(), address: t.address },
    });
    expect(code(unauthorized.body)).toMatchObject({
      code: "REWARDS_TOKEN_INVALID",
      details: { reason: "unauthorized" },
    });
    state.summary = { kind: "ok", data: { totalPoints: 1, walletAddress: t.address } };
    state.signerDown = true;
    const key = randomUUID();
    const token = fakeToken();
    const down = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token, address: t.address },
      idempotencyKey: key,
    });
    expect(down.statusCode).toBe(503);
    expect(code(down.body).code).toBe("REWARDS_WATCH_UNAVAILABLE");
    expect(down.body).not.toContain(token);
    expect(await rowCount(t.userId)).toBe(0);
    // Chưa ghi gì: key được giải phóng, gửi lại cùng key khi signer đã lên thì chạy.
    state.signerDown = false;
    const retry = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token, address: t.address },
      idempotencyKey: key,
    });
    expect(retry.statusCode).toBe(200);
  });

  it("reports paused when the token expired or the wallet changed", async () => {
    const t = await trader();
    state.summary = { kind: "ok", data: { totalPoints: 1, walletAddress: t.address } };
    await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token: fakeToken(), address: t.address },
    });
    await env.pool.query("update rewards_watch set token_exp = $2 where user_id = $1", [
      t.userId,
      new Date(env.clock.now.getTime() - 60_000),
    ]);
    expect(
      rewardsWatchStateSchema.parse(
        (await t.client.request("GET", "/api/v1/rewards/watch")).json(),
      ),
    ).toMatchObject({ status: "paused", reason: "expired" });
    await env.pool.query("update sodex_accounts set status = 'disconnected' where id = $1", [
      t.accountId,
    ]);
    expect(
      rewardsWatchStateSchema.parse(
        (await t.client.request("GET", "/api/v1/rewards/watch")).json(),
      ),
    ).toMatchObject({ status: "paused", reason: "wallet_changed" });
  });
});

describe("deleting the stored rewards session", () => {
  async function watching() {
    const t = await trader();
    state.summary = { kind: "ok", data: { totalPoints: 1, walletAddress: t.address } };
    const res = await t.client.request("POST", "/api/v1/rewards/watch", {
      body: { token: fakeToken(), address: t.address },
    });
    expect(res.statusCode).toBe(200);
    expect(await rowCount(t.userId)).toBe(1);
    return t;
  }

  it("DELETE turns alerts off and is idempotent", async () => {
    const t = await watching();
    expect((await t.client.request("DELETE", "/api/v1/rewards/watch")).statusCode).toBe(204);
    expect(await rowCount(t.userId)).toBe(0);
    expect((await t.client.request("DELETE", "/api/v1/rewards/watch")).statusCode).toBe(204);
    expect(
      rewardsWatchStateSchema.parse(
        (await t.client.request("GET", "/api/v1/rewards/watch")).json(),
      ),
    ).toMatchObject({ status: "off" });
  });

  it("signing out of DeskLabs deletes it", async () => {
    const t = await watching();
    expect((await t.client.request("DELETE", "/api/v1/auth/session")).statusCode).toBe(204);
    expect(await rowCount(t.userId)).toBe(0);
  });

  it("an expired DeskLabs session keeps it", async () => {
    const t = await watching();
    await env.pool.query("update sessions set expires_at = $2 where user_id = $1", [
      t.userId,
      new Date(env.clock.now.getTime() - 60_000),
    ]);
    // Phiên hết hạn: request bị từ chối, dòng vẫn còn (token có hạn riêng 15 ngày).
    expect((await t.client.request("GET", "/api/v1/rewards/watch")).statusCode).toBe(401);
    expect(await rowCount(t.userId)).toBe(1);
  });

  it("disconnecting SoDEX deletes it", async () => {
    const t = await watching();
    await env.pool.query(
      `insert into api_keys (id, sodex_account_id, name, public_key, ciphertext, kms_key_ref, last4, permissions_mask, expires_at, status)
       values (gen_random_uuid(), $1, 'drift-test', $2, 'vault:v1:test', 'test', 'abcd', 14, now() + interval '30 days', 'active')`,
      [t.accountId, fakeAddress()],
    );
    const res = await t.client.request("POST", "/api/v1/sodex/disconnection", { body: {} });
    expect(res.statusCode).toBe(201);
    expect(await rowCount(t.userId)).toBe(0);
  });

  it("deleting the account deletes it", async () => {
    const t = await watching();
    await env.pool.query("update sodex_accounts set status = 'disconnected' where id = $1", [
      t.accountId,
    ]);
    const res = await t.client.request("DELETE", "/api/v1/account", { body: {} });
    expect(res.statusCode).toBe(204);
    expect(await rowCount(t.userId)).toBe(0);
  });
});
