import type { Db } from "@drift/db";
import { sessions, users } from "@drift/db";
import { AppError, CSRF_COOKIE, CSRF_HEADER, ErrorCode, SESSION_COOKIE } from "@drift/shared";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { randomToken, safeEqual, sha256 } from "../lib/crypto";
import { TWO_FACTOR_TRUST_MS } from "../modules/security/two-factor";

// Phiên cookie httpOnly + chống CSRF bằng double-submit token (CODING_STANDARDS C12).
// Phiên trượt 7 ngày, trần tuyệt đối 30 ngày (DEC-28).

export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** Chỉ ghi lại `expires_at` tối đa mỗi giờ một lần. */
const SESSION_TOUCH_MS = 60 * 60 * 1000;

export interface AuthContext {
  userId: string;
  sessionId: string;
  twoFactorEnabled: boolean;
  /** Trong cửa sổ 2 giờ sau lần nhập đúng 2FA thì không hỏi lại (DEC-115); null khi không có. */
  twoFactorTrustedUntil: Date | null;
}

declare module "fastify" {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export interface SessionOptions {
  db: Db;
  cookieSecure: boolean;
  now: () => Date;
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Đường dẫn chính xác (không wildcard, không query) được miễn CSRF vì không đến từ trình duyệt và có cách xác
 * thực riêng: webhook Telegram kiểm tra header secret (docs/NOTIFICATIONS.md mục 3, DEC-170); OAuth token / register /
 * revoke theo RFC 6749 / 7591 / 7009 (PKCE, không cookie) và introspect nội bộ (shared secret).
 */
export const CSRF_EXEMPT_POST_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/telegram/webhook",
  // OAuth cho MCP (DEC-215): client gọi bằng form + PKCE / bearer, không có cookie.
  "/api/v1/oauth/token",
  "/api/v1/oauth/register",
  "/api/v1/oauth/revoke",
  "/api/v1/oauth/introspect",
  "/api/v1/mcp/calls",
  // Bản nháp từ Claude (DEC-TBD-mcp-drafts): route nội bộ, xác thực bằng shared secret + token MCP, không dùng cookie.
  "/api/v1/mcp/me/drafts/new",
  "/api/v1/mcp/me/drafts/change",
  "/api/v1/mcp/step-up",
]);

export function registerSession(app: FastifyInstance, options: SessionOptions): void {
  const { db, now } = options;
  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request, reply) => {
    ensureCsrfCookie(request, reply, options.cookieSecure);
    const exempt = request.method === "POST" && CSRF_EXEMPT_POST_PATHS.has(request.url);
    if (MUTATING.has(request.method) && !exempt) checkCsrf(request);

    const token = request.cookies[SESSION_COOKIE];
    if (token === undefined) return;
    const at = now();
    const [row] = await db
      .select({
        sessionId: sessions.id,
        userId: sessions.userId,
        expiresAt: sessions.expiresAt,
        absoluteExpiresAt: sessions.absoluteExpiresAt,
        lastSeenAt: sessions.lastSeenAt,
        twoFactorEnabled: users.twofaEnabled,
        twofaVerifiedAt: sessions.twofaVerifiedAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, sha256(token)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, at),
          gt(sessions.absoluteExpiresAt, at),
        ),
      )
      .limit(1);
    if (row === undefined) {
      clearSessionCookie(reply, options.cookieSecure);
      return;
    }
    request.auth = {
      userId: row.userId,
      sessionId: row.sessionId,
      twoFactorEnabled: row.twoFactorEnabled,
      twoFactorTrustedUntil:
        row.twoFactorEnabled && row.twofaVerifiedAt !== null
          ? new Date(row.twofaVerifiedAt.getTime() + TWO_FACTOR_TRUST_MS)
          : null,
    };
    if (at.getTime() - row.lastSeenAt.getTime() >= SESSION_TOUCH_MS) {
      const expiresAt = new Date(
        Math.min(at.getTime() + SESSION_IDLE_MS, row.absoluteExpiresAt.getTime()),
      );
      await db
        .update(sessions)
        .set({ lastSeenAt: at, expiresAt })
        .where(eq(sessions.id, row.sessionId));
    }
  });
}

export function requireAuth(request: FastifyRequest): AuthContext {
  if (request.auth === null) throw new AppError(ErrorCode.unauthenticated, "Sign in required.");
  return request.auth;
}

export function setSessionCookie(
  reply: FastifyReply,
  token: string,
  secure: boolean,
  expiresAt: Date,
): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: "lax", path: "/" });
}

function ensureCsrfCookie(request: FastifyRequest, reply: FastifyReply, secure: boolean): void {
  if (request.cookies[CSRF_COOKIE] !== undefined) return;
  const token = randomToken();
  // Client đọc cookie này và gửi lại trong header; không httpOnly là có chủ đích.
  reply.setCookie(CSRF_COOKIE, token, { httpOnly: false, secure, sameSite: "lax", path: "/" });
  request.cookies[CSRF_COOKIE] = token;
}

function checkCsrf(request: FastifyRequest): void {
  const cookie = request.cookies[CSRF_COOKIE];
  const header = request.headers[CSRF_HEADER.toLowerCase()];
  if (cookie === undefined || typeof header !== "string" || !safeEqual(cookie, header)) {
    throw new AppError(ErrorCode.forbidden, "CSRF check failed.", { reason: "csrf" });
  }
}
