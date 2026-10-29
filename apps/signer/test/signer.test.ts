import { readdirSync, readFileSync } from "node:fs";
import { Writable } from "node:stream";

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import pg from "pg";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { v7 as uuidv7 } from "uuid";
import { recoverTypedDataAddress, toHex } from "viem";
import { privateKeyToAccount, privateKeyToAddress } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { buildSignerApp } from "../src/app";
import { signExchangeAction } from "../src/exchange-sign";
import { connectVault, type VaultTransit } from "../src/vault";

// Vault dev mode + Postgres thật (CODING_STANDARDS C14). Schema lấy từ migration của api
// (một nguồn duy nhất cho schema DB).
const MIGRATIONS = new URL("../../../packages/db/src/migrations/", import.meta.url);
const ROOT_TOKEN = "test-root";

let vaultContainer: StartedTestContainer;
let pgContainer: StartedPostgreSqlContainer;
let pool: pg.Pool;
let vault: VaultTransit;

async function vaultCall(path: string, body: unknown) {
  const base = `http://${vaultContainer.getHost()}:${String(vaultContainer.getMappedPort(8200))}`;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "X-Vault-Token": ROOT_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`vault ${path} ${String(res.status)}`);
}

beforeAll(async () => {
  [vaultContainer, pgContainer] = await Promise.all([
    new GenericContainer("hashicorp/vault:1.17")
      .withEnvironment({ VAULT_DEV_ROOT_TOKEN_ID: ROOT_TOKEN })
      .withAddedCapabilities("IPC_LOCK")
      .withExposedPorts(8200)
      .withWaitStrategy(Wait.forHttp("/v1/sys/health", 8200))
      .start(),
    new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start(),
  ]);
  await vaultCall("/v1/sys/mounts/transit", { type: "transit" });
  await vaultCall("/v1/transit/keys/drift-api-keys", { type: "aes256-gcm96" });
  // Khoá khác: mô phỏng ciphertext được mã hoá bằng khoá transit đã mất (Vault dev restart, UI_REVIEW H1).
  await vaultCall("/v1/transit/keys/other-key", { type: "aes256-gcm96" });
  vault = await connectVault(
    `http://${vaultContainer.getHost()}:${String(vaultContainer.getMappedPort(8200))}`,
    { token: ROOT_TOKEN },
    "drift-api-keys",
  );

  pool = new pg.Pool({ connectionString: pgContainer.getConnectionUri() });
  for (const file of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    for (const statement of readFileSync(new URL(file, MIGRATIONS), "utf8").split(
      "--> statement-breakpoint",
    )) {
      await pool.query(statement);
    }
  }
});

afterAll(async () => {
  await pool.end();
  await Promise.all([vaultContainer.stop(), pgContainer.stop()]);
});

async function seedAccount(): Promise<string> {
  const userId = uuidv7();
  const accountId = uuidv7();
  await pool.query("insert into users (id, email) values ($1, $2)", [
    userId,
    `${userId}@example.com`,
  ]);
  await pool.query(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values ($1, $2, $3, $4, 'mainnet', 'connecting')",
    [
      accountId,
      userId,
      "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
      Math.floor(Math.random() * 1e9),
    ],
  );
  return accountId;
}

const responseSchema = z.object({
  id: z.uuid(),
  publicKey: z.string(),
  last4: z.string().length(4),
});

describe("signer /v1/sign", () => {
  it("matches the Go SDK vector for ExchangeAction (DEC-27)", async () => {
    const account = privateKeyToAccount(`0x${"22".repeat(32)}`);
    const sig = await signExchangeAction(
      account,
      "futures",
      "0x24d973a9f714c68e80bf214cbd6a39798da4022b17d43719ec6017f19f4685a7",
      1760373925001n,
    );
    expect(sig).toBe(
      "0x0120f43c779a937112a9993194b3f94d9c441a389901c75e9a8251216c146ef66403a59d722cbf3eeb4ab77d8222ab1aa81c40323ba1aad7e88bb1787e40834c7d01",
    );
  });

  it("signs only with the current shard epoch", async () => {
    const app = buildSignerApp({ pool, vault, logLevel: "silent" });
    const sodexAccountId = await seedAccount();
    const created = responseSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/v1/api-keys",
          payload: { sodexAccountId, name: "DRIFT", expiresAt: "2027-04-25T08:00:00Z" },
        })
      ).json(),
    );
    await pool.query("update api_keys set status = 'active' where id = $1", [created.id]);
    await pool.query(
      "insert into shard_epochs (shard, epoch, owner, acquired_at) values (7, 3, 'w', now()) on conflict (shard) do update set epoch = 3",
    );
    const payloadHash = "0x24d973a9f714c68e80bf214cbd6a39798da4022b17d43719ec6017f19f4685a7";
    const body = {
      apiKeyId: created.id,
      domain: "spot",
      payloadHash,
      nonce: "1760373925001",
      shard: 7,
      epoch: 3,
    };

    const ok = await app.inject({ method: "POST", url: "/v1/sign", payload: body });
    expect(ok.statusCode).toBe(200);
    const { signature } = z.object({ signature: z.string() }).parse(ok.json());
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: "spot",
        version: "1",
        chainId: 286623n,
        verifyingContract: "0x0000000000000000000000000000000000000000",
      },
      types: {
        ExchangeAction: [
          { name: "payloadHash", type: "bytes32" },
          { name: "nonce", type: "uint64" },
        ],
      },
      primaryType: "ExchangeAction",
      message: { payloadHash, nonce: 1760373925001n },
      signature: `0x${signature.slice(4)}`,
    });
    expect(recovered).toBe(created.publicKey);

    const stale = await app.inject({
      method: "POST",
      url: "/v1/sign",
      payload: { ...body, epoch: 2 },
    });
    expect(stale.statusCode).toBe(409);

    // Key còn dùng được: verify 204, không trả gì về secret.
    const verified = await app.inject({ method: "POST", url: `/v1/keys/${created.id}/verify` });
    expect(verified.statusCode).toBe(204);
    expect(verified.body).toBe("");
    await app.close();
  });

  it("reports a key encrypted with a lost transit key as unusable and never signs with it", async () => {
    const app = buildSignerApp({ pool, vault, logLevel: "silent" });
    const sodexAccountId = await seedAccount();
    const created = responseSchema.parse(
      (
        await app.inject({
          method: "POST",
          url: "/v1/api-keys",
          payload: { sodexAccountId, name: "DRIFT", expiresAt: "2027-04-25T08:00:00Z" },
        })
      ).json(),
    );
    const other = await connectVault(
      `http://${vaultContainer.getHost()}:${String(vaultContainer.getMappedPort(8200))}`,
      { token: ROOT_TOKEN },
      "other-key",
    );
    const foreign = await other.encrypt(Buffer.alloc(32, 7));
    await pool.query("update api_keys set status = 'active', ciphertext = $2 where id = $1", [
      created.id,
      foreign,
    ]);
    await pool.query(
      "insert into shard_epochs (shard, epoch, owner, acquired_at) values (8, 1, 'w', now()) on conflict (shard) do update set epoch = 1",
    );
    const sign = await app.inject({
      method: "POST",
      url: "/v1/sign",
      payload: {
        apiKeyId: created.id,
        domain: "futures",
        payloadHash: `0x${"ab".repeat(32)}`,
        nonce: "1",
        shard: 8,
        epoch: 1,
      },
    });
    expect(sign.statusCode).toBe(422);
    expect(sign.json()).toEqual({ error: "key_unusable" });
    const verify = await app.inject({ method: "POST", url: `/v1/keys/${created.id}/verify` });
    expect(verify.statusCode).toBe(422);
    await app.close();
  });
});

describe("signer", () => {
  it("creates a pending key whose private key only exists encrypted by Vault", async () => {
    const logs: string[] = [];
    const app = buildSignerApp({
      pool,
      vault,
      logLevel: "trace",
      logStream: new Writable({
        write(chunk: Buffer, _enc, done) {
          logs.push(chunk.toString());
          done();
        },
      }),
    });
    const sodexAccountId = await seedAccount();

    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      payload: { sodexAccountId, name: "DRIFT", expiresAt: "2027-04-25T08:00:00Z" },
    });
    expect(res.statusCode).toBe(201);
    const body = responseSchema.parse(res.json());
    expect(body.last4).toBe(body.publicKey.slice(-4).toLowerCase());
    expect(Object.keys(z.record(z.string(), z.unknown()).parse(res.json())).sort()).toEqual([
      "id",
      "last4",
      "publicKey",
    ]);

    const { rows } = await pool.query<{
      ciphertext: string;
      status: string;
      permissions_mask: number;
      kms_key_ref: string;
    }>("select ciphertext, status, permissions_mask, kms_key_ref from api_keys where id = $1", [
      body.id,
    ]);
    const row = rows[0];
    expect(row).toMatchObject({
      status: "pending",
      permissions_mask: 14,
      kms_key_ref: "vault-transit:drift-api-keys",
    });
    expect(row?.ciphertext).toMatch(/^vault:v1:/);

    // Vault giải mã ra đúng private key của publicKey.
    const raw = await vault.decrypt(row?.ciphertext ?? "");
    expect(privateKeyToAddress(toHex(raw))).toBe(body.publicKey);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("")).not.toContain(toHex(raw).slice(2));
    expect(logs.join("")).not.toContain(row?.ciphertext ?? "missing");
    await app.close();
  });

  it("rejects an invalid body", async () => {
    const app = buildSignerApp({ pool, vault, logLevel: "silent" });
    const res = await app.inject({
      method: "POST",
      url: "/v1/api-keys",
      payload: { name: "default key" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
