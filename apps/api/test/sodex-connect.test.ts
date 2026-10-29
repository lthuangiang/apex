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
  expect(created.statusCode).toBe(201);
  const request = signatureRequestSchema.parse(JSON.parse(created.body));
  const signature = await walletSign(wallet, request.typedData);
  return t.client.request("POST", `/api/v1/sodex/signature-requests/${request.id}/signature`, {
    body: { signature },
  });
}

const connection = async (t: Trader) =>
  sodexConnectionSchema.parse((await t.client.request("GET", "/api/v1/sodex/connection")).json())
    .connection;

describe("connect SoDEX with two signatures", () => {
  it("creates the DRIFT key, then approves 0.01%, reading both back", async () => {
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
      name: "DRIFT",
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

    const noTwoFactor = await t.client.request("POST", "/api/v1/sodex/builder-fee/revocation", {
      body: { twoFactorCode: "123456" },
    });
    expect(errorCode(noTwoFactor.body)).toBe("TWO_FACTOR_REQUIRED");

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
  });

  it("renews the key with one signature: a new DRIFT-<date> key replaces the old one (DEC-59)", async () => {
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
    expect(String(request.typedData.message.name)).toMatch(/^DRIFT-\d{8}$/);
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

  it("refuses a SoDEX account already connected to another DRIFT user", async () => {
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

  it("lets another DRIFT user connect once the account was disconnected or its owner deleted", async () => {
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

  it("requires 2FA", async () => {
    const t = await newTrader();
    await signAndSubmit(
      t,
      await t.client.request("POST", "/api/v1/sodex/connection", {
        body: { address: t.wallet.address },
      }),
    );
    const res = await t.client.request("POST", "/api/v1/sodex/disconnection", {
      body: { twoFactorCode: "123456" },
    });
    expect(errorCode(res.body)).toBe("TWO_FACTOR_REQUIRED");
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
