import { createHash, randomBytes } from "node:crypto";

import { connectedAppsSchema, meSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// OAuth 2.1 cho MCP (docs/MCP.md mục 4, DEC-167, DEC-215): đăng ký client, consent, PKCE, resource, token
// xoay, phát hiện dùng lại refresh, quyền theo SoDEX / role team, revoke có hiệu lực ngay, introspect nội bộ.

const SECRET = "test-introspect-secret-0123456789abcdef";
const RESOURCE = "https://mcp.desklabs.test/mcp";
const TEAM_RESOURCE = "https://mcp.desklabs.test/team/mcp";
const REDIRECT = "https://claude.example/api/mcp/auth_callback";
const CIMD_ID = "https://claude.ai/oauth/claude-code-client-metadata";

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv({
    oauth: {
      issuer: "https://desklabs.test",
      mcpPublicUrl: "https://mcp.desklabs.test",
      introspectSecret: SECRET,
      // Client ID Metadata Document giả (không gọi mạng): một client hợp lệ.
      cimd: {
        lookup: () => Promise.resolve([{ address: "93.184.216.34", family: 4 }]),
        get: () =>
          Promise.resolve({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              client_id: CIMD_ID,
              client_name: "Claude Code",
              redirect_uris: ["http://127.0.0.1:33418/callback"],
            }),
          }),
      },
    },
  });
});
afterAll(async () => {
  await env.close();
});

const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

async function register(redirect = REDIRECT): Promise<string> {
  const r = await env.app.inject({
    method: "POST",
    url: "/api/v1/oauth/register",
    payload: { client_name: "Claude", redirect_uris: [redirect] },
  });
  expect(r.statusCode).toBe(201);
  return r.json<{ client_id: string }>().client_id;
}

async function user(email: string, opts: { sodex?: boolean; team?: boolean } = {}) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  if (opts.sodex !== false)
    await env.pool.query(
      "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected')",
      [me.id, `0x${randomBytes(20).toString("hex")}`, Math.floor(Math.random() * 1e9)],
    );
  if (opts.team === true)
    await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
  return { client, userId: me.id };
}

const query = (p: Record<string, string>) => new URLSearchParams(p).toString();

async function authorize(
  client: TestClient,
  clientId: string,
  challenge: string,
  extra: Record<string, string> = {},
  allow = true,
) {
  const params = {
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: RESOURCE,
    scope: "read",
    state: "st-1",
    ...extra,
  };
  const info = await client.request("GET", `/api/v1/oauth/authorize?${query(params)}`);
  const decided = await client.request("POST", "/api/v1/oauth/authorize", {
    body: { ...params, allow },
  });
  return { info, decided, redirect: new URL(decided.json<{ redirect: string }>().redirect) };
}

const form = (url: string, body: Record<string, string>) =>
  env.app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: query(body),
  });

const introspect = async (token: string) =>
  (
    await env.app.inject({
      method: "POST",
      url: "/api/v1/oauth/introspect",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-mcp-introspect-secret": SECRET,
      },
      payload: query({ token }),
    })
  ).json<{ active: boolean; scope?: string[]; team?: boolean; resource?: string }>();

interface Tokens {
  access_token: string;
  refresh_token: string;
  scope: string;
  expires_in: number;
}

describe("OAuth for MCP", () => {
  it("publishes authorization server metadata with PKCE, CIMD and iss", async () => {
    const r = await env.app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(r.json()).toMatchObject({
      issuer: "https://desklabs.test",
      authorization_endpoint: "https://desklabs.test/oauth/authorize",
      token_endpoint: "https://desklabs.test/api/v1/oauth/token",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it("runs the whole flow, rotates refresh tokens and revokes the family on reuse", async () => {
    const clientId = await register();
    const { client } = await user("oauth-flow@example.com");
    const { verifier, challenge } = pkce();
    const { info, redirect } = await authorize(client, clientId, challenge);
    expect(info.json()).toMatchObject({
      consent: {
        client: { name: "Claude", host: "claude.example" },
        scopes: ["read"],
        needsSodex: false,
      },
    });
    expect(redirect.searchParams.get("state")).toBe("st-1");
    expect(redirect.searchParams.get("iss")).toBe("https://desklabs.test");
    const code = redirect.searchParams.get("code") ?? "";

    // PKCE sai → từ chối; code vẫn dùng được đúng một lần sau đó? Không: lần đổi đầu đã đánh dấu used.
    const bad = await form("/api/v1/oauth/token", {
      grant_type: "authorization_code",
      code,
      code_verifier: "x".repeat(43),
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: RESOURCE,
    });
    expect(bad.json()).toMatchObject({ error: "invalid_grant" });

    const { verifier: v2, challenge: c2 } = pkce();
    const second = await authorize(client, clientId, c2);
    const code2 = second.redirect.searchParams.get("code") ?? "";
    const wrongResource = await form("/api/v1/oauth/token", {
      grant_type: "authorization_code",
      code: code2,
      code_verifier: v2,
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: "https://evil.example/mcp",
    });
    expect(wrongResource.json()).toMatchObject({ error: "invalid_target" });

    const { verifier: v3, challenge: c3 } = pkce();
    const third = await authorize(client, clientId, c3);
    const exchange = () =>
      form("/api/v1/oauth/token", {
        grant_type: "authorization_code",
        code: third.redirect.searchParams.get("code") ?? "",
        code_verifier: v3,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
      });
    const ok = await exchange();
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    const t = ok.json<Tokens>();
    expect(t).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "read" });
    expect((await exchange()).json()).toMatchObject({ error: "invalid_grant" });
    expect(await introspect(t.access_token)).toMatchObject({
      active: true,
      scope: ["read"],
      resource: RESOURCE,
      team: false,
    });
    expect(verifier).toBeDefined();

    // Xoay refresh: token mới chạy; dùng lại refresh cũ → thu hồi cả họ.
    const refreshed = (
      await form("/api/v1/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
        client_id: clientId,
      })
    ).json<Tokens>();
    expect(await introspect(refreshed.access_token)).toMatchObject({ active: true });
    const reuse = await form("/api/v1/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: clientId,
    });
    expect(reuse.json()).toMatchObject({ error: "invalid_grant" });
    expect(await introspect(refreshed.access_token)).toEqual({ active: false });
  });

  it("grants read only after SoDEX is connected, and team:read only to the team", async () => {
    const clientId = await register();
    const fresh = await user("oauth-nosodex@example.com", { sodex: false });
    const a = await authorize(fresh.client, clientId, pkce().challenge, {
      scope: "read team:read",
    });
    expect(a.info.json()).toMatchObject({
      consent: { scopes: [], denied: ["read", "team:read"], needsSodex: true },
    });
    expect(a.redirect.searchParams.get("error")).toBe("access_denied");

    const plain = await user("oauth-plain@example.com");
    const b = await authorize(plain.client, clientId, pkce().challenge, {
      scope: "read team:read",
    });
    expect(b.info.json()).toMatchObject({ consent: { scopes: ["read"], denied: ["team:read"] } });

    const team = await user("oauth-team@example.com", { team: true });
    const { verifier, challenge } = pkce();
    const c = await authorize(team.client, clientId, challenge, {
      scope: "team:read",
      resource: TEAM_RESOURCE,
    });
    const t = (
      await form("/api/v1/oauth/token", {
        grant_type: "authorization_code",
        code: c.redirect.searchParams.get("code") ?? "",
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: TEAM_RESOURCE,
      })
    ).json<Tokens>();
    expect(await introspect(t.access_token)).toMatchObject({
      active: true,
      scope: ["team:read"],
      team: true,
    });
    // Gỡ role: introspect báo `team: false` ngay request sau (apps/mcp từ chối /team/mcp).
    await env.pool.query("update users set role = 'user' where id = $1", [team.userId]);
    expect(await introspect(t.access_token)).toMatchObject({ team: false });
  });

  it("lists connected apps and revokes one at once; expired tokens are inactive", async () => {
    const clientId = await register();
    const { client } = await user("oauth-apps@example.com");
    const { verifier, challenge } = pkce();
    const a = await authorize(client, clientId, challenge);
    const t = (
      await form("/api/v1/oauth/token", {
        grant_type: "authorization_code",
        code: a.redirect.searchParams.get("code") ?? "",
        code_verifier: verifier,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
      })
    ).json<Tokens>();
    const apps = connectedAppsSchema.parse(
      (await client.request("GET", "/api/v1/oauth/apps")).json(),
    );
    expect(apps.items).toEqual([
      expect.objectContaining({ clientId, name: "Claude", host: "claude.example" }),
    ]);
    const del = await client.request(
      "DELETE",
      `/api/v1/oauth/apps/${encodeURIComponent(clientId)}`,
    );
    expect(del.statusCode).toBe(204);
    expect(await introspect(t.access_token)).toEqual({ active: false });

    const { verifier: v2, challenge: c2 } = pkce();
    const b = await authorize(client, clientId, c2);
    const t2 = (
      await form("/api/v1/oauth/token", {
        grant_type: "authorization_code",
        code: b.redirect.searchParams.get("code") ?? "",
        code_verifier: v2,
        client_id: clientId,
        redirect_uri: REDIRECT,
        resource: RESOURCE,
      })
    ).json<Tokens>();
    const saved = env.clock.now;
    env.clock.now = new Date(saved.getTime() + 61 * 60_000);
    expect(await introspect(t2.access_token)).toEqual({ active: false });
    env.clock.now = saved;
  });

  it("never redirects to an unregistered redirect_uri, and rejects a missing resource or PKCE", async () => {
    const clientId = await register();
    const { client } = await user("oauth-bad@example.com");
    const bad = await client.request(
      "GET",
      `/api/v1/oauth/authorize?${query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: "https://evil.example/cb",
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
        resource: RESOURCE,
      })}`,
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toMatchObject({ error: "invalid_request" });
    const noResource = await client.request(
      "GET",
      `/api/v1/oauth/authorize?${query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: "S256",
      })}`,
    );
    expect(
      new URL(noResource.json<{ redirect: string }>().redirect).searchParams.get("error"),
    ).toBe("invalid_target");
    const plain = await client.request(
      "GET",
      `/api/v1/oauth/authorize?${query({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_challenge: pkce().challenge,
        code_challenge_method: "plain",
        resource: RESOURCE,
      })}`,
    );
    expect(new URL(plain.json<{ redirect: string }>().redirect).searchParams.get("error")).toBe(
      "invalid_request",
    );
  });

  it("rejects registrations with unsafe redirect URIs, and rate limits them", async () => {
    const r = await env.app.inject({
      method: "POST",
      url: "/api/v1/oauth/register",
      payload: { redirect_uris: ["http://claude.example/cb"] },
    });
    expect(r.json()).toMatchObject({ error: "invalid_redirect_uri" });
    const loopback = await env.app.inject({
      method: "POST",
      url: "/api/v1/oauth/register",
      payload: { redirect_uris: ["http://127.0.0.1:33418/callback"] },
      remoteAddress: "203.0.113.9",
    });
    expect(loopback.statusCode).toBe(201);
    const codes: number[] = [];
    for (let i = 0; i < 11; i++)
      codes.push(
        (
          await env.app.inject({
            method: "POST",
            url: "/api/v1/oauth/register",
            payload: { redirect_uris: [REDIRECT] },
            remoteAddress: "203.0.113.10",
          })
        ).statusCode,
      );
    expect(codes.filter((c) => c === 201)).toHaveLength(10);
    expect(codes.at(-1)).toBe(429);
  });

  it("refuses introspection without the shared secret", async () => {
    const r = await env.app.inject({
      method: "POST",
      url: "/api/v1/oauth/introspect",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-mcp-introspect-secret": "nope",
      },
      payload: query({ token: "x" }),
    });
    expect(r.statusCode).toBe(401);
  });

  it("accepts a Client ID Metadata Document client and shows its own host, never redirecting elsewhere", async () => {
    const { client } = await user("oauth-cimd@example.com");
    const base = {
      response_type: "code",
      client_id: CIMD_ID,
      code_challenge: pkce().challenge,
      code_challenge_method: "S256",
      resource: RESOURCE,
      scope: "read",
    };
    const good = await client.request(
      "GET",
      `/api/v1/oauth/authorize?${query({ ...base, redirect_uri: "http://127.0.0.1:33418/callback" })}`,
    );
    expect(good.json()).toMatchObject({
      consent: { client: { name: "Claude Code", host: "claude.ai" }, scopes: ["read"] },
    });
    const outside = await client.request(
      "GET",
      `/api/v1/oauth/authorize?${query({ ...base, redirect_uri: "https://evil.example/cb" })}`,
    );
    expect(outside.statusCode).toBe(400);
  });
});
