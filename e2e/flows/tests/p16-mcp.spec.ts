import { randomUUID } from "node:crypto";

// Subpath của "exports" trong package SDK: TypeScript resolve được, plugin import của eslint thì không.
// eslint-disable-next-line import/no-unresolved
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js"; // prettier-ignore
// eslint-disable-next-line import/no-unresolved
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import/no-unresolved
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js"; // prettier-ignore
import { expect, test } from "@playwright/test";

import { signUpConnectAnd2fa } from "../support/onboard";

// MCP A2 (docs/MCP.md, DEC-167, DEC-217): client MCP chính thức (SDK) tự khám phá OAuth từ apps/mcp
// (401 + Protected Resource Metadata → metadata của issuer), đăng ký động, mở màn consent; người dùng bấm Allow;
// client đổi code lấy token (PKCE) rồi gọi được /mcp. Token cấp cho /mcp không dùng được ở /team/mcp; revoke ở
// Settings › Connected apps có hiệu lực ngay ở lần gọi kế tiếp.

const WEB = process.env.E2E_WEB ?? "http://127.0.0.1:13100";
const API = process.env.E2E_API ?? "http://127.0.0.1:18080";
const MCP = process.env.E2E_MCP ?? "http://127.0.0.1:18094";
/** Callback loopback của client (không có server thật: Playwright chặn và đọc code). */
const CALLBACK = "http://127.0.0.1:18093/callback";

/** Thay Traefik: metadata và endpoint OAuth của issuer (web E2E) đi thẳng tới api. */
const viaTraefik: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const routed = url.startsWith(`${WEB}/.well-known/oauth-authorization-server`)
    ? url.replace(WEB, API)
    : url.startsWith(`${WEB}/api/`)
      ? url.replace(WEB, API)
      : url;
  return fetch(routed, init);
};

class MemoryProvider implements OAuthClientProvider {
  info: OAuthClientInformationMixed | undefined;
  saved: OAuthTokens | undefined;
  verifier = "";
  authorizationUrl: URL | undefined;

  get redirectUrl() {
    return CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "E2E MCP client",
      redirect_uris: [CALLBACK],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery") {
    if (scope === "all" || scope === "tokens") this.saved = undefined;
    if (scope === "all" || scope === "client") this.info = undefined;
  }
}

const transportFor = (path: string, provider: MemoryProvider) =>
  new StreamableHTTPClientTransport(new URL(`${MCP}${path}`), {
    authProvider: provider,
    fetch: viaTraefik,
  });

test("an MCP client connects with OAuth, reads, and loses access on revoke", async ({
  page,
}, info) => {
  await signUpConnectAnd2fa(page, info, { emailPrefix: "e2e-mcp" });
  const provider = new MemoryProvider();

  await test.step("401 sends the client to the consent screen", async () => {
    const res = await fetch(`${MCP}/mcp`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer scope="read", resource_metadata="${MCP}/.well-known/oauth-protected-resource/mcp"`,
    );
    await expect(
      new Client({ name: "e2e", version: "1.0.0" }).connect(transportFor("/mcp", provider)),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.authorizationUrl?.origin).toBe(WEB);
    expect(provider.authorizationUrl?.searchParams.get("resource")).toBe(`${MCP}/mcp`);
  });

  let code = "";
  await test.step("Allow returns a code to the client", async () => {
    await page.route(`${CALLBACK}**`, async (route) => {
      const u = new URL(route.request().url());
      code = u.searchParams.get("code") ?? "";
      expect(u.searchParams.get("iss")).toBe(WEB);
      await route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
    });
    await page.goto(String(provider.authorizationUrl));
    await expect(page.getByRole("heading", { name: "Connect an app to DeskLabs" })).toBeVisible();
    await expect(page.getByText("E2E MCP client")).toBeVisible();
    await expect(
      page.getByText(
        "This app can read your DeskLabs data. It can't place trades, change bots or move funds.",
      ),
    ).toBeVisible();
    // Lần đầu chỉ xin `read`; quyền `draft` xin sau, lúc cần (step-up).
    await expect(
      page.getByText("Save bot drafts for you to review and apply in DeskLabs"),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Allow" }).click();
    await expect.poll(() => code).not.toBe("");
  });

  await test.step("the client exchanges the code and calls /mcp", async () => {
    await transportFor("/mcp", provider).finishAuth(code);
    expect(provider.saved?.access_token).toBeTruthy();
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transportFor("/mcp", provider));
    // B1: tool đọc của người dùng, không có tool nội bộ của team.
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("list_bots");
    expect(names.some((n) => n.startsWith("team_"))).toBe(false);
    // Đọc thật qua api: người vừa onboard chưa có bot; portfolio là số dư SoDEX (mock) của chính họ.
    const bots = await client.callTool({ name: "list_bots", arguments: {} });
    expect(bots.isError).not.toBe(true);
    expect(bots.structuredContent).toMatchObject({ bots: [] });
    const summary = await client.callTool({ name: "get_portfolio_summary", arguments: {} });
    expect(summary.isError).not.toBe(true);
    expect(summary.structuredContent).toMatchObject({ realMoney: { reason: null } });
    // B2: thành tích AI Desk (chưa có lần Apply nào) luôn kèm câu "not a forecast".
    const record = await client.callTool({ name: "get_track_record", arguments: {} });
    expect(record.isError).not.toBe(true);
    expect(JSON.stringify(record.structuredContent)).toContain("not a forecast");
    await client.close();
  });

  await test.step("drafting asks for the draft permission once (step-up), then works", async () => {
    const reader = new Client({ name: "e2e", version: "1.0.0" });
    await reader.connect(transportFor("/mcp", provider));
    const tools = (await reader.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("draft_new_bot");
    provider.authorizationUrl = undefined;
    // Đọc qua hàm: TypeScript không biết callTool gán lại giá trị này.
    const authUrl = (): URL | undefined => provider.authorizationUrl;
    // Token chỉ có `read`: 403 insufficient_scope → refresh cũ bị từ chối → client mở lại consent với "read draft".
    await expect(
      reader.callTool({ name: "draft_new_bot", arguments: { strategy: "spot_grid", config: {} } }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
    expect(authUrl()?.searchParams.get("scope")).toBe("read draft");
    await reader.close().catch(() => undefined);

    code = "";
    await page.goto(String(authUrl()));
    await expect(
      page.getByText("Save bot drafts for you to review and apply in DeskLabs"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Allow" }).click();
    await expect.poll(() => code).not.toBe("");
    await transportFor("/mcp", provider).finishAuth(code);
  });

  await test.step("a draft from Claude opens prefilled; only the user saves it", async () => {
    const client = new Client({ name: "e2e", version: "1.0.0" });
    await client.connect(transportFor("/mcp", provider));
    const made = await client.callTool({
      name: "draft_new_bot",
      arguments: {
        strategy: "spot_grid",
        name: "Grid from Claude",
        config: {
          market: "vBTC_vUSDC",
          lowerPrice: "90",
          upperPrice: "110",
          gridLevels: 5,
          spacing: "arithmetic",
          investment: "500",
          maxLoss: "100",
          onStop: "keep_base",
        },
      },
    });
    expect(made.isError).not.toBe(true);
    const out = made.structuredContent as { url: string; note: string };
    expect(out.note).toBe("Open this link in DeskLabs to review. Claude can't apply or start it.");
    // Bản nháp không tạo bot nào.
    const before = await client.callTool({ name: "list_bots", arguments: {} });
    expect(before.structuredContent).toMatchObject({ bots: [] });
    await client.close();

    await page.unroute(`${CALLBACK}**`);
    await page.goto(out.url);
    await expect(page.getByRole("heading", { name: "Create Spot Grid" })).toBeVisible();
    await expect(page.getByText("From Claude")).toBeVisible();
    await expect(
      page.getByText(
        "Claude drafted these settings. Nothing changes until you review and save or start the bot yourself.",
      ),
    ).toBeVisible();
    await expect(page.getByLabel("Lower price")).toHaveValue("90");
    await expect(page.getByLabel("Grid levels")).toHaveValue("5");
    // Người dùng tự lưu bằng luồng có sẵn.
    await page.getByRole("button", { name: "Save draft" }).click();
    const checks = page.getByRole("region", { name: "Before it starts" });
    await expect(checks.getByText("Builder fee approval")).toBeVisible();
    await page.goto("/bots");
    await expect(page.getByText("Grid from Claude")).toBeVisible();
    // Link bản nháp không tồn tại → một câu chung, không lộ gì.
    await page.goto(`/bots/new/spot_grid?draft=${randomUUID()}`);
    await expect(
      page.getByText("This draft is no longer available. Drafts from Claude last 24 hours."),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Open Strategy Lab" })).toBeVisible();
  });

  await test.step("a /mcp token is refused at /team/mcp", async () => {
    const res = await fetch(`${MCP}/team/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.saved?.access_token ?? ""}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  await test.step("Revoke in Settings › Connected apps cuts access right away", async () => {
    await page.unroute(`${CALLBACK}**`);
    await page.goto("/settings?tab=apps");
    await expect(page.getByText("E2E MCP client")).toBeVisible();
    await page.getByRole("button", { name: "Revoke" }).click();
    const dialog = page.getByRole("dialog", { name: "Revoke E2E MCP client?" });
    await dialog.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("No apps connected yet.")).toBeVisible();

    const res = await fetch(`${MCP}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${provider.saved?.access_token ?? ""}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});
