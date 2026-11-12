import { randomBytes } from "node:crypto";

import type { Db } from "@drift/db";
import { createBotApi, isBlockedResult, type SendMessage } from "@drift/runtime";
import { errorResponseSchema, escapeTelegramHtml } from "@drift/shared";
import { fastifyCookie as cookie } from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadApiConfig } from "../src/config";
import { randomToken } from "../src/lib/crypto";
import { registerErrorHandler } from "../src/lib/http";
import { registerTelegramRoutes, TELEGRAM_WEBHOOK_PATH } from "../src/modules/telegram/routes";
import { formatTotalPnl, pnlUnit } from "../src/modules/telegram/service";
import { isWellFormedToken, parseCommand } from "../src/modules/telegram/update";
import { memoryRateLimiter } from "../src/plugins/rate-limit";
import { registerSession } from "../src/plugins/session";

// Phần không cần Postgres của kết nối Telegram (docs/NOTIFICATIONS.md mục 3, 5, 9; DEC-170). Luồng có DB nằm ở
// telegram.test.ts (Testcontainers).

const SECRET = "s".repeat(40);
const BOT_TOKEN = "test:not-a-real-telegram-bot-token-0000";

describe("parseCommand", () => {
  it("reads /start with a token, including /start@desklabsbot", () => {
    expect(parseCommand("/start abc", "desklabsbot")).toEqual({ kind: "start", token: "abc" });
    expect(parseCommand("/start@DeskLabsBot abc", "desklabsbot")).toEqual({
      kind: "start",
      token: "abc",
    });
    expect(parseCommand("  /start  ", "desklabsbot")).toEqual({ kind: "start", token: null });
  });

  it("knows /stop, /help, /status and treats everything else as free text", () => {
    expect(parseCommand("/STOP", "desklabsbot")).toEqual({ kind: "stop" });
    expect(parseCommand("/help", "desklabsbot")).toEqual({ kind: "help" });
    expect(parseCommand("/status", "desklabsbot")).toEqual({ kind: "status" });
    expect(parseCommand("pause my bot", "desklabsbot")).toEqual({ kind: "text" });
    expect(parseCommand("/pause", "desklabsbot")).toEqual({ kind: "text" });
    expect(parseCommand("/start a b", "desklabsbot")).toEqual({ kind: "text" });
    expect(parseCommand(undefined, "desklabsbot")).toEqual({ kind: "text" });
  });

  it("ignores commands addressed to another bot", () => {
    expect(parseCommand("/start@otherbot abc", "desklabsbot")).toEqual({ kind: "text" });
  });
});

describe("link token format", () => {
  it("is 43 chars of [A-Za-z0-9_-], within Telegram's 64-char start limit", () => {
    for (let i = 0; i < 20; i += 1) {
      const t = randomToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t.length).toBeLessThanOrEqual(64);
      expect(isWellFormedToken(t)).toBe(true);
    }
    expect(isWellFormedToken("../../etc")).toBe(false);
    expect(isWellFormedToken(`${randomToken()}x`)).toBe(false);
  });
});

describe("escapeTelegramHtml", () => {
  it("escapes & < > so a bot name can't become a tag or link", () => {
    expect(escapeTelegramHtml(`<a href="x">BTC & Co</a>`)).toBe(
      `&lt;a href="x"&gt;BTC &amp; Co&lt;/a&gt;`,
    );
  });
});

describe("createBotApi", () => {
  const msg: SendMessage = {
    chat_id: 42,
    text: "hi",
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
  };

  it("returns ok on success", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 })),
    );
    const api = createBotApi({ token: BOT_TOKEN, fetch: fetchMock });
    expect(await api.sendMessage(msg)).toEqual({ ok: true });
  });

  it("maps 429 with retry_after and 403", async () => {
    const api429 = createBotApi({
      token: BOT_TOKEN,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              ok: false,
              description: "Too Many Requests: retry after 7",
              parameters: { retry_after: 7 },
            }),
            { status: 429 },
          ),
        ),
    });
    expect(await api429.sendMessage(msg)).toMatchObject({
      ok: false,
      status: 429,
      retryAfterSec: 7,
    });
    const api403 = createBotApi({
      token: BOT_TOKEN,
      fetch: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ ok: false, description: "Forbidden: bot was blocked by the user" }),
            { status: 403 },
          ),
        ),
    });
    expect(await api403.sendMessage(msg)).toMatchObject({ ok: false, status: 403 });
  });

  it("never puts the bot token in a result, even when the error text contains the URL", async () => {
    const network = createBotApi({
      token: BOT_TOKEN,
      fetch: () =>
        Promise.reject(
          new TypeError(`fetch failed: https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`),
        ),
    });
    const a = await network.sendMessage(msg);
    expect(JSON.stringify(a)).not.toContain(BOT_TOKEN);
    expect(a).toMatchObject({ ok: false, status: 0 });
    const echo = createBotApi({
      token: BOT_TOKEN,
      fetch: () =>
        Promise.resolve(
          new Response(JSON.stringify({ ok: false, description: `bad bot${BOT_TOKEN}` }), {
            status: 400,
          }),
        ),
    });
    expect(JSON.stringify(await echo.sendMessage(msg))).not.toContain(BOT_TOKEN);
  });
});

describe("/status total PnL (DEC-TBD-telegram-status-total)", () => {
  const b = (
    netPnl: string | null,
    fills = 3,
    engine: "spot" | "perps" = "perps",
    market = "BTC-USD",
  ) => ({
    netPnl,
    fills,
    engine,
    market,
  });
  it("shows the Strategy Lab net PnL with ▲/▼ and unit, never a made-up zero", () => {
    expect(formatTotalPnl(b("1.3249"))).toBe("+1.32 USDC ▲");
    expect(formatTotalPnl(b("-4.951"))).toBe("−4.95 USDC ▼");
    expect(formatTotalPnl(b("0"))).toBe("0.00 USDC");
    expect(formatTotalPnl(b(null))).toBe("Not available");
    expect(formatTotalPnl(b(null, 0))).toBe("No fills yet");
    expect(formatTotalPnl(b("2", 1, "spot", "vETH_vUSDC"))).toBe("+2.00 USDC ▲");
  });
  it("uses the quote asset for spot, USDC otherwise", () => {
    expect(pnlUnit({ engine: "spot", market: "vBTC_vUSDC" })).toBe("USDC");
    expect(pnlUnit({ engine: "spot", market: "vSOL_vBTC" })).toBe("BTC");
    expect(pnlUnit({ engine: "perps", market: "BTC-USD" })).toBe("USDC");
  });
});

describe("isBlockedResult", () => {
  it("treats 403 and 'chat not found' as blocked, nothing else", () => {
    const fail = (status: number, description = "") =>
      ({ ok: false, status, description, retryAfterSec: null }) as const;
    expect(isBlockedResult(fail(403, "Forbidden: bot was blocked by the user"))).toBe(true);
    expect(isBlockedResult(fail(400, "Bad Request: chat not found"))).toBe(true);
    expect(isBlockedResult(fail(400, "Bad Request: message is too long"))).toBe(false);
    expect(isBlockedResult(fail(429))).toBe(false);
    expect(isBlockedResult(fail(502))).toBe(false);
    expect(isBlockedResult({ ok: true })).toBe(false);
  });
});

describe("loadApiConfig", () => {
  const env = {
    DATABASE_URL: "postgres://x",
    API_TOTP_ENC_KEY: randomBytes(32).toString("base64"),
    SMTP_URL: "smtp://x",
    REDIS_URL: "redis://x",
    SIGNER_URL: "https://signer:8090",
    RECO_URL: "http://reco:8095",
    MAIL_FROM: "DeskLabs <no-reply@example.com>",
    SODEX_REST_URL: "https://mainnet-gw.sodex.dev",
    SODEX_WS_URL: "wss://mainnet-gw.sodex.dev/ws",
    SODEX_CHAIN: "mainnet",
    DRIFT_BUILDER_ID: "1645",
  };

  it("keeps Telegram off by default", () => {
    const c = loadApiConfig(env);
    expect(c.TELEGRAM_ENABLED).toBe(false);
    expect(c.DRIFT_TELEGRAM_BOT_USERNAME).toBe("desklabsbot");
  });

  it("refuses to start with Telegram on but no token or webhook secret", () => {
    expect(() => loadApiConfig({ ...env, TELEGRAM_ENABLED: "true" })).toThrow(/TELEGRAM/);
    expect(() =>
      loadApiConfig({ ...env, TELEGRAM_ENABLED: "true", DRIFT_TELEGRAM_BOT_TOKEN: BOT_TOKEN }),
    ).toThrow(/TELEGRAM/);
    expect(
      loadApiConfig({
        ...env,
        TELEGRAM_ENABLED: "true",
        DRIFT_TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        DRIFT_TELEGRAM_WEBHOOK_SECRET: SECRET,
      }).TELEGRAM_ENABLED,
    ).toBe(true);
  });
});

// App nhỏ: session thật (CSRF), routes Telegram thật, DB giả. Các trường hợp dưới đây không chạm DB.
async function miniApp(enabled = true): Promise<FastifyInstance> {
  const noDb = {} as unknown as Db;
  const app = Fastify();
  await app.register(cookie);
  registerErrorHandler(app);
  registerSession(app, { db: noDb, cookieSecure: false, now: () => new Date() });
  registerTelegramRoutes(app, {
    enabled,
    webhookSecret: SECRET,
    deps: {
      db: noDb,
      now: () => new Date(),
      botUsername: "desklabsbot",
      appUrl: "https://desklabs.xyz",
      botApi: { sendMessage: () => Promise.reject(new Error("must not send from webhook")) },
      rateLimiter: memoryRateLimiter(),
      warn: () => undefined,
      listBots: () => Promise.reject(new Error("must not list bots here")),
    },
  });
  app.post("/api/v1/other", () => ({ ok: true }));
  await app.ready();
  return app;
}

const update = (text: string, type = "private") => ({
  update_id: 1,
  message: { message_id: 1, date: 0, chat: { id: 777, type, username: "mai_trades" }, text },
});

let app: FastifyInstance | null = null;
afterEach(async () => {
  await app?.close();
  app = null;
});

describe("webhook", () => {
  const post = (a: FastifyInstance, body: unknown, secret: string | null = SECRET) =>
    a.inject({
      method: "POST",
      url: TELEGRAM_WEBHOOK_PATH,
      headers: secret === null ? {} : { "x-telegram-bot-api-secret-token": secret },
      payload: body as object,
    });

  it("is exempt from CSRF on that exact path only", async () => {
    app = await miniApp();
    expect((await post(app, update("/help"))).statusCode).toBe(200);
    const other = await app.inject({ method: "POST", url: "/api/v1/other", payload: {} });
    expect(other.statusCode).toBe(403);
    expect(errorResponseSchema.parse(other.json()).error.details.reason).toBe("csrf");
    const withQuery = await app.inject({
      method: "POST",
      url: `${TELEGRAM_WEBHOOK_PATH}?x=1`,
      headers: { "x-telegram-bot-api-secret-token": SECRET },
      payload: update("/help"),
    });
    expect(withQuery.statusCode).toBe(403);
  });

  it("rejects a missing or wrong secret", async () => {
    app = await miniApp();
    expect((await post(app, update("/help"), null)).statusCode).toBe(401);
    expect((await post(app, update("/help"), `${SECRET}x`)).statusCode).toBe(401);
    expect((await post(app, update("/help"), "short")).statusCode).toBe(401);
  });

  it("answers /help in the webhook response with one Open DeskLabs URL button and no action buttons", async () => {
    app = await miniApp();
    const res = await post(app, update("/help"));
    const body = res.json<{
      method: string;
      chat_id: number;
      text: string;
      reply_markup: { inline_keyboard: { text: string; url?: string; callback_data?: string }[][] };
    }>();
    expect(body.method).toBe("sendMessage");
    expect(body.chat_id).toBe(777);
    expect(body.text).toContain("/stop");
    const buttons = body.reply_markup.inline_keyboard.flat();
    expect(buttons).toEqual([{ text: "Open DeskLabs", url: "https://desklabs.xyz" }]);
    expect(buttons.some((b) => b.callback_data !== undefined)).toBe(false);
  });

  it("answers free text with a fixed sentence and never echoes it", async () => {
    app = await miniApp();
    const res = await post(app, update("my seed is <b>abandon abandon</b>"));
    const body = res.json<{ text: string }>();
    expect(body.text).toBe("I only send alerts for now. Open DeskLabs to ask Desk AI.");
    expect(res.body).not.toContain("abandon");
  });

  it("answers a malformed /start token with 'link expired' without touching the database", async () => {
    app = await miniApp();
    const res = await post(app, update("/start not-a-token"));
    expect(res.json<{ text: string }>().text).toBe(
      "This link expired. Open DeskLabs › Settings to get a new one.",
    );
  });

  it("ignores groups and channels, and updates it can't read", async () => {
    app = await miniApp();
    expect((await post(app, update(`/start ${randomToken()}`, "group"))).json()).toEqual({});
    expect((await post(app, update("/help", "channel"))).json()).toEqual({});
    expect((await post(app, { update_id: 2, edited_message: {} })).json()).toEqual({});
    expect((await post(app, { nonsense: true })).json()).toEqual({});
  });

  it("is 404 while TELEGRAM_ENABLED is off", async () => {
    app = await miniApp(false);
    expect((await post(app, update("/help"))).statusCode).toBe(404);
  });
});
