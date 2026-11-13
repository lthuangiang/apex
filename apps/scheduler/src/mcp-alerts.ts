import { mcpCalls, outbox, type Db } from "@drift/db";
import {
  MCP_LIMIT_TOOL,
  MCP_MONITORING,
  mcpIntrospectFailKey,
  type TeamOpsEvent,
} from "@drift/shared";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

// Theo dõi MCP (docs/MCP.md mục 6, DEC-225): mỗi phút xét 3 điều kiện, đạt thì ghi outbox `jobs.team_ops`
// (jobs gửi Telegram cho team như DEC-184). Mỗi loại tối đa 1 tin / 30 phút (khoá Redis NX). Lỗi tool và giới hạn ngày
// đọc từ `mcp_calls`; lỗi introspect đọc bộ đếm Redis theo phút của apps/mcp (khi introspect lỗi thì api có thể đang
// lỗi, nên không ghi được `mcp_calls`). Tin không bao giờ chứa token id hay client id.

export interface AlertStore {
  /** Tổng các bộ đếm (khoá không có = 0). */
  sum(keys: readonly string[]): Promise<number>;
  /** Đặt khoá nếu chưa có, hết hạn sau `ms`; true = vừa đặt (được gửi). */
  claim(key: string, ms: number): Promise<boolean>;
}

export function redisAlertStore(redis: {
  mget(...keys: string[]): Promise<(string | null)[]>;
  set(key: string, value: string, px: "PX", ms: number, nx: "NX"): Promise<string | null>;
}): AlertStore {
  return {
    async sum(keys) {
      if (keys.length === 0) return 0;
      const vals = await redis.mget(...keys);
      return vals.reduce((n, v) => n + (v === null ? 0 : Number(v) || 0), 0);
    },
    async claim(key, ms) {
      return (await redis.set(key, "1", "PX", ms, "NX")) === "OK";
    },
  };
}

type Kind = "team_mcp_tool_errors" | "team_mcp_introspect_failing" | "team_mcp_daily_limit";

async function toolErrors(db: Db, now: number): Promise<TeamOpsEvent | null> {
  const rows = await db
    .select({
      tool: mcpCalls.tool,
      calls: sql<number>`count(*)::int`,
      errors: sql<number>`count(*) filter (where ${mcpCalls.status} = 'error')::int`,
    })
    .from(mcpCalls)
    .where(
      and(
        gte(mcpCalls.createdAt, new Date(now - MCP_MONITORING.errorWindowMs)),
        inArray(mcpCalls.status, ["ok", "error"]),
      ),
    )
    .groupBy(mcpCalls.tool);
  const calls = rows.reduce((n, r) => n + r.calls, 0);
  const errors = rows.reduce((n, r) => n + r.errors, 0);
  if (calls < MCP_MONITORING.errorMinCalls || errors * 100 < MCP_MONITORING.errorMinPct * calls)
    return null;
  const top = [...rows].sort((a, b) => b.errors - a.errors)[0];
  return {
    type: "team_mcp_tool_errors",
    calls,
    errors,
    pct: String(Math.round((errors * 100) / calls)),
    tool: top === undefined || top.errors === 0 ? null : top.tool,
  };
}

async function introspectFailing(store: AlertStore, now: number): Promise<TeamOpsEvent | null> {
  const minute = Math.floor(now / 60_000);
  const n = Math.round(MCP_MONITORING.introspectWindowMs / 60_000);
  const keys = Array.from({ length: n }, (_, i) => mcpIntrospectFailKey(minute - i));
  const failures = await store.sum(keys);
  return failures >= MCP_MONITORING.introspectMinFailures
    ? { type: "team_mcp_introspect_failing", failures }
    : null;
}

async function dailyLimit(db: Db, now: number): Promise<TeamOpsEvent | null> {
  const rows = await db
    .selectDistinct({ userId: mcpCalls.userId })
    .from(mcpCalls)
    .where(
      and(
        eq(mcpCalls.status, "rate_limited"),
        eq(mcpCalls.tool, MCP_LIMIT_TOOL.per_day),
        gte(mcpCalls.createdAt, new Date(now - MCP_MONITORING.dailyLimitWindowMs)),
        isNotNull(mcpCalls.userId),
      ),
    )
    .limit(50);
  const userIds = rows.flatMap((r) => (r.userId === null ? [] : [r.userId]));
  return userIds.length === 0 ? null : { type: "team_mcp_daily_limit", userIds };
}

/** Một lượt kiểm tra; trả các loại đã ghi outbox (để log / test). */
export async function checkMcpAlerts(db: Db, store: AlertStore, now: number): Promise<Kind[]> {
  const found = (
    await Promise.all([toolErrors(db, now), introspectFailing(store, now), dailyLimit(db, now)])
  ).filter((e): e is TeamOpsEvent => e !== null);
  const sent: Kind[] = [];
  for (const e of found) {
    const kind = e.type as Kind;
    if (!(await store.claim(`team:mcp_alert:${kind}`, MCP_MONITORING.throttleMs))) continue;
    await db.insert(outbox).values({ topic: "jobs.team_ops", payload: e });
    sent.push(kind);
  }
  return sent;
}
