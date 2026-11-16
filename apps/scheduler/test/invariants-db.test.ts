import {
  bots,
  createDb,
  fills,
  orders,
  runMigrations,
  sodexAccounts,
  users,
  type Db,
} from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { p4FilledNet, stopTimeOf } from "../src/invariants";

// P4 (DEC-TBD-prod-invariants): tổng fill của version không đọc lại cả version mỗi phút; mốc trong Redis (ở đây: Map).

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

async function seedBot() {
  const [u] = await db
    .insert(users)
    .values({ email: `${String(Math.random())}@x.test` })
    .returning();
  const [a] = await db
    .insert(sodexAccounts)
    .values({
      userId: u?.id ?? "",
      address: "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db",
      sodexAccountId: BigInt(Math.floor(Math.random() * 1e9)),
      network: "mainnet",
      status: "connected",
    })
    .returning();
  const [b] = await db
    .insert(bots)
    .values({
      userId: u?.id ?? "",
      sodexAccountId: a?.id ?? "",
      strategy: "volume_maker",
      market: "BTC-USD",
      engine: "perps",
      name: "MM",
      state: "running",
    })
    .returning();
  let n = 0;
  const fill = async (side: "buy" | "sell", size: string, createdAt: Date) => {
    n += 1;
    const [o] = await db
      .insert(orders)
      .values({
        botId: b?.id ?? "",
        sodexAccountId: a?.id ?? "",
        clOrdId: `p4-${String(n)}-${String(Math.random()).slice(2, 10)}`,
        market: "BTC-USD",
        engine: "perps",
        side,
        type: "limit",
        timeInForce: "GTX",
        size,
        status: "filled",
        reduceOnly: false,
        tag: "vm",
        epoch: 1,
        createdAt,
      })
      .returning();
    await db.insert(fills).values({
      orderId: o?.id ?? "",
      sodexTradeId: BigInt(Math.floor(Math.random() * 1e12)),
      price: "100000",
      size,
      fee: "0",
      filledAt: createdAt,
      createdAt,
    });
  };
  return { botId: b?.id ?? "", fill };
}

function mapStore() {
  const m = new Map<string, string>();
  return {
    m,
    get: (k: string) => Promise.resolve(m.get(k) ?? null),
    put: (k: string, v: string) => {
      m.set(k, v);
      return Promise.resolve();
    },
  };
}

describe("P4 filled net with a watermark", () => {
  it("sums the whole version once, then only the fills written after the watermark", async () => {
    const { botId, fill } = await seedBot();
    const t0 = Date.parse("2026-11-16T09:00:00Z");
    const from = new Date(t0 - 60_000);
    await fill("buy", "0.003", new Date(t0));
    await fill("sell", "0.001", new Date(t0 + 1_000));
    const store = mapStore();
    const q = { botId, versionId: "v1", from };
    expect(await p4FilledNet(db, store, { ...q, upTo: new Date(t0 + 2_000) })).toEqual({
      net: "0.002",
      decimals: 3,
    });
    // Fill ghi sau lần engine lưu sổ cái: chưa tính.
    await fill("buy", "0.0005", new Date(t0 + 5_000));
    expect((await p4FilledNet(db, store, { ...q, upTo: new Date(t0 + 4_000) })).net).toBe("0.002");
    // Lượt sau: cộng phần mới, không đếm lại phần cũ.
    expect(await p4FilledNet(db, store, { ...q, upTo: new Date(t0 + 6_000) })).toEqual({
      net: "0.0025",
      decimals: 4,
    });
    expect(await p4FilledNet(db, store, { ...q, upTo: new Date(t0 + 7_000) })).toEqual({
      net: "0.0025",
      decimals: 4,
    });
    // Mốc theo version: version mới đọc lại từ đầu của nó.
    expect(store.m.size).toBe(1);
    expect(
      (
        await p4FilledNet(db, store, {
          ...q,
          versionId: "v2",
          from: new Date(t0 + 3_000),
          upTo: new Date(t0 + 7_000),
        })
      ).net,
    ).toBe("0.0005");
  });

  it("re-reads the version when the watermark is unreadable", async () => {
    const { botId, fill } = await seedBot();
    const t0 = Date.parse("2026-11-16T09:30:00Z");
    await fill("buy", "0.01", new Date(t0));
    const store = mapStore();
    store.m.set(`team:invariant:p4:${botId}:v1`, "not json");
    expect(
      (
        await p4FilledNet(db, store, {
          botId,
          versionId: "v1",
          from: new Date(t0 - 1_000),
          upTo: new Date(t0 + 1_000),
        })
      ).net,
    ).toBe("0.01");
  });

  it("keeps the stop time rule pure (sanity)", () => {
    expect(stopTimeOf([{ state: "stopped", at: 3 }])).toBe(3);
  });
});
