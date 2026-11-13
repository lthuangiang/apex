import { createHash, randomUUID } from "node:crypto";

import type { McpIntrospection, McpScope } from "@drift/shared";
// Subpath của "exports" trong package SDK: TypeScript resolve được, plugin import của eslint thì không.
// eslint-disable-next-line import/no-unresolved
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// eslint-disable-next-line import/no-unresolved
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { z } from "zod";

import { ApiCallError, type ApiClient, type McpCallRecord } from "./api-client";
import { checkLimits, type Counter } from "./rate-limit";

// DeskLabs MCP server (docs/MCP.md mục 3, DEC-167, DEC-217). Resource server OAuth: kiểm tra token bằng
// introspect của api ở MỌI request (revoke có hiệu lực ngay), token phải được cấp cho đúng endpoint (RFC 8707), scope
// đủ (403 insufficient_scope), rồi chạy MCP Streamable HTTP không trạng thái. Chỉ tool đọc / bản nháp: không tool nào
// đặt lệnh, đổi bot hay chuyển tiền. Mọi lần gọi tool ghi `mcp_calls` (hash tham số, không lưu kết quả).

export type Endpoint = "user" | "team";
type Active = Extract<McpIntrospection, { active: true }>;

export interface ToolContext {
  token: string;
  introspection: Active;
  api: ApiClient;
  now: () => Date;
}

export interface ToolDef {
  name: string;
  endpoint: Endpoint;
  /** Scope cần có để thấy và gọi tool. */
  scope: McpScope;
  title: string;
  description: string;
  input: z.ZodRawShape;
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

export interface McpAppDeps {
  api: ApiClient;
  counter: Counter;
  /** Gốc công khai của MCP, ví dụ `https://mcp.desklabs.xyz`. */
  publicUrl: string;
  /** Issuer của authorization server, ví dụ `https://desklabs.xyz`. */
  issuer: string;
  tools: readonly ToolDef[];
  now?: () => Date;
  logLevel?: string;
}

/** docs/MCP.md mục 6: tối đa 64 KB mỗi kết quả. */
const MAX_RESULT_BYTES = 64 * 1024;
const TOO_LARGE = "The result is too large. Narrow the time range or lower `limit`.";

class ToolFailure extends Error {
  constructor(readonly userMessage: string) {
    super(userMessage);
    this.name = "ToolFailure";
  }
}

/** Câu lỗi cho client: chỉ những gì an toàn để nói (không chi tiết nội bộ, không token). */
function toolErrorText(err: unknown): string {
  if (err instanceof ToolFailure) return err.userMessage;
  if (err instanceof ApiCallError) {
    if (err.status === 404) return "Not found.";
    if (err.status === 400) {
      const body = err.body as { error?: { message?: unknown } } | null;
      const msg = body?.error?.message;
      return typeof msg === "string" && msg.length <= 200
        ? `Invalid input: ${msg}`
        : "Invalid input.";
    }
    if (err.status === 401 || err.status === 403) return "Access denied.";
  }
  return "DeskLabs couldn't answer this right now. Try again.";
}

const PATH: Record<Endpoint, string> = { user: "/mcp", team: "/team/mcp" };
const REQUIRED: Record<Endpoint, McpScope> = { user: "read", team: "team:read" };

const canonical = (raw: string) => {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};

export function buildMcpApp(deps: McpAppDeps): FastifyInstance {
  const app = Fastify({
    logger: {
      level: deps.logLevel ?? "info",
      redact: [
        "req.headers.authorization",
        'req.headers["x-mcp-introspect-secret"]',
        'req.headers["x-mcp-token"]',
      ],
    },
    genReqId: () => randomUUID(),
    bodyLimit: 256 * 1024,
  });
  const base = deps.publicUrl.replace(/\/+$/, "");
  const now = deps.now ?? (() => new Date());
  const resourceOf = (e: Endpoint) => `${base}${PATH[e]}`;
  const metadataUrl = (e: Endpoint) => `${base}/.well-known/oauth-protected-resource${PATH[e]}`;

  // RFC 9728: Protected Resource Metadata, chèn path của resource sau `/.well-known/oauth-protected-resource`.
  const prm = (e: Endpoint) => ({
    resource: resourceOf(e),
    authorization_servers: [deps.issuer.replace(/\/+$/, "")],
    scopes_supported: e === "team" ? ["team:read"] : ["read", "draft"],
    bearer_methods_supported: ["header"],
    resource_name: e === "team" ? "DeskLabs team tools" : "DeskLabs",
  });
  app.get("/.well-known/oauth-protected-resource", () => prm("user"));
  app.get("/.well-known/oauth-protected-resource/mcp", () => prm("user"));
  app.get("/.well-known/oauth-protected-resource/team/mcp", () => prm("team"));
  app.get("/healthz", () => ({ ok: true }));

  const challenge = (reply: FastifyReply, e: Endpoint, status: 401 | 403, error?: string) => {
    const params = [
      ...(error === undefined ? [] : [`error="${error}"`]),
      `scope="${REQUIRED[e]}"`,
      `resource_metadata="${metadataUrl(e)}"`,
    ];
    return reply
      .status(status)
      .header("www-authenticate", `Bearer ${params.join(", ")}`)
      .send({ error: error ?? "unauthorized" });
  };

  const record = (row: McpCallRecord) => {
    void deps.api.recordCall(row).catch((err: unknown) => {
      app.log.warn(
        { err: err instanceof Error ? err.message : "unknown", tool: row.tool },
        "mcp call log failed",
      );
    });
  };

  const handle = async (e: Endpoint, request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    const token =
      typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token === "") return challenge(reply, e, 401);
    let intro: McpIntrospection;
    try {
      intro = await deps.api.introspect(token);
    } catch (err) {
      request.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "introspect failed",
      );
      return reply.status(503).send({ error: "temporarily_unavailable" });
    }
    if (!intro.active) return challenge(reply, e, 401, "invalid_token");
    // RFC 8707: chỉ nhận token cấp cho đúng endpoint này.
    if (canonical(intro.resource) !== canonical(resourceOf(e)))
      return challenge(reply, e, 401, "invalid_token");
    const allowed =
      e === "team" ? intro.scope.includes("team:read") && intro.team : intro.scope.includes("read");
    if (!allowed) {
      record({
        tokenId: intro.tokenId,
        userId: intro.userId,
        clientId: intro.clientId,
        endpoint: e,
        tool: "-",
        argsHash: null,
        durationMs: 0,
        status: "denied",
        traceId: request.id,
      });
      return challenge(reply, e, 403, "insufficient_scope");
    }
    let limited: Awaited<ReturnType<typeof checkLimits>>;
    try {
      limited = await checkLimits(deps.counter, intro, e === "team");
    } catch (err) {
      // Redis lỗi: không cho qua khi không đếm được, nhưng trả 503 (tạm thời), không 500.
      request.log.error(
        { err: err instanceof Error ? err.message : "unknown" },
        "rate limit failed",
      );
      return reply.status(503).send({ error: "temporarily_unavailable" });
    }
    if (limited !== null) {
      record({
        tokenId: intro.tokenId,
        userId: intro.userId,
        clientId: intro.clientId,
        endpoint: e,
        tool: "-",
        argsHash: null,
        durationMs: 0,
        status: "rate_limited",
        traceId: request.id,
      });
      return reply
        .status(429)
        .header("retry-after", limited === "per_minute" ? "60" : "3600")
        .send({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              limited === "per_minute"
                ? "Too many DeskLabs requests this minute. Try again shortly."
                : "Daily DeskLabs request limit reached. Try again tomorrow.",
          },
          id: null,
        });
    }

    // Một server MCP mỗi request (không trạng thái): chỉ tool của endpoint này và trong scope của token.
    const server = new McpServer(
      { name: e === "team" ? "desklabs-team" : "desklabs", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    const ctx: ToolContext = { token, introspection: intro, api: deps.api, now };
    for (const tool of deps.tools) {
      if (tool.endpoint !== e || !intro.scope.includes(tool.scope)) continue;
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
          annotations: { readOnlyHint: true, openWorldHint: false },
        },
        async (args: Record<string, unknown>) => {
          const started = Date.now();
          const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
          try {
            const result = await tool.run(ctx, args);
            const text = JSON.stringify(result);
            if (Buffer.byteLength(text) > MAX_RESULT_BYTES) throw new ToolFailure(TOO_LARGE);
            record({
              tokenId: intro.tokenId,
              userId: intro.userId,
              clientId: intro.clientId,
              endpoint: e,
              tool: tool.name,
              argsHash,
              durationMs: Date.now() - started,
              status: "ok",
              traceId: request.id,
            });
            return {
              content: [{ type: "text" as const, text }],
              structuredContent: result as Record<string, unknown>,
            };
          } catch (err) {
            record({
              tokenId: intro.tokenId,
              userId: intro.userId,
              clientId: intro.clientId,
              endpoint: e,
              tool: tool.name,
              argsHash,
              durationMs: Date.now() - started,
              status: "error",
              traceId: request.id,
            });
            request.log.warn(
              { err: err instanceof Error ? err.name : "unknown", tool: tool.name },
              "tool failed",
            );
            return {
              isError: true,
              content: [{ type: "text" as const, text: toolErrorText(err) }],
            };
          }
        },
      );
    }
    // Không trạng thái: không truyền `sessionIdGenerator` (SDK coi như không có phiên).
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });
    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, request.body);
    return reply;
  };

  for (const e of ["user", "team"] as const) {
    app.post(PATH[e], (request, reply) => handle(e, request, reply));
    // Không trạng thái: không có luồng SSE GET hay DELETE phiên.
    app.get(PATH[e], (_request, reply) => reply.status(405).header("allow", "POST").send());
    app.delete(PATH[e], (_request, reply) => reply.status(405).header("allow", "POST").send());
  }
  return app;
}
