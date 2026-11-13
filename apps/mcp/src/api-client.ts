import { mcpIntrospectionSchema, type McpIntrospection } from "@drift/shared";

// apps/mcp chỉ gọi api (DEC-167): introspect token mỗi request và ghi nhật ký `mcp_calls`, cả hai qua endpoint nội bộ có
// shared secret (`MCP_INTROSPECT_SECRET`, không bao giờ log). Không chạm signer, engine, SoDEX hay database.

export const INTROSPECT_SECRET_HEADER = "x-mcp-introspect-secret";

export interface McpCallRecord {
  tokenId: string | null;
  userId: string | null;
  clientId: string | null;
  endpoint: "user" | "team";
  tool: string;
  argsHash: string | null;
  durationMs: number;
  status: "ok" | "error" | "denied" | "rate_limited";
  traceId: string;
}

export interface ApiClient {
  introspect(token: string): Promise<McpIntrospection>;
  recordCall(row: McpCallRecord): Promise<void>;
  /** GET nội bộ cho tool (A3+): gửi kèm token của user để api tự kiểm tra scope và quyền sở hữu. */
  get(path: string, token: string): Promise<unknown>;
  /** Step-up (B3): kết thúc refresh của family token này để client phải chạy lại OAuth với scope mới. */
  stepUp(token: string): Promise<void>;
  /** POST nội bộ cho tool ghi bản nháp (B3); api tự kiểm tra scope `draft`. */
  post(path: string, token: string, body: unknown): Promise<unknown>;
}

export function httpApiClient(
  baseUrl: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  const base = baseUrl.replace(/\/+$/, "");
  const headers = { [INTROSPECT_SECRET_HEADER]: secret };
  return {
    async introspect(token) {
      const res = await fetchImpl(`${base}/api/v1/oauth/introspect`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`introspect failed: HTTP ${String(res.status)}`);
      return mcpIntrospectionSchema.parse(await res.json());
    },
    async recordCall(row) {
      const res = await fetchImpl(`${base}/api/v1/mcp/calls`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(row),
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`record call failed: HTTP ${String(res.status)}`);
    },
    async stepUp(token) {
      const res = await fetchImpl(`${base}/api/v1/mcp/step-up`, {
        method: "POST",
        headers: { ...headers, "x-mcp-token": token },
        signal: AbortSignal.timeout(3_000),
      });
      if (!res.ok) throw new Error(`step-up failed: HTTP ${String(res.status)}`);
    },
    async post(path, token, body) {
      const res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          ...headers,
          "x-mcp-token": token,
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      const out: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new ApiCallError(res.status, out);
      return out;
    },
    async get(path, token) {
      const res = await fetchImpl(`${base}${path}`, {
        headers: { ...headers, "x-mcp-token": token, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) throw new ApiCallError(res.status, body);
      return body;
    },
  };
}

export class ApiCallError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`api returned HTTP ${String(status)}`);
    this.name = "ApiCallError";
  }
}
