import {
  AppError,
  ErrorCode,
  MCP_SCOPES,
  OAUTH_CONFIG,
  type OauthConsentInfo,
} from "@drift/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { safeEqual, sha256 } from "../../lib/crypto";
import { idempotent } from "../../lib/idempotency";
import type { RateLimiter } from "../../plugins/rate-limit";
import { requireAuth } from "../../plugins/session";

import {
  connectedApps,
  consentInfo,
  decide,
  introspect,
  OauthError,
  registerClient,
  revoke,
  revokeApp,
  token,
  validateAuthorize,
  type AuthorizeParams,
  type OauthDeps,
} from "./service";

// Routes OAuth 2.1 cho MCP (DEC-167, DEC-215). Token / register / revoke / introspect không dùng cookie nên
// được miễn CSRF (`OAUTH_CSRF_EXEMPT`); consent và Connected apps dùng phiên đăng nhập như mọi màn khác.

export const OAUTH_PATHS = {
  metadata: "/.well-known/oauth-authorization-server",
  token: "/api/v1/oauth/token",
  register: "/api/v1/oauth/register",
  revoke: "/api/v1/oauth/revoke",
  introspect: "/api/v1/oauth/introspect",
} as const;

export const OAUTH_CSRF_EXEMPT: readonly string[] = [
  OAUTH_PATHS.token,
  OAUTH_PATHS.register,
  OAUTH_PATHS.revoke,
  OAUTH_PATHS.introspect,
];

export const INTROSPECT_SECRET_HEADER = "x-mcp-introspect-secret";

export interface OauthRouteOptions {
  deps: OauthDeps;
  rateLimiter: RateLimiter;
  /** Shared secret giữa api và apps/mcp; null = tắt introspect (MCP chưa bật). Không bao giờ log. */
  introspectSecret: string | null;
}

const authorizeQuery = z.object({
  response_type: z.string().optional(),
  client_id: z.string().max(2000).optional(),
  redirect_uri: z.string().max(2000).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  resource: z.string().max(2000).optional(),
  scope: z.string().max(200).optional(),
  state: z.string().max(2000).optional(),
});

const toParams = (q: z.infer<typeof authorizeQuery>): AuthorizeParams => ({
  responseType: q.response_type,
  clientId: q.client_id,
  redirectUri: q.redirect_uri,
  codeChallenge: q.code_challenge,
  codeChallengeMethod: q.code_challenge_method,
  resource: q.resource,
  scope: q.scope,
  state: q.state,
});

/** Lỗi OAuth trả theo RFC 6749 (`error`, `error_description`), không theo format C6. */
function sendOauthError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof OauthError)
    return reply
      .status(e.status)
      .header("cache-control", "no-store")
      .send({ error: e.error, error_description: e.description });
  throw e;
}

/** Body form-urlencoded (token / revoke) hoặc JSON. */
function formOf(request: FastifyRequest): Record<string, string | undefined> {
  const b = request.body;
  if (typeof b !== "object" || b === null) return {};
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(b as Record<string, unknown>))
    if (typeof v === "string") out[k] = v;
  return out;
}

export function registerOauthRoutes(app: FastifyInstance, options: OauthRouteOptions): void {
  const { deps } = options;

  // Chỉ trong phạm vi route OAuth: đọc body form-urlencoded (RFC 6749) mà không thêm dependency.
  app.register((scope, _opts, done) => {
    scope.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string", bodyLimit: 16 * 1024 },
      (_req, body, cb) => {
        cb(null, Object.fromEntries(new URLSearchParams(body as string)));
      },
    );

    // RFC 8414: metadata của authorization server.
    scope.get(OAUTH_PATHS.metadata, async (_request, reply) =>
      reply.header("cache-control", "public, max-age=300").send({
        issuer: deps.issuer,
        authorization_endpoint: `${deps.issuer}/oauth/authorize`,
        token_endpoint: `${deps.issuer}${OAUTH_PATHS.token}`,
        registration_endpoint: `${deps.issuer}${OAUTH_PATHS.register}`,
        revocation_endpoint: `${deps.issuer}${OAUTH_PATHS.revoke}`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        revocation_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...MCP_SCOPES],
        client_id_metadata_document_supported: true,
        authorization_response_iss_parameter_supported: true,
      }),
    );

    scope.post(OAUTH_PATHS.token, async (request, reply) => {
      try {
        const res = await token(deps, formOf(request));
        return await reply
          .header("cache-control", "no-store")
          .header("pragma", "no-cache")
          .send(res);
      } catch (e) {
        return sendOauthError(reply, e);
      }
    });

    // RFC 7591 (giữ để tương thích): 10 lần / giờ / IP.
    scope.post(OAUTH_PATHS.register, async (request, reply) => {
      const hit = await options.rateLimiter.hit(`rl:oauth-register:${request.ip}`, 3_600_000);
      if (hit.count > OAUTH_CONFIG.registerPerHourPerIp)
        return reply
          .status(429)
          .header("retry-after", String(Math.ceil(hit.resetMs / 1000)))
          .send({
            error: "slow_down",
            error_description: "Too many client registrations. Try again later.",
          });
      try {
        return await reply
          .status(201)
          .header("cache-control", "no-store")
          .send(await registerClient(deps, request.body));
      } catch (e) {
        return sendOauthError(reply, e);
      }
    });

    // RFC 7009: luôn 200.
    scope.post(OAUTH_PATHS.revoke, async (request, reply) => {
      await revoke(deps, formOf(request).token);
      return reply.status(200).send({});
    });

    // Nội bộ (apps/mcp → api): kiểm tra token mỗi request. Sai / thiếu secret → 401, không nói lý do.
    scope.post(OAUTH_PATHS.introspect, async (request, reply) => {
      const secret = options.introspectSecret;
      const header = request.headers[INTROSPECT_SECRET_HEADER];
      if (
        secret === null ||
        typeof header !== "string" ||
        !safeEqual(sha256(header), sha256(secret))
      )
        throw new AppError(ErrorCode.unauthenticated, "Sign in required.");
      const raw = formOf(request).token;
      if (raw === undefined || raw === "") return { active: false };
      return reply.header("cache-control", "no-store").send(await introspect(deps, raw));
    });

    done();
  });

  // Màn consent (web /oauth/authorize): kiểm tra tham số, trả thông tin hiển thị. Lỗi client / redirect_uri thì không
  // redirect (400 kèm lỗi OAuth); lỗi khác trả `redirect` để web chuyển về client.
  app.get("/api/v1/oauth/authorize", async (request, reply) => {
    const auth = requireAuth(request);
    const q = authorizeQuery.safeParse(request.query);
    if (!q.success)
      return reply
        .status(400)
        .send({ error: "invalid_request", error_description: "Bad parameters." });
    try {
      const r = await validateAuthorize(deps, toParams(q.data));
      if (!r.ok) return { redirect: r.redirect };
      const info: OauthConsentInfo = await consentInfo(deps, auth.userId, r.v);
      return { consent: info };
    } catch (e) {
      return sendOauthError(reply, e);
    }
  });

  // Allow / Deny (phiên + CSRF như mọi POST của web).
  app.post("/api/v1/oauth/authorize", async (request, reply) => {
    const auth = requireAuth(request);
    const body = authorizeQuery.extend({ allow: z.boolean() }).safeParse(request.body);
    if (!body.success)
      return reply
        .status(400)
        .send({ error: "invalid_request", error_description: "Bad parameters." });
    try {
      const r = await validateAuthorize(deps, toParams(body.data));
      if (!r.ok) return { redirect: r.redirect };
      return { redirect: await decide(deps, auth.userId, r.v, body.data.allow) };
    } catch (e) {
      return sendOauthError(reply, e);
    }
  });

  // Settings › Connected apps.
  app.get("/api/v1/oauth/apps", async (request) =>
    connectedApps(deps, requireAuth(request).userId),
  );

  app.delete("/api/v1/oauth/apps/:clientId", async (request, reply) => {
    const auth = requireAuth(request);
    const { clientId } = z.object({ clientId: z.string().min(1).max(2000) }).parse(request.params);
    return idempotent(deps.db, request, reply, auth.userId, deps.now(), async () => {
      await revokeApp(deps, auth.userId, clientId);
      return { status: 204, body: null };
    });
  });
}
