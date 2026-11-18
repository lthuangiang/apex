import { createDb, runMigrations, type Db } from "@drift/db";
import { engineHealthKey, teamIncidentCountKey } from "@drift/shared";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { checkTeamIncidents, type IncidentReadStore } from "../src/team-incidents";

// Sức khoẻ engine / SoDEX cho team (#241): bộ đếm Redis theo phút do engine ghi, `sodex_calls` (DEC-309), tin tổng hợp
// ngày. Mỗi loại tối đa một dòng outbox / 31 phút. Account chỉ ở dạng che.

const NOW = Date.parse("2026-11-18T00:30:30Z");
const MIN = 60_000;
const minute = Math.floor(NOW / MIN);
const WALLET = "0x3e9a4c7b1d2e3f405162738495a6b7c8d9e011fd";

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
beforeEach(async () => {
  await pool.query(
    "delete from sodex_calls_ok; delete from sodex_calls_problem; delete from outbox where topic = 'jobs.team_ops'",
  );
});

/** Redis giả: bộ đếm và khoá chặn lặp (không hết hạn; test dùng store mới khi cần). */
function memStore(counts: Record<string, number> = {}): IncidentReadStore & { claimed: string[] } {
  const claimed: string[] = [];
  return {
    claimed,
    values: (keys) => Promise.resolve(keys.map((k) => counts[k] ?? 0)),
    claim: (key) => {
      if (claimed.includes(key)) return Promise.resolve(false);
      claimed.push(key);
      return Promise.resolve(true);
    },
    release: (key) => {
      claimed.splice(claimed.indexOf(key), 1);
      return Promise.resolve();
    },
  };
}

async function call(o: {
  table?: "ok" | "problem";
  kind?: "rest" | "ws";
  method?: string;
  endpoint?: string;
  outcome?: string;
  http?: number | null;
  agoMs?: number;
  address?: string | null;
}) {
  await pool.query(
    `insert into sodex_calls_${o.table ?? "ok"} (id, at, service, kind, method, endpoint, outcome, http_status, latency_ms, account_address)
     values (gen_random_uuid(), $1, 'engine', $2, $3, $4, $5, $6, 10, $7)`,
    [
      new Date(NOW - (o.agoMs ?? MIN)),
      o.kind ?? "rest",
      o.method ?? "GET",
      o.endpoint ?? "/perps/markets/symbols",
      o.outcome ?? "ok",
      o.http ?? null,
      o.address ?? null,
    ],
  );
}

const queued = async () =>
  (
    await pool.query<{ payload: Record<string, unknown> }>(
      "select payload from outbox where topic = 'jobs.team_ops' order by created_at, id",
    )
  ).rows.map((r) => r.payload);

describe("team incident checks", () => {
  it("raises engine health warnings from the per-minute counters, once per type until the window passes", async () => {
    const store = memStore({
      [engineHealthKey("shard_lost", minute - 2)]: 1,
      [engineHealthKey("tick_slow", minute)]: 1,
      [engineHealthKey("tick_slow", minute - 4)]: 2,
      // Ngoài cửa sổ 10 phút: không tính.
      [engineHealthKey("tick_slow", minute - 11)]: 9,
      [engineHealthKey("reads_skipped", minute - 1)]: 140,
      [engineHealthKey("reads_skipped", minute - 2)]: 30,
    });
    expect(await checkTeamIncidents(db, store, NOW)).toEqual([
      "shard_lost",
      "tick_slow",
      "reads_skipped",
    ]);
    expect(await queued()).toEqual([
      { type: "team_incident", kind: "shard_lost", detail: "1 shard(s) lost in the last 5 min" },
      { type: "team_incident", kind: "tick_slow", detail: "3 slow ticks in the last 10 min" },
      {
        type: "team_incident",
        kind: "reads_skipped",
        detail: "up to 140 reads/min skipped by the write reserve (170 in 5 min)",
      },
    ]);
    // Điều kiện còn đúng phút sau: không ghi lại.
    expect(await checkTeamIncidents(db, store, NOW + MIN)).toEqual([]);
  });

  it("stays quiet below the thresholds", async () => {
    const store = memStore({
      [engineHealthKey("tick_slow", minute)]: 2,
      [engineHealthKey("reads_skipped", minute)]: 99,
    });
    for (let i = 0; i < 99; i++) await call({});
    await call({ table: "problem", outcome: "timeout" });
    expect(await checkTeamIncidents(db, store, NOW)).toEqual([]);
  });

  it("raises a SoDEX error spike from sodex_calls: timeouts, network, unreadable and 5xx, not business rejects", async () => {
    for (let i = 0; i < 80; i++) await call({});
    for (let i = 0; i < 6; i++)
      await call({
        table: "problem",
        outcome: "timeout",
        endpoint: "/perps/orders",
        method: "POST",
      });
    for (let i = 0; i < 4; i++)
      await call({ table: "problem", outcome: "unreadable", http: 502, endpoint: "/perps/orders" });
    for (let i = 0; i < 2; i++) await call({ table: "problem", outcome: "network" });
    // Bị từ chối (post-only…) không phải lỗi SoDEX.
    for (let i = 0; i < 20; i++) await call({ table: "problem", outcome: "rejected" });
    // Cũ hơn 10 phút: không tính.
    for (let i = 0; i < 30; i++)
      await call({ table: "problem", outcome: "timeout", agoMs: 11 * MIN });
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual(["sodex_errors"]);
    expect(await queued()).toEqual([
      {
        type: "team_incident",
        kind: "sodex_errors",
        detail: "12 of 112 REST calls failed in 10 min (11%) · most: /perps/orders",
      },
    ]);
  });

  it("raises user-stream closes above the hourly limit with the account masked", async () => {
    for (let i = 0; i < 11; i++)
      await call({ kind: "ws", method: "CLOSE", endpoint: "connection", address: WALLET });
    for (let i = 0; i < 10; i++)
      await call({
        kind: "ws",
        method: "CLOSE",
        endpoint: "connection",
        address: "0xaaaa00000000000000000000000000000000bbbb",
      });
    await call({ kind: "ws", method: "OPEN", endpoint: "connection", address: WALLET });
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual(["ws_closes"]);
    const [e] = await queued();
    expect(e).toEqual({
      type: "team_incident",
      kind: "ws_closes",
      detail: "user stream closed 11× on 0x3e9a…11fd in the last hour (limit 10)",
    });
    expect(JSON.stringify(e).toLowerCase()).not.toContain(WALLET.slice(2, -4));
  });

  it("sends one digest a day from 01:00 UTC with the last 24 hours of counts", async () => {
    const at = Date.parse("2026-11-18T01:02:00Z");
    const hour = Math.floor(at / 3_600_000);
    const store = memStore({
      [teamIncidentCountKey(hour - 1, "position_mismatch")]: 2,
      [teamIncidentCountKey(hour - 24, "tick_slow")]: 3,
      // Giờ hiện tại chưa xong, và cũ hơn 24 giờ: không tính.
      [teamIncidentCountKey(hour, "late_fill")]: 5,
      [teamIncidentCountKey(hour - 25, "late_fill")]: 5,
    });
    // Trước 01:00 UTC: chưa gửi.
    expect(await checkTeamIncidents(db, store, Date.parse("2026-11-18T00:59:00Z"))).toEqual([]);
    expect(await checkTeamIncidents(db, store, at)).toEqual(["digest"]);
    expect(await checkTeamIncidents(db, store, at + 60 * MIN)).toEqual([]);
    expect(await queued()).toEqual([
      { type: "team_incident_digest", counts: { position_mismatch: 2, tick_slow: 3 } },
    ]);
  });

  it("keeps checking the others when one source fails", async () => {
    const store = memStore({ [engineHealthKey("shard_lost", minute)]: 1 });
    const broken: IncidentReadStore = {
      ...store,
      values: () => Promise.reject(new Error("redis down")),
    };
    for (let i = 0; i < 11; i++) await call({ kind: "ws", method: "CLOSE", address: WALLET });
    const warned: string[] = [];
    expect(
      await checkTeamIncidents(db, broken, NOW, (_m, d) => warned.push(String(d.check))),
    ).toEqual(["ws_closes"]);
    expect(warned).toEqual(["engine_health"]);
  });
});
