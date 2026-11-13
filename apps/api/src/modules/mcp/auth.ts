import { bots, type Db } from "@drift/db";
import { AppError, ErrorCode, type McpScope } from "@drift/shared";
import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";

import { safeEqual, sha256 } from "../../lib/crypto";
import { introspect, type OauthDeps } from "../oauth/service";

// Route nội bộ cho tool MCP (DEC-167, DEC-TBD-mcp-team-tools). apps/mcp gửi kèm shared secret và token MCP của
// người dùng (`x-mcp-token`). api KHÔNG tin kết quả kiểm tra của apps/mcp: tự introspect token, kiểm tra endpoint
// (RFC 8707), scope và role team ở mỗi request, rồi mọi truy vấn của tool người dùng lọc theo `userId` của token
// (bot của người khác → 404, không nói là có tồn tại). Traefik chặn các route này từ ngoài (DEPLOY 2.10).

export const MCP_SECRET_HEADER = "x-mcp-introspect-secret";
export const MCP_TOKEN_HEADER = "x-mcp-token";

export type McpEndpoint = "user" | "team";

export interface McpAuthDeps {
  oauth: OauthDeps;
  /** Null = MCP tắt: mọi route nội bộ trả 401. */
  introspectSecret: string | null;
  /** URL canonical của từng endpoint, ví dụ `https://mcp.desklabs.xyz/team/mcp`. */
  resources: Record<McpEndpoint, string>;
}

export interface McpCaller {
  userId: string;
  tokenId: string;
  scope: McpScope[];
}

const REQUIRED: Record<McpEndpoint, McpScope> = { user: "read", team: "team:read" };

/** Sai secret / token → 401; token đúng nhưng sai endpoint, thiếu scope hay mất role team → 403. Không nói lý do. */
export async function requireMcpCaller(
  deps: McpAuthDeps,
  request: FastifyRequest,
  endpoint: McpEndpoint,
  scope: McpScope = REQUIRED[endpoint],
): Promise<McpCaller> {
  const secret = deps.introspectSecret;
  const header = request.headers[MCP_SECRET_HEADER];
  if (secret === null || typeof header !== "string" || !safeEqual(sha256(header), sha256(secret)))
    throw new AppError(ErrorCode.unauthenticated, "Sign in required.");
  const raw = request.headers[MCP_TOKEN_HEADER];
  if (typeof raw !== "string" || raw === "")
    throw new AppError(ErrorCode.unauthenticated, "Sign in required.");
  const intro = await introspect(deps.oauth, raw);
  if (!intro.active) throw new AppError(ErrorCode.unauthenticated, "Sign in required.");
  const allowed =
    intro.resource === deps.resources[endpoint] &&
    intro.scope.includes(scope) &&
    (endpoint !== "team" || intro.team);
  if (!allowed) throw new AppError(ErrorCode.forbidden, "Not allowed.");
  return { userId: intro.userId, tokenId: intro.tokenId, scope: intro.scope };
}

/** Bot của chính người gọi; của người khác hay không tồn tại → 404 như nhau. */
export async function ownBotOr404(db: Db, userId: string, botId: string) {
  const [row] = await db
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.botNotFound, "Bot not found.");
  return row;
}
