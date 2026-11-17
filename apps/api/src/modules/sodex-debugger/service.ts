import type { Db } from "@drift/db";
import {
  AppError,
  ErrorCode,
  SODEX_CALL_COUNT_CAP,
  SODEX_CALL_RANGE_MS,
  SODEX_CALL_SLOW_MS,
  sodexCallFacetsQuerySchema,
  sodexCallsQuerySchema,
  type SodexCallDetail,
  type SodexCallFacets,
  type SodexCallItem,
  type SodexCallsPage,
  type SodexCallsQuery,
  type SodexCallShow,
  type SodexCallSummary,
  type SodexEndpointStat,
  type SodexHeader,
} from "@drift/shared";
import { uuidV7Time } from "@drift/sodex";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { parseOrThrow } from "../../lib/http";
import { requireTeam } from "../account/team";

// SoDEX Debugger (team, docs/mockups/sodex-debugger, DEC-309). Đọc view `sodex_calls` (hai hypertable
// theo thời hạn giữ). Mọi endpoint kiểm role team TRƯỚC khi parse tham số (401 chưa đăng nhập, 403 người ngoài team).

export interface SodexDebuggerDeps {
  db: Db;
  now: () => Date;
  builderId: bigint | null;
}

const FORBIDDEN = "SoDEX Debugger is for the DeskLabs team only.";
/** Mọi truy vấn của trang chạy trong một transaction có statement timeout (review PR #217 M4). */
const QUERY_TIMEOUT_MS = 5_000;

type Exec = Pick<Db, "execute">;

const SUMMARY_CACHE_MS = 30_000;
const summaryCache = new WeakMap<Db, { at: number; value: SodexCallSummary }>();

/** Chạy `fn` trong một transaction chỉ đọc có `SET LOCAL statement_timeout` (hợp lệ qua PgBouncer). */
function readOnly<T>(db: Db, fn: (q: Exec) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION READ ONLY`);
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${String(QUERY_TIMEOUT_MS)}`));
    return fn(tx);
  });
}
const HOUR = 3_600_000;
const RELATED_WINDOW_MS = 10 * 60_000;
/** Ngưỡng "cao hơn mức thường": ≥ 3 lần và > 2 × mức của 48 giờ trước đó (DEC-309). */
const ABOVE_USUAL_MIN = 3;
const ABOVE_USUAL_FACTOR = 2;
/** Endpoint đặt lệnh mới (cho câu "X is N% of the rejects on new orders"). */
const NEW_ORDER_ENDPOINTS = ["/perps/trade/orders", "/spot/trade/orders/batch"];

interface ItemRow extends Record<string, unknown> {
  id: string;
  /** Epoch ms (db.execute trả timestamptz dạng chuỗi; đọc số cho chắc). */
  at: number;
  service: string;
  kind: "rest" | "ws";
  method: string;
  endpoint: string;
  http_status: number | null;
  outcome: SodexCallItem["outcome"];
  sodex_code: number | null;
  sodex_error: string | null;
  error_detail: string | null;
  latency_ms: number;
  bot_id: string | null;
  bot_name: string | null;
  account_address: string | null;
  cl_ord_ids: string[];
  conn_id: string | null;
}

const ITEM_COLUMNS = sql`c.id, (extract(epoch from c.at) * 1000)::float8 AS at, c.service, c.kind, c.method, c.endpoint, c.http_status, c.outcome, c.sodex_code,
  c.sodex_error, c.error_detail, c.latency_ms, c.bot_id, b.name AS bot_name, c.account_address, c.cl_ord_ids, c.conn_id`;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function toItem(r: ItemRow): SodexCallItem {
  const address = r.account_address;
  return {
    id: r.id,
    at: new Date(r.at).toISOString(),
    service: r.service,
    kind: r.kind,
    method: r.method,
    endpoint: r.endpoint,
    httpStatus: r.http_status,
    outcome: r.outcome,
    sodexCode: r.sodex_code,
    sodexSays: r.sodex_error ?? r.error_detail,
    latencyMs: r.latency_ms,
    bot: r.bot_id === null ? null : { id: r.bot_id, name: r.bot_name ?? "" },
    accountAddress: address !== null && ADDRESS.test(address) ? address : null,
    clOrdIds: r.cl_ord_ids,
    connId: r.conn_id,
  };
}

const cursorSchema = z.object({ at: z.iso.datetime(), id: z.uuid() });

function encodeCursor(r: ItemRow): string {
  return Buffer.from(JSON.stringify({ at: new Date(r.at).toISOString(), id: r.id })).toString(
    "base64url",
  );
}

function decodeCursor(cursor: string): { at: string; id: string } {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new AppError(ErrorCode.validationFailed, "Invalid input.", {
      fieldErrors: { cursor: ["invalid"] },
    });
  }
}

/** Điều kiện lọc chung (trừ nút Outcome và cursor). */
function baseFilters(q: SodexCallsQuery, now: Date): SQL[] {
  const from = new Date(now.getTime() - SODEX_CALL_RANGE_MS[q.range]);
  const where: SQL[] = [sql`c.at >= ${from.toISOString()}::timestamptz`];
  if (q.after !== undefined) where.push(sql`c.at >= ${q.after}::timestamptz`);
  if (q.before !== undefined) where.push(sql`c.at < ${q.before}::timestamptz`);
  if (q.service !== undefined) where.push(sql`c.service = ${q.service}`);
  if (q.endpoint !== undefined) where.push(sql`c.endpoint = ${q.endpoint}`);
  if (q.botId !== undefined) where.push(sql`c.bot_id = ${q.botId}::uuid`);
  if (q.account !== undefined) where.push(sql`c.account_address = ${q.account.toLowerCase()}`);
  if (q.q !== undefined) {
    where.push(sql`(c.trace_id = ${q.q} OR c.conn_id = ${q.q}
      OR c.cl_ord_ids @> ARRAY[${q.q}]::text[] OR c.order_ids @> ARRAY[${q.q}]::text[])`);
  }
  return where;
}

function showFilter(q: SodexCallsQuery): SQL | null {
  switch (q.show) {
    case "all":
      return null;
    case "errors":
      return sql`c.outcome <> 'ok'`;
    case "timeouts":
      return sql`c.outcome = 'timeout'`;
    case "slow":
      return sql`c.latency_ms > ${q.slowMs}`;
  }
}

const and = (parts: SQL[]) => sql.join(parts, sql` AND `);

/**
 * Bảng cần đọc: Errors / Timeouts / Slow (ngưỡng ≥ 1000 ms) chỉ có ở `sodex_calls_problem`, nên không quét bảng ok
 * (review PR #217 M4). Ngưỡng chậm thấp hơn 1000 ms thì cần cả hai bảng.
 */
function tableFor(show: SodexCallShow, slowMs: number): SQL {
  const problemOnly =
    show === "errors" || show === "timeouts" || (show === "slow" && slowMs >= SODEX_CALL_SLOW_MS);
  return problemOnly ? sql.raw("sodex_calls_problem") : sql.raw("sodex_calls");
}

export async function listSodexCalls(
  deps: SodexDebuggerDeps,
  userId: string,
  query: unknown,
): Promise<SodexCallsPage> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  const f = parseOrThrow(sodexCallsQuerySchema, query);
  return readOnly(deps.db, async (q) => {
    const now = deps.now();
    const base = baseFilters(f, now);
    const where = [...base];
    const show = showFilter(f);
    if (show !== null) where.push(show);
    if (f.cursor !== undefined) {
      const c = decodeCursor(f.cursor);
      where.push(sql`(c.at, c.id) < (${c.at}::timestamptz, ${c.id}::uuid)`);
    }
    const rows = await q.execute<ItemRow>(sql`
      SELECT ${ITEM_COLUMNS}
      FROM ${tableFor(f.show, f.slowMs)} c LEFT JOIN bots b ON b.id = c.bot_id
      WHERE ${and(where)}
      ORDER BY c.at DESC, c.id DESC
      LIMIT ${f.limit + 1}`);
    // Đếm chỉ ở trang đầu, mỗi nút đếm tối đa CAP + 1 dòng trên đúng bảng (lỗi / timeout / chậm chỉ ở bảng problem).
    const count = async (show: SodexCallShow) => {
      const extra = showFilter({ ...f, show });
      const res = await q.execute<{ n: string }>(sql`
        SELECT count(*) AS n FROM (
          SELECT 1 FROM ${tableFor(show, f.slowMs)} c
          WHERE ${and(extra === null ? base : [...base, extra])}
          LIMIT ${SODEX_CALL_COUNT_CAP + 1}
        ) x`);
      return Number(res.rows[0]?.n ?? 0);
    };
    const counts =
      f.cursor === undefined
        ? {
            all: await count("all"),
            errors: await count("errors"),
            timeouts: await count("timeouts"),
            slow: await count("slow"),
          }
        : null;
    const page = rows.rows.slice(0, f.limit);
    const last = page.at(-1);
    return {
      items: page.map(toItem),
      nextCursor: rows.rows.length > f.limit && last !== undefined ? encodeCursor(last) : null,
      counts,
      readAt: now.toISOString(),
    };
  });
}

interface DetailRow extends ItemRow {
  url: string | null;
  engine: "spot" | "perps" | null;
  action_type: string | null;
  request_headers: unknown;
  request_body: string | null;
  request_body_bytes: number | null;
  signed: boolean;
  response_headers: unknown;
  response_body: string | null;
  response_body_bytes: number | null;
  response_truncated: boolean;
  envelope_code: number | null;
  order_codes: number[];
  unreadable_reason: SodexCallDetail["unreadableReason"];
  trace_id: string | null;
  sodex_account_id: string | null;
  order_ids: string[];
  account_id: string | null;
  bot_strategy: string | null;
  bot_market: string | null;
}

const headerListSchema = z.array(
  z.object({
    name: z.string(),
    value: z.string().nullable(),
    redaction: z.enum(["none", "signature", "masked"]),
  }),
);
const responseHeaderListSchema = z.array(z.object({ name: z.string(), value: z.string() }));

export async function sodexCallDetail(
  deps: SodexDebuggerDeps,
  userId: string,
  id: string,
): Promise<SodexCallDetail> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  const callId = parseOrThrow(z.uuid(), id);
  return readOnly(deps.db, async (q) => {
    // UUID v7 mang thời điểm gọi: chỉ tìm trong ±1 s quanh đó để Timescale chỉ đọc đúng chunk.
    const t = uuidV7Time(callId);
    // Không phải UUID v7 (id do recorder sinh luôn là v7): chắc chắn không có.
    if (callId[14] !== "7" || !Number.isFinite(new Date(t).getTime())) {
      throw new AppError(ErrorCode.notFound, "Call not found.");
    }
    const res = await q.execute<DetailRow>(sql`
      SELECT ${ITEM_COLUMNS}, c.url, c.engine, c.action_type, c.request_headers, c.request_body, c.request_body_bytes,
        c.signed, c.response_headers, c.response_body, c.response_body_bytes, c.response_truncated, c.envelope_code,
        c.order_codes, c.unreadable_reason, c.trace_id, c.sodex_account_id, c.order_ids, c.account_id,
        b.strategy AS bot_strategy, b.market AS bot_market
      FROM sodex_calls c LEFT JOIN bots b ON b.id = c.bot_id
      WHERE c.id = ${callId}::uuid
        AND c.at BETWEEN ${new Date(t - 1000).toISOString()}::timestamptz AND ${new Date(t + 1000).toISOString()}::timestamptz
      LIMIT 1`);
    const r = res.rows[0];
    if (r === undefined) throw new AppError(ErrorCode.notFound, "Call not found.");

    const at = r.at;
    const lo = new Date(at - RELATED_WINDOW_MS).toISOString();
    const hi = new Date(at + RELATED_WINDOW_MS).toISOString();
    const links: SQL[] = [];
    if (r.trace_id !== null) links.push(sql`c.trace_id = ${r.trace_id}`);
    if (r.cl_ord_ids.length > 0)
      links.push(sql`c.cl_ord_ids && ${sql.param(r.cl_ord_ids)}::text[]`);

    const [related, owner, conn] = await Promise.all([
      links.length === 0
        ? Promise.resolve({ rows: [] as ItemRow[] })
        : q.execute<ItemRow>(sql`
            SELECT ${ITEM_COLUMNS} FROM sodex_calls c LEFT JOIN bots b ON b.id = c.bot_id
            WHERE c.at BETWEEN ${lo}::timestamptz AND ${hi}::timestamptz AND c.id <> ${callId}::uuid
              AND (${sql.join(links, sql` OR `)})
            ORDER BY c.at ASC LIMIT 10`),
      r.account_id === null && r.account_address === null
        ? Promise.resolve({ rows: [] as { user_id: string }[] })
        : q.execute<{ user_id: string }>(sql`
            SELECT user_id FROM sodex_accounts
            WHERE ${r.account_id === null ? sql`lower(address) = ${r.account_address}` : sql`id = ${r.account_id}::uuid`}
            LIMIT 1`),
      wsConnection(q, r),
    ]);

    const requestHeaders: SodexHeader[] = headerListSchema.safeParse(r.request_headers).data ?? [];
    return {
      ...toItem(r),
      url: r.url,
      engine: r.engine,
      actionType: r.action_type,
      requestHeaders,
      requestBody: r.request_body,
      requestBodyBytes: r.request_body_bytes,
      signed: r.signed,
      responseHeaders: responseHeaderListSchema.safeParse(r.response_headers).data ?? [],
      responseBody: r.response_body,
      responseBodyBytes: r.response_body_bytes,
      responseTruncated: r.response_truncated,
      envelopeCode: r.envelope_code,
      orderCodes: r.order_codes,
      unreadableReason: r.unreadable_reason,
      traceId: r.trace_id,
      sodexAccountId: r.sodex_account_id,
      orderIds: r.order_ids,
      botDetail:
        r.bot_id === null
          ? null
          : {
              id: r.bot_id,
              name: r.bot_name ?? "",
              strategy: r.bot_strategy ?? "",
              market: r.bot_market ?? "",
            },
      accountUserId: owner.rows[0]?.user_id ?? null,
      wsConn: conn,
      related: related.rows.map(toItem),
      builderId: deps.builderId === null ? null : deps.builderId.toString(),
    };
  });
}

/** WS: kết nối của chính sự kiện. REST: kết nối user stream gần nhất của cùng account + engine mở trước lời gọi. */
async function wsConnection(
  db: Exec,
  r: DetailRow,
): Promise<{ connId: string; open: boolean } | null> {
  if (r.kind === "ws") return r.conn_id === null ? null : { connId: r.conn_id, open: true };
  if (r.account_address === null || r.engine === null) return null;
  const at = new Date(r.at).toISOString();
  const since = new Date(r.at - 24 * HOUR).toISOString();
  const opened = await db.execute<{ conn_id: string }>(sql`
    SELECT c.conn_id FROM sodex_calls c
    WHERE c.kind = 'ws' AND c.method = 'OPEN' AND c.account_address = ${r.account_address}
      AND c.engine = ${r.engine} AND c.at BETWEEN ${since}::timestamptz AND ${at}::timestamptz
    ORDER BY c.at DESC LIMIT 1`);
  const connId = opened.rows[0]?.conn_id;
  if (connId === undefined) return null;
  const closed = await db.execute<{ n: string }>(sql`
    SELECT count(*) AS n FROM sodex_calls c
    WHERE c.conn_id = ${connId} AND c.method IN ('CLOSE', 'ERROR')
      AND c.at BETWEEN ${since}::timestamptz AND ${at}::timestamptz`);
  return { connId, open: Number(closed.rows[0]?.n ?? 0) === 0 };
}

interface EndpointAgg extends Record<string, unknown> {
  kind: string;
  method: string;
  endpoint: string;
  calls: string;
  errors: string;
  timeouts: string;
  p95: number | null;
}

/** Tên hiển thị của method: REST giữ nguyên, WS thêm tiền tố "WS". */
const methodLabel = (kind: string, method: string) => (kind === "ws" ? `WS ${method}` : method);

function aboveUsual(now: number, nowCalls: number, prev: number, prevCalls: number): boolean {
  if (prevCalls === 0 || now < ABOVE_USUAL_MIN) return false;
  // Cùng số lời gọi: so tỷ lệ; prev là 48 giờ nên quy về tỷ lệ trên mỗi lời gọi.
  return now / Math.max(nowCalls, 1) > (ABOVE_USUAL_FACTOR * prev) / prevCalls;
}

export async function sodexCallSummary(
  deps: SodexDebuggerDeps,
  userId: string,
): Promise<SodexCallSummary> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  // Tóm tắt quét 24 giờ + 48 giờ trước: giữ 30 giây trong process, nhiều người xem / refetch không quét lại.
  const cached = summaryCache.get(deps.db);
  if (cached !== undefined && deps.now().getTime() - cached.at < SUMMARY_CACHE_MS)
    return cached.value;
  const value = await readOnly(deps.db, async (q) => {
    const now = deps.now();
    const hourStart = Math.floor(now.getTime() / HOUR) * HOUR;
    const fromMs = hourStart - 23 * HOUR;
    const from = new Date(fromMs).toISOString();
    const to = now.toISOString();
    const prevFrom = new Date(fromMs - 48 * HOUR).toISOString();

    const [current, previous, hours, rejects] = await Promise.all([
      q.execute<EndpointAgg>(sql`
        SELECT c.kind, c.method, c.endpoint, count(*) AS calls,
          count(*) FILTER (WHERE c.outcome <> 'ok') AS errors,
          count(*) FILTER (WHERE c.outcome = 'timeout') AS timeouts,
          round(percentile_cont(0.95) WITHIN GROUP (ORDER BY c.latency_ms))::int AS p95
        FROM sodex_calls c WHERE c.at >= ${from}::timestamptz AND c.at <= ${to}::timestamptz
        GROUP BY GROUPING SETS ((c.kind, c.method, c.endpoint), ())`),
      q.execute<EndpointAgg>(sql`
        SELECT c.kind, c.method, c.endpoint, count(*) AS calls,
          count(*) FILTER (WHERE c.outcome <> 'ok') AS errors,
          count(*) FILTER (WHERE c.outcome = 'timeout') AS timeouts, NULL::int AS p95
        FROM sodex_calls c WHERE c.at >= ${prevFrom}::timestamptz AND c.at < ${from}::timestamptz
        GROUP BY GROUPING SETS ((c.kind, c.method, c.endpoint), ())`),
      q.execute<{
        hour: number;
        n: string;
        first_at: number;
        last_at: number;
        endpoints: string[];
      }>(sql`
        SELECT (extract(epoch from h.hour) * 1000)::float8 AS hour, h.n,
          (extract(epoch from h.first_at) * 1000)::float8 AS first_at,
          (extract(epoch from h.last_at) * 1000)::float8 AS last_at,
          ARRAY(
            SELECT CASE WHEN x.kind = 'ws' THEN 'WS ' ELSE '' END || x.method || ' ' || x.endpoint
            FROM sodex_calls x
            WHERE x.outcome = 'timeout' AND x.at >= h.hour AND x.at < h.hour + interval '1 hour'
            GROUP BY x.kind, x.method, x.endpoint ORDER BY count(*) DESC LIMIT 2
          ) AS endpoints
        FROM (
          SELECT date_trunc('hour', c.at) AS hour, count(*) AS n, min(c.at) AS first_at, max(c.at) AS last_at
          FROM sodex_calls c
          WHERE c.outcome = 'timeout' AND c.at >= ${from}::timestamptz AND c.at <= ${to}::timestamptz
          GROUP BY 1
        ) h`),
      q.execute<{ reason: string | null; n: string; total: string }>(sql`
        SELECT c.sodex_error AS reason, count(*) AS n, sum(count(*)) OVER () AS total
        FROM sodex_calls c
        WHERE c.outcome = 'rejected' AND c.method = 'POST' AND c.endpoint IN (${sql.join(
          NEW_ORDER_ENDPOINTS.map((e) => sql`${e}`),
          sql`, `,
        )})
          AND c.at >= ${from}::timestamptz AND c.at <= ${to}::timestamptz
        GROUP BY c.sodex_error ORDER BY count(*) DESC LIMIT 1`),
    ]);

    const key = (r: EndpointAgg) => `${r.kind} ${r.method} ${r.endpoint}`;
    // Hàng tổng của GROUPING SETS có kind / method / endpoint NULL.
    const isTotal = (r: EndpointAgg) => (r.endpoint as string | null) === null;
    const prevByKey = new Map(previous.rows.filter((r) => !isTotal(r)).map((r) => [key(r), r]));
    const prevTotal = previous.rows.find(isTotal);
    const total = current.rows.find(isTotal);

    const endpoints: SodexEndpointStat[] = current.rows
      .filter((r) => !isTotal(r))
      .map((r) => {
        const p = prevByKey.get(key(r));
        const calls = Number(r.calls);
        const errors = Number(r.errors);
        const timeouts = Number(r.timeouts);
        const prevCalls = Number(prevTotal?.calls ?? 0) === 0 ? 0 : Number(p?.calls ?? 0);
        return {
          endpoint: r.endpoint,
          method: methodLabel(r.kind, r.method),
          calls,
          errors,
          timeouts,
          p95Ms: r.p95,
          errorsAboveUsual: aboveUsual(errors, calls, Number(p?.errors ?? 0), prevCalls),
          timeoutsAboveUsual: aboveUsual(timeouts, calls, Number(p?.timeouts ?? 0), prevCalls),
        };
      })
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 8);

    const byHour = new Map(hours.rows.map((h) => [h.hour, h]));
    const timeoutsPerHour = Array.from({ length: 24 }, (_, i) => {
      const hour = fromMs + i * HOUR;
      return { hour: new Date(hour).toISOString(), count: Number(byHour.get(hour)?.n ?? 0) };
    });
    const peakRow = [...hours.rows].sort((a, b) => Number(b.n) - Number(a.n))[0];
    const calls = Number(total?.calls ?? 0);
    const errors = Number(total?.errors ?? 0);
    const timeouts = Number(total?.timeouts ?? 0);
    const prevCalls = Number(prevTotal?.calls ?? 0);
    const reject = rejects.rows[0];

    return {
      from: new Date(fromMs).toISOString(),
      to,
      calls,
      errors,
      timeouts,
      errorsAboveUsual: aboveUsual(errors, calls, Number(prevTotal?.errors ?? 0), prevCalls),
      timeoutsAboveUsual: aboveUsual(timeouts, calls, Number(prevTotal?.timeouts ?? 0), prevCalls),
      p95Ms: calls === 0 ? null : (total?.p95 ?? null),
      timeoutsPerHour,
      peak:
        peakRow === undefined
          ? null
          : {
              hour: new Date(peakRow.hour).toISOString(),
              count: Number(peakRow.n),
              firstAt: new Date(peakRow.first_at).toISOString(),
              lastAt: new Date(peakRow.last_at).toISOString(),
              endpoints: peakRow.endpoints,
            },
      endpoints,
      topReject:
        reject === undefined || reject.reason === null || Number(reject.total) === 0
          ? null
          : { reason: reject.reason, share: Number(reject.n) / Number(reject.total) },
      readAt: now.toISOString(),
    };
  });
  summaryCache.set(deps.db, { at: deps.now().getTime(), value });
  return value;
}

export async function sodexCallFacets(
  deps: SodexDebuggerDeps,
  userId: string,
  query: unknown,
): Promise<SodexCallFacets> {
  await requireTeam(deps.db, userId, FORBIDDEN);
  const f = parseOrThrow(sodexCallFacetsQuerySchema, query);
  return readOnly(deps.db, async (q) => {
    const from = new Date(deps.now().getTime() - SODEX_CALL_RANGE_MS[f.range]).toISOString();
    const [services, endpoints, bots, accounts] = await Promise.all([
      q.execute<{ v: string }>(
        sql`SELECT DISTINCT c.service AS v FROM sodex_calls c WHERE c.at >= ${from}::timestamptz ORDER BY 1 LIMIT 50`,
      ),
      q.execute<{ v: string }>(
        sql`SELECT DISTINCT c.endpoint AS v FROM sodex_calls c WHERE c.at >= ${from}::timestamptz ORDER BY 1 LIMIT 200`,
      ),
      q.execute<{ id: string; name: string }>(sql`
        SELECT b.id, b.name FROM bots b
        WHERE b.id IN (SELECT DISTINCT c.bot_id FROM sodex_calls c WHERE c.at >= ${from}::timestamptz AND c.bot_id IS NOT NULL)
        ORDER BY b.name LIMIT 500`),
      q.execute<{ v: string }>(sql`
        SELECT DISTINCT c.account_address AS v FROM sodex_calls c
        WHERE c.at >= ${from}::timestamptz AND c.account_address IS NOT NULL ORDER BY 1 LIMIT 500`),
    ]);
    return {
      services: services.rows.map((r) => r.v),
      endpoints: endpoints.rows.map((r) => r.v),
      bots: bots.rows,
      accounts: accounts.rows.map((r) => r.v).filter((a) => ADDRESS.test(a)),
    };
  });
}
