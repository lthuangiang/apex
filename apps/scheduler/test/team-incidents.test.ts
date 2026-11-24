import { createDb, runMigrations, type Db } from "@drift/db";
import { engineHealthKey, teamIncidentCountKey } from "@drift/shared";
import { toSodexCallRow, type SodexRestCapture } from "@drift/sodex";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  checkTeamIncidents,
  teamIncidentRunner,
  type IncidentReadStore,
} from "../src/team-incidents";

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

  it("#493: cancels answered OrderNotFound (no clOrdID) are business rejects, not errors: no spike", async () => {
    // Đúng response SoDEX trả trên prod 2026-11-23: HTTP 200, envelope 0, item lỗi OrderNotFound không kèm clOrdID.
    const results = [{ code: -1, error: "order rejected: OrderNotFound" }];
    const capture: SodexRestCapture = {
      kind: "rest",
      startedAt: NOW - MIN,
      latencyMs: 40,
      method: "DELETE",
      url: "https://mainnet-gw.sodex.dev/api/v1/perps/trade/orders",
      requestHeaders: {},
      requestBody: '{"accountID":1,"cancels":[{"symbolID":2,"clOrdID":"d1-1-x-0"}]}',
      signed: true,
      actionType: "cancelOrder",
      failure: null,
      errorDetail: null,
      httpStatus: 200,
      responseHeaders: {},
      responseText: JSON.stringify({ code: 0, timestamp: 1, data: results }),
      responseLength: null,
      json: true,
      envelopeCode: 0,
      envelopeError: null,
      orderEndpoint: true,
      orderResults: results,
      context: undefined,
    };
    const row = toSodexCallRow(capture, "engine");
    expect(row).toMatchObject({ outcome: "rejected", problem: true, sodexCode: -1 });
    for (let i = 0; i < 90; i++) await call({});
    for (let i = 0; i < 30; i++)
      await call({
        table: row.problem ? "problem" : "ok",
        outcome: row.outcome,
        http: row.httpStatus,
        method: "DELETE",
        endpoint: row.endpoint,
      });
    // 30 / 120 = 25%: trước #493 (ghi `unreadable`) là cảnh báo giả.
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual([]);
    expect(await queued()).toEqual([]);
    // Response thật sự không đọc được vẫn được tính.
    for (let i = 0; i < 30; i++)
      await call({ table: "problem", outcome: "unreadable", http: 200, endpoint: row.endpoint });
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual(["sodex_errors"]);
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

  it("never overlaps runs, and checks user-stream closes only every 5 minutes", async () => {
    for (let i = 0; i < 11; i++) await call({ kind: "ws", method: "CLOSE", address: WALLET });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const base = memStore();
    // Bộ đếm Redis chậm: lượt đầu còn chạy khi lượt sau tới.
    const slow: IncidentReadStore = {
      ...base,
      values: async (keys) => {
        await gate;
        return base.values(keys);
      },
    };
    const run = teamIncidentRunner(db, slow);
    const first = run(NOW);
    expect(await run(NOW + MIN)).toBeNull();
    release();
    expect(await first).toEqual(["ws_closes"]);
    // Khoá raise đã nhả để thấy lượt sau có quét WS hay không.
    base.claimed.length = 0;
    await pool.query("delete from outbox where topic = 'jobs.team_ops'");
    expect(await run(NOW + 2 * MIN)).toEqual([]);
    expect(await run(NOW + 5 * MIN)).toEqual(["ws_closes"]);
  });
});

// #518 (DEC-386): luồng lệnh WS của SoDEX trễ, E − T > 5 s ở ≥ 2 tin trong 5 phút. Hai tin mẫu theo đúng E − T của
// 23/11 14:38 UTC (20,0 s và 22,0 s), định dạng tin `accountOrderUpdate` ({channel, type, data}) như user stream ghi.
describe("SoDEX order stream lag (#518)", () => {
  const OTHER = "0xaaaa00000000000000000000000000000000bbbb";
  const update = (lagMs: number, extra: Record<string, unknown> = {}) => {
    const T = NOW - 2 * MIN;
    return {
      s: "ETH-USD",
      c: "d183n9q-3-3t64jkvjqp7rf-0",
      i: "34698959402",
      S: "BUY",
      o: "LIMIT",
      f: "GTX",
      p: "3000",
      q: "0.01",
      X: "REJECTED",
      z: "0",
      v: "0",
      E: T + lagMs,
      T,
      r: "PostOnly",
      ...extra,
    };
  };
  async function msg(o: {
    data: unknown;
    agoMs?: number;
    address?: string | null;
    endpoint?: string;
    outcome?: string;
    truncated?: boolean;
    body?: string;
  }) {
    const body =
      o.body ??
      JSON.stringify({ channel: o.endpoint ?? "accountOrderUpdate", type: "update", data: o.data });
    await pool.query(
      `insert into sodex_calls_ok (id, at, service, kind, method, endpoint, outcome, latency_ms, account_address,
                                   response_body, response_truncated)
       values (gen_random_uuid(), $1, 'engine', 'ws', 'MSG', $2, $3, 0, $4, $5, $6)`,
      [
        new Date(NOW - (o.agoMs ?? MIN)),
        o.endpoint ?? "accountOrderUpdate",
        o.outcome ?? "ok",
        o.address === undefined ? WALLET : o.address,
        body,
        o.truncated ?? false,
      ],
    );
  }

  it("raises one warning for the two 23/11 updates (20.0 s and 22.0 s late), account masked", async () => {
    await msg({ data: update(20_000) });
    await msg({ data: [update(22_000), update(22_000, { X: "NEW", S: "SELL" })], agoMs: 2 * MIN });
    // Tin bình thường (E − T 22–101 ms): không tính.
    for (const lag of [22, 60, 101]) await msg({ data: update(lag) });
    const store = memStore();
    expect(await checkTeamIncidents(db, store, NOW)).toEqual(["sodex_ws_lag"]);
    const [e] = await queued();
    expect(e).toEqual({
      type: "team_incident",
      kind: "sodex_ws_lag",
      detail:
        "2 order updates arrived over 5 s late in the last 5 min (max 22.0 s) · accounts: 0x3e9a…11fd",
    });
    expect(JSON.stringify(e).toLowerCase()).not.toContain(WALLET.slice(2, -4));
    // Điều kiện còn đúng phút sau: không ghi lại (khoá theo loại, 31 phút).
    expect(await checkTeamIncidents(db, store, NOW + MIN)).toEqual([]);
    expect(await queued()).toHaveLength(1);
  });

  it("counts messages, not items; lists up to 3 accounts, most late messages first, then the longest lag", async () => {
    // Một tin có hai item trễ chỉ tính một lần: dưới ngưỡng.
    await msg({ data: [update(9_000), update(12_000)] });
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual([]);
    await msg({ data: update(6_000), address: OTHER });
    await msg({ data: update(7_000), address: OTHER });
    await msg({ data: update(8_000), address: "0xcccc00000000000000000000000000000000dddd" });
    await msg({ data: update(8_500), address: "0xeeee00000000000000000000000000000000ffff" });
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual(["sodex_ws_lag"]);
    const [e] = await queued();
    expect(e?.detail).toBe(
      "5 order updates arrived over 5 s late in the last 5 min (max 12.0 s) · accounts: 0xaaaa…bbbb, 0x3e9a…11fd, 0xeeee…ffff",
    );
  });

  it("ignores filled / cancelled / replaced updates of orders that rested on the book, still counts late NEW / REJECTED", async () => {
    // Chưa rõ `T` là mốc sự kiện hay mốc tạo lệnh (review PM #521): lệnh nằm sổ 30 s rồi khớp / bị huỷ không được báo.
    await msg({ data: update(30_000, { X: "FILLED", x: "TRADE", z: "0.01", v: "30" }) });
    await msg({ data: update(30_000, { X: "CANCELED", x: "CANCELED" }) });
    await msg({ data: update(30_000, { X: "PARTIALLY_FILLED", x: "PARTIALLY_FILLED" }) });
    // Như ví dụ trong tài liệu SoDEX: lệnh thay giá vẫn NEW nhưng x = REPLACED.
    await msg({ data: update(30_000, { X: "NEW", x: "REPLACED" }) });
    await msg({ data: update(30_000, { X: "EXPIRED" }) });
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual([]);
    // Một tin trộn: item FILLED trễ không tính, item NEW đúng giờ → tin không trễ.
    await msg({ data: [update(30_000, { X: "FILLED" }), update(40, { X: "NEW", x: "NEW" })] });
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual([]);
    // NEW / REJECTED trễ vẫn báo, kể cả khi có x tương ứng.
    await msg({ data: update(21_000, { X: "NEW", x: "NEW" }) });
    await msg({ data: update(20_000, { X: "REJECTED", x: "REJECTED" }) });
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual(["sodex_ws_lag"]);
    const [e] = await queued();
    expect(e?.detail).toBe(
      "2 order updates arrived over 5 s late in the last 5 min (max 21.0 s) · accounts: 0x3e9a…11fd",
    );
  });

  it("stays quiet with one late update, at exactly 5 s, or when the two are more than 5 minutes apart", async () => {
    await msg({ data: update(20_000) });
    await msg({ data: update(5_000) });
    await msg({ data: update(22_000), agoMs: 6 * MIN });
    expect(await checkTeamIncidents(db, memStore(), NOW)).toEqual([]);
  });

  it("skips truncated or broken bodies, items without T, other channels and non-ok rows without failing", async () => {
    await msg({ data: update(20_000), truncated: true });
    await msg({ data: null, body: '{"channel":"accountOrderUpdate","data":[{"E":1' });
    await msg({ data: { ...update(20_000), T: undefined } });
    await msg({ data: { ...update(20_000), T: "abc" } });
    await msg({ data: "not an object" });
    await msg({ data: update(20_000), endpoint: "accountTrade" });
    await msg({ data: update(20_000), outcome: "unreadable" });
    await msg({ data: update(22_000) });
    const warned: string[] = [];
    expect(
      await checkTeamIncidents(db, memStore(), NOW, (_m, d) => warned.push(String(d.check))),
    ).toEqual([]);
    expect(warned).toEqual([]);
  });
});
