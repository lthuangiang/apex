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
import { PROMPTS } from "./prompts";
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
  /** false: tool ghi (chỉ bản nháp, scope `draft`); mặc định chỉ đọc. */
  readOnly?: boolean;
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
    const body = err.body as {
      error?: { message?: unknown; details?: { fieldErrors?: unknown } };
    } | null;
    const msg = body?.error?.message;
    const safe = typeof msg === "string" && msg.length <= 200 ? msg : null;
    if (err.status === 400) {
      // Lỗi từng field của cấu hình (zod của chiến lược) để client sửa lại bản nháp; tối đa 10 field.
      const fe = body?.error?.details?.fieldErrors;
      const fields =
        typeof fe === "object" && fe !== null
          ? Object.entries(fe as Record<string, unknown>)
              .slice(0, 10)
              .map(
                ([k, v]) =>
                  `${k.slice(0, 60)}: ${Array.isArray(v) ? v.map(String).join(", ").slice(0, 120) : ""}`,
              )
          : [];
      return [safe === null ? "Invalid input." : `Invalid input: ${safe}`, ...fields].join("\n");
    }
    // 409: câu của DeskLabs (ví dụ đủ 20 bản nháp, bot không sửa được ở trạng thái này).
    if (err.status === 409 && safe !== null) return safe;
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
  const draftTools = new Set(deps.tools.filter((t) => t.scope === "draft").map((t) => t.name));
  /** Tên tool bản nháp được gọi trong body JSON-RPC (một message hoặc batch). */
  const draftCallsIn = (body: unknown): string[] =>
    (Array.isArray(body) ? body : [body]).flatMap((m: unknown) => {
      if (typeof m !== "object" || m === null) return [];
      const msg = m as { method?: unknown; params?: { name?: unknown } };
      const name = msg.params?.name;
      return msg.method === "tools/call" && typeof name === "string" && draftTools.has(name)
        ? [name]
        : [];
    });
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

  const challenge = (
    reply: FastifyReply,
    e: Endpoint,
    status: 401 | 403,
    error?: string,
    scope: string = REQUIRED[e],
  ) => {
    const params = [
      ...(error === undefined ? [] : [`error="${error}"`]),
      `scope="${scope}"`,
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

    // Step-up (DEC-223, PM chốt phương án C): token chỉ có `read` vẫn thấy tool bản nháp, nhưng gọi tool đó
    // (kể cả nằm trong batch) thì trả 403 `insufficient_scope` với scope="read draft" ở tầng HTTP, trước khi chạy tool.
    // api kết thúc refresh của family token cũ để client chạy lại OAuth (màn consent) thay vì refresh ra token cũ.
    if (e === "user" && !intro.scope.includes("draft")) {
      const wanted = draftCallsIn(request.body);
      if (wanted.length > 0) {
        for (const tool of wanted)
          record({
            tokenId: intro.tokenId,
            userId: intro.userId,
            clientId: intro.clientId,
            endpoint: e,
            tool,
            argsHash: null,
            durationMs: 0,
            status: "denied",
            traceId: request.id,
          });
        await deps.api.stepUp(token).catch((err: unknown) => {
          request.log.warn(
            { err: err instanceof Error ? err.message : "unknown" },
            "step-up refresh end failed",
          );
        });
        return challenge(reply, e, 403, "insufficient_scope", "read draft");
      }
    }

    // Một server MCP mỗi request (không trạng thái): chỉ tool của endpoint này và trong scope của token.
    const server = new McpServer(
      { name: e === "team" ? "desklabs-team" : "desklabs", version: "1.0.0" },
      { capabilities: e === "user" ? { tools: {}, prompts: {} } : { tools: {} } },
    );
    const ctx: ToolContext = { token, introspection: intro, api: deps.api, now };
    for (const tool of deps.tools) {
      // Tool bản nháp hiện cho token `read` (step-up khi gọi), các tool khác cần đúng scope.
      const visible =
        intro.scope.includes(tool.scope) ||
        (tool.scope === "draft" && intro.scope.includes("read"));
      if (tool.endpoint !== e || !visible) continue;
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
          annotations:
            tool.readOnly === false
              ? {
                  readOnlyHint: false,
                  destructiveHint: false,
                  idempotentHint: false,
                  openWorldHint: false,
                }
              : { readOnlyHint: true, openWorldHint: false },
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
    // Prompts có sẵn (B4): chỉ ở endpoint người dùng, cần scope `read` (đã kiểm tra ở trên).
    if (e === "user")
      for (const p of PROMPTS)
        server.registerPrompt(
          p.name,
          { title: p.title, description: p.description, argsSchema: p.args },
          (args: Record<string, string | undefined>) => ({
            messages: [
              { role: "user" as const, content: { type: "text" as const, text: p.text(args) } },
            ],
          }),
        );
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
