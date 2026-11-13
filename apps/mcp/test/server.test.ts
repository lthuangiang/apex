import type { McpIntrospection } from "@drift/shared";
// eslint-disable-next-line import/no-unresolved
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import/no-unresolved
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ApiClient, McpCallRecord } from "../src/api-client";
import { memoryCounter } from "../src/rate-limit";
import { buildMcpApp } from "../src/server";
import { TOOLS } from "../src/tools";

// DeskLabs MCP server (DEC-167, DEC-TBD-mcp-server): introspect mỗi request, audience (RFC 8707), scope, role team,
// rate limit, nhật ký `mcp_calls` chỉ có hash tham số. api là bản giả; client là SDK MCP chính thức.

const PUBLIC = "https://mcp.desklabs.test";
const base = (over: Partial<Extract<McpIntrospection, { active: true }>>) => ({
  active: true as const,
  tokenId: "00000000-0000-4000-8000-000000000001",
  userId: "00000000-0000-4000-8000-000000000002",
  clientId: "dlc_x",
  scope: ["read" as const],
  resource: `${PUBLIC}/mcp`,
  team: false,
  expiresAt: "2026-11-13T12:00:00.000Z",
  ...over,
});
const TOKENS: Record<string, McpIntrospection> = {
  user: base({}),
  team: base({
    tokenId: "00000000-0000-4000-8000-0000000000aa",
    scope: ["team:read"],
    resource: `${PUBLIC}/team/mcp`,
    team: true,
  }),
  "team-removed": base({ scope: ["team:read"], resource: `${PUBLIC}/team/mcp`, team: false }),
  "user-on-team": base({ resource: `${PUBLIC}/team/mcp` }),
  "other-audience": base({ resource: "https://evil.example/mcp" }),
};

const calls: McpCallRecord[] = [];
const api: ApiClient = {
  introspect: (t) => Promise.resolve(TOKENS[t] ?? { active: false }),
  recordCall: (row) => {
    calls.push(row);
    return Promise.resolve();
  },
  get: () => Promise.reject(new Error("not used")),
};

let app: FastifyInstance;
let url: string;
beforeAll(async () => {
  app = buildMcpApp({
    api,
    counter: memoryCounter(),
    publicUrl: PUBLIC,
    issuer: "https://desklabs.test",
    tools: TOOLS,
    logLevel: "silent",
  });
  url = await app.listen({ host: "127.0.0.1", port: 0 });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  calls.length = 0;
});

async function connect(path: string, token: string) {
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}${path}`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

const post = (path: string, token?: string) =>
  app.inject({
    method: "POST",
    url: path,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });

describe("MCP server", () => {
  it("publishes protected resource metadata that points at the DeskLabs issuer", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource/team/mcp",
    });
    expect(r.json()).toEqual({
      resource: `${PUBLIC}/team/mcp`,
      authorization_servers: ["https://desklabs.test"],
      scopes_supported: ["team:read"],
      bearer_methods_supported: ["header"],
      resource_name: "DeskLabs team tools",
    });
    const u = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource/mcp" });
    expect(u.json()).toMatchObject({
      resource: `${PUBLIC}/mcp`,
      scopes_supported: ["read", "draft"],
    });
  });

  it("asks for a token, rejects unknown tokens and tokens issued for another server", async () => {
    const none = await post("/mcp");
    expect(none.statusCode).toBe(401);
    expect(none.headers["www-authenticate"]).toBe(
      `Bearer scope="read", resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp"`,
    );
    const bad = await post("/mcp", "nope");
    expect(bad.statusCode).toBe(401);
    expect(bad.headers["www-authenticate"]).toContain('error="invalid_token"');
    expect((await post("/mcp", "other-audience")).statusCode).toBe(401);
    expect((await post("/team/mcp", "user")).statusCode).toBe(401);
  });

  it("keeps team tools behind team:read and the team role, checked on every request", async () => {
    const userOnTeam = await post("/team/mcp", "user-on-team");
    expect(userOnTeam.statusCode).toBe(403);
    expect(userOnTeam.headers["www-authenticate"]).toContain('error="insufficient_scope"');
    // Role bị gỡ: introspect báo team=false → 403 ngay, dù token vẫn có team:read.
    expect((await post("/team/mcp", "team-removed")).statusCode).toBe(403);
    expect(calls.map((c) => c.status)).toEqual(["denied", "denied"]);

    const team = await connect("/team/mcp", "team");
    expect((await team.listTools()).tools.map((t) => t.name)).toEqual(["team_reason_code"]);
    const r = await team.callTool({
      name: "team_reason_code",
      arguments: { code: "risk_daily_loss" },
    });
    expect(r.structuredContent).toMatchObject({
      code: "RISK_DAILY_LOSS",
      outcome: "paused",
      source: "docs/DOMAIN.md 7.2",
    });
    const unknown = await team.callTool({ name: "team_reason_code", arguments: { code: "NOPE" } });
    expect(unknown.structuredContent).toMatchObject({ info: null, reason: "unknown_code" });
    await team.close();
    // Nhật ký: tên tool, hash tham số, không có tham số gốc.
    const logged = calls.filter((c) => c.tool === "team_reason_code");
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      endpoint: "team",
      status: "ok",
      tokenId: "00000000-0000-4000-8000-0000000000aa",
    });
    expect(logged[0]?.argsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(calls)).not.toContain("risk_daily_loss");

    // Endpoint người dùng không thấy tool nội bộ.
    const user = await connect("/mcp", "user");
    expect((await user.listTools()).tools).toEqual([]);
    await user.close();
  });

  it("limits a team token to 120 requests a minute with a clear error", async () => {
    const limited = buildMcpApp({
      api,
      counter: memoryCounter(),
      publicUrl: PUBLIC,
      issuer: "https://desklabs.test",
      tools: TOOLS,
      logLevel: "silent",
    });
    const codes: number[] = [];
    for (let i = 0; i < 121; i++)
      codes.push(
        (
          await limited.inject({
            method: "POST",
            url: "/team/mcp",
            headers: {
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              authorization: "Bearer team",
            },
            payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
          })
        ).statusCode,
      );
    expect(codes.slice(0, 120).every((c) => c === 200)).toBe(true);
    expect(codes[120]).toBe(429);
    await limited.close();
  });
});
