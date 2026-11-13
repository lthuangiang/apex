import { mcpCalls, oauthClients, oauthCodes, type Db } from "@drift/db";
import { OAUTH_CONFIG } from "@drift/shared";
import { and, eq, lt, sql } from "drizzle-orm";

// Dọn dữ liệu OAuth / MCP (docs/MCP.md mục 6, DEC-167): code hết hạn quá 1 ngày, client đăng ký động không dùng 30 ngày
// (token của nó xoá theo, cascade), nhật ký `mcp_calls` quá 90 ngày.

export const MCP_CALLS_RETENTION_MS = 90 * 86_400_000;

export async function purgeMcp(
  db: Db,
  now: number,
): Promise<{ codes: number; clients: number; calls: number }> {
  const codes = await db
    .delete(oauthCodes)
    .where(lt(oauthCodes.expiresAt, new Date(now - 86_400_000)))
    .returning({ h: oauthCodes.codeHash });
  const clients = await db
    .delete(oauthClients)
    .where(
      and(
        eq(oauthClients.kind, "dcr"),
        lt(
          sql`coalesce(${oauthClients.lastUsedAt}, ${oauthClients.createdAt})`,
          new Date(now - OAUTH_CONFIG.clientIdleDeleteMs),
        ),
      ),
    )
    .returning({ id: oauthClients.id });
  const calls = await db
    .delete(mcpCalls)
    .where(lt(mcpCalls.createdAt, new Date(now - MCP_CALLS_RETENTION_MS)))
    .returning({ id: mcpCalls.id });
  return { codes: codes.length, clients: clients.length, calls: calls.length };
}
