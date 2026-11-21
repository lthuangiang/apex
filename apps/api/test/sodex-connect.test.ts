import {
  disconnectResponseSchema,
  errorResponseSchema,
  signatureRequestSchema,
  sodexConnectionSchema,
  twoFactorSetupSchema,
  type TypedData,
} from "@drift/shared";
import type { Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { generateTotp } from "../src/lib/totp";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Luồng kết nối hai chữ ký (DEC-25) chạy trên SoDEX mock có kiểm tra chữ ký EIP-712 thật.

let env: TestEnv;
let n = 0;
const errorCode = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error.code;
const later = () => {
  env.clock.now = new Date(env.clock.now.getTime() + 2 * 60 * 60 * 1000);
};

beforeAll(async () => {
  env = await startTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(later);

/** Ví ký đúng typed data server trả về, như `eth_signTypedData_v4`. */
async function walletSign(wallet: PrivateKeyAccount, typedData: TypedData): Promise<Hex> {
  const fields = typedData.types[typedData.primaryType] ?? [];
  const message = Object.fromEntries(
    fields.map((f) => {
      const value = typedData.message[f.name];
      return [
        f.name,
        f.type.startsWith("uint") && f.type !== "uint8" ? BigInt(String(value)) : value,
      ];
    }),
  );
  return wallet.signTypedData({
    domain: {
      ...typedData.domain,
      chainId: BigInt(typedData.domain.chainId),
      verifyingContract: typedData.domain.verifyingContract as Hex,
    },
    types: typedData.types,
    primaryType: typedData.primaryType,
    message,
  });
}

interface Trader {
  client: TestClient;
  wallet: PrivateKeyAccount;
  accountID: number;
}

async function newTrader(): Promise<Trader> {
  n += 1;
  const wallet = privateKeyToAccount(`0x${(n + 0x40).toString(16).padStart(64, "0")}`);
  const accountID = 5000 + n;
  env.sodex.addUser(wallet.address, accountID);
  const client = new TestClient(env.app);
  await signIn(env, client, `connect${String(n)}@example.com`);
  return { client, wallet, accountID };
}

async function signAndSubmit(
  t: Trader,
  created: { body: string; statusCode: number },
  wallet = t.wallet,
) {
  expect(created.statusCode, created.body).toBe(201);
  const request = signatureRequestSchema.parse(JSON.parse(created.body));
  const signature = await walletSign(wallet, request.typedData);
  return t.client.request("POST", `/api/v1/sodex/signature-requests/${request.id}/signature`, {
    body: { signature },
  });
}

// Sự kiện báo team (DEC-191) của account SoDEX này.
const teamConnected = async (t: Trader) =>
  (
    await env.pool.query(
      `select o.id from outbox o join sodex_accounts a on a.id::text = o.payload->>'sodexAccountId'
       where o.topic = 'jobs.team_ops' and o.payload->>'type' = 'team_sodex_connected'
         and a.sodex_account_id = $1`,
      [String(t.accountID)],
    )
  ).rowCount;
const connection = async (t: Trader) =>
  sodexConnectionSchema.parse((await t.client.request("GET", "/api/v1/sodex/connection")).json())
    .connection;

describe("connect SoDEX with two signatures", () => {
  it("creates the DeskLabs key, then approves 0.01%, reading both back", async () => {
    const t = await newTrader();
    expect(await connection(t)).toBeNull();

    const start = await t.client.request("POST", "/api/v1/sodex/connection", {
      body: { address: t.wallet.address },
    });
    const request = signatureRequestSchema.parse(start.json());
    expect(request.typedData.primaryType).toBe("UserSignedAddPermissionedAPIKeyAction");
    expect(request.typedData.message).toMatchObject({
      chainID: "286623",
      accountID: String(t.accountID),
      name: "DeskLabs",
      permissions: "14",
    });
    // expiresAt = nonce + 180 ngày (DEC-28).
    expect(
      BigInt(String(request.typedData.message.expiresAt)) -
        BigInt(String(request.typedData.message.nonce)),
    ).toBe(180n * 24n * 3600n * 1000n);

    const key = await signAndSubmit(t, start);
    expect(signatureRequestSchema.parse(key.json()).status).toBe("succeeded");
    let conn = await connection(t);
    expect(conn).toMatchObject({
      status: "connected",
      sodexAccountId: String(t.accountID),
      builderFee: null,
    });
    expect(conn?.apiKey).toMatchObject({
      status: "active",
      permissions: { trade: true, withdrawTransfer: false },
    });
    expect(conn?.apiKey?.last4).toMatch(/^[0-9a-f]{4}$/);

    const approve = await t.client.request("POST", "/api/v1/sodex/builder-fee/approval");
    expect(signatureRequestSchema.parse(approve.json()).typedData.message).toMatchObject({
      builderID: "1645",
      maxFeeRate: "10",
    });
    const approved = await signAndSubmit(t, approve);
    expect(signatureRequestSchema.parse(approved.json()).status).toBe("succeeded");
    conn = await connection(t);
    expect(conn?.builderFee).toMatchObject({ spot: 10, perps: 10, approved: true });
  });

  it("revokes with 2FA, pausing nothing on its own, then approves again", async () => {
    const t = await newTrader();
    await signAndSubmit(
      t,
      await t.client.request("POST", "/api/v1/sodex/connection", {
        body: { address: t.wallet.address },
      }),
    );
    await signAndSubmit(t, await t.client.request("POST", "/api/v1/sodex/builder-fee/approval"));
    expect(await teamConnected(t)).toBe(1);

    const setup = twoFactorSetupSchema.parse(
      (await t.client.request("POST", "/api/v1/security/2fa/setup")).json(),
    );
    await t.client.request("POST", "/api/v1/security/2fa/enable", {
      body: { code: generateTotp(setup.secret, env.clock.now) },
    });
    env.clock.now = new Date(env.clock.now.getTime() + 30_000);

    const revoke = await t.client.request("POST", "/api/v1/sodex/builder-fee/revocation", {
      body: { twoFactorCode: generateTotp(setup.secret, env.clock.now) },
    });
    expect(signatureRequestSchema.parse(revoke.json()).typedData.message).toMatchObject({
      maxFeeRate: "0",
    });
    expect(signatureRequestSchema.parse((await signAndSubmit(t, revoke)).json()).status).toBe(
      "succeeded",
    );
    expect((await connection(t))?.builderFee).toMatchObject({
      spot: null,
      perps: null,
      approved: false,
    });

    expect(
      signatureRequestSchema.parse(
        (
          await signAndSubmit(
            t,
            await t.client.request("POST", "/api/v1/sodex/builder-fee/approval"),
          )
        ).json(),
      ).status,
    ).toBe("succeeded");
    expect((await connection(t))?.builderFee).toMatchObject({
      spot: 10,
      perps: 10,
      approved: true,
    });
    // Approve lại sau revoke không báo team lần nữa.
    expect(await teamConnected(t)).toBe(1);
  });

  it("renews the key with one signature: a new DeskLabs-<date> key replaces the old one (DEC-59)", async () => {
    const t = await newTrader();
    await signAndSubmit(
      t,
      await t.client.request("POST", "/api/v1/sodex/connection", {
        body: { address: t.wallet.address },
      }),
    );
    const before = await connection(t);
    const renew = await t.client.request("POST", "/api/v1/sodex/connection/renewal");
    const request = signatureRequestSchema.parse(renew.json());
    expect(request.typedData.primaryType).toBe("UserSignedAddPermissionedAPIKeyAction");
    expect(String(request.typedData.message.name)).toMatch(/^DeskLabs-\d{8}$/);
    expect(request.typedData.message).toMatchObject({ permissions: "14" });
    const done = await signAndSubmit(t, renew);
    expect(signatureRequestSchema.parse(done.json()).status).toBe("succeeded");
    const after = await connection(t);
    expect(after?.apiKey?.status).toBe("active");
    expect(after?.apiKey?.last4).not.toBe(before?.apiKey?.last4);
    // Chỉ còn một key `active` cho account: engine không thấy hai key.
    const { rows } = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from api_keys k join sodex_accounts a on a.id = k.sodex_account_id where a.sodex_account_id = $1 and k.status = 'active'",
      [t.accountID],
    );
    expect(rows[0]?.n).toBe(1);
  });

  it("rejects a signature from a different wallet and keeps the request pending", async () => {
    const t = await newTrader();
    const start = await t.client.request("POST", "/api/v1/sodex/connection", {
      body: { address: t.wallet.address },
    });
    const res = await signAndSubmit(t, start, privateKeyToAccount(`0x${"99".repeat(32)}`));
    expect(errorCode(res.body)).toBe("SIGNATURE_INVALID");
    const id = signatureRequestSchema.parse(start.json()).id;
    const after = signatureRequestSchema.parse(
      (await t.client.request("GET", `/api/v1/sodex/signature-requests/${id}`)).json(),
    );
    expect(after.status).toBe("pending");
  });

  it("marks the request failed when SoDEX rejects it, with the SoDEX reason", async () => {
    const t = await newTrader();
    env.sodex.failNextWrite("reject", "insufficient deposit");
    const res = await signAndSubmit(
      t,
      await t.client.request("POST", "/api/v1/sodex/connection", {
        body: { address: t.wallet.address },
      }),
    );
    expect(signatureRequestSchema.parse(res.json())).toMatchObject({
      status: "failed",
      sodexError: "insufficient deposit",
    });
    expect((await connection(t))?.apiKey).toBeNull();
  });

  it("treats a timeout as unknown, never resends, and reconciles by reading back", async () => {
    const t = await newTrader();
    await signAndSubmit(
      t,
      await t.client.request("POST", "/api/v1/sodex/connection", {
        body: { address: t.wallet.address },
      }),
    );
    env.sodex.failNextWrite("timeout-after-apply");
    const approve = await t.client.request("POST", "/api/v1/sodex/builder-fee/approval");
    const res = await signAndSubmit(t, approve);
    // Mock đã áp dụng trước khi "timeout": đọc lại ngay thấy 50 nên request thành công mà không gửi lại.
    expect(signatureRequestSchema.parse(res.json()).status).toBe("succeeded");
    expect((await connection(t))?.builderFee?.approved).toBe(true);
  });

  it("does not submit the same signature request twice", async () => {
    const t = await newTrader();
    const start = await t.client.request("POST", "/api/v1/sodex/connection", {
      body: { address: t.wallet.address },
    });
    const request = signatureRequestSchema.parse(start.json());
    const signature = await walletSign(t.wallet, request.typedData);
    const url = `/api/v1/sodex/signature-requests/${request.id}/signature`;
    expect((await t.client.request("POST", url, { body: { signature } })).statusCode).toBe(200);
    const again = await t.client.request("POST", url, { body: { signature } });
    expect(errorCode(again.body)).toBe("STATE_CONFLICT");
  });

  it("reports a wallet without a SoDEX account", async () => {
    const t = await newTrader();
    const stranger = privateKeyToAccount(`0x${"77".repeat(32)}`);
    const res = await t.client.request("POST", "/api/v1/sodex/connection", {
      body: { address: stranger.address },
    });
    expect(errorCode(res.body)).toBe("SODEX_ACCOUNT_NOT_FOUND");
  });

  it("refuses a SoDEX account already connected to another DeskLabs user", async () => {
    const t = await newTrader();
    await t.client.request("POST", "/api/v1/sodex/connection", {
      body: { address: t.wallet.address },
    });
    const other = new TestClient(env.app);
    await signIn(env, other, `other${String(n)}@example.com`);
    const res = await other.request("POST", "/api/v1/sodex/connection", {
      body: { address: t.wallet.address },
    });
    expect(errorCode(res.body)).toBe("SODEX_ACCOUNT_IN_USE");
  });

  it("lets another DeskLabs user connect once the account was disconnected or its owner deleted", async () => {
    const t = await newTrader();
    await t.client.request("POST", "/api/v1/sodex/connection", {
      body: { address: t.wallet.address },
    });
    await env.pool.query("update sodex_accounts set status = 'disconnected' where address = $1", [
      t.wallet.address,
    ]);
    const other = new TestClient(env.app);
    await signIn(env, other, `reclaim${String(n)}@example.com`);
    const res = await other.request("POST", "/api/v1/sodex/connection", {
      body: { address: t.wallet.address },
    });
    expect(res.statusCode).toBeLessThan(300);

    // Chủ cũ đã xoá tài khoản DRIFT: account cũng được giải phóng.
    const t2 = await newTrader();
    await t2.client.request("POST", "/api/v1/sodex/connection", {
      body: { address: t2.wallet.address },
    });
    await env.pool.query(
      "update users set deleted_at = now() where id = (select user_id from sodex_accounts where address = $1)",
      [t2.wallet.address],
    );
    const third = new TestClient(env.app);
    await signIn(env, third, `reclaim-deleted${String(n)}@example.com`);
    const res2 = await third.request("POST", "/api/v1/sodex/connection", {
      body: { address: t2.wallet.address },
    });
    expect(res2.statusCode).toBeLessThan(300);
  });
});

describe("disconnect", () => {
  async function connectedWithTwoFactor() {
    const t = await newTrader();
    await signAndSubmit(
      t,
      await t.client.request("POST", "/api/v1/sodex/connection", {
        body: { address: t.wallet.address },
      }),
    );
    const setup = twoFactorSetupSchema.parse(
      (await t.client.request("POST", "/api/v1/security/2fa/setup")).json(),
    );
    await t.client.request("POST", "/api/v1/security/2fa/enable", {
      body: { code: generateTotp(setup.secret, env.clock.now) },
    });
    env.clock.now = new Date(env.clock.now.getTime() + 30_000);
    return { t, code: () => generateTotp(setup.secret, env.clock.now) };
  }

  it("revokes the key on Spot and Perps with two master-wallet signatures, then disconnects", async () => {
    const { t, code } = await connectedWithTwoFactor();
    const res = await t.client.request("POST", "/api/v1/sodex/disconnection", {
      body: { twoFactorCode: code() },
    });
    expect(res.statusCode).toBe(201);
    const { spot, perps } = disconnectResponseSchema.parse(res.json());
    expect(spot.typedData).toMatchObject({
      primaryType: "ExchangeAction",
      domain: { name: "spot" },
    });
    expect(perps.typedData).toMatchObject({
      primaryType: "ExchangeAction",
      domain: { name: "futures" },
    });

    const submit = async (request: typeof spot) =>
      signatureRequestSchema.parse(
        (
          await t.client.request(
            "POST",
            `/api/v1/sodex/signature-requests/${request.id}/signature`,
            {
              body: { signature: await walletSign(t.wallet, request.typedData) },
            },
          )
        ).json(),
      );
    expect((await submit(spot)).status).toBe("succeeded");
    // Mới xoá ở Spot: vẫn còn kết nối.
    expect((await connection(t))?.status).toBe("connected");
    expect((await submit(perps)).status).toBe("succeeded");
    expect(await connection(t)).toBeNull();
    const { rows } = await env.pool.query<{ status: string; ciphertext: string }>(
      "select k.status, k.ciphertext from api_keys k join sodex_accounts a on a.id = k.sodex_account_id where a.sodex_account_id = $1",
      [t.accountID],
    );
    expect(rows).toEqual([{ status: "deleted", ciphertext: "revoked" }]);
  });

  it("asks for 2FA once per session, then trusts it for 2 hours (DEC-115)", async () => {
    const { t, code } = await connectedWithTwoFactor();
    const noCode = await t.client.request("POST", "/api/v1/sodex/disconnection", { body: {} });
    expect(errorCode(noCode.body)).toBe("TWO_FACTOR_REQUIRED");
    expect(
      (
        await t.client.request("POST", "/api/v1/sodex/disconnection", {
          body: { twoFactorCode: code() },
        })
      ).statusCode,
    ).toBe(201);
    // Cùng phiên, trong 2 giờ: không cần mã.
    env.clock.now = new Date(env.clock.now.getTime() + 60 * 60_000);
    expect(
      (await t.client.request("POST", "/api/v1/sodex/disconnection", { body: {} })).statusCode,
    ).toBe(201);
    // Quá 2 giờ: hỏi lại.
    env.clock.now = new Date(env.clock.now.getTime() + 61 * 60_000);
    const late = await t.client.request("POST", "/api/v1/sodex/disconnection", { body: {} });
    expect(errorCode(late.body)).toBe("TWO_FACTOR_REQUIRED");
  });

  it("does not ask for 2FA when the user has not turned it on (DEC-115)", async () => {
    const t = await newTrader();
    await signAndSubmit(
      t,
      await t.client.request("POST", "/api/v1/sodex/connection", {
        body: { address: t.wallet.address },
      }),
    );
    // Chưa bật 2FA thì không hỏi mã (DEC-115).
    const res = await t.client.request("POST", "/api/v1/sodex/disconnection", { body: {} });
    expect(res.statusCode).toBe(201);
  });

  it("keeps the connection when SoDEX rejects one engine", async () => {
    const { t, code } = await connectedWithTwoFactor();
    const { spot } = disconnectResponseSchema.parse(
      (
        await t.client.request("POST", "/api/v1/sodex/disconnection", {
          body: { twoFactorCode: code() },
        })
      ).json(),
    );
    env.sodex.failNextWrite("reject", "engine busy");
    const res = await t.client.request(
      "POST",
      `/api/v1/sodex/signature-requests/${spot.id}/signature`,
      {
        body: { signature: await walletSign(t.wallet, spot.typedData) },
      },
    );
    expect(signatureRequestSchema.parse(res.json())).toMatchObject({
      status: "failed",
      sodexError: "engine busy",
    });
    expect((await connection(t))?.apiKey?.status).toBe("active");
  });
});

describe("connect flag", () => {
  it("is off until the key mask is verified on mainnet", async () => {
    const off = await startTestEnv({ connectEnabled: false });
    try {
      const client = new TestClient(off.app);
      await signIn(off, client, "flag@example.com");
      const res = await client.request("POST", "/api/v1/sodex/connection", {
        body: { address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db" },
      });
      expect(res.statusCode).toBe(403);
    } finally {
      await off.close();
    }
  });
});

describe("same SoDEX action twice with two Idempotency-Keys (#318)", () => {
  const parse = (res: { json: () => unknown }) => signatureRequestSchema.parse(res.json());
  const pendingKeys = async (t: Trader) =>
    (
      await env.pool.query(
        `select k.id from api_keys k join sodex_accounts a on a.id = k.sodex_account_id
         where a.sodex_account_id = $1 and k.status = 'pending'`,
        [t.accountID],
      )
    ).rowCount;
  const requests = async (t: Trader, action: string) =>
    (
      await env.pool.query<{ status: string; sodex_error: string | null }>(
        `select r.status, r.sodex_error from sodex_signature_requests r
         join sodex_accounts a on a.id = r.sodex_account_id
         where a.sodex_account_id = $1 and r.action = $2 order by r.expires_at`,
        [t.accountID, action],
      )
    ).rows;
  const connect = (t: Trader) =>
    t.client.request("POST", "/api/v1/sodex/connection", { body: { address: t.wallet.address } });

  it("connects with one key and one signature request when Connect arrives twice at once", async () => {
    const t = await newTrader();
    // Tạo account trước (lần đầu thì hai request cùng lúc đụng unique index của sodex_accounts).
    const first = parse(await connect(t));
    const [a, b] = await Promise.all([connect(t), connect(t)]);
    expect(parse(a).id).toBe(first.id);
    expect(parse(b).id).toBe(first.id);
    expect(await pendingKeys(t)).toBe(1);
    expect(await requests(t, "add_api_key")).toHaveLength(1);

    // Một lần ký là xong; gửi lại cùng request thì bị chặn.
    expect(parse(await signAndSubmit(t, a)).status).toBe("succeeded");
    const again = await signAndSubmit(t, b);
    expect(errorCode(again.body)).toBe("STATE_CONFLICT");
  });

  it("the first-ever Connect sent twice at once never returns 500 and makes one account, key and request (#326)", async () => {
    const t = await newTrader();
    const [a, b] = await Promise.all([connect(t), connect(t)]);
    // Tuỳ thứ tự: bên sau dùng lại request của bên trước (201, cùng id), hoặc đụng race ghi account (409, test dưới).
    for (const r of [a, b]) {
      expect([201, 409], r.body).toContain(r.statusCode);
      if (r.statusCode === 409) expect(errorCode(r.body)).toBe("STATE_CONFLICT");
    }
    const ok = [a, b].filter((r) => r.statusCode === 201).map((r) => parse(r).id);
    expect(ok.length).toBeGreaterThan(0);
    expect(new Set(ok).size).toBe(1);
    const accounts = await env.pool.query(
      "select id from sodex_accounts where sodex_account_id = $1",
      [t.accountID],
    );
    expect(accounts.rowCount).toBe(1);
    expect(await pendingKeys(t)).toBe(1);
    expect(await requests(t, "add_api_key")).toHaveLength(1);
  });

  it("the loser of a first-ever Connect race gets 409 STATE_CONFLICT, not 500 (#326)", async () => {
    // Ép đúng thứ tự của race: request kia đã thấy "chưa có account" và đang ghi dòng sodex_accounts (transaction
    // chưa commit). Request này cũng không thấy dòng đó, nên phải chờ ở unique index rồi đụng nó sau khi bên kia commit.
    const t = await newTrader();
    const user = await env.pool.query<{ id: string }>(
      "select u.id from users u order by u.created_at desc limit 1",
    );
    const other = await env.pool.connect();
    try {
      await other.query("begin");
      await other.query(
        `insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status)
         values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connecting')`,
        [user.rows[0]?.id, t.wallet.address, t.accountID],
      );
      const pending = connect(t);
      // Chờ tới khi request bị chặn ở unique index (đợi lock của transaction kia).
      for (let i = 0; i < 100; i++) {
        const w = await env.pool.query(
          "select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike 'insert into \"sodex_accounts\"%'",
        );
        if (w.rowCount !== null && w.rowCount > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await other.query("commit");
      const res = await pending;
      expect(res.statusCode, res.body).toBe(409);
      const body = errorResponseSchema.parse(res.json());
      expect(body.error.code).toBe("STATE_CONFLICT");
      expect(res.body).not.toMatch(/stack|duplicate key|sodex_accounts_network_account_key/);
    } finally {
      other.release();
    }
    const accounts = await env.pool.query(
      "select id from sodex_accounts where sodex_account_id = $1",
      [t.accountID],
    );
    expect(accounts.rowCount).toBe(1);
    // Request thua không tạo key ở signer, không tạo request ký (không có gì được gửi lên SoDEX).
    expect(await pendingKeys(t)).toBe(0);
    expect(await requests(t, "add_api_key")).toHaveLength(0);
    // Thử lại (key mới) thì dùng account đã có và tạo đúng một request ký.
    const again = parse(await connect(t));
    expect(again.action).toBe("add_api_key");
    expect(await pendingKeys(t)).toBe(1);
  });

  it("replaces a request about to expire, so two requests are never signable at once", async () => {
    const t = await newTrader();
    const old = await connect(t);
    // Còn dưới 2 phút để ký: tạo request mới, request cũ thành `failed` (superseded) và key chờ của nó bị xoá.
    env.clock.now = new Date(env.clock.now.getTime() + 9 * 60_000);
    const fresh = await connect(t);
    expect(parse(fresh).id).not.toBe(parse(old).id);
    expect(await requests(t, "add_api_key")).toEqual([
      { status: "failed", sodex_error: "superseded" },
      { status: "pending", sodex_error: null },
    ]);
    expect(await pendingKeys(t)).toBe(1);
    expect(errorCode((await signAndSubmit(t, old)).body)).toBe("STATE_CONFLICT");
    expect(parse(await signAndSubmit(t, fresh)).status).toBe("succeeded");
  });

  it("reuses the pending approve, renew and revoke requests", async () => {
    const t = await newTrader();
    await signAndSubmit(t, await connect(t));

    const approve = () => t.client.request("POST", "/api/v1/sodex/builder-fee/approval");
    const [a1, a2] = await Promise.all([approve(), approve()]);
    expect(parse(a1).id).toBe(parse(a2).id);
    expect(await requests(t, "approve_builder_fee")).toHaveLength(1);
    expect(parse(await signAndSubmit(t, a1)).status).toBe("succeeded");
    // Request đã xong thì lần bấm sau tạo request mới.
    expect(parse(await approve()).id).not.toBe(parse(a1).id);

    const renew = () => t.client.request("POST", "/api/v1/sodex/connection/renewal");
    const [r1, r2] = await Promise.all([renew(), renew()]);
    expect(parse(r1).id).toBe(parse(r2).id);
    expect(await pendingKeys(t)).toBe(1);

    const revoke = () =>
      t.client.request("POST", "/api/v1/sodex/builder-fee/revocation", { body: {} });
    const [v1, v2] = await Promise.all([revoke(), revoke()]);
    expect(parse(v1).id).toBe(parse(v2).id);
    expect(await requests(t, "revoke_builder_fee")).toHaveLength(1);
  });

  it("reuses the pending Spot and Perps revoke requests on a second Disconnect", async () => {
    const t = await newTrader();
    await signAndSubmit(t, await connect(t));
    const disconnect = () => t.client.request("POST", "/api/v1/sodex/disconnection", { body: {} });
    const [d1, d2] = (await Promise.all([disconnect(), disconnect()])).map((r) =>
      disconnectResponseSchema.parse(r.json()),
    );
    expect(d2?.spot.id).toBe(d1?.spot.id);
    expect(d2?.perps.id).toBe(d1?.perps.id);
    expect(await requests(t, "revoke_api_key_spot")).toHaveLength(1);
    expect(await requests(t, "revoke_api_key_perps")).toHaveLength(1);
  });
});

describe("one builder-fee intent awaiting signature per account (#327)", () => {
  const parse = (res: { json: () => unknown }) => signatureRequestSchema.parse(res.json());
  const feeRequests = async (t: Trader) =>
    (
      await env.pool.query<{ action: string; status: string; sodex_error: string | null }>(
        `select r.action, r.status, r.sodex_error from sodex_signature_requests r
         join sodex_accounts a on a.id = r.sodex_account_id
         where a.sodex_account_id = $1 and r.action in ('approve_builder_fee', 'revoke_builder_fee')
         order by r.created_at, r.action`,
        [t.accountID],
      )
    ).rows;
  const approve = (t: Trader) => t.client.request("POST", "/api/v1/sodex/builder-fee/approval");
  const revoke = (t: Trader) =>
    t.client.request("POST", "/api/v1/sodex/builder-fee/revocation", { body: {} });
  const connected = async () => {
    const t = await newTrader();
    await signAndSubmit(
      t,
      await t.client.request("POST", "/api/v1/sodex/connection", {
        body: { address: t.wallet.address },
      }),
    );
    return t;
  };
  const conflict = (res: { body: string }) => errorResponseSchema.parse(JSON.parse(res.body)).error;

  it("a new revoke supersedes the pending approve, which can no longer be signed", async () => {
    const t = await connected();
    const a = await approve(t);
    env.clock.now = new Date(env.clock.now.getTime() + 1000);
    const v = await revoke(t);
    expect(v.statusCode).toBe(201);
    expect(await feeRequests(t)).toEqual([
      { action: "approve_builder_fee", status: "failed", sodex_error: "superseded" },
      { action: "revoke_builder_fee", status: "pending", sodex_error: null },
    ]);
    const stale = await signAndSubmit(t, a);
    expect(conflict(stale)).toMatchObject({
      code: "STATE_CONFLICT",
      details: { reason: "superseded" },
    });
    // Request cũ không tới SoDEX: phí vẫn chưa approve; chỉ revoke còn ký được.
    expect((await connection(t))?.builderFee?.approved).not.toBe(true);
    expect(parse(await signAndSubmit(t, v)).status).toBe("succeeded");
  });

  it("a new approve supersedes the pending revoke", async () => {
    const t = await connected();
    await signAndSubmit(t, await approve(t));
    const v = await revoke(t);
    env.clock.now = new Date(env.clock.now.getTime() + 1000);
    const a = await approve(t);
    expect(a.statusCode).toBe(201);
    expect((await feeRequests(t)).slice(1)).toEqual([
      { action: "revoke_builder_fee", status: "failed", sodex_error: "superseded" },
      { action: "approve_builder_fee", status: "pending", sodex_error: null },
    ]);
    expect(conflict(await signAndSubmit(t, v)).code).toBe("STATE_CONFLICT");
    // Revoke bị thay không được gửi: phí vẫn approve.
    expect((await connection(t))?.builderFee).toMatchObject({ approved: true });
    expect(parse(await signAndSubmit(t, a)).status).toBe("succeeded");
  });

  it("refuses the opposite intent while an approve sent to SoDEX is still unconfirmed", async () => {
    const t = await connected();
    const a = parse(await approve(t));
    // Đã gửi SoDEX, chưa rõ kết quả (rule 1.7).
    await env.pool.query(
      `update sodex_signature_requests set status = 'unknown', submitted_at = now() where id = $1`,
      [a.id],
    );
    const v = await revoke(t);
    expect(v.statusCode).toBe(409);
    expect(conflict(v)).toMatchObject({
      code: "STATE_CONFLICT",
      details: { reason: "builder_fee_in_flight", requestId: a.id },
    });
    // Không đụng request đang gửi, không tạo revoke.
    expect(await feeRequests(t)).toEqual([
      { action: "approve_builder_fee", status: "unknown", sodex_error: null },
    ]);

    // Đối soát xong (SoDEX không áp dụng → nonce ra khỏi cửa sổ 2 ngày) thì revoke tạo được.
    env.clock.now = new Date(env.clock.now.getTime() + 2 * 24 * 60 * 60 * 1000 + 60_000);
    expect((await revoke(t)).statusCode).toBe(201);
  });

  it("lets an opposite intent through once the in-flight request is reconciled", async () => {
    const t = await connected();
    await signAndSubmit(t, await approve(t));
    const v = parse(await revoke(t));
    await env.pool.query(
      `update sodex_signature_requests set status = 'unknown', submitted_at = now() where id = $1`,
      [v.id],
    );
    expect(conflict(await approve(t)).details).toMatchObject({ reason: "builder_fee_in_flight" });
    // Đọc lại: SoDEX vẫn approve 10 nên revoke chưa áp dụng, request vẫn `unknown` và approve vẫn bị chặn.
    const read = await t.client.request(
      "POST",
      `/api/v1/sodex/signature-requests/${v.id}/reconciliation`,
    );
    expect(read.statusCode, read.body).toBe(200);
    expect(parse(read).status).toBe("unknown");
    expect((await approve(t)).statusCode).toBe(409);
    // Đối soát kết luận xong (ở đây: SoDEX đã từ chối) thì approve tạo được.
    await env.pool.query(
      `update sodex_signature_requests set status = 'failed', resolved_at = now() where id = $1`,
      [v.id],
    );
    expect((await approve(t)).statusCode).toBe(201);
  });
});
