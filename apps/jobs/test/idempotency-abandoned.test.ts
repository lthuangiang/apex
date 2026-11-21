import { randomUUID } from "node:crypto";

import { createDb, runMigrations, type Db } from "@drift/db";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  idempotencyAbandonedEnvSchema,
  markAbandonedIdempotencyKeysOnce,
} from "../src/idempotency-abandoned";

// #319: dòng Idempotency-Key đang chạy quá N phút → `failed_unknown` / `ABANDONED`; dòng mới và dòng đã xong giữ nguyên;
// không xoá dòng nào; chạy lại không đổi gì. (409 `unknown` cho request lặp lại: apps/api/test/idempotency.test.ts.)

const NOW = new Date("2026-11-21T08:00:00Z");
const MIN = 60_000;

let container: StartedPostgreSqlContainer;
let db: Db;
let pool: ReturnType<typeof createDb>["pool"];
let userId: string;
const logs: { data: Record<string, unknown>; msg: string }[] = [];
const log = { warn: (data: Record<string, unknown>, msg: string) => logs.push({ data, msg }) };
const run = () => markAbandonedIdempotencyKeysOnce({ db, now: () => NOW, afterMin: 10 }, log);

beforeAll(async () => {
  container = await new PostgreSqlContainer("timescale/timescaledb:2.16.1-pg16").start();
  await runMigrations(container.getConnectionUri());
  ({ db, pool } = createDb(container.getConnectionUri()));
  userId = randomUUID();
  await pool.query("insert into users (id, email) values ($1, $2)", [
    userId,
    `abandoned-${userId}@drift.test`,
  ]);
});
afterAll(async () => {
  await pool.end();
  await container.stop();
});
beforeEach(async () => {
  logs.length = 0;
  await pool.query("delete from idempotency_keys");
});

/** Một dòng tạo `ageMin` phút trước NOW; mặc định đang chạy (chưa có kết quả). */
async function row(
  ageMin: number,
  done: { statusCode?: number; outcome?: string; errorCode?: string } = {},
): Promise<string> {
  const key = randomUUID();
  const at = new Date(NOW.getTime() - ageMin * MIN);
  await pool.query(
    `insert into idempotency_keys (id, key, user_id, request_hash, status_code, response, outcome, error_code, expires_at,
       created_at, updated_at)
     values (gen_random_uuid(), $1, $2, 'v2:x', $3, $4, $5, $6, $7, $8, $8)`,
    [
      key,
      userId,
      done.statusCode ?? null,
      done.statusCode === undefined ? null : JSON.stringify({ ok: true }),
      done.outcome ?? null,
      done.errorCode ?? null,
      new Date(at.getTime() + 24 * 60 * MIN),
      at,
    ],
  );
  return key;
}

const stateOf = async (key: string) =>
  (
    await pool.query<{
      status_code: number | null;
      outcome: string | null;
      error_code: string | null;
    }>("select status_code, outcome, error_code from idempotency_keys where key = $1", [key])
  ).rows[0];

describe("abandoned idempotency keys (#319)", () => {
  it("marks a row in progress for over N minutes failed_unknown / ABANDONED, with a warn log per row", async () => {
    const stuck = await row(11);
    expect(await run()).toBe(1);
    expect(await stateOf(stuck)).toEqual({
      status_code: null,
      outcome: "failed_unknown",
      error_code: "ABANDONED",
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]?.data).toMatchObject({ afterMin: 10, userTail: userId.slice(-4) });
    expect(typeof logs[0]?.data.traceId).toBe("string");
    // Không log key đầy đủ hay user id đầy đủ.
    expect(JSON.stringify(logs)).not.toContain(stuck);
    expect(JSON.stringify(logs)).not.toContain(userId);
  });

  it("leaves a row in progress for less than N minutes alone", async () => {
    const fresh = await row(9);
    expect(await run()).toBe(0);
    expect(await stateOf(fresh)).toEqual({ status_code: null, outcome: null, error_code: null });
  });

  it("never touches finished rows: a stored response or an earlier failed_unknown", async () => {
    const done = await row(60, { statusCode: 202 });
    const unknown = await row(60, { outcome: "failed_unknown", errorCode: "SODEX_TIMEOUT" });
    expect(await run()).toBe(0);
    expect(await stateOf(done)).toEqual({ status_code: 202, outcome: null, error_code: null });
    expect(await stateOf(unknown)).toEqual({
      status_code: null,
      outcome: "failed_unknown",
      error_code: "SODEX_TIMEOUT",
    });
  });

  it("is idempotent and deletes nothing: a second pass changes nothing", async () => {
    const stuck = await row(30);
    await row(1);
    await row(60, { statusCode: 200 });
    expect(await run()).toBe(1);
    const before = (await pool.query("select * from idempotency_keys order by key")).rows;
    expect(await run()).toBe(0);
    expect((await pool.query("select * from idempotency_keys order by key")).rows).toEqual(before);
    expect(before).toHaveLength(3);
    expect((await stateOf(stuck))?.error_code).toBe("ABANDONED");
    expect(logs).toHaveLength(1);
  });

  it("env: 10 minutes by default, whole minutes from 5 to 1440", () => {
    expect(idempotencyAbandonedEnvSchema.parse(undefined)).toBe(10);
    expect(idempotencyAbandonedEnvSchema.parse("15")).toBe(15);
    for (const bad of ["4", "1441", "7.5", "x"])
      expect(idempotencyAbandonedEnvSchema.safeParse(bad).success, bad).toBe(false);
  });
});
