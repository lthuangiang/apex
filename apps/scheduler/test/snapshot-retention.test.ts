import { createDb, runMigrations, type Db } from "@drift/db";
import { SIGNAL_RANGE_MS, SIGNAL_SNAPSHOT_RETENTION_DAYS } from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { snapshotCutoff, stripOldSnapshots } from "../src/snapshot-retention";

// Retention snapshot của Signal Analysis (#229): bỏ `payload.signal` / `orders.context` quá hạn, giữ nguyên dòng.

const NOW = Date.parse("2026-11-18T00:00:00Z");
const DAY = 86_400_000;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
let botId = "";
let accountId = "";

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
  const one = async (text: string, p: unknown[]) =>
    (await pool.query<{ id: string }>(text, p)).rows[0]?.id ?? "";
  const user = await one(
    "insert into users (id, email) values (gen_random_uuid(), 'retention@x.test') returning id",
    [],
  );
  accountId = await one(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, '0xabc', 1, 'mainnet', 'connected') returning id",
    [user],
  );
  botId = await one(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_farm', 'BTC-USD', 'perps', 'Farm', 'running', 'live') returning id",
    [user, accountId],
  );
}, 120_000);
afterAll(async () => {
  await pool.end();
  await container.stop();
});

const SIGNAL = { v: 1, score: 0.7, reason: "momentum" };
const CONTEXT = { v: 2, reason: "refresh", mid: "100", bookAgeMs: 120 };

async function addEvent(daysAgo: number, payload: Record<string, unknown>): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "insert into bot_events (id, bot_id, type, decision, why, payload, occurred_at) values (gen_random_uuid(), $1, 'decision', 'Enter long', 'why', $2, $3) returning id",
    [botId, JSON.stringify(payload), new Date(NOW - daysAgo * DAY)],
  );
  return rows[0]?.id ?? "";
}

let seq = 0;
async function addOrder(daysAgo: number, context: Record<string, unknown> | null): Promise<string> {
  seq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into orders (id, bot_id, sodex_account_id, cl_ord_id, market, engine, side, type, time_in_force, size, status, tag, epoch, context, created_at)
     values (gen_random_uuid(), $1, $2, $3, 'BTC-USD', 'perps', 'buy', 'limit', 'GTX', '1', 'filled', 'quote', 1, $4, $5) returning id`,
    [
      botId,
      accountId,
      `drift-ret-${String(seq)}`,
      context === null ? null : JSON.stringify(context),
      new Date(NOW - daysAgo * DAY),
    ],
  );
  return rows[0]?.id ?? "";
}

describe("signal snapshot retention (#229)", () => {
  it("keeps snapshots longer than the longest Signal Analysis range", () => {
    const longest = Math.max(...Object.values(SIGNAL_RANGE_MS));
    expect(SIGNAL_SNAPSHOT_RETENTION_DAYS * DAY).toBeGreaterThan(longest);
    expect(SIGNAL_SNAPSHOT_RETENTION_DAYS).toBe(45);
    expect(snapshotCutoff(NOW).toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });

  it("strips old signal snapshots and order contexts in batches but keeps every row", async () => {
    const oldEvents = await Promise.all(
      [46, 50, 60, 90, 120].map((d) => addEvent(d, { orders: ["drift-a"], signal: SIGNAL })),
    );
    const fresh = await addEvent(29, { orders: ["drift-b"], signal: SIGNAL });
    const edge = await addEvent(44, { signal: SIGNAL });
    const oldPlain = await addEvent(100, { orders: ["drift-c"] });
    const oldOrders = await Promise.all([46, 47, 80].map((d) => addOrder(d, CONTEXT)));
    const freshOrder = await addOrder(10, CONTEXT);

    // Lô 2 dòng, tối đa 2 lô: lượt đầu chỉ dọn 4 event, lượt sau dọn nốt.
    const first = await stripOldSnapshots(db, NOW, { batch: 2, maxBatches: 2 });
    expect(first).toEqual({ signals: 4, contexts: 3 });
    const second = await stripOldSnapshots(db, NOW, { batch: 2, maxBatches: 2 });
    expect(second).toEqual({ signals: 1, contexts: 0 });
    expect(await stripOldSnapshots(db, NOW)).toEqual({ signals: 0, contexts: 0 });

    const events = await pool.query<{ id: string; payload: Record<string, unknown> }>(
      "select id, payload from bot_events where bot_id = $1",
      [botId],
    );
    const byId = new Map(events.rows.map((r) => [r.id, r.payload]));
    expect(byId.size).toBe(8); // không xoá dòng nào
    for (const id of oldEvents) expect(byId.get(id)).toEqual({ orders: ["drift-a"] });
    expect(byId.get(fresh)).toEqual({ orders: ["drift-b"], signal: SIGNAL });
    expect(byId.get(edge)).toEqual({ signal: SIGNAL });
    expect(byId.get(oldPlain)).toEqual({ orders: ["drift-c"] });

    const ords = await pool.query<{ id: string; context: unknown; status: string }>(
      "select id, context, status from orders where bot_id = $1",
      [botId],
    );
    const ctx = new Map(ords.rows.map((r) => [r.id, r]));
    expect(ctx.size).toBe(4);
    for (const id of oldOrders)
      expect(ctx.get(id)).toMatchObject({ context: null, status: "filled" });
    expect(ctx.get(freshOrder)?.context).toEqual(CONTEXT);
  });

  it("finds expired rows through the partial indexes", async () => {
    const client = await pool.connect();
    try {
      await client.query("set enable_seqscan = off");
      const plan = async (text: string) =>
        (await client.query<{ "QUERY PLAN": string }>(`explain ${text}`)).rows
          .map((r) => r["QUERY PLAN"])
          .join("\n");
      expect(
        await plan(
          "select id from bot_events where payload ? 'signal' and occurred_at < now() order by occurred_at limit 10",
        ),
      ).toContain("bot_events_signal_idx");
      expect(
        await plan(
          "select id from orders where context is not null and created_at < now() order by created_at limit 10",
        ),
      ).toContain("orders_context_created_idx");
    } finally {
      client.release();
    }
  });

  it("skips rows another transaction holds instead of waiting for them", async () => {
    const held = await addEvent(70, { signal: SIGNAL });
    const other = await addEvent(71, { signal: SIGNAL });
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from bot_events where id = $1 for update", [held]);
      const started = Date.now();
      const r = await stripOldSnapshots(db, NOW);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(r.signals).toBe(1);
      await client.query("rollback");
    } finally {
      client.release();
    }
    const { rows } = await pool.query<{ id: string; payload: Record<string, unknown> }>(
      "select id, payload from bot_events where id = any($1::uuid[])",
      [[held, other]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.payload]));
    expect(byId.get(other)).toEqual({});
    expect(byId.get(held)).toEqual({ signal: SIGNAL });
    // Lượt sau dọn nốt dòng đã được nhả.
    expect((await stripOldSnapshots(db, NOW)).signals).toBe(1);
  });
});
