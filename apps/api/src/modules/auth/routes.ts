import { users } from "@drift/db";
import {
  adminResetPasswordBodySchema,
  AppError,
  dec,
  createSessionBodySchema,
  enableTwoFactorBodySchema,
  ErrorCode,
  loginBodySchema,
  registerBodySchema,
  requestOtpBodySchema,
  type Me,
} from "@drift/shared";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { AuditAction } from "../../lib/audit";
import { parseOrThrow } from "../../lib/http";
import { idempotent } from "../../lib/idempotency";
import { clearSessionCookie, requireAuth, setSessionCookie } from "../../plugins/session";
import { enableTwoFactor, listSessions, setupTwoFactor } from "../security/service";

import {
  createSession,
  loginWithPassword,
  registerWithPassword,
  requestOtp,
  resetPasswordByTeam,
  revokeSession,
  type AuthDeps,
} from "./service";

export interface AuthRouteOptions {
  deps: AuthDeps;
  cookieSecure: boolean;
}

export function registerAuthRoutes(
  app: FastifyInstance,
  { deps, cookieSecure }: AuthRouteOptions,
): void {
  const { db } = deps;

  /** Lấy CSRF cookie trước request ghi đầu tiên. */
  app.get("/api/v1/auth/csrf", (_request, reply) => reply.status(204).send());

  app.post("/api/v1/auth/otp", async (request, reply) => {
    const body = parseOrThrow(requestOtpBodySchema, request.body);
    await requestOtp(deps, body.email);
    return reply.status(202).send({ status: "sent" });
  });

  // Email + mật khẩu (DEC-76): dùng khi production chưa có SMTP. Đăng ký xong là đăng nhập luôn.
  app.post("/api/v1/auth/register", async (request, reply) => {
    const body = parseOrThrow(registerBodySchema, request.body);
    const session = await registerWithPassword(deps, body, {
      ip: request.ip,
      userAgent: request.headers["user-agent"] ?? null,
    });
    setSessionCookie(reply, session.token, cookieSecure, session.expiresAt);
    return reply.status(201).send(await me(session.userId));
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
    const body = parseOrThrow(loginBodySchema, request.body);
    const session = await loginWithPassword(
      deps,
      { email: body.email, password: body.password, twoFactorCode: body.twoFactorCode },
      { ip: request.ip, userAgent: request.headers["user-agent"] ?? null },
    );
    setSessionCookie(reply, session.token, cookieSecure, session.expiresAt);
    return reply.status(201).send(await me(session.userId));
  });

  // Team đặt lại mật khẩu cho user (DEC-77). Mật khẩu tạm nằm trong response nên không lưu lại để replay.
  app.post("/api/v1/admin/users/:id/password", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(z.object({ id: z.uuid() }), request.params);
    const body = parseOrThrow(adminResetPasswordBodySchema, request.body);
    return idempotent(
      db,
      request,
      reply,
      auth.userId,
      deps.now(),
      async () => ({
        status: 200,
        body: await resetPasswordByTeam(
          deps,
          { actorId: auth.userId, targetId: id, twoFactorCode: body.twoFactorCode },
          request.ip,
        ),
      }),
      { sensitive: true },
    );
  });

  app.post("/api/v1/auth/session", async (request, reply) => {
    const body = parseOrThrow(createSessionBodySchema, request.body);
    const session = await createSession(
      deps,
      { email: body.email, code: body.code, twoFactorCode: body.twoFactorCode },
      { ip: request.ip, userAgent: request.headers["user-agent"] ?? null },
    );
    setSessionCookie(reply, session.token, cookieSecure, session.expiresAt);
    return reply.status(201).send(await me(session.userId));
  });

  app.delete("/api/v1/auth/session", async (request, reply) => {
    const auth = requireAuth(request);
    await revokeSession(
      db,
      auth.userId,
      auth.sessionId,
      deps.now(),
      request.ip,
      AuditAction.signOut,
    );
    clearSessionCookie(reply, cookieSecure);
    return reply.status(204).send();
  });

  app.get("/api/v1/me", async (request) => {
    const auth = requireAuth(request);
    return me(auth.userId, auth.twoFactorTrustedUntil);
  });

  app.get("/api/v1/security/sessions", async (request) => {
    const auth = requireAuth(request);
    return { items: await listSessions(deps, auth.userId, auth.sessionId) };
  });

  app.delete("/api/v1/security/sessions/:id", async (request, reply) => {
    const auth = requireAuth(request);
    const { id } = parseOrThrow(z.object({ id: z.uuid() }), request.params);
    return idempotent(db, request, reply, auth.userId, deps.now(), async () => {
      const revoked = await revokeSession(
        db,
        auth.userId,
        id,
        deps.now(),
        request.ip,
        AuditAction.sessionRevoked,
      );
      if (!revoked) throw new AppError(ErrorCode.notFound, "Session not found.");
      if (id === auth.sessionId) clearSessionCookie(reply, cookieSecure);
      return { status: 204, body: null };
    });
  });

  app.post("/api/v1/security/2fa/setup", async (request, reply) => {
    const auth = requireAuth(request);
    return idempotent(
      db,
      request,
      reply,
      auth.userId,
      deps.now(),
      async () => ({
        status: 200,
        body: await setupTwoFactor(deps, auth.userId),
      }),
      { sensitive: true },
    );
  });

  app.post("/api/v1/security/2fa/enable", async (request, reply) => {
    const auth = requireAuth(request);
    const body = parseOrThrow(enableTwoFactorBodySchema, request.body);
    return idempotent(
      db,
      request,
      reply,
      auth.userId,
      deps.now(),
      async () => ({
        status: 200,
        body: await enableTwoFactor(deps, auth.userId, body.code, request.ip),
      }),
      { sensitive: true },
    );
  });

  async function me(userId: string, trustedUntil: Date | null = null): Promise<Me> {
    const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (user?.deletedAt !== null)
      throw new AppError(ErrorCode.unauthenticated, "Sign in required.");
    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      timezone: user.timezone,
      numberFormat: user.numberFormat,
      defaultMaxLossPct:
        user.defaultMaxLossPct === null ? null : dec(user.defaultMaxLossPct).toString(),
      twoFactorEnabled: user.twofaEnabled,
      twoFactorTrustedUntil:
        user.twofaEnabled && trustedUntil !== null && trustedUntil.getTime() > deps.now().getTime()
          ? trustedUntil.toISOString()
          : null,
      role: user.role,
    };
  }
}
