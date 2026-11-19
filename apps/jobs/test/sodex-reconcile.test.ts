import {
  createDb,
  outbox,
  runMigrations,
  sodexAccounts,
  sodexSignatureRequests,
  users,
  type Db,
} from "@drift/db";
import { MemoryRateLimitStore, SodexRestClient } from "@drift/sodex";
import { buildSodexMock } from "@drift/sodex-mock";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { reconcileUnknownSignaturesOnce } from "../src/sodex-reconcile";

// Vòng đối soát nền (#327): request ký `unknown` được kết luận bằng cách ĐỌC lại SoDEX, không cần web còn mở.

const BUILDER_ID = 1645;
const NOW = new Date("2026-11-19T08:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
const mock = buildSodexMock({ builderIds: [BUILDER_ID] });
const rest = new SodexRestClient({
  config: { restUrl: "https://mainnet-gw.sodex.dev" },
  rateLimit: new MemoryRateLimitStore(),
  egressKey: "test",
  fetch: mock.fetch,
});
const logs: { level: string; data: Record<string, unknown>; msg: string }[] = [];
const log = {
  info: (data: Record<string, unknown>, msg: string) => logs.push({ level: "info", data, msg }),
  warn: (data: Record<string, unknown>, msg: string) => logs.push({ level: "warn", data, msg }),
};
const deps = () => ({ db, rest, builderId: BigInt(BUILDER_ID), now: () => NOW });

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

let n = 0;
async function seed(maxFeeRate: number, nonceAt: Date) {
  n += 1;
  const address = `0x${(0x9000 + n).toString(16).padStart(40, "0")}`;
  const accountID = 7000 + n;
  mock.addUser(address, accountID);
  const [user] = await db
    .insert(users)
    .values({ email: `reconcile${String(n)}@x.test` })
    .returning();
  const [account] = await db
    .insert(sodexAccounts)
    .values({
      userId: user?.id ?? "",
      address,
      sodexAccountId: BigInt(accountID),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  const [request] = await db
    .insert(sodexSignatureRequests)
    .values({
      userId: user?.id ?? "",
      sodexAccountId: account?.id ?? "",
      action: maxFeeRate === 0 ? "revoke_builder_fee" : "approve_builder_fee",
      message: {
        chainID: "286623",
        nonce: String(nonceAt.getTime()),
        accountID: String(accountID),
        builderID: String(BUILDER_ID),
        maxFeeRate: String(maxFeeRate),
      },
      status: "unknown",
      submittedAt: nonceAt,
      expiresAt: new Date(nonceAt.getTime() + 10 * 60_000),
    })
    .returning();
  return { address, accountId: account?.id ?? "", requestId: request?.id ?? "" };
}
const status = async (id: string) =>
  (
    await db
      .select({ status: sodexSignatureRequests.status })
      .from(sodexSignatureRequests)
      .where(eq(sodexSignatureRequests.id, id))
  )[0]?.status;

describe("background reconcile of unknown SoDEX signature requests", () => {
  it("resolves an unknown approve once SoDEX shows it applied, and leaves one that is not", async () => {
    const applied = await seed(10, new Date(NOW.getTime() - 5 * 60_000));
    const notYet = await seed(10, new Date(NOW.getTime() - 4 * 60_000));
    mock.setBuilder(applied.address, BUILDER_ID, 10);

    expect(await reconcileUnknownSignaturesOnce(deps(), log)).toBe(1);
    expect(await status(applied.requestId)).toBe("succeeded");
    // Chưa thấy trên SoDEX: vẫn `unknown`; vòng nền chỉ đọc, không gửi lại gì (quy tắc 1.7).
    expect(await status(notYet.requestId)).toBe("unknown");
    // Lần approve đầu của account: báo team như khi đối soát qua api (DEC-184).
    const events = await db.select().from(outbox).where(eq(outbox.topic, "jobs.team_ops"));
    expect(events.map((e) => (e.payload as { sodexAccountId: string }).sodexAccountId)).toContain(
      applied.accountId,
    );
    const line = logs.find(
      (l) => l.msg === "signature request reconciled" && l.data.requestId === applied.requestId,
    );
    expect(line?.data).toMatchObject({ status: "succeeded" });
    expect(typeof line?.data.traceId).toBe("string");

    // SoDEX áp dụng muộn: lượt sau kết luận nốt.
    mock.setBuilder(notYet.address, BUILDER_ID, 10);
    expect(await reconcileUnknownSignaturesOnce(deps(), log)).toBe(1);
    expect(await status(notYet.requestId)).toBe("succeeded");
  });

  it("resolves an unknown revoke when SoDEX no longer lists the approval", async () => {
    const revoke = await seed(0, new Date(NOW.getTime() - 60_000));
    expect(await reconcileUnknownSignaturesOnce(deps(), log)).toBe(1);
    expect(await status(revoke.requestId)).toBe("succeeded");
  });

  it("skips requests whose nonce is past the 2-day SoDEX window and keeps batches bounded", async () => {
    const old = await seed(10, new Date(NOW.getTime() - 2 * DAY - 60_000));
    mock.setBuilder(old.address, BUILDER_ID, 10);
    const fresh = await Promise.all([1, 2, 3].map(() => seed(10, new Date(NOW.getTime() - 1000))));
    for (const f of fresh) mock.setBuilder(f.address, BUILDER_ID, 10);

    expect(await reconcileUnknownSignaturesOnce(deps(), log, 2)).toBe(2);
    expect(await reconcileUnknownSignaturesOnce(deps(), log, 2)).toBe(1);
    expect(await Promise.all(fresh.map((f) => status(f.requestId)))).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    // Ngoài cửa sổ nonce: không đọc lại, giữ nguyên.
    expect(await status(old.requestId)).toBe("unknown");
  });
});
