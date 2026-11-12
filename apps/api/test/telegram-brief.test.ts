import { meSchema } from "@drift/shared";
import { MemoryRateLimitStore, SodexRestClient } from "@drift/sodex";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { DeskLlm } from "../src/modules/desk/llm";
import { queueTelegramBriefs, type TelegramBriefDeps } from "../src/modules/desk/telegram-brief";

import { signIn, startTestEnv, TEST_BUILDER_ID, TestClient, type TestEnv } from "./helpers";

// Morning brief qua Telegram (N4, DEC-TBD-telegram-brief): một tin mỗi ngày địa phương từ 08:00 tới trước 12:00, chỉ cho
// user có AI Desk + Telegram active + nhóm daily bật + có bot. Không gọi LLM chỉ vì Telegram; dùng lại brief đã có.

const llm = { reply: "Good morning. Your bots are running.", calls: 0 };
const fake: DeskLlm = {
  complete: () => {
    llm.calls += 1;
    return Promise.resolve({
      text: llm.reply,
      model: "claude-sonnet-5-5",
      stopReason: "end_turn",
      usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 },
    });
  },
};

let env: TestEnv;
let deps: TelegramBriefDeps;
let chat = 7000;
const ADDRESS = "0x7d3C8b7a1F2D3C4B5A69788766554433221100Cd";

beforeAll(async () => {
  env = await startTestEnv({ deskLlm: fake });
  const rest = new SodexRestClient({
    config: { restUrl: "https://mainnet-gw.sodex.dev" },
    rateLimit: new MemoryRateLimitStore(),
    egressKey: "test",
    fetch: env.sodex.fetch,
  });
  deps = {
    db: env.db,
    totpKey: env.totpKey,
    now: () => env.clock.now,
    rest,
    builderId: TEST_BUILDER_ID,
    lastPrice: () => Promise.resolve(null),
    prices: () => Promise.resolve({}),
    verifyApiKey: () => Promise.resolve("ok"),
    llm: fake,
    useLlm: false,
  };
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  llm.calls = 0;
  // 08:30 UTC; user ở múi UTC.
  env.clock.now = new Date("2026-11-13T08:30:00Z");
  deps.useLlm = false;
});

async function briefUser(email: string, opts: { botName?: string } = {}) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  await env.pool.query("update users set ai_desk = true, timezone = 'UTC' where id = $1", [me.id]);
  const accountID = Math.floor(Math.random() * 1e9);
  const { rows } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected') returning id",
    [me.id, ADDRESS, accountID],
  );
  await env.pool.query(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state) values (gen_random_uuid(), $1, $2, 'spot_grid', 'vBTC_vUSDC', 'spot', $3, 'running')",
    [me.id, rows[0]?.id, opts.botName ?? "Grid"],
  );
  chat += 1;
  await env.pool.query(
    "insert into telegram_links (user_id, chat_id, status, connected_at) values ($1, $2, 'active', now())",
    [me.id, chat],
  );
  return { client, userId: me.id };
}

const sent = async (userId: string) =>
  (
    await env.pool.query<{ id: string; payload: Record<string, unknown>; delivery_status: string }>(
      "select id, payload, delivery_status from notifications where user_id = $1 and type = 'daily_summary' and channel = 'telegram'",
      [userId],
    )
  ).rows;
const queuedJobs = async (ids: string[]) =>
  (
    await env.pool.query(
      "select id from outbox where topic = 'jobs.telegram' and payload->>'notificationId' = any($1)",
      [ids],
    )
  ).rowCount;

describe("Telegram morning brief", () => {
  it("queues one template brief a day without calling the model, even with two replicas", async () => {
    const { userId } = await briefUser("brief-one@example.com");
    const [a, b] = await Promise.all([queueTelegramBriefs(deps), queueTelegramBriefs(deps)]);
    expect(a.queued + b.queued >= 1).toBe(true);
    const rows = await sent(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.delivery_status).toBe("queued");
    expect(rows[0]?.payload).toEqual({ localDate: "2026-11-13", count: 0, bot: "" });
    expect(await queuedJobs(rows.map((r) => r.id))).toBe(1);
    expect(llm.calls).toBe(0);
    // Lượt sau cùng ngày, và gửi bù trong giờ: không thêm.
    env.clock.now = new Date("2026-11-13T11:55:00Z");
    await queueTelegramBriefs(deps);
    expect(await sent(userId)).toHaveLength(1);
    // Ngày hôm sau: một tin mới.
    env.clock.now = new Date("2026-11-14T08:05:00Z");
    await queueTelegramBriefs(deps);
    expect(await sent(userId)).toHaveLength(2);
  });

  it("sends only between 08:00 and noon local time", async () => {
    const { userId } = await briefUser("brief-window@example.com");
    env.clock.now = new Date("2026-11-13T07:59:00Z");
    await queueTelegramBriefs(deps);
    expect(await sent(userId)).toHaveLength(0);
    env.clock.now = new Date("2026-11-13T12:00:00Z");
    await queueTelegramBriefs(deps);
    expect(await sent(userId)).toHaveLength(0);
    // Múi giờ của user: 08:30 ở Hà Nội là 01:30 UTC.
    await env.pool.query("update users set timezone = 'Asia/Ho_Chi_Minh' where id = $1", [userId]);
    env.clock.now = new Date("2026-11-14T01:30:00Z");
    await queueTelegramBriefs(deps);
    expect((await sent(userId)).map((r) => r.payload.localDate)).toEqual(["2026-11-14"]);
  });

  it("skips users without AI Desk, an active chat, the daily setting or a bot", async () => {
    const noDesk = await briefUser("brief-nodesk@example.com");
    await env.pool.query("update users set ai_desk = false where id = $1", [noDesk.userId]);
    const blocked = await briefUser("brief-blocked@example.com");
    await env.pool.query("update telegram_links set status = 'blocked' where user_id = $1", [
      blocked.userId,
    ]);
    const offUser = await briefUser("brief-off@example.com");
    await env.pool.query(
      "insert into notification_settings (user_id, type, channel, enabled) values ($1, 'daily', 'telegram', false)",
      [offUser.userId],
    );
    const archived = await briefUser("brief-archived@example.com");
    await env.pool.query("update bots set state = 'archived' where user_id = $1", [
      archived.userId,
    ]);
    await queueTelegramBriefs(deps);
    for (const u of [noDesk, blocked, offUser, archived]) expect(await sent(u.userId)).toEqual([]);
  });

  it("reuses the brief Desk AI already wrote on the web, and calls the model only when told to", async () => {
    const web = await briefUser("brief-web@example.com");
    llm.reply = "Good morning. Your <b>bots</b> are running.";
    await web.client.request("GET", "/api/v1/desk/ai/brief");
    expect(llm.calls).toBe(1);
    await queueTelegramBriefs(deps);
    expect((await sent(web.userId))[0]?.payload).toEqual({
      localDate: "2026-11-13",
      text: "Good morning. Your <b>bots</b> are running.",
    });
    expect(llm.calls).toBe(1);

    const flag = await briefUser("brief-flag@example.com");
    deps.useLlm = true;
    llm.reply = "Good morning. Your bots are running.";
    await queueTelegramBriefs(deps);
    expect(llm.calls).toBe(2);
    expect((await sent(flag.userId))[0]?.payload).toMatchObject({ text: llm.reply });
  });
});
