import { createDb, runMigrations, type Db } from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { queueDueRecords } from "../src/desk-record";

// AI Desk B+ M4 (DEC-166): xếp job đo thành tích 7 ngày sau khi version AI thật sự được áp, mỗi lần Apply một job.

const NOW = Date.parse("2026-11-12T00:00:00Z");
const DAY = 86_400_000;

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

/** Bot có version 1 (cũ) và version 2 (AI) được áp `activeDaysAgo` ngày trước (null = chưa áp) + một dòng Apply. */
async function seedApply(activeDaysAgo: number | null): Promise<string> {
  const q = async (sql: string, p: unknown[]) =>
    (await pool.query<{ id: string }>(sql, p)).rows[0]?.id ?? "";
  const user = await q(
    "insert into users (id, email) values (gen_random_uuid(), $1) returning id",
    [`r${String(Math.random())}@x.test`],
  );
  const acct = await q(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, '0xabc', $2, 'mainnet', 'connected') returning id",
    [user, Math.floor(Math.random() * 1e9)],
  );
  const bot = await q(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode) values (gen_random_uuid(), $1, $2, 'volume_farm', 'BTC-USD', 'perps', 'Farm', 'running', 'live') returning id",
    [user, acct],
  );
  for (const [version, at] of [
    [1, new Date(NOW - 20 * DAY)],
    [2, activeDaysAgo === null ? null : new Date(NOW - activeDaysAgo * DAY)],
  ] as const)
    await pool.query(
      "insert into bot_versions (id, bot_id, version, config, param_source, status, applied_at) values (gen_random_uuid(), $1, $2, '{}', 'manual', $3, $4)",
      [bot, version, at === null ? "pending" : "active", at],
    );
  const item = await q(
    "insert into desk_items (id, user_id, bot_id, rule, severity, facts, fingerprint, badness, last_seen_at) values (gen_random_uuid(), $1, $2, 'liquidation_before_stop', 3, '[]', 'f', '0', now()) returning id",
    [user, bot],
  );
  const whatif = await q(
    "insert into desk_whatifs (id, item_id, user_id, bot_id, bot_version, item_fingerprint, status, options, window_from, window_to) values (gen_random_uuid(), $1, $2, $3, 1, 'f', 'done', '[]', now(), now()) returning id",
    [item, user, bot],
  );
  return q(
    "insert into desk_applies (id, whatif_id, user_id, bot_id, rule, option, from_version, to_version, baseline_config, applied_at) values (gen_random_uuid(), $1, $2, $3, 'liquidation_before_stop', 'lower_leverage', 1, 2, '{}', $4) returning id",
    [whatif, user, bot, new Date(NOW - 9 * DAY)],
  );
}

const statusOf = async (id: string) =>
  (
    await pool.query<{ record_status: string }>(
      "select record_status from desk_applies where id = $1",
      [id],
    )
  ).rows[0]?.record_status;
const jobsFor = async (id: string) =>
  (
    await pool.query<{ n: number }>(
      "select count(*)::int as n from outbox where topic = 'backtest.run' and payload->>'applyId' = $1",
      [id],
    )
  ).rows[0]?.n;

describe("desk record queue", () => {
  it("queues one job 7 days after the AI version became active, not after the click", async () => {
    const due = await seedApply(8);
    const recent = await seedApply(3);
    const pending = await seedApply(null);
    expect(await queueDueRecords(db, NOW)).toBe(1);
    expect(await statusOf(due)).toBe("queued");
    expect(await jobsFor(due)).toBe(1);
    // Bấm Apply 9 ngày trước nhưng version mới áp 3 ngày (hoặc chưa áp): chưa tới hạn.
    expect(await statusOf(recent)).toBe("measuring");
    expect(await statusOf(pending)).toBe("measuring");

    // Lượt sau không xếp lại.
    expect(await queueDueRecords(db, NOW + 60_000)).toBe(0);
    expect(await jobsFor(due)).toBe(1);
  });
});
