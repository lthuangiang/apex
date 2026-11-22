import { randomUUID } from "node:crypto";

import {
  baselineVersionConfig,
  botSummarySchema,
  errorResponseSchema,
  meSchema,
  NEWS_BOTS_NOT_READY,
  newsCommandSchema,
  newsTradesSchema,
  startChecksSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #420: API bot `news_signal` mainnet. Chốt chặn `SIGNAL_NEWS_BOTS_ENABLED` (409 `FEATURE_NOT_READY`, không ghi gì), quyền
// team HOẶC `users.signal_research`, bot của người khác → 404, `narrowsVersion`, trần 200 USDC, Close now / Edit TP/SL ghi
// `news_signal_commands` (idempotent, seq tăng dần). Không có SoDEX: engine chưa nối.

const flag = { enabled: false };
let env: TestEnv;
const ADDRESS = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const base = "/api/v1/signal-research/bots";
const errOf = (r: { body: string }) => errorResponseSchema.parse(JSON.parse(r.body)).error;
const config = (over: Record<string, unknown> = {}) => ({
  ...baselineVersionConfig(),
  sizeUsdc: "100",
  leverage: 1,
  ...over,
});

let team: TestClient;
let tester: TestClient;
let other: TestClient;
let plain: TestClient;
let testerId: string;
let baselineId: string;

async function user(email: string, opts: { team?: boolean; flag?: boolean } = {}) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  const accountID = Math.floor(Math.random() * 1e9);
  env.sodex.addUser(ADDRESS, accountID);
  await env.pool.query(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, $3, 'mainnet', 'connected')",
    [me.id, ADDRESS, accountID],
  );
  if (opts.team === true)
    await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
  if (opts.flag === true)
    await env.pool.query("update users set signal_research = true where id = $1", [me.id]);
  return { client, id: me.id };
}

const count = async (sql: string, params: unknown[] = []) =>
  Number((await env.pool.query<{ n: string }>(sql, params)).rows[0]?.n ?? 0);

const create = (c: TestClient, over: Record<string, unknown> = {}, key?: string) =>
  c.request("POST", base, {
    body: { versionId: baselineId, name: "News", config: config(), ...over },
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });

async function createdBot(c: TestClient) {
  const r = await create(c);
  expect(r.statusCode).toBe(201);
  return botSummarySchema.parse(r.json());
}

let markets = 0;
/**
 * Một lệnh mainnet đang mở của bot (engine ghi; ở đây chèn thẳng). Mỗi lệnh một market riêng: mỗi account × market chỉ
 * một lệnh mở (partial unique của #432).
 */
async function openTrade(botId: string, side: "long" | "short" = "long") {
  markets += 1;
  const market = `T${String(markets)}-USD`;
  const { rows: s } = await env.pool.query<{ id: string }>(
    `insert into news_signals (id, story_key, cycle_at, article_id, market, kind, catalyst, side, level, first_published_at,
       collected_at, decided_at, expires_at, typical_by_hold_hours, classifier_version, asset_map_version, rule_version)
     values (gen_random_uuid(), $1, now(), 'a1', $3, 'crypto', 'listing', $2, 'high', now(), now(), now(),
       now() + interval '2 minutes', '{"24":"3"}', 'c', 'a', 'news-v4') returning id`,
    [`${market}|${randomUUID()}`, side, market],
  );
  const { rows: b } = await env.pool.query<{ account: string }>(
    "select sodex_account_id as account from bots where id = $1",
    [botId],
  );
  const { rows } = await env.pool.query<{ id: string }>(
    `insert into news_signal_trades (id, bot_id, sodex_account_id, signal_id, seq, market, side, status, size_usdc,
       entry_limit_price, qty, entry_avg_price, tp_price, sl_price, max_hold_until, opened_at, created_at, updated_at)
     values (gen_random_uuid(), $1, $2, $3, (select coalesce(max(seq), 0) + 1 from news_signal_trades where bot_id = $1),
       $7, $4, 'open', 100, 100.3, 0.99, 100.2, $5, $6, now() + interval '1 day', now(), now(), now()) returning id`,
    [
      botId,
      b[0]?.account,
      s[0]?.id,
      side,
      side === "long" ? "104.7" : "95.7",
      side === "long" ? "97.95" : "102.4",
      market,
    ],
  );
  return rows[0]?.id ?? "";
}

beforeAll(async () => {
  env = await startTestEnv({ newsBots: flag });
  team = (await user(`nsb-team-${randomUUID()}@drift.test`, { team: true })).client;
  const t = await user(`nsb-tester-${randomUUID()}@drift.test`, { flag: true });
  tester = t.client;
  testerId = t.id;
  other = (await user(`nsb-other-${randomUUID()}@drift.test`, { flag: true })).client;
  plain = (await user(`nsb-plain-${randomUUID()}@drift.test`)).client;
  const { rows } = await env.pool.query<{ id: string }>(
    "select id from signal_bot_versions where is_baseline",
  );
  baselineId = rows[0]?.id ?? "";
});
afterAll(async () => {
  await env.close();
});

describe("SIGNAL_NEWS_BOTS_ENABLED off", () => {
  it("create, Start and Resume return 409 FEATURE_NOT_READY for everyone and change nothing", async () => {
    flag.enabled = false;
    const before = {
      bots: await count("select count(*) as n from bots"),
      audit: await count("select count(*) as n from audit_log"),
    };
    for (const c of [team, tester, plain]) {
      const r = await create(c);
      expect(r.statusCode).toBe(409);
      expect(errOf(r)).toMatchObject({ code: "FEATURE_NOT_READY", message: NEWS_BOTS_NOT_READY });
    }
    // Bot đã có (ví dụ tạo lúc cờ bật): Start / Resume cũng bị chặn, state giữ nguyên.
    flag.enabled = true;
    const bot = await createdBot(tester);
    flag.enabled = false;
    const mid = await count("select count(*) as n from audit_log");
    for (const action of ["start", "resume"]) {
      const r = await tester.request("POST", `/api/v1/bots/${bot.id}/actions/${action}`, {
        body: { acknowledged: true },
      });
      expect(r.statusCode).toBe(409);
      expect(errOf(r).code).toBe("FEATURE_NOT_READY");
    }
    const { rows } = await env.pool.query<{ state: string }>(
      "select state from bots where id = $1",
      [bot.id],
    );
    expect(rows[0]?.state).toBe("draft");
    expect(await count("select count(*) as n from audit_log")).toBe(mid);
    expect(await count("select count(*) as n from bots")).toBe(before.bots + 1);
    expect(before.audit).toBeLessThan(mid);
    // Key không bị giữ: cùng key gửi lại sau khi bật cờ thì chạy thật.
    const key = randomUUID();
    expect((await create(tester, {}, key)).statusCode).toBe(409);
    flag.enabled = true;
    expect((await create(tester, {}, key)).statusCode).toBe(201);
  });
});

describe("creating a bot from a version (flag on)", () => {
  it("team and users with signal_research can create; others get 403", async () => {
    flag.enabled = true;
    for (const c of [team, tester]) {
      const bot = await createdBot(c);
      expect(bot).toMatchObject({ strategy: "news_signal", state: "draft", engine: "perps" });
      const { rows } = await env.pool.query<{
        v: string;
        config: { sizeUsdc: string; leverage: number };
      }>(
        `select b.signal_version_id as v, bv.config from bots b join bot_versions bv on bv.id = b.active_version_id
         where b.id = $1`,
        [bot.id],
      );
      expect(rows[0]?.v).toBe(baselineId);
      expect(rows[0]?.config).toMatchObject({ sizeUsdc: "100", leverage: 1 });
    }
    const r = await create(plain);
    expect(r.statusCode).toBe(403);
    expect((await plain.request("GET", base)).statusCode).toBe(403);
  });

  it("markets can only narrow and Min level can only rise; size is capped at 200 USDC, leverage 1", async () => {
    flag.enabled = true;
    const narrow = {
      ...baselineVersionConfig(),
      minLevel: "medium",
      assets: { mode: "only", markets: ["SOL-USD"], crypto: true, stocks: true },
    };
    const { rows } = await env.pool.query<{ id: string }>(
      `insert into signal_bot_versions (id, number, name, config, status) values (gen_random_uuid(),
         (select max(number) + 1 from signal_bot_versions), 'Narrow', $1, 'stopped') returning id`,
      [JSON.stringify(narrow)],
    );
    const versionId = rows[0]?.id ?? "";
    const wide = await create(tester, { versionId, config: config({ minLevel: "medium" }) });
    expect(wide.statusCode).toBe(400);
    expect(errOf(wide).details).toMatchObject({ fieldErrors: { assets: [expect.any(String)] } });
    const lower = await create(tester, {
      versionId,
      config: config({ assets: narrow.assets, minLevel: "low" }),
    });
    expect(errOf(lower).details).toMatchObject({ fieldErrors: { minLevel: [expect.any(String)] } });
    const ok = await create(tester, {
      versionId,
      config: config({ assets: narrow.assets, minLevel: "high" }),
    });
    expect(ok.statusCode).toBe(201);
    const big = await create(tester, { config: config({ sizeUsdc: "200.01" }) });
    expect(big.statusCode).toBe(400);
    expect(errOf(big).details).toMatchObject({
      fieldErrors: { "config.sizeUsdc": [expect.any(String)] },
    });
    // Đòn bẩy 1 / 5 / 10 / 20 (#458): mức khác bị chặn.
    expect((await create(tester, { config: config({ leverage: 2 }) })).statusCode).toBe(400);
    expect((await create(tester, { config: config({ leverage: 3 }) })).statusCode).toBe(400);
    expect((await create(tester, { config: config({ leverage: 50 }) })).statusCode).toBe(400);
    for (const leverage of [5, 10, 20])
      expect((await create(tester, { config: config({ leverage }) })).statusCode).toBe(201);
    expect((await create(tester, { config: config({ sizeUsdc: "200" }) })).statusCode).toBe(201);
  });

  it("someone else's My version is 404", async () => {
    flag.enabled = true;
    const { rows } = await env.pool.query<{ id: string }>(
      `insert into signal_bot_versions (id, number, name, config, status, owner_user_id) values (gen_random_uuid(),
         (select max(number) + 1 from signal_bot_versions), 'Mine', $1, 'stopped', $2) returning id`,
      [JSON.stringify(baselineVersionConfig()), testerId],
    );
    expect((await create(other, { versionId: rows[0]?.id })).statusCode).toBe(404);
    expect((await create(tester, { versionId: rows[0]?.id })).statusCode).toBe(201);
  });
});

describe("one person's bot is invisible to everyone else", () => {
  it("user B (and team) get 404 BOT_NOT_FOUND on A's bot, and nothing changes", async () => {
    flag.enabled = true;
    const bot = await createdBot(tester);
    const tradeId = await openTrade(bot.id);
    const before = await count("select count(*) as n from news_signal_commands");
    for (const c of [other, team]) {
      const calls = [
        c.request("GET", `${base}/${bot.id}/trades`),
        c.request("GET", `${base}/${bot.id}/signals`),
        c.request("POST", `${base}/${bot.id}/trades/${tradeId}/close`),
        c.request("POST", `${base}/${bot.id}/trades/${tradeId}/tpsl`, { body: { tp: "110" } }),
        c.request("POST", `/api/v1/bots/${bot.id}/actions/start`, { body: { acknowledged: true } }),
        c.request("POST", `/api/v1/bots/${bot.id}/actions/stop`, { body: {} }),
      ];
      for (const r of await Promise.all(calls)) {
        expect(r.statusCode).toBe(404);
        expect(errOf(r).code).toBe("BOT_NOT_FOUND");
      }
    }
    expect(await count("select count(*) as n from news_signal_commands")).toBe(before);
    const { rows } = await env.pool.query<{ state: string }>(
      "select state from bots where id = $1",
      [bot.id],
    );
    expect(rows[0]?.state).toBe("draft");
  });
});

describe("Close now and Edit TP/SL", () => {
  it("queue commands idempotently with an increasing seq; one at a time per trade", async () => {
    flag.enabled = true;
    const bot = await createdBot(tester);
    const tradeId = await openTrade(bot.id);
    const key = randomUUID();
    const r1 = await tester.request("POST", `${base}/${bot.id}/trades/${tradeId}/close`, {
      idempotencyKey: key,
    });
    expect(r1.statusCode).toBe(202);
    const c1 = newsCommandSchema.parse(r1.json());
    expect(c1).toMatchObject({ kind: "close", seq: 1, status: "queued", tp: null, sl: null });
    const again = await tester.request("POST", `${base}/${bot.id}/trades/${tradeId}/close`, {
      idempotencyKey: key,
    });
    expect(newsCommandSchema.parse(again.json()).id).toBe(c1.id);
    expect(
      await count("select count(*) as n from news_signal_commands where trade_id = $1", [tradeId]),
    ).toBe(1);

    // Command trước chưa xong → không xếp thêm.
    const busy = await tester.request("POST", `${base}/${bot.id}/trades/${tradeId}/tpsl`, {
      body: { tp: "106" },
    });
    expect(busy.statusCode).toBe(409);
    expect(errOf(busy)).toMatchObject({
      code: "STATE_CONFLICT",
      details: { reason: "command_pending" },
    });

    await env.pool.query("update news_signal_commands set status = 'rejected' where id = $1", [
      c1.id,
    ]);
    const r2 = await tester.request("POST", `${base}/${bot.id}/trades/${tradeId}/tpsl`, {
      body: { tp: "106", sl: "99" },
    });
    expect(r2.statusCode).toBe(202);
    expect(newsCommandSchema.parse(r2.json())).toMatchObject({
      kind: "edit_tpsl",
      seq: 2,
      tp: "106",
      sl: "99",
      status: "queued",
    });
    const trades = newsTradesSchema.parse(
      (await tester.request("GET", `${base}/${bot.id}/trades`)).json(),
    );
    expect(trades.items[0]?.pendingCommand?.seq).toBe(2);
    expect(trades.items[0]).toMatchObject({ tpPrice: "104.7", slPrice: "97.95", status: "open" });
  });

  it("rejects wrong prices and trades that are not open", async () => {
    flag.enabled = true;
    const bot = await createdBot(tester);
    const long = await openTrade(bot.id, "long");
    const tpsl = (tradeId: string, body: unknown) =>
      tester.request("POST", `${base}/${bot.id}/trades/${tradeId}/tpsl`, { body });
    // Long: SL phải dưới TP (TP hiện tại 104.7).
    const bad = await tpsl(long, { sl: "105" });
    expect(bad.statusCode).toBe(400);
    expect(errOf(bad).details).toMatchObject({ fieldErrors: { sl: [expect.any(String)] } });
    expect((await tpsl(long, {})).statusCode).toBe(400);
    expect((await tpsl(long, { tp: "0" })).statusCode).toBe(400);
    expect((await tpsl(long, { tp: "abc" })).statusCode).toBe(400);
    await env.pool.query(
      "update news_signal_trades set status = 'closed', closed_at = now() where id = $1",
      [long],
    );
    const closed = await tpsl(long, { tp: "110" });
    expect(closed.statusCode).toBe(409);
    expect(errOf(closed).details).toMatchObject({ reason: "trade_not_open" });
    expect(
      await count("select count(*) as n from news_signal_commands where trade_id = $1", [long]),
    ).toBe(0);
    // Trade không thuộc bot → 404.
    const another = await createdBot(tester);
    const foreign = await openTrade(another.id);
    expect((await tpsl(foreign, { tp: "110" })).statusCode).toBe(404);
  });

  it("users without Signal Research cannot list, but the owner can always Close now", async () => {
    flag.enabled = true;
    const bot = await createdBot(tester);
    const tradeId = await openTrade(bot.id);
    await env.pool.query("update users set signal_research = false where id = $1", [testerId]);
    try {
      expect((await tester.request("GET", `${base}/${bot.id}/trades`)).statusCode).toBe(403);
      expect(
        (
          await tester.request("POST", `${base}/${bot.id}/trades/${tradeId}/tpsl`, {
            body: { tp: "110" },
          })
        ).statusCode,
      ).toBe(403);
      const close = await tester.request("POST", `${base}/${bot.id}/trades/${tradeId}/close`);
      expect(close.statusCode).toBe(202);
    } finally {
      await env.pool.query("update users set signal_research = true where id = $1", [testerId]);
    }
  });
});

describe("leverage 1 / 5 / 10 / 20 (#458)", () => {
  it("the balance start check needs size × max open trades ÷ leverage; a bot without the field reads as 1×", async () => {
    flag.enabled = true;
    const u = await user(`nsb-levx-${randomUUID()}@drift.test`, { flag: true });
    const needed = async (over: Record<string, unknown>) => {
      const r = await create(u.client, { config: config({ assets: only("XRP-USD"), ...over }) });
      expect(r.statusCode).toBe(201);
      const bot = botSummarySchema.parse(r.json());
      const res = await u.client.request("GET", `/api/v1/bots/${bot.id}/checks`);
      const body = startChecksSchema.parse(res.json());
      const balance = body.checks.find((c) => c.key === "balance");
      return { botId: bot.id, needed: (balance?.data as { needed?: string } | undefined)?.needed };
    };
    const maxOpen = baselineVersionConfig().maxOpenTrades;
    const one = await needed({ sizeUsdc: "200", leverage: 1 });
    expect(one.needed).toBe(String(200 * maxOpen));
    const five = await needed({ sizeUsdc: "200", leverage: 5 });
    expect(five.needed).toBe(String((200 * maxOpen) / 5));
    const twenty = await needed({ sizeUsdc: "150", leverage: 20 });
    expect(twenty.needed).toBe(String((150 * maxOpen) / 20));
    // Bot cũ: config không có trường `leverage` → 1×.
    await env.pool.query(`update bot_versions set config = config - 'leverage' where bot_id = $1`, [
      one.botId,
    ]);
    const res = await u.client.request("GET", `/api/v1/bots/${one.botId}/checks`);
    const balance = startChecksSchema.parse(res.json()).checks.find((c) => c.key === "balance");
    expect((balance?.data as { needed?: string } | undefined)?.needed).toBe(String(200 * maxOpen));
  });
});

describe("leverage_conflict start-check (DEC-58)", () => {
  /** Bot thật khác của user, đang chạy, đặt đòn bẩy trên `market`. */
  async function liveBot(userId: string, market: string) {
    const { rows: a } = await env.pool.query<{ id: string }>(
      "select id from sodex_accounts where user_id = $1",
      [userId],
    );
    const { rows: b } = await env.pool.query<{ id: string }>(
      `insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state, mode)
       values (gen_random_uuid(), $1, $2, 'futures_grid', $3, 'perps', 'Grid ' || $3, 'running', 'live') returning id`,
      [userId, a[0]?.id, market],
    );
    const { rows: v } = await env.pool.query<{ id: string }>(
      `insert into bot_versions (id, bot_id, version, config, param_source, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 1, $2, 'manual', 'active', now(), now()) returning id`,
      [b[0]?.id, JSON.stringify({ market, leverage: 2, marginMode: "cross" })],
    );
    await env.pool.query("update bots set active_version_id = $1 where id = $2", [
      v[0]?.id,
      b[0]?.id,
    ]);
  }
  const only = (m: string) => ({ mode: "only", markets: [m], crypto: true, stocks: true });

  it("blocks creating a bot whose markets include a market another live bot uses", async () => {
    flag.enabled = true;
    const u = await user(`nsb-lev-${randomUUID()}@drift.test`, { flag: true });
    await liveBot(u.id, "SOL-USD");
    const all = await create(u.client);
    expect(all.statusCode).toBe(409);
    expect(errOf(all)).toMatchObject({
      code: "STATE_CONFLICT",
      details: { reason: "leverage_conflict", market: "SOL-USD", kind: "bot" },
    });
    expect(
      (await create(u.client, { config: config({ assets: only("SOL-USD") }) })).statusCode,
    ).toBe(409);
    expect(
      (await create(u.client, { config: config({ assets: only("BTC-USD") }) })).statusCode,
    ).toBe(201);
  });

  it("reports the conflict in the bot's start checks", async () => {
    flag.enabled = true;
    const u = await user(`nsb-lev2-${randomUUID()}@drift.test`, { flag: true });
    const r = await create(u.client, { config: config({ assets: only("BTC-USD") }) });
    const bot = botSummarySchema.parse(r.json());
    const check = async () => {
      const res = await u.client.request("GET", `/api/v1/bots/${bot.id}/checks`);
      expect(res.statusCode).toBe(200);
      const body = startChecksSchema.parse(res.json());
      expect(body.checks.map((c) => c.key)).toEqual([
        "api_key",
        "builder_fee",
        "balance",
        "leverage_conflict",
      ]);
      return body.checks.find((c) => c.key === "leverage_conflict");
    };
    expect(await check()).toMatchObject({ ok: true, detail: "none" });
    await liveBot(u.id, "BTC-USD");
    expect(await check()).toMatchObject({
      ok: false,
      detail: "bot",
      data: { market: "BTC-USD", botName: "Grid BTC-USD" },
    });
  });
});
