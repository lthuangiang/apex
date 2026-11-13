import { mcpCalls, mcpTokens, type Db } from "@drift/db";
import type { McpPlatformStats } from "@drift/shared";
import { and, desc, gt, gte, isNull, sql } from "drizzle-orm";

// Mục MCP ở Stats (role team, DEC-TBD-mcp-monitoring). Chỉ số đếm thật; không có lượt gọi nào trong 24h thì tỷ lệ là
// null (web hiện "Not available"), không bao giờ 0%.

const pct = (n: number, total: number) =>
  total === 0 ? null : ((n * 100) / total).toFixed(1).replace(/\.0$/, "");

export async function mcpStats(db: Db, now: Date): Promise<McpPlatformStats> {
  const since = new Date(now.getTime() - 86_400_000);
  const [connected] = await db
    .select({ n: sql<number>`count(distinct ${mcpTokens.userId})::int` })
    .from(mcpTokens)
    .where(
      and(
        isNull(mcpTokens.revokedAt),
        isNull(mcpTokens.rotatedAt),
        gt(mcpTokens.refreshExpiresAt, now),
      ),
    );
  const [totals] = await db
    .select({
      all: sql<number>`count(*)::int`,
      denied: sql<number>`count(*) filter (where ${mcpCalls.status} = 'denied')::int`,
      limited: sql<number>`count(*) filter (where ${mcpCalls.status} = 'rate_limited')::int`,
    })
    .from(mcpCalls)
    .where(gte(mcpCalls.createdAt, since));
  // Lượt gọi tool thật (ok / error), theo tool.
  const calls = sql<number>`count(*)::int`;
  const byTool = await db
    .select({
      tool: mcpCalls.tool,
      calls,
      errors: sql<number>`count(*) filter (where ${mcpCalls.status} = 'error')::int`,
    })
    .from(mcpCalls)
    .where(and(gte(mcpCalls.createdAt, since), sql`${mcpCalls.status} in ('ok', 'error')`))
    .groupBy(mcpCalls.tool)
    .orderBy(desc(calls), mcpCalls.tool)
    .limit(30);
  const all = totals?.all ?? 0;
  return {
    connectedUsers: connected?.n ?? 0,
    calls24h: byTool.reduce((n, r) => n + r.calls, 0),
    byTool24h: byTool,
    deniedPct24h: pct(totals?.denied ?? 0, all),
    rateLimitedPct24h: pct(totals?.limited ?? 0, all),
  };
}
