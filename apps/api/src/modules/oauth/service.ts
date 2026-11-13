import { createHash } from "node:crypto";

import { mcpTokens, oauthClients, oauthCodes, sodexAccounts, users, type Db } from "@drift/db";
import {
  MCP_SCOPES,
  OAUTH_CONFIG,
  UserRole,
  type ConnectedApps,
  type McpIntrospection,
  type McpScope,
  type OauthConsentInfo,
} from "@drift/shared";
import { and, eq, gt, isNull, or } from "drizzle-orm";

import { randomToken, safeEqual, sha256 } from "../../lib/crypto";

import { fetchClientMetadata, isAllowedRedirectUri, type CimdDeps } from "./cimd";

// Authorization server OAuth 2.1 cho MCP (docs/MCP.md mục 4, DEC-167, DEC-215). Client công khai + PKCE S256,
// token gắn với resource (RFC 8707), `iss` trong redirect (RFC 9207), client qua Client ID Metadata Document hoặc đăng
// ký động. Token opaque, chỉ lưu hash; refresh xoay mỗi lần dùng, dùng lại refresh cũ → thu hồi cả họ.

export interface OauthDeps {
  db: Db;
  now: () => Date;
  /** Issuer, ví dụ `https://desklabs.xyz` (không có dấu `/` cuối). */
  issuer: string;
  /** URL canonical của các MCP endpoint được cấp token (RFC 8707), ví dụ `https://mcp.desklabs.xyz/mcp`. */
  resources: readonly string[];
  cimd?: CimdDeps;
}

/** Lỗi theo RFC 6749 mục 5.2 (token / register / revoke) và mục 4.1.2.1 (authorize). */
export class OauthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "OauthError";
  }
}

const isUrlClientId = (id: string) => id.startsWith("https://");

/** Chuẩn hoá resource để so sánh: scheme + host chữ thường, bỏ `/` cuối. */
export function canonicalResource(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.hash !== "") return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
}

export interface ResolvedClient {
  id: string;
  name: string | null;
  redirectUris: string[];
  /** Host hiện trên consent: host của URL client_id (CIMD) hoặc của redirect_uri (đăng ký động). */
  hostOf: (redirectUri: string) => string;
}

/** Client theo client_id: CIMD (tải metadata, cache 1 giờ) hoặc client đã đăng ký động. */
export async function resolveClient(deps: OauthDeps, clientId: string): Promise<ResolvedClient> {
  if (isUrlClientId(clientId)) {
    const [cached] = await deps.db
      .select()
      .from(oauthClients)
      .where(eq(oauthClients.id, clientId))
      .limit(1);
    const fresh =
      cached?.fetchedAt != null &&
      deps.now().getTime() - cached.fetchedAt.getTime() < OAUTH_CONFIG.cimdCacheMs;
    let name = cached?.name ?? null;
    let redirectUris = cached?.redirectUris ?? [];
    if (!fresh) {
      let meta;
      try {
        meta = await fetchClientMetadata(clientId, deps.cimd);
      } catch (e) {
        throw new OauthError(
          "invalid_client",
          e instanceof Error ? e.message : "client metadata could not be fetched",
        );
      }
      name = meta.client_name ?? null;
      redirectUris = meta.redirect_uris;
      await deps.db
        .insert(oauthClients)
        .values({ id: clientId, kind: "cimd", name, redirectUris, fetchedAt: deps.now() })
        .onConflictDoUpdate({
          target: oauthClients.id,
          set: { name, redirectUris, fetchedAt: deps.now(), updatedAt: deps.now() },
        });
    }
    const host = new URL(clientId).host;
    return { id: clientId, name, redirectUris, hostOf: () => host };
  }
  const [row] = await deps.db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.id, clientId))
    .limit(1);
  if (row?.kind !== "dcr") throw new OauthError("invalid_client", "Unknown client_id.");
  return {
    id: row.id,
    name: row.name,
    redirectUris: row.redirectUris,
    hostOf: (redirectUri) => new URL(redirectUri).host,
  };
}

/** Đăng ký client động (RFC 7591, giữ để tương thích). Client công khai: `token_endpoint_auth_method = none`. */
export async function registerClient(
  deps: OauthDeps,
  body: unknown,
): Promise<Record<string, unknown>> {
  const b = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const redirectUris = Array.isArray(b.redirect_uris)
    ? b.redirect_uris.filter((x): x is string => typeof x === "string")
    : [];
  if (redirectUris.length === 0 || redirectUris.length > 20)
    throw new OauthError("invalid_redirect_uri", "redirect_uris is required (1 to 20).");
  if (redirectUris.some((r) => r.length > 2000 || !isAllowedRedirectUri(r)))
    throw new OauthError(
      "invalid_redirect_uri",
      "redirect_uris must be https, or http on a loopback address.",
    );
  const name =
    typeof b.client_name === "string" && b.client_name.trim() !== ""
      ? b.client_name.trim().slice(0, 200)
      : null;
  const id = `dlc_${randomToken()}`;
  const at = deps.now();
  await deps.db
    .insert(oauthClients)
    .values({ id, kind: "dcr", name, redirectUris, lastUsedAt: at });
  return {
    client_id: id,
    client_id_issued_at: Math.floor(at.getTime() / 1000),
    client_name: name ?? undefined,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  };
}

export interface AuthorizeParams {
  responseType: string | undefined;
  clientId: string | undefined;
  redirectUri: string | undefined;
  codeChallenge: string | undefined;
  codeChallengeMethod: string | undefined;
  resource: string | undefined;
  scope: string | undefined;
  state: string | undefined;
}

export interface ValidAuthorize {
  client: ResolvedClient;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scopes: McpScope[];
  state: string | undefined;
}

/**
 * Kiểm tra request authorize. Lỗi client / redirect_uri ném `OauthError` với `status` 400 (không được redirect, web hiện
 * lỗi tại chỗ); lỗi khác trả về dạng redirect có `error` (RFC 6749 mục 4.1.2.1).
 */
export async function validateAuthorize(
  deps: OauthDeps,
  p: AuthorizeParams,
): Promise<{ ok: true; v: ValidAuthorize } | { ok: false; redirect: string }> {
  if (p.clientId === undefined || p.clientId === "")
    throw new OauthError("invalid_request", "client_id is required.");
  const client = await resolveClient(deps, p.clientId);
  if (p.redirectUri === undefined || !client.redirectUris.includes(p.redirectUri))
    throw new OauthError("invalid_request", "redirect_uri is not registered for this client.");
  const fail = (error: string, description: string) => ({
    ok: false as const,
    redirect: redirectWith(deps, p.redirectUri ?? "", {
      error,
      error_description: description,
      state: p.state,
    }),
  });
  if (p.responseType !== "code")
    return fail("unsupported_response_type", "response_type must be code.");
  if (p.codeChallenge === undefined || !/^[A-Za-z0-9_-]{43,128}$/.test(p.codeChallenge))
    return fail("invalid_request", "code_challenge is required (PKCE).");
  if (p.codeChallengeMethod !== "S256")
    return fail("invalid_request", "code_challenge_method must be S256.");
  const resource = p.resource === undefined ? null : canonicalResource(p.resource);
  const allowed = deps.resources.map((r) => canonicalResource(r));
  if (resource === null || !allowed.includes(resource))
    return fail("invalid_target", "resource must be a DeskLabs MCP server.");
  const requested = (p.scope ?? "read").split(" ").filter((s) => s !== "");
  if (requested.some((s) => !(MCP_SCOPES as readonly string[]).includes(s)))
    return fail("invalid_scope", "Unknown scope.");
  return {
    ok: true,
    v: {
      client,
      redirectUri: p.redirectUri,
      codeChallenge: p.codeChallenge,
      resource,
      scopes: [...new Set(requested)] as McpScope[],
      state: p.state,
    },
  };
}

/** Scope user được cấp: `read` / `draft` cần SoDEX đã kết nối (DEC-167); `team:read` chỉ role team. */
async function grantable(
  db: Pick<Db, "select">,
  userId: string,
): Promise<{ sodex: boolean; team: boolean }> {
  const [u] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const [a] = await db
    .select({ id: sodexAccounts.id })
    .from(sodexAccounts)
    .where(and(eq(sodexAccounts.userId, userId), eq(sodexAccounts.status, "connected")))
    .limit(1);
  return { sodex: a !== undefined, team: u?.role === UserRole.team };
}

function split(scopes: readonly McpScope[], g: { sodex: boolean; team: boolean }) {
  const ok = (s: McpScope) => (s === "team:read" ? g.team : g.sodex);
  return { granted: scopes.filter(ok), denied: scopes.filter((s) => !ok(s)) };
}

export async function consentInfo(
  deps: OauthDeps,
  userId: string,
  v: ValidAuthorize,
): Promise<OauthConsentInfo> {
  const g = await grantable(deps.db, userId);
  const { granted, denied } = split(v.scopes, g);
  return {
    client: { name: v.client.name, host: v.client.hostOf(v.redirectUri) },
    scopes: granted,
    denied,
    needsSodex: !g.sodex && v.scopes.some((s) => s !== "team:read"),
  };
}

function redirectWith(
  deps: OauthDeps,
  redirectUri: string,
  params: Record<string, string | undefined>,
): string {
  const u = new URL(redirectUri);
  for (const [k, val] of Object.entries(params)) if (val !== undefined) u.searchParams.set(k, val);
  u.searchParams.set("iss", deps.issuer);
  return u.toString();
}

/** Allow / Deny trên màn consent. Allow cấp phần scope user được phép; không còn scope nào → access_denied. */
export async function decide(
  deps: OauthDeps,
  userId: string,
  v: ValidAuthorize,
  allow: boolean,
): Promise<string> {
  const { granted } = split(v.scopes, await grantable(deps.db, userId));
  if (!allow || granted.length === 0)
    return redirectWith(deps, v.redirectUri, {
      error: "access_denied",
      error_description: allow ? "No permission could be granted." : "The user denied access.",
      state: v.state,
    });
  const code = randomToken();
  await deps.db.insert(oauthCodes).values({
    codeHash: sha256(code),
    clientId: v.client.id,
    userId,
    redirectUri: v.redirectUri,
    codeChallenge: v.codeChallenge,
    scope: granted,
    resource: v.resource,
    expiresAt: new Date(deps.now().getTime() + OAUTH_CONFIG.codeTtlMs),
  });
  return redirectWith(deps, v.redirectUri, { code, state: v.state });
}

const pkceS256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Id họ token (uuid) suy ra tất định từ hash của authorization code. */
export function familyOfCode(codeHash: string): string {
  const h = createHash("sha256").update(`family:${codeHash}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

async function issue(
  deps: OauthDeps,
  tx: Pick<Db, "insert">,
  t: { familyId: string; userId: string; clientId: string; scope: McpScope[]; resource: string },
): Promise<TokenResponse> {
  const access = randomToken();
  const refresh = randomToken();
  const at = deps.now().getTime();
  await tx.insert(mcpTokens).values({
    familyId: t.familyId,
    userId: t.userId,
    clientId: t.clientId,
    scope: t.scope,
    resource: t.resource,
    accessHash: sha256(access),
    accessExpiresAt: new Date(at + OAUTH_CONFIG.accessTtlMs),
    refreshHash: sha256(refresh),
    refreshExpiresAt: new Date(at + OAUTH_CONFIG.refreshTtlMs),
  });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.floor(OAUTH_CONFIG.accessTtlMs / 1000),
    refresh_token: refresh,
    scope: t.scope.join(" "),
  };
}

/** Token endpoint: `authorization_code` (PKCE + resource) và `refresh_token` (xoay, phát hiện dùng lại). */
export async function token(
  deps: OauthDeps,
  form: Record<string, string | undefined>,
): Promise<TokenResponse> {
  const now = deps.now();
  if (form.grant_type === "authorization_code") {
    const { code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId } = form;
    if (code === undefined || verifier === undefined || clientId === undefined)
      throw new OauthError("invalid_request", "code, code_verifier and client_id are required.");
    const codeHash = sha256(code);
    const out = await deps.db.transaction(async (tx) => {
      const [c] = await tx
        .update(oauthCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(oauthCodes.codeHash, codeHash),
            isNull(oauthCodes.usedAt),
            gt(oauthCodes.expiresAt, now),
          ),
        )
        .returning();
      if (c === undefined) {
        // Code đã dùng mà bị đổi lại: có thể đã lộ. Thu hồi token cấp từ code đó SAU transaction (OAuth 2.1 mục 4.1.3).
        const [used] = await tx
          .select({ usedAt: oauthCodes.usedAt })
          .from(oauthCodes)
          .where(eq(oauthCodes.codeHash, codeHash))
          .limit(1);
        if (used?.usedAt != null) return { reusedCode: true as const };
        throw new OauthError("invalid_grant", "The code is invalid, expired or used.");
      }
      if (c.clientId !== clientId || c.redirectUri !== redirectUri)
        throw new OauthError("invalid_grant", "client_id or redirect_uri does not match the code.");
      if (!safeEqual(pkceS256(verifier), c.codeChallenge))
        throw new OauthError("invalid_grant", "code_verifier does not match.");
      const resource = form.resource === undefined ? null : canonicalResource(form.resource);
      if (resource !== c.resource)
        throw new OauthError("invalid_target", "resource does not match the code.");
      await tx.update(oauthClients).set({ lastUsedAt: now }).where(eq(oauthClients.id, c.clientId));
      return issue(deps, tx, {
        // Họ token suy ra từ code: code bị dùng lại thì tìm lại đúng họ này mà không cần thêm cột.
        familyId: familyOfCode(codeHash),
        userId: c.userId,
        clientId: c.clientId,
        scope: c.scope as McpScope[],
        resource: c.resource,
      });
    });
    if ("reusedCode" in out) {
      await deps.db
        .update(mcpTokens)
        .set({ revokedAt: now })
        .where(and(eq(mcpTokens.familyId, familyOfCode(codeHash)), isNull(mcpTokens.revokedAt)));
      throw new OauthError("invalid_grant", "The code was already used.");
    }
    return out;
  }
  if (form.grant_type === "refresh_token") {
    const { refresh_token: refresh, client_id: clientId } = form;
    if (refresh === undefined || clientId === undefined)
      throw new OauthError("invalid_request", "refresh_token and client_id are required.");
    const out = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(mcpTokens)
        .where(eq(mcpTokens.refreshHash, sha256(refresh)))
        .limit(1)
        .for("update");
      if (row?.clientId !== clientId)
        throw new OauthError("invalid_grant", "The refresh token is invalid.");
      // Refresh đã xoay mà bị dùng lại: có thể đã lộ. Thu hồi cả họ SAU khi transaction này kết thúc (ném lỗi trong
      // transaction sẽ rollback việc thu hồi).
      if (row.rotatedAt !== null) return { reusedFamily: row.familyId };
      if (row.revokedAt !== null || row.refreshExpiresAt <= now)
        throw new OauthError("invalid_grant", "The refresh token is expired or revoked.");
      const resource =
        form.resource === undefined ? row.resource : canonicalResource(form.resource);
      if (resource !== row.resource)
        throw new OauthError("invalid_target", "resource does not match the token.");
      // Kiểm tra lại quyền: role team bị gỡ hay SoDEX ngắt kết nối thì scope tương ứng mất ở lần xoay này.
      const { granted } = split(row.scope as McpScope[], await grantable(tx, row.userId));
      if (granted.length === 0)
        throw new OauthError("invalid_grant", "No permission is left on this token.");
      await tx.update(mcpTokens).set({ rotatedAt: now }).where(eq(mcpTokens.id, row.id));
      await tx
        .update(oauthClients)
        .set({ lastUsedAt: now })
        .where(eq(oauthClients.id, row.clientId));
      return issue(deps, tx, {
        familyId: row.familyId,
        userId: row.userId,
        clientId: row.clientId,
        scope: granted,
        resource: row.resource,
      });
    });
    if ("reusedFamily" in out) {
      await deps.db
        .update(mcpTokens)
        .set({ revokedAt: now })
        .where(and(eq(mcpTokens.familyId, out.reusedFamily), isNull(mcpTokens.revokedAt)));
      throw new OauthError("invalid_grant", "The refresh token was already used.");
    }
    return out;
  }
  throw new OauthError(
    "unsupported_grant_type",
    "grant_type must be authorization_code or refresh_token.",
  );
}

/** RFC 7009: thu hồi theo access hay refresh token, cả họ. Luôn thành công (không lộ token có tồn tại hay không). */
export async function revoke(deps: OauthDeps, raw: string | undefined): Promise<void> {
  if (raw === undefined || raw === "") return;
  const h = sha256(raw);
  const [row] = await deps.db
    .select({ familyId: mcpTokens.familyId })
    .from(mcpTokens)
    .where(or(eq(mcpTokens.accessHash, h), eq(mcpTokens.refreshHash, h)))
    .limit(1);
  if (row === undefined) return;
  await deps.db
    .update(mcpTokens)
    .set({ revokedAt: deps.now() })
    .where(and(eq(mcpTokens.familyId, row.familyId), isNull(mcpTokens.revokedAt)));
}

/** Introspect nội bộ cho apps/mcp, mỗi request (revoke có hiệu lực ngay). Đọc lại role user. */
export async function introspect(deps: OauthDeps, raw: string): Promise<McpIntrospection> {
  const now = deps.now();
  const [row] = await deps.db
    .select({ t: mcpTokens, role: users.role })
    .from(mcpTokens)
    .innerJoin(users, eq(users.id, mcpTokens.userId))
    .where(
      and(
        eq(mcpTokens.accessHash, sha256(raw)),
        isNull(mcpTokens.revokedAt),
        gt(mcpTokens.accessExpiresAt, now),
      ),
    )
    .limit(1);
  if (row === undefined) return { active: false };
  // Ghi lần dùng cuối tối đa mỗi phút một lần.
  if (row.t.lastUsedAt === null || now.getTime() - row.t.lastUsedAt.getTime() > 60_000)
    await deps.db.update(mcpTokens).set({ lastUsedAt: now }).where(eq(mcpTokens.id, row.t.id));
  return {
    active: true,
    tokenId: row.t.id,
    userId: row.t.userId,
    clientId: row.t.clientId,
    scope: row.t.scope as McpScope[],
    resource: row.t.resource,
    team: row.role === UserRole.team,
    expiresAt: row.t.accessExpiresAt.toISOString(),
  };
}

/** Settings › Connected apps: mỗi client một dòng (token còn hiệu lực), gộp scope, lần dùng cuối. */
export async function connectedApps(deps: OauthDeps, userId: string): Promise<ConnectedApps> {
  const now = deps.now();
  const rows = await deps.db
    .select({ t: mcpTokens, c: oauthClients })
    .from(mcpTokens)
    .innerJoin(oauthClients, eq(oauthClients.id, mcpTokens.clientId))
    .where(
      and(
        eq(mcpTokens.userId, userId),
        isNull(mcpTokens.revokedAt),
        isNull(mcpTokens.rotatedAt),
        gt(mcpTokens.refreshExpiresAt, now),
      ),
    );
  const byClient = new Map<string, ConnectedApps["items"][number]>();
  for (const { t, c } of rows) {
    const host =
      c.kind === "cimd" ? new URL(c.id).host : new URL(c.redirectUris[0] ?? "https://unknown").host;
    const cur = byClient.get(c.id);
    const last = t.lastUsedAt?.toISOString() ?? null;
    if (cur === undefined)
      byClient.set(c.id, {
        clientId: c.id,
        name: c.name,
        host,
        scopes: t.scope as McpScope[],
        connectedAt: t.createdAt.toISOString(),
        lastUsedAt: last,
      });
    else {
      cur.scopes = [...new Set([...cur.scopes, ...(t.scope as McpScope[])])];
      if (last !== null && (cur.lastUsedAt === null || last > cur.lastUsedAt))
        cur.lastUsedAt = last;
      if (t.createdAt.toISOString() < cur.connectedAt) cur.connectedAt = t.createdAt.toISOString();
    }
  }
  return { items: [...byClient.values()] };
}

/** Revoke một app ở Settings: thu hồi mọi token của user cho client đó, có hiệu lực ngay. */
export async function revokeApp(deps: OauthDeps, userId: string, clientId: string): Promise<void> {
  await deps.db
    .update(mcpTokens)
    .set({ revokedAt: deps.now() })
    .where(
      and(
        eq(mcpTokens.userId, userId),
        eq(mcpTokens.clientId, clientId),
        isNull(mcpTokens.revokedAt),
      ),
    );
}
