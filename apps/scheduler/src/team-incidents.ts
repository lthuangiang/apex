import { outbox, type Db } from "@drift/db";
import {
  engineHealthKey,
  teamIncidentCountKey,
  teamMaskAddress,
  TEAM_INCIDENT_KINDS,
  TEAM_INCIDENT_RULES,
  type EngineHealthSignal,
  type TeamIncidentKind,
  type TeamOpsEvent,
} from "@drift/shared";
import { sql } from "drizzle-orm";

// Sức khoẻ engine / SoDEX cho team (#241, DEC-313). Scheduler kiểm tra mỗi phút, chỉ đọc: bộ đếm
// Redis theo phút do engine ghi (không chờ, không nằm trên đường gửi lệnh) và `sodex_calls` (DEC-309). Đạt ngưỡng thì
// ghi outbox `jobs.team_ops` type `team_incident` mức warning, tối đa một dòng / loại / 31 phút; jobs chặn lặp 1 tin / loại
// / 30 phút và đếm cho tin tổng hợp. Mỗi ngày từ 01:00 UTC một tin tổng hợp 24 giờ. Không bao giờ email, ví đầy đủ, key.

export interface IncidentReadStore {
  /** Giá trị các bộ đếm theo đúng thứ tự (khoá không có = 0). */
  values(keys: readonly string[]): Promise<number[]>;
  /** Đặt khoá nếu chưa có, hết hạn sau `ms`; true = vừa đặt. */
  claim(key: string, ms: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export function redisIncidentReadStore(redis: {
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<string | null>;
  del(key: string): Promise<number>;
}): IncidentReadStore {
  return {
    async values(keys) {
      if (keys.length === 0) return [];
      const vals = await redis.mget(...keys);
      return vals.map((v) => (v === null ? 0 : Number(v) || 0));
    },
    async claim(key, ms) {
      return (await redis.set(key, "1", "PX", ms, "NX")) === "OK";
    },
    async release(key) {
      await redis.del(key);
    },
  };
}

type Incident = Extract<TeamOpsEvent, { type: "team_incident" }>;

const minutesOf = (now: number, windowMs: number): number[] => {
  const minute = Math.floor(now / 60_000);
  return Array.from({ length: Math.round(windowMs / 60_000) }, (_, i) => minute - i);
};

async function counts(
  store: IncidentReadStore,
  signal: EngineHealthSignal,
  now: number,
  windowMs: number,
): Promise<number[]> {
  return store.values(minutesOf(now, windowMs).map((m) => engineHealthKey(signal, m)));
}

const minutes = (ms: number) => String(Math.round(ms / 60_000));

/** Tín hiệu sức khoẻ engine từ bộ đếm theo phút (engine ghi khi log `shard lost` / `tick slow` / reads skipped). */
export async function engineHealthIncidents(
  store: IncidentReadStore,
  now: number,
): Promise<Incident[]> {
  const R = TEAM_INCIDENT_RULES;
  const [lost, slow, skipped] = await Promise.all([
    counts(store, "shard_lost", now, R.shardLostWindowMs),
    counts(store, "tick_slow", now, R.tickSlowWindowMs),
    counts(store, "reads_skipped", now, R.readsSkippedWindowMs),
  ]);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const out: Incident[] = [];
  if (sum(lost) >= R.shardLostMin)
    out.push({
      type: "team_incident",
      kind: "shard_lost",
      detail: `${String(sum(lost))} shard(s) lost in the last ${minutes(R.shardLostWindowMs)} min`,
    });
  if (sum(slow) >= R.tickSlowMin)
    out.push({
      type: "team_incident",
      kind: "tick_slow",
      detail: `${String(sum(slow))} slow ticks in the last ${minutes(R.tickSlowWindowMs)} min`,
    });
  const peak = Math.max(0, ...skipped);
  if (peak >= R.readsSkippedPerMinute)
    out.push({
      type: "team_incident",
      kind: "reads_skipped",
      detail: `up to ${String(peak)} reads/min skipped by the write reserve (${String(sum(skipped))} in ${minutes(R.readsSkippedWindowMs)} min)`,
    });
  return out;
}

const rowsOf = <T>(r: { rows: unknown[] }): T[] => r.rows as T[];

/** Trần thời gian mỗi truy vấn `sodex_calls` (như SoDEX Debugger, DEC-309): truy vấn chậm bị huỷ, không giữ kết nối. */
export const SODEX_QUERY_TIMEOUT_MS = 5_000;
/** WS close quét 1 giờ dữ liệu: chỉ chạy mỗi 5 phút. */
export const WS_CLOSES_EVERY_MS = 5 * 60_000;

/** Một truy vấn đọc trong transaction chỉ đọc có `SET LOCAL statement_timeout` (hợp lệ qua PgBouncer). */
function readOnly<T>(db: Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${String(SODEX_QUERY_TIMEOUT_MS)}`));
    return rowsOf<T>(await tx.execute(q));
  });
}

/** Tỷ lệ lời gọi REST tới SoDEX bị timeout / network / unreadable / HTTP 5xx (từ `sodex_calls`). */
export async function sodexErrorIncident(db: Db, now: number): Promise<Incident | null> {
  const R = TEAM_INCIDENT_RULES;
  const since = new Date(now - R.sodexWindowMs);
  const r = await readOnly<{ endpoint: string; calls: number; problems: number }>(
    db,
    sql`
      select endpoint, count(*)::int as calls,
             count(*) filter (where outcome in ('timeout', 'network', 'unreadable')
                              or coalesce(http_status, 0) >= 500)::int as problems
        from sodex_calls
        where at >= ${since} and kind = 'rest'
        group by endpoint`,
  );
  const calls = r.reduce((n, x) => n + x.calls, 0);
  const problems = r.reduce((n, x) => n + x.problems, 0);
  if (calls < R.sodexMinCalls || problems * 100 < R.sodexMinPct * calls) return null;
  const top = [...r].sort((a, b) => b.problems - a.problems)[0];
  const pct = Math.round((problems * 100) / calls);
  return {
    type: "team_incident",
    kind: "sodex_errors",
    detail:
      `${String(problems)} of ${String(calls)} REST calls failed in ${minutes(R.sodexWindowMs)} min (${String(pct)}%)${top === undefined || top.problems === 0 ? "" : ` · most: ${top.endpoint}`}`.slice(
        0,
        200,
      ),
  };
}

/** WS user stream đóng quá nhiều lần / giờ ở một account (từ `sodex_calls`, sự kiện CLOSE). Account chỉ ở dạng che. */
export async function wsClosesIncident(db: Db, now: number): Promise<Incident | null> {
  const R = TEAM_INCIDENT_RULES;
  const r = await readOnly<{ address: string; closes: number }>(
    db,
    sql`
      select account_address as address, count(*)::int as closes
        from sodex_calls
        where at >= ${new Date(now - R.wsClosesWindowMs)} and kind = 'ws' and method = 'CLOSE'
          and account_address is not null
        group by account_address
        having count(*) > ${R.wsClosesPerHour}
        order by count(*) desc
        limit 3`,
  );
  if (r.length === 0) return null;
  return {
    type: "team_incident",
    kind: "ws_closes",
    detail: `user stream closed ${r
      .map((x) => `${String(x.closes)}× on ${teamMaskAddress(x.address)}`)
      .join(", ")} in the last hour (limit ${String(R.wsClosesPerHour)})`.slice(0, 200),
  };
}

/**
 * Luồng lệnh WS của SoDEX trễ (#518, DEC-386): trong `wsLagWindowMs` có ≥ `wsLagMin` tin `accountOrderUpdate` mà E − T
 * > `wsLagMs`. E (event time) và T (block time) đều do SoDEX gắn vào tin (packages/sodex/src/ws/schemas.ts), nên lệch
 * giờ máy ta không ảnh hưởng. Đọc `response_body` của dòng WS trong `sodex_calls`: chỉ có dữ liệu khi recorder ghi dòng
 * WS `ok` (SoDEX Debugger bật, hàng đợi không đầy). Body bị cắt / không phải JSON, item thiếu `T` bị bỏ, không làm truy
 * vấn lỗi. Đếm theo tin (mỗi dòng), lấy E − T lớn nhất trong các item của tin. Account chỉ ở dạng che, tối đa 3.
 */
export async function wsLagIncident(db: Db, now: number): Promise<Incident | null> {
  const R = TEAM_INCIDENT_RULES;
  const r = await readOnly<{ address: string | null; late: number; max_ms: string }>(
    db,
    sql`
      with msgs as (
        select c.account_address as address,
               (select max((it->>'E')::bigint - (it->>'T')::bigint)
                  from jsonb_array_elements(
                         case jsonb_typeof(b.body->'data')
                           when 'array' then b.body->'data'
                           when 'object' then jsonb_build_array(b.body->'data')
                           else '[]'::jsonb
                         end) as it
                 where jsonb_typeof(it) = 'object'
                   and (it->>'E') ~ '^[0-9]{1,15}$'
                   and (it->>'T') ~ '^[0-9]{1,15}$') as lag_ms
          from sodex_calls c
          cross join lateral (
            select case when pg_input_is_valid(c.response_body, 'jsonb') then c.response_body::jsonb end as body
          ) b
          where c.at >= ${new Date(now - R.wsLagWindowMs)} and c.at <= ${new Date(now)}
            and c.kind = 'ws' and c.method = 'MSG' and c.endpoint = 'accountOrderUpdate'
            and c.outcome = 'ok' and not c.response_truncated and c.response_body is not null
      )
      select address, count(*)::int as late, max(lag_ms)::text as max_ms
        from msgs
        where lag_ms > ${R.wsLagMs}
        group by address
        order by count(*) desc, max(lag_ms) desc`,
  );
  const late = r.reduce((n, x) => n + x.late, 0);
  if (late < R.wsLagMin) return null;
  const maxMs = Math.max(...r.map((x) => Number(x.max_ms)));
  const accounts = r
    .filter((x): x is typeof x & { address: string } => x.address !== null)
    .slice(0, 3)
    .map((x) => teamMaskAddress(x.address));
  return {
    type: "team_incident",
    kind: "sodex_ws_lag",
    detail:
      `${String(late)} order updates arrived over ${String(R.wsLagMs / 1000)} s late in the last ${minutes(R.wsLagWindowMs)} min (max ${(maxMs / 1000).toFixed(1)} s)${accounts.length === 0 ? "" : ` · accounts: ${accounts.join(", ")}`}`.slice(
        0,
        200,
      ),
  };
}

/** Tin tổng hợp ngày: một lần mỗi ngày từ 01:00 UTC (08:00 giờ Việt Nam), đếm 24 giờ qua theo loại. */
export async function digestIncident(
  store: IncidentReadStore,
  now: number,
): Promise<{
  claim: string;
  event: Extract<TeamOpsEvent, { type: "team_incident_digest" }>;
} | null> {
  const d = new Date(now);
  if (d.getUTCHours() < TEAM_INCIDENT_RULES.digestHourUtc) return null;
  const claim = `team:incident_digest:${d.toISOString().slice(0, 10)}`;
  if (!(await store.claim(claim, TEAM_INCIDENT_RULES.digestClaimMs))) return null;
  const hour = Math.floor(now / 3_600_000);
  const hours = Array.from({ length: 24 }, (_, i) => hour - 1 - i);
  const keys = TEAM_INCIDENT_KINDS.flatMap((k) => hours.map((h) => teamIncidentCountKey(h, k)));
  let vals: number[];
  try {
    vals = await store.values(keys);
  } catch (error) {
    await store.release(claim).catch(() => undefined);
    throw error;
  }
  const result: Partial<Record<TeamIncidentKind, number>> = {};
  TEAM_INCIDENT_KINDS.forEach((k, i) => {
    const n = vals.slice(i * 24, (i + 1) * 24).reduce((a, b) => a + b, 0);
    if (n > 0) result[k] = n;
  });
  return { claim, event: { type: "team_incident_digest", counts: result } };
}

/**
 * Một lượt kiểm tra: ghi outbox cho mọi tín hiệu đạt ngưỡng (jobs chặn lặp), và tin tổng hợp khi tới giờ. Mỗi nguồn lỗi
 * riêng (Redis / DB) không chặn các nguồn khác. Trả các loại đã ghi (để log / test).
 */
export async function checkTeamIncidents(
  db: Db,
  store: IncidentReadStore,
  now: number,
  warn: (msg: string, data: Record<string, unknown>) => void = () => undefined,
  opts: { ws?: boolean } = {},
): Promise<string[]> {
  const safe = async <T>(name: string, f: () => Promise<T>, empty: T): Promise<T> => {
    try {
      return await f();
    } catch (error) {
      warn("team incident check failed", { check: name, err: String(error) });
      return empty;
    }
  };
  const [health, sodex, ws, lag] = await Promise.all([
    safe("engine_health", () => engineHealthIncidents(store, now), [] as Incident[]),
    safe("sodex_errors", () => sodexErrorIncident(db, now), null),
    opts.ws === false ? null : safe("ws_closes", () => wsClosesIncident(db, now), null),
    safe("sodex_ws_lag", () => wsLagIncident(db, now), null),
  ]);
  const found = [
    ...health,
    ...(sodex === null ? [] : [sodex]),
    ...(ws === null ? [] : [ws]),
    ...(lag === null ? [] : [lag]),
  ];
  const sent: string[] = [];
  for (const e of found) {
    // Điều kiện còn đúng thì không ghi lại mỗi phút: một dòng / loại / (30 phút + 1 phút). Thêm 1 phút để khoá chặn lặp
    // của jobs (đặt sau khoá này) luôn hết hạn trước lần ghi sau. Tin tổng hợp vì thế đếm số lần báo, không số phút.
    const key = `team:incident_raise:${e.kind}`;
    if (!(await store.claim(key, TEAM_INCIDENT_RULES.typeThrottleMs + 60_000))) continue;
    try {
      await db.insert(outbox).values({ topic: "jobs.team_ops", payload: e });
    } catch (error) {
      await store.release(key).catch(() => undefined);
      throw error;
    }
    sent.push(e.kind);
  }
  const digest = await safe("digest", () => digestIncident(store, now), null);
  if (digest !== null) {
    try {
      await db.insert(outbox).values({ topic: "jobs.team_ops", payload: digest.event });
      sent.push("digest");
    } catch (error) {
      await store.release(digest.claim).catch(() => undefined);
      throw error;
    }
  }
  return sent;
}

/**
 * Vòng chạy của scheduler: không bao giờ chạy chồng (lượt trước chưa xong thì bỏ lượt này, trả null); kiểm tra WS close
 * mỗi WS_CLOSES_EVERY_MS.
 */
export function teamIncidentRunner(
  db: Db,
  store: IncidentReadStore,
  warn: (msg: string, data: Record<string, unknown>) => void = () => undefined,
): (now: number) => Promise<string[] | null> {
  let running = false;
  let lastWs = Number.NEGATIVE_INFINITY;
  return async (now) => {
    if (running) return null;
    running = true;
    try {
      const ws = now - lastWs >= WS_CLOSES_EVERY_MS;
      if (ws) lastWs = now;
      return await checkTeamIncidents(db, store, now, warn, { ws });
    } finally {
      running = false;
    }
  };
}
