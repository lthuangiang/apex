import { randomBytes, randomUUID } from "node:crypto";

import {
  botDraftViewSchema,
  botListSchema,
  botSummarySchema,
  errorResponseSchema,
  MCP_DRAFT_NOTE,
  MCP_DRAFTS_FULL,
  mcpDraftResultSchema,
  meSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sha256 } from "../src/lib/crypto";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Bản nháp từ Claude (docs/MCP.md mục 5B, DEC-223): cần scope `draft`; chỉ ghi `bot_drafts` (không tạo bot,
// không thêm version, không Start); config kiểm tra như màn Create / Edit; hết hạn 24 giờ; tối đa 20 bản đang chờ;
// web chỉ mở bản nháp của chính mình, còn hạn, bot chưa archive (mọi trường hợp khác cùng một 404).

const SECRET = "test-introspect-secret-0123456789abcdef";
const PUBLIC = "https://mcp.desklabs.test";
const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const grid = {
  market: "vBTC_vUSDC",
  lowerPrice: "90",
  upperPrice: "110",
  gridLevels: 5,
  spacing: "arithmetic",
  investment: "500",
  maxLoss: "100",
  onStop: "keep_base",
};

let env: TestEnv;
beforeAll(async () => {
  env = await startTestEnv({
    oauth: { issuer: "https://desklabs.test", mcpPublicUrl: PUBLIC, introspectSecret: SECRET },
  });
  await env.pool.query(
    "insert into oauth_clients (id, kind, name, redirect_uris) values ('dlc_draft', 'dcr', 'Claude', '{https://claude.example/cb}')",
  );
});
afterAll(async () => {
  await env.close();
});

async function person(email: string, scope: string[] = ["read", "draft"]) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  const accountID = Math.floor(Math.random() * 1e9);
  env.sodex.addUser(ADDRESS, accountID);
  await env.pool.query(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected')",
    [me.id, ADDRESS, accountID],
  );
  const token = randomBytes(24).toString("base64url");
  await env.pool.query(
    "insert into mcp_tokens (id, family_id, user_id, client_id, scope, resource, access_hash, access_expires_at, refresh_hash, refresh_expires_at) values (gen_random_uuid(), $1, $2, 'dlc_draft', $3, $4, $5, $6, $7, $6)",
    [
      randomUUID(),
      me.id,
      scope,
      `${PUBLIC}/mcp`,
      sha256(token),
      new Date(env.clock.now.getTime() + 3_600_000),
      sha256(`r-${token}`),
    ],
  );
  return { client, userId: me.id, token };
}

const post = (url: string, token: string, body: unknown) =>
  env.app.inject({
    method: "POST",
    url,
    headers: { "x-mcp-introspect-secret": SECRET, "x-mcp-token": token },
    payload: body as Record<string, unknown>,
  });
const errorOf = (body: unknown) => errorResponseSchema.parse(body).error;
const draftIdOf = (url: string) => new URL(url).searchParams.get("draft") ?? "";

describe("MCP drafts", () => {
  it("needs the draft scope", async () => {
    const reader = await person("draft-reader@example.com", ["read"]);
    const r = await post("/api/v1/mcp/me/drafts/new", reader.token, {
      strategy: "spot_grid",
      config: grid,
    });
    expect(r.statusCode).toBe(403);
  });

  it("drafts a new bot without creating one; the web opens it once, then it counts as opened", async () => {
    const u = await person("draft-new@example.com");
    const r = await post("/api/v1/mcp/me/drafts/new", u.token, {
      strategy: "spot_grid",
      name: "Grid from Claude",
      config: grid,
    });
    expect(r.statusCode).toBe(200);
    const d = mcpDraftResultSchema.parse(r.json());
    expect(d.note).toBe(MCP_DRAFT_NOTE);
    expect(d.url).toBe(`https://desklabs.test/bots/new/spot_grid?draft=${d.draftId}`);
    expect(new Date(d.expiresAt).getTime() - env.clock.now.getTime()).toBe(24 * 3_600_000);
    // Không có bot nào được tạo.
    const bots = botListSchema.parse((await u.client.request("GET", "/api/v1/bots")).json());
    expect(bots.items).toEqual([]);

    const view = botDraftViewSchema.parse(
      (await u.client.request("GET", `/api/v1/drafts/${d.draftId}`)).json(),
    );
    expect(view).toMatchObject({ strategy: "spot_grid", botId: null, name: "Grid from Claude" });
    expect(view.config).toMatchObject({ market: "vBTC_vUSDC", gridLevels: 5 });
    const { rows } = await env.pool.query<{ opened_at: Date | null }>(
      "select opened_at from bot_drafts where id = $1",
      [d.draftId],
    );
    expect(rows[0]?.opened_at).not.toBeNull();
  });

  it("checks settings like the form and lists the bad fields", async () => {
    const u = await person("draft-invalid@example.com");
    const r = await post("/api/v1/mcp/me/drafts/new", u.token, {
      strategy: "spot_grid",
      config: { ...grid, gridLevels: 1, lowerPrice: "120" },
    });
    expect(r.statusCode).toBe(400);
    expect(Object.keys(errorOf(r.json()).details.fieldErrors ?? {}).length).toBeGreaterThan(0);
    const copy = await post("/api/v1/mcp/me/drafts/new", u.token, {
      strategy: "copy_trade",
      config: {},
    });
    expect(errorOf(copy.json()).message).toBe(
      "Copy Trading bots are set up in DeskLabs › Find traders.",
    );
    const unknown = await post("/api/v1/mcp/me/drafts/new", u.token, {
      strategy: "moon_bot",
      config: {},
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("drafts a change to an own bot without touching it; locked fields and other users' bots are refused", async () => {
    const u = await person("draft-change@example.com");
    const made = await u.client.request("POST", "/api/v1/bots", {
      body: { strategy: "spot_grid", name: "Grid", paramSource: "manual", config: grid },
    });
    const botId = botSummarySchema.parse(made.json()).id;
    const r = await post("/api/v1/mcp/me/drafts/change", u.token, {
      botId,
      changes: { maxLoss: "60" },
    });
    expect(r.statusCode).toBe(200);
    const d = mcpDraftResultSchema.parse(r.json());
    expect(d.url).toBe(`https://desklabs.test/bots/${botId}/edit?draft=${d.draftId}`);
    // Bot vẫn chỉ có version 1.
    const { rows } = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from bot_versions where bot_id = $1",
      [botId],
    );
    expect(rows[0]?.n).toBe(1);
    const view = botDraftViewSchema.parse(
      (await u.client.request("GET", `/api/v1/drafts/${d.draftId}`)).json(),
    );
    expect(view).toMatchObject({ botId, config: { ...grid, maxLoss: "60" } });

    const locked = await post("/api/v1/mcp/me/drafts/change", u.token, {
      botId,
      changes: { market: "vETH_vUSDC" },
    });
    expect(locked.statusCode).toBe(400);
    expect(errorOf(locked.json()).details.fieldErrors).toMatchObject({ market: ["locked"] });

    const other = await person("draft-other@example.com");
    const cross = await post("/api/v1/mcp/me/drafts/change", other.token, {
      botId,
      changes: { maxLoss: "60" },
    });
    expect(cross.statusCode).toBe(404);
    // Bản nháp của người khác: cùng 404 như không tồn tại.
    const peek = await other.client.request("GET", `/api/v1/drafts/${d.draftId}`);
    expect(peek.statusCode).toBe(404);
    expect(errorOf(peek.json()).message).toBe("This draft is no longer available.");

    // Bot bị archive: bản nháp không mở được nữa.
    await env.pool.query("update bots set archived_at = now() where id = $1", [botId]);
    expect((await u.client.request("GET", `/api/v1/drafts/${d.draftId}`)).statusCode).toBe(404);
  });

  it("expires drafts after 24 hours", async () => {
    const u = await person("draft-expiry@example.com");
    const d = mcpDraftResultSchema.parse(
      (
        await post("/api/v1/mcp/me/drafts/new", u.token, { strategy: "spot_grid", config: grid })
      ).json(),
    );
    await env.pool.query("update bot_drafts set expires_at = $2 where id = $1", [
      d.draftId,
      new Date(env.clock.now.getTime() - 1000),
    ]);
    const r = await u.client.request("GET", `/api/v1/drafts/${draftIdOf(d.url)}`);
    expect(r.statusCode).toBe(404);
    expect(errorOf(r.json()).message).toBe("This draft is no longer available.");
  });

  it("step-up ends the old refresh token so the client asks again, without cutting current access", async () => {
    const u = await person("draft-stepup@example.com", ["read"]);
    const r = await post("/api/v1/mcp/step-up", u.token, {});
    expect(r.statusCode).toBe(204);
    const refresh = await env.app.inject({
      method: "POST",
      url: "/api/v1/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: `r-${u.token}`,
        client_id: "dlc_draft",
      }).toString(),
    });
    expect(refresh.statusCode).toBe(400);
    expect(refresh.json()).toMatchObject({ error: "invalid_grant" });
    // Access token hiện tại vẫn đọc được (không thu hồi family).
    const still = await env.app.inject({
      method: "GET",
      url: "/api/v1/mcp/me/bots",
      headers: { "x-mcp-introspect-secret": SECRET, "x-mcp-token": u.token },
    });
    expect(still.statusCode).toBe(200);
  });

  it("allows at most 20 waiting drafts; opened or expired ones free a place", async () => {
    const u = await person("draft-limit@example.com");
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await post("/api/v1/mcp/me/drafts/new", u.token, {
        strategy: "spot_grid",
        config: grid,
      });
      expect(r.statusCode, String(i)).toBe(200);
      ids.push(mcpDraftResultSchema.parse(r.json()).draftId);
    }
    const full = await post("/api/v1/mcp/me/drafts/new", u.token, {
      strategy: "spot_grid",
      config: grid,
    });
    expect(full.statusCode).toBe(409);
    expect(errorOf(full.json()).message).toBe(MCP_DRAFTS_FULL);
    await u.client.request("GET", `/api/v1/drafts/${ids[0] ?? ""}`);
    const again = await post("/api/v1/mcp/me/drafts/new", u.token, {
      strategy: "spot_grid",
      config: grid,
    });
    expect(again.statusCode).toBe(200);
  });
});
