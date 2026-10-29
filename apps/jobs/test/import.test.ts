import {
  accountAnalyses,
  createDb,
  historyTrades,
  imports,
  outbox,
  runMigrations,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import type { AccountMetrics } from "@drift/shared";
import { MemoryRateLimitStore, SodexRestClient } from "@drift/sodex";
import { buildSodexMock } from "@drift/sodex-mock";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runImport } from "../src/import";
import { relayOnce } from "../src/outbox";

const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const NOW = Date.parse("2026-10-27T00:00:00Z");
const H = 3_600_000;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
const mock = buildSodexMock();
const rest = new SodexRestClient({
  config: { restUrl: "https://mainnet-gw.sodex.dev" },
  rateLimit: new MemoryRateLimitStore(),
  egressKey: "test",
  fetch: mock.fetch,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});

async function seedImport(): Promise<{ importId: string; accountId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `${String(Math.random())}@x.test` })
    .returning();
  const [account] = await db
    .insert(sodexAccounts)
    .values({
      userId: user?.id ?? "",
      address: ADDRESS,
      sodexAccountId: BigInt(Math.floor(Math.random() * 1e9)),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  const [imp] = await db
    .insert(imports)
    .values({ sodexAccountId: account?.id ?? "", status: "queued" })
    .returning();
  return { importId: imp?.id ?? "", accountId: account?.id ?? "" };
}

// 1200 fill perps (buộc phân trang 1000 + 200) + một position có PnL tính tay + funding.
mock.addUser(ADDRESS, 1645);
mock.setHistory(ADDRESS, {
  perpsTrades: Array.from({ length: 1200 }, (_, i) => ({
    symbol: "BTC-USD",
    tradeID: 1_000_000 + i,
    orderID: 2_000_000 + i,
    clOrdID: `c${String(i)}`,
    side: i % 2 === 0 ? "BUY" : "SELL",
    price: "60000",
    quantity: "0.001",
    fee: "0.03",
    feeCoin: "vUSDC",
    isMaker: i % 4 === 0,
    time: NOW - (i + 1) * 60_000,
  })),
  positions: [
    {
      id: 77,
      symbol: "BTC-USD",
      marginMode: "CROSS",
      positionSide: "LONG",
      size: "0",
      avgEntryPrice: "60000",
      cumTradingFee: "3",
      cumFundingFee: "0",
      cumClosedSize: "0.1",
      avgClosePrice: "61000",
      maxSize: "0.1",
      realizedPnL: "97",
      leverage: 10,
      active: false,
      createdAt: NOW - 3 * H,
      updatedAt: NOW - H,
    },
  ],
  fundings: [
    {
      symbol: "BTC-USD",
      positionID: 77,
      positionSide: "LONG",
      fundingFee: "4",
      feeCoin: "vUSDC",
      timestamp: NOW - 2 * H,
    },
  ],
  // Lệnh spot quá 365 ngày: phải bị bỏ qua.
  spotTrades: [
    {
      symbol: "vBTC_vUSDC",
      tradeID: 9,
      orderID: 9,
      clOrdID: "old",
      side: "BUY",
      price: "1",
      quantity: "1",
      time: NOW - 400 * 24 * H,
    },
  ],
  accountValue: "1000",
});

describe("runImport", () => {
  it("imports every section with coverage, paginating past one page", async () => {
    const { importId, accountId } = await seedImport();
    await runImport(
      { db, rest, now: () => new Date(NOW), sleep: () => Promise.resolve() },
      importId,
    );

    const [imp] = await db.select().from(imports).where(eq(imports.id, importId));
    expect(imp?.status).toBe("done");
    expect(imp?.coverage).toMatchObject({
      perpsFills: {
        status: "done",
        count: 1200,
        from: NOW - 1200 * 60_000,
        to: NOW - 60_000,
        truncated: false,
      },
      spotFills: { status: "done", count: 0, from: null, to: null },
      positions: { status: "done", count: 1 },
      fundings: { status: "done", count: 1 },
    });

    const [analysis] = await db
      .select()
      .from(accountAnalyses)
      .where(eq(accountAnalyses.importId, importId));
    const metrics = analysis?.metrics as AccountMetrics;
    // gross 100, phí 3, funding 4 → net 93.
    expect(metrics).toMatchObject({
      grossRealizedPnl: "100",
      fees: "3",
      netFunding: "4",
      netPnl: "93",
      closedPositions: 1,
    });
    expect(Number(metrics.takerRatio)).toBeCloseTo(0.75, 12);
    // Equity dựng lại: 1000 − 93 = 907 đầu kỳ, funding −4 → 903: drawdown 4/907.
    expect(Number(metrics.maxDrawdownPct)).toBeCloseTo(4 / 907, 15);

    // Chạy lại cùng import: đã xong nên bỏ qua; import mới không tạo fill trùng.
    await runImport({ db, rest, now: () => new Date(NOW) }, importId);
    const second = await db
      .insert(imports)
      .values({ sodexAccountId: accountId, status: "queued" })
      .returning();
    await runImport(
      { db, rest, now: () => new Date(NOW), sleep: () => Promise.resolve() },
      second[0]?.id ?? "",
    );
    const [{ n } = { n: 0 }] = await db
      .select({ n: count() })
      .from(historyTrades)
      .where(eq(historyTrades.sodexAccountId, accountId));
    expect(n).toBe(1200);
  });

  it("marks only the failing section and the import as failed", async () => {
    const { importId } = await seedImport();
    await runImport(
      {
        db,
        rest: {
          getTrades: (engine, address, q) => rest.getTrades(engine, address, q),
          getPositionsHistory: (address, q) => rest.getPositionsHistory(address, q),
          getFundings: () => Promise.reject(new Error("boom")),
          getPerpsAccountValue: (address) => rest.getPerpsAccountValue(address),
        },
        now: () => new Date(NOW),
        sleep: () => Promise.resolve(),
      },
      importId,
    );
    const [imp] = await db.select().from(imports).where(eq(imports.id, importId));
    expect(imp?.status).toBe("failed");
    expect(imp?.coverage).toMatchObject({
      fundings: { status: "failed" },
      perpsFills: { status: "done" },
    });
  });
});

describe("outbox relay", () => {
  it("publishes each row once and marks it", async () => {
    await db.insert(outbox).values([
      { topic: "jobs.import", payload: { importId: "a" } },
      { topic: "jobs.import", payload: { importId: "b" } },
    ]);
    const sent: string[] = [];
    expect(
      await relayOnce(db, (_topic, payload) => {
        sent.push(JSON.stringify(payload));
        return Promise.resolve();
      }),
    ).toBe(2);
    expect(await relayOnce(db, () => Promise.reject(new Error("must not publish again")))).toBe(0);
    expect(sent).toEqual(['{"importId":"a"}', '{"importId":"b"}']);
  });
});
