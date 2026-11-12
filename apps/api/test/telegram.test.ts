import {
  errorResponseSchema,
  meSchema,
  telegramLinkCreatedSchema,
  telegramLinkStatusSchema,
} from "@drift/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { SendMessage } from "../src/modules/telegram/bot-api";
import { TELEGRAM_WEBHOOK_PATH } from "../src/modules/telegram/routes";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Kết nối Telegram với Postgres thật (docs/NOTIFICATIONS.md mục 3, 8, 9; DEC-170). Bot API là giả: ghi lại tin
// api gửi ra ngoài (chỉ có tin "Disconnected" khi ngắt từ web); tin trả lời webhook nằm trong response.

const SECRET = "w".repeat(40);
const sent: SendMessage[] = [];
let env: TestEnv;
const errorOf = (body: string) => errorResponseSchema.parse(JSON.parse(body)).error;

beforeAll(async () => {
  env = await startTestEnv({
    telegram: {
      enabled: true,
      botUsername: "desklabsbot",
      webhookSecret: SECRET,
      appUrl: "https://desklabs.test",
      botApi: {
        sendMessage: (m) => {
          sent.push(m);
          return Promise.resolve({ ok: true });
        },
      },
    },
  });
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  sent.length = 0;
  env.clock.now = new Date("2026-11-12T08:00:00Z");
});

async function user(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  return { client, userId: me.id };
}

async function newLink(client: TestClient) {
  const res = await client.request("POST", "/api/v1/telegram/link");
  expect(res.statusCode).toBe(201);
  const body = telegramLinkCreatedSchema.parse(res.json());
  const token = new URL(body.deepLink).searchParams.get("start") ?? "";
  return { ...body, token };
}

async function status(client: TestClient) {
  return telegramLinkStatusSchema.parse(
    (await client.request("GET", "/api/v1/telegram/link")).json(),
  );
}

function webhook(text: string, chatId: number, username?: string) {
  return env.app.inject({
    method: "POST",
    url: TELEGRAM_WEBHOOK_PATH,
    headers: { "x-telegram-bot-api-secret-token": SECRET },
    payload: {
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: 1,
        date: 0,
        chat: { id: chatId, type: "private", ...(username === undefined ? {} : { username }) },
        text,
      },
    },
  });
}

const replyText = (res: { json: () => unknown }) =>
  z.object({ text: z.string().optional() }).parse(res.json()).text;

describe("Telegram link", () => {
  it("connects with one Start: deep link → /start <token> → active, with a welcome message", async () => {
    const { client, userId } = await user("tg1@example.com");
    expect((await status(client)).status).toBe("not_connected");
    const link = await newLink(client);
    expect(link.deepLink).toMatch(/^https:\/\/t\.me\/desklabsbot\?start=[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(link.expiresAt) - env.clock.now.getTime()).toBe(10 * 60 * 1000);
    expect(await status(client)).toMatchObject({ status: "pending", expiresAt: link.expiresAt });

    // Chỉ lưu hash, không lưu token gốc ở đâu cả (kể cả bảng idempotency).
    const raw = await env.pool.query(
      "select count(*)::int as n from telegram_link_tokens where token_hash = $1",
      [link.token],
    );
    expect(raw.rows[0]).toEqual({ n: 0 });
    const idem = await env.pool.query<{ response: unknown }>(
      "select response from idempotency_keys where user_id = $1",
      [userId],
    );
    expect(JSON.stringify(idem.rows)).not.toContain(link.token);

    const res = await webhook(`/start ${link.token}`, 5001, "mai_trades");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ method: "sendMessage", chat_id: 5001 });
    expect(replyText(res)).toContain("Connected to DeskLabs");
    expect(await status(client)).toMatchObject({ status: "active", username: "mai_trades" });

    const audit = await env.pool.query<{ action: string }>(
      "select action from audit_log where user_id = $1 and action like 'telegram.%'",
      [userId],
    );
    expect(audit.rows.map((r) => r.action)).toContain("telegram.connected");
  });

  it("uses a token only once and only for 10 minutes", async () => {
    const { client } = await user("tg2@example.com");
    const a = await newLink(client);
    expect(replyText(await webhook(`/start ${a.token}`, 5002))).toContain("Connected");
    // Dùng lại.
    expect(replyText(await webhook(`/start ${a.token}`, 5003))).toBe(
      "This link expired. Open DeskLabs › Settings to get a new one.",
    );
    // Hết hạn.
    const b = await newLink(client);
    env.clock.now = new Date(env.clock.now.getTime() + 10 * 60 * 1000 + 1);
    expect(replyText(await webhook(`/start ${b.token}`, 5004))).toContain("expired");
    // Token sai đúng định dạng.
    expect(replyText(await webhook(`/start ${"A".repeat(43)}`, 5005))).toContain("expired");
    expect((await status(client)).status).toBe("active");
  });

  it("keeps one live token per user: a new link cancels the old one", async () => {
    const { client } = await user("tg3@example.com");
    const first = await newLink(client);
    await newLink(client);
    expect(replyText(await webhook(`/start ${first.token}`, 5006))).toContain("expired");
  });

  it("moves a chat to the newest user and takes it off the old one", async () => {
    const one = await user("tg4a@example.com");
    const two = await user("tg4b@example.com");
    await webhook(`/start ${(await newLink(one.client)).token}`, 5007);
    expect((await status(one.client)).status).toBe("active");
    await webhook(`/start ${(await newLink(two.client)).token}`, 5007);
    expect((await status(two.client)).status).toBe("active");
    expect((await status(one.client)).status).toBe("not_connected");
    const rows = await env.pool.query("select user_id from telegram_links where chat_id = 5007");
    expect(rows.rows).toEqual([{ user_id: two.userId }]);
    // In-app nhóm hệ thống (DEC-183): user cũ được báo, user mới thấy "connected".
    const notes = await env.pool.query<{ user_id: string; type: string; channel: string }>(
      "select user_id, type, channel from notifications where user_id = any($1) and type like 'telegram_%'",
      [[one.userId, two.userId]],
    );
    // Hai dòng của lần kết nối thứ hai cùng một transaction nên cùng `created_at`: so như tập hợp.
    expect(notes.rows).toHaveLength(3);
    expect(notes.rows).toEqual(
      expect.arrayContaining([
        { user_id: one.userId, type: "telegram_connected", channel: "in_app" },
        { user_id: two.userId, type: "telegram_connected", channel: "in_app" },
        { user_id: one.userId, type: "telegram_moved", channel: "in_app" },
      ]),
    );
  });

  it("reconnecting replaces the old chat for the same user", async () => {
    const { client, userId } = await user("tg5@example.com");
    await webhook(`/start ${(await newLink(client)).token}`, 5008);
    await webhook(`/start ${(await newLink(client)).token}`, 5009);
    const rows = await env.pool.query("select chat_id from telegram_links where user_id = $1", [
      userId,
    ]);
    expect(rows.rows).toEqual([{ chat_id: "5009" }]);
  });

  it("/stop disconnects from Telegram; /start without a token explains how to connect", async () => {
    const { client } = await user("tg6@example.com");
    await webhook(`/start ${(await newLink(client)).token}`, 5010);
    expect(replyText(await webhook("/stop", 5010))).toBe("Disconnected from DeskLabs.");
    expect((await status(client)).status).toBe("not_connected");
    expect(replyText(await webhook("/stop", 5010))).toContain("Connect Telegram");
    expect(replyText(await webhook("/start", 5010))).toContain("Connect Telegram");
  });

  it("disconnect from the web sends a last message, then forgets the chat", async () => {
    const { client } = await user("tg7@example.com");
    await webhook(`/start ${(await newLink(client)).token}`, 5011);
    const res = await client.request("DELETE", "/api/v1/telegram/link");
    expect(res.statusCode).toBe(204);
    expect(sent).toEqual([
      expect.objectContaining({ chat_id: 5011, text: "Disconnected from DeskLabs." }),
    ]);
    expect((await status(client)).status).toBe("not_connected");
    // Gọi lại khi đã ngắt: không lỗi, không gửi gì.
    expect((await client.request("DELETE", "/api/v1/telegram/link")).statusCode).toBe(204);
    expect(sent).toHaveLength(1);
  });

  it("rate limits new links to 5 per minute per user", async () => {
    const { client } = await user("tg8@example.com");
    for (let i = 0; i < 5; i += 1) await newLink(client);
    const res = await client.request("POST", "/api/v1/telegram/link");
    expect(res.statusCode).toBe(429);
    expect(errorOf(res.body).code).toBe("RATE_LIMITED");
  });

  it("does not replay a link response for a reused Idempotency-Key (the token is never stored)", async () => {
    const { client } = await user("tg9@example.com");
    const key = "6f1c2b9e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
    expect(
      (await client.request("POST", "/api/v1/telegram/link", { idempotencyKey: key })).statusCode,
    ).toBe(201);
    const again = await client.request("POST", "/api/v1/telegram/link", { idempotencyKey: key });
    expect(again.statusCode).toBe(409);
    expect(errorOf(again.body).code).toBe("IDEMPOTENCY_KEY_CONFLICT");
  });

  it("needs a session for the link endpoints", async () => {
    const res = await env.app.inject({ method: "GET", url: "/api/v1/telegram/link" });
    expect(res.statusCode).toBe(401);
  });

  it("returns telegram in notification settings with the DEC-170 defaults", async () => {
    const { client } = await user("tg10@example.com");
    const res = (await client.request("GET", "/api/v1/notifications/settings")).json<{
      groups: { group: string; telegram: boolean }[];
    }>();
    const tg = Object.fromEntries(res.groups.map((g) => [g.group, g.telegram]));
    expect(tg).toEqual({
      botErrors: true,
      risk: true,
      keyFee: true,
      fills: false,
      daily: true,
      copyTrading: false,
    });
  });
});
