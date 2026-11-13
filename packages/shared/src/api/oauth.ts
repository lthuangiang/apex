import { z } from "zod";

import { isoDateTimeSchema } from "../schemas";

// OAuth 2.1 cho MCP (docs/MCP.md mục 4, DEC-167, DEC-TBD-mcp-oauth). Authorization server nằm trong api; MCP server
// (`apps/mcp`) là resource server, kiểm tra token bằng introspect nội bộ mỗi request.

export const MCP_SCOPES = ["read", "draft", "team:read"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const OAUTH_CONFIG = {
  /** Access token 1 giờ, refresh 30 ngày (xoay mỗi lần dùng). */
  accessTtlMs: 60 * 60_000,
  refreshTtlMs: 30 * 86_400_000,
  /** Authorization code dùng một lần, sống 5 phút. */
  codeTtlMs: 5 * 60_000,
  /** Đăng ký client động: 10 lần / giờ / IP; client không dùng 30 ngày thì xoá. */
  registerPerHourPerIp: 10,
  clientIdleDeleteMs: 30 * 86_400_000,
  /** Client ID Metadata Document: cache 1 giờ, tối đa 16 KB, timeout 3 s. */
  cimdCacheMs: 60 * 60_000,
  cimdMaxBytes: 16 * 1024,
  cimdTimeoutMs: 3_000,
} as const;

/** Giới hạn gọi MCP (PM chốt, thay 2.000/ngày của DEC-167): theo token mỗi phút, theo user mỗi ngày. */
export const MCP_RATE_LIMITS = {
  perTokenPerMinute: 60,
  teamPerTokenPerMinute: 120,
  perUserPerDay: 5_000,
} as const;

/** Thông tin màn consent (web `/oauth/consent`), do api kiểm tra tham số authorize trước. */
export const oauthConsentInfoSchema = z.object({
  client: z.object({
    /** Tên do client tự khai: không tin cậy, chỉ hiện kèm `host`. */
    name: z.string().nullable(),
    /** Host của URL client_id (CIMD) hoặc của redirect_uri (đăng ký động). */
    host: z.string(),
  }),
  scopes: z.array(z.enum(MCP_SCOPES)),
  /** Scope client xin nhưng user không được cấp (ví dụ `team:read` với user thường). */
  denied: z.array(z.enum(MCP_SCOPES)),
  /** Chưa kết nối SoDEX: không cấp `read` / `draft` (DEC-167). */
  needsSodex: z.boolean(),
});
export type OauthConsentInfo = z.infer<typeof oauthConsentInfoSchema>;

/** Kết quả Allow / Deny: web chuyển trình duyệt tới `redirect`. */
export const oauthDecisionSchema = z.object({ redirect: z.string() });

/** Settings › Connected apps. */
export const connectedAppsSchema = z.object({
  items: z.array(
    z.object({
      clientId: z.string(),
      name: z.string().nullable(),
      host: z.string(),
      scopes: z.array(z.enum(MCP_SCOPES)),
      connectedAt: isoDateTimeSchema,
      lastUsedAt: isoDateTimeSchema.nullable(),
    }),
  ),
});
export type ConnectedApps = z.infer<typeof connectedAppsSchema>;

/** Kết quả introspect nội bộ (api → apps/mcp). `active = false` thì không có field nào khác. */
export const mcpIntrospectionSchema = z.discriminatedUnion("active", [
  z.object({ active: z.literal(false) }),
  z.object({
    active: z.literal(true),
    tokenId: z.string(),
    userId: z.string(),
    clientId: z.string(),
    scope: z.array(z.enum(MCP_SCOPES)),
    resource: z.string(),
    /** Role hiện tại của user (đọc lại mỗi request): `team:read` chỉ có hiệu lực khi role là team. */
    team: z.boolean(),
    expiresAt: isoDateTimeSchema,
  }),
]);
export type McpIntrospection = z.infer<typeof mcpIntrospectionSchema>;
