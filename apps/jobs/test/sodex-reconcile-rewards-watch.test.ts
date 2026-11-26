import {
  apiKeys,
  auditLog,
  createDb,
  rewardsWatch,
  runMigrations,
  sodexAccounts,
  sodexSignatureRequests,
  users,
  type Db,
} from "@drift/db";
import { SignatureAction } from "@drift/shared";
import type { ApiKeys } from "@drift/sodex";
import { reconcileSignatureRequest, type SignatureReconcileDeps } from "@drift/sodex-reconcile";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// #558 (DEC-398): đối soát request ký SoDEX xoá phiên rewards lưu ở server khi (a) key DeskLabs đã bị xoá trên SoDEX
// (account `disconnected`) và (b) đổi ví (một account SoDEX khác của cùng user sang `connected`). Postgres thật qua
// Testcontainers (CI); SoDEX là client giả trả danh sách key. Địa chỉ ví là địa chỉ giả.

const NOW = new Date("2026-11-26T08:00:00Z");

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

const noKeys: ApiKeys = { spot: [], perps: [] };
function deps(keys: ApiKeys): SignatureReconcileDeps {
  return {
    db,
    rest: {
      getApiKeys: () => Promise.resolve(keys),
      getBuilderApprovals: () => Promise.reject(new Error("not used")),
    },
    builderId: 1645n,
    now: () => NOW,
  };
}

let n = 0;
const fakeAddress = () => {
  n += 1;
  return `0x${(0xa000 + n).toString(16).padStart(40, "0")}`;
};

async function newUser() {
  n += 1;
  const [user] = await db
    .insert(users)
    .values({ email: `rw-reconcile${String(n)}@x.test` })
    .returning();
  return user?.id ?? "";
}

async function newAccount(userId: string, status: "connecting" | "connected") {
  const [account] = await db
    .insert(sodexAccounts)
    .values({
      userId,
      address: fakeAddress(),
      sodexAccountId: BigInt(8000 + n),
      network: "mainnet",
      status,
    })
    .returning();
  return { id: account?.id ?? "", address: account?.address ?? "" };
}

async function watch(userId: string, sodexAccountId: string) {
  await db.insert(rewardsWatch).values({
    userId,
    sodexAccountId,
    status: "active",
    tokenCiphertext: "vault:v1:test",
    kmsKeyRef: "vault-transit:drift-rewards",
    tokenExp: new Date(NOW.getTime() + 10 * 24 * 3600_000),
  });
}

const watching = async (userId: string) =>
  (await db.select().from(rewardsWatch).where(eq(rewardsWatch.userId, userId))).map(
    (r) => r.sodexAccountId,
  );

describe("reconcile deletes the stored rewards session", () => {
  it("(a) when SoDEX no longer lists the DeskLabs key: account disconnected, its rewards row deleted", async () => {
    const userId = await newUser();
    const account = await newAccount(userId, "connected");
    const otherUser = await newUser();
    const otherAccount = await newAccount(otherUser, "connected");
    await watch(userId, account.id);
    await watch(otherUser, otherAccount.id);
    const [key] = await db
      .insert(apiKeys)
      .values({
        sodexAccountId: account.id,
        name: "drift-test",
        publicKey: fakeAddress(),
        ciphertext: "vault:v1:key",
        kmsKeyRef: "test",
        last4: "abcd",
        permissionsMask: 14,
        expiresAt: new Date(NOW.getTime() + 30 * 24 * 3600_000),
        status: "active",
      })
      .returning();
    const [request] = await db
      .insert(sodexSignatureRequests)
      .values({
        userId,
        sodexAccountId: account.id,
        apiKeyId: key?.id ?? null,
        action: SignatureAction.revokeApiKeySpot,
        message: { nonce: String(NOW.getTime() - 60_000), accountID: "1" },
        status: "unknown",
        submittedAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      })
      .returning();

    const row = await reconcileSignatureRequest(deps(noKeys), request?.id ?? "");
    expect(row.status).toBe("succeeded");
    const [acc] = await db.select().from(sodexAccounts).where(eq(sodexAccounts.id, account.id));
    expect(acc?.status).toBe("disconnected");
    expect(await watching(userId)).toEqual([]);
    // Dòng của người khác không bị đụng.
    expect(await watching(otherUser)).toEqual([otherAccount.id]);
  });

  it("(b) when another SoDEX account of the same user becomes connected: the old account's row is deleted", async () => {
    const userId = await newUser();
    const oldAccount = await newAccount(userId, "connected");
    await watch(userId, oldAccount.id);
    const otherUser = await newUser();
    const otherAccount = await newAccount(otherUser, "connected");
    await watch(otherUser, otherAccount.id);

    const newAcc = await newAccount(userId, "connecting");
    const publicKey = fakeAddress();
    const [request] = await db
      .insert(sodexSignatureRequests)
      .values({
        userId,
        sodexAccountId: newAcc.id,
        action: SignatureAction.addApiKey,
        message: {
          chainID: "286623",
          nonce: String(NOW.getTime() - 60_000),
          accountID: "1",
          name: "drift-new",
          keyType: 1,
          publicKey,
          expiresAt: String(NOW.getTime() + 30 * 24 * 3600_000),
          permissions: "14",
        },
        status: "unknown",
        submittedAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      })
      .returning();
    const key = { name: "drift-new", type: "1", publicKey, expiresAt: 1n, permissions: 14n };
    const row = await reconcileSignatureRequest(
      deps({ spot: [key], perps: [key] }),
      request?.id ?? "",
    );
    expect(row.status).toBe("succeeded");
    const [acc] = await db.select().from(sodexAccounts).where(eq(sodexAccounts.id, newAcc.id));
    expect(acc?.status).toBe("connected");
    expect(await watching(userId)).toEqual([]);
    expect(await watching(otherUser)).toEqual([otherAccount.id]);
    const audit = await db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(eq(auditLog.userId, userId), eq(auditLog.action, "rewards.watch_disabled")));
    expect(audit.map((a) => a.metadata)).toEqual([{ reason: "wallet_changed" }]);
  });

  it("(b) keeps the row when the same account reconnects", async () => {
    const userId = await newUser();
    const account = await newAccount(userId, "connecting");
    await watch(userId, account.id);
    const publicKey = fakeAddress();
    const [request] = await db
      .insert(sodexSignatureRequests)
      .values({
        userId,
        sodexAccountId: account.id,
        action: SignatureAction.addApiKey,
        message: {
          chainID: "286623",
          nonce: String(NOW.getTime() - 60_000),
          accountID: "1",
          name: "drift-again",
          keyType: 1,
          publicKey,
          expiresAt: String(NOW.getTime() + 30 * 24 * 3600_000),
          permissions: "14",
        },
        status: "unknown",
        submittedAt: new Date(NOW.getTime() - 60_000),
        expiresAt: new Date(NOW.getTime() + 10 * 60_000),
      })
      .returning();
    const key = { name: "drift-again", type: "1", publicKey, expiresAt: 1n, permissions: 14n };
    await reconcileSignatureRequest(deps({ spot: [key], perps: [key] }), request?.id ?? "");
    expect(await watching(userId)).toEqual([account.id]);
  });
});
