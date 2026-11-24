import { randomUUID } from "node:crypto";

import {
  baselineVersionConfig,
  errorResponseSchema,
  meSchema,
  NEWS_CLASSIFIER,
  NEWS_RULES,
  SR_EXPORT_ROW_LIMITS,
  srExportSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Export data của Signal Research (#489): chỉ team (401 / 403), kỳ 24h / 7d / 30d (khác → 400), đúng các khoá theo
// `srExportSchema`, mainnet chỉ số gộp (DEC-361), vượt trần ghi rõ trong `meta`, và test dò: không email, user id, địa chỉ
// ví (kể cả ví H1), id bot / tài khoản mainnet, id version riêng, nội dung / URL bài, chuỗi lỗi thô của nguồn.

let env: TestEnv;
let team: TestClient;
let tester: TestClient;
let plain: TestClient;
const ids: string[] = [];
const emails: string[] = [];
let botId = "";
let accountId = "";
let privateVersionId = "";
let paperTradeId = "";
const base = "/api/v1/admin/signal-research";
const WALLET = "0x4E1e4796c10C637EDAB56461450BD8D02EFb29Db";
const H1_WALLET = "0x1111111111111111111111111111111111111abc";
const BODY = "FULL-ARTICLE-BODY-must-not-be-exported";
const URL_SECRET = "https://example.test/article?apikey=SECRET123";
const SOURCE_ERROR = "fetch failed: https://api.example.test/news?token=SOURCE-TOKEN-XYZ";

const ago = (min: number) => new Date(env.clock.now.getTime() - min * 60_000).toISOString();
const errOf = (r: { json: () => unknown }) => errorResponseSchema.parse(r.json()).error;

async function user(email: string) {
  const client = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, client, email)).json());
  ids.push(me.id);
  emails.push(email);
  return { client, id: me.id };
}

/** Bài qua Score (classifier hiện tại), thu `minAgo` phút trước. */
async function article(id: string, minAgo: number) {
  await env.pool.query(
    `insert into signal_articles (id, source, url, title, content, published_at, collected_at, matched_currencies, candidates, content_hash,
       status, classified_at, classification, claude_calls, claude_input_tokens, claude_cache_write_tokens, claude_cache_read_tokens,
       claude_output_tokens, claude_model, claude_prompt_version, claude_done_at, rule_version)
     values ($1, 'Reuters', $7, $2, $8, $3, $3, '[{"symbol":"ETH","name":"Ethereum"}]',
       '[{"symbol":"ETH","market":"ETH-USD","kind":"crypto"}]', $4, 'classified', $3,
       '{"catalyst":"etf_approved","market":"ETH-USD","relevance":"direct","promotional":false}', 1, 500, 0, 4000, 100, $5, $6, $3,
       $9)`,
    [
      id,
      `Title ${id}`,
      ago(minAgo),
      `hash-${id}`,
      NEWS_CLASSIFIER.model,
      NEWS_CLASSIFIER.promptVersion,
      URL_SECRET,
      BODY,
      NEWS_RULES.version,
    ],
  );
  for (const [stage, detail] of [
    ["collect", null],
    ["normalize", null],
    [
      "understand",
      { market: "ETH-USD", catalyst: "etf_approved", direction: "long", maxHoldHours: 72 },
    ],
  ] as const)
    await env.pool.query(
      `insert into signal_events (id, article_id, stage, outcome, detail, rule_version, at)
       values (gen_random_uuid(), $1, $2, 'pass', $3, $4, $5)`,
      [id, stage, detail === null ? null : JSON.stringify(detail), NEWS_RULES.version, ago(minAgo)],
    );
}

async function paperTrade(articleId: string, versionId: string | null, level: string) {
  const { rows } = await env.pool.query<{ id: string }>(
    `insert into signal_paper_trades (id, lane, label, version_id, article_id, market, token, catalyst, direction, size_usdc, qty,
       entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until,
       event_at, seen_at, opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, rule_version,
       classifier_version)
     values (gen_random_uuid(), 'news', 'live', $1, $2, 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 0.15, 3400, 3400, 0.01, 0.05, 0.25,
       1, 1.6, 0.8, 3454, 3372, $3::timestamptz + interval '3 days', $3, $3, $3, $4, '[]', false, 'book', 'open', $5, $6)
     returning id`,
    [versionId, articleId, ago(20), level, NEWS_RULES.version, NEWS_CLASSIFIER.promptVersion],
  );
  return rows[0]?.id ?? "";
}

const exportOf = (c: TestClient, period = "24h") =>
  c.request("GET", `${base}/export?period=${period}`);

beforeAll(async () => {
  env = await startTestEnv();
  const t = await user(`sre-team-${randomUUID()}@drift.test`);
  team = t.client;
  await env.pool.query("update users set role = 'team' where id = $1", [t.id]);
  const s = await user(`sre-tester-${randomUUID()}@drift.test`);
  tester = s.client;
  await env.pool.query("update users set signal_research = true where id = $1", [s.id]);
  plain = (await user(`sre-plain-${randomUUID()}@drift.test`)).client;

  // Bot mainnet của người dùng test: tài khoản có địa chỉ ví, một tín hiệu đã phát, một lần giao, một lệnh đang mở.
  const { rows: acc } = await env.pool.query<{ id: string }>(
    "insert into sodex_accounts (id, user_id, address, sodex_account_id, network, status) values (gen_random_uuid(), $1, $2, 4242, 'mainnet', 'connected') returning id",
    [s.id, WALLET],
  );
  accountId = acc[0]?.id ?? "";
  ids.push(accountId);
  const { rows: bot } = await env.pool.query<{ id: string }>(
    "insert into bots (id, user_id, sodex_account_id, strategy, market, engine, name, state) values (gen_random_uuid(), $1, $2, 'spot_grid', 'vBTC_vUSDC', 'spot', 'Grid', 'running') returning id",
    [s.id, accountId],
  );
  botId = bot[0]?.id ?? "";
  ids.push(botId);
  const { rows: sig } = await env.pool.query<{ id: string }>(
    `insert into news_signals (id, story_key, cycle_at, article_id, market, kind, catalyst, side, level, first_published_at,
       collected_at, decided_at, expires_at, typical_by_hold_hours, classifier_version, asset_map_version, rule_version)
     values (gen_random_uuid(), 'ETH-USD|x', $1, 'e1', 'ETH-USD', 'crypto', 'listing', 'long', 'high', $1, $1, $1,
       $1::timestamptz + interval '2 minutes', '{"24":"3"}', 'c', 'a', 'news-v5') returning id`,
    [ago(30)],
  );
  const signalId = sig[0]?.id ?? "";
  await env.pool.query(
    `insert into news_signal_deliveries (signal_id, bot_id, outcome, reason, epoch, created_at) values ($1, $2, 'accepted', null, 1, $3)`,
    [signalId, botId, ago(30)],
  );
  await env.pool.query(
    `insert into news_signal_trades (id, bot_id, sodex_account_id, signal_id, seq, market, side, status, size_usdc,
       entry_limit_price, qty, max_hold_until, opened_at)
     values (gen_random_uuid(), $1, $2, $3, 1, 'ETH-USD', 'long', 'open', 100, 100.3, 0.99,
       $4::timestamptz + interval '1 day', $4)`,
    [botId, accountId, signalId, ago(29)],
  );

  // Bài: e1 (30 phút trước, mở lệnh giấy Baseline level high), e2 (3 ngày trước: chỉ có trong 7d / 30d).
  await article("e1", 30);
  await article("e2", 3 * 24 * 60);
  const { rows: bl } = await env.pool.query<{ id: string }>(
    "select id from signal_bot_versions where is_baseline",
  );
  const baselineId = bl[0]?.id ?? "";
  paperTradeId = await paperTrade("e1", baselineId, "high");
  await env.pool.query(
    `insert into signal_events (id, article_id, trade_id, stage, outcome, rule_version, version_id, at)
     values (gen_random_uuid(), 'e1', $1, 'decide', 'open', $2, $3, $4)`,
    [paperTradeId, NEWS_RULES.version, baselineId, ago(20)],
  );
  // Version riêng của người dùng test + một lệnh giấy của nó: chỉ được đếm.
  const { rows: pv } = await env.pool.query<{ id: string }>(
    `insert into signal_bot_versions (id, number, name, config, status, owner_user_id)
     values (gen_random_uuid(), 900, 'Private tester version', $1, 'paused', $2) returning id`,
    [JSON.stringify(baselineVersionConfig()), s.id],
  );
  privateVersionId = pv[0]?.id ?? "";
  ids.push(privateVersionId);
  ids.push(await paperTrade("e1", privateVersionId, "low"));

  // Bối cảnh của e1 với địa chỉ ví H1 đã lưu (không được xuất, chỉ số đếm).
  await env.pool.query(
    `insert into signal_contexts (id, article_id, market, direction, decided_at, source, context_version, rule_version,
       h1_status, h1_wallets_checked, h1_agreeing_wallets, h1_opposing_wallets, h1_agreeing_addresses, h1_opposing_addresses,
       h2_status, h3_status)
     values (gen_random_uuid(), 'e1', 'ETH-USD', 'long', $1, 'live', 'context-v2', $2, 'yes', 30, 1, 0, $3, '{}', 'na', 'no')`,
    [ago(25), NEWS_RULES.version, [H1_WALLET]],
  );
  await env.pool.query(
    `insert into signal_source_health (source, last_ok_at, last_error_at, last_error, last_cycle_at) values ('sosovalue', $1, $2, $3, $1)`,
    [ago(1), ago(90), SOURCE_ERROR],
  );
  await env.pool.query(
    `insert into signal_research_usage (day, soso_requests, claude_calls, claude_input_tokens, claude_cache_write_tokens,
       claude_cache_read_tokens, claude_output_tokens) values ($1, 12, 3, 1500, 0, 12000, 300)`,
    [env.clock.now.toISOString().slice(0, 10)],
  );
  await env.pool.query(
    `insert into signal_classifier_versions (prompt_version, model, started_at) values ($1, $2, $3) on conflict do nothing`,
    [NEWS_CLASSIFIER.promptVersion, NEWS_CLASSIFIER.model, ago(10_000)],
  );
});

afterAll(async () => {
  await env.close();
});

describe("Export data access (#489)", () => {
  it("401 without a session, 403 for testers with the flag and for other users", async () => {
    expect((await exportOf(new TestClient(env.app))).statusCode).toBe(401);
    const t = await exportOf(tester);
    expect(t.statusCode).toBe(403);
    expect(errOf(t).code).toBe("FORBIDDEN");
    expect((await exportOf(plain)).statusCode).toBe(403);
  });

  it("400 for a period other than 24h / 7d / 30d (no silent clamp to 30 days)", async () => {
    for (const p of ["1y", "90d", "31d", ""]) {
      const r = await exportOf(team, p);
      expect(r.statusCode, p).toBe(400);
      expect(errOf(r).code).toBe("VALIDATION_FAILED");
    }
  });
});

describe("Export data file (#489)", () => {
  it("downloads a JSON attachment named by period and UTC date, matching the shared schema", async () => {
    const r = await exportOf(team);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("application/json");
    expect(r.headers["content-disposition"]).toBe(
      `attachment; filename="desklabs-signal-research-24h-${env.clock.now.toISOString().slice(0, 10)}.json"`,
    );
    expect(r.headers["cache-control"]).toBe("no-store");
    const raw: unknown = r.json();
    expect(Object.keys(raw as object).sort()).toEqual(
      [
        "articles",
        "context",
        "costs",
        "mainnet",
        "meta",
        "paperTrades",
        "sources",
        "versions",
      ].sort(),
    );
    const f = srExportSchema.parse(raw);
    expect(f.meta).toMatchObject({
      schemaVersion: 2,
      period: "24h",
      to: env.clock.now.toISOString(),
      rulesVersion: NEWS_RULES.version,
      readerVersion: NEWS_CLASSIFIER.promptVersion,
      truncated: false,
    });
    expect(f.meta.from).toBe(ago(24 * 60));
    expect(f.meta.sections.articles).toEqual({
      rows: 1,
      total: 1,
      omitted: 0,
      truncated: false,
      limit: SR_EXPORT_ROW_LIMITS.articles,
    });
  });

  it("articles carry stop step, outcome, reader, Claude labels, level and side; title only, no body or URL", async () => {
    const f = srExportSchema.parse((await exportOf(team)).json());
    expect(f.articles.map((a) => a.id)).toEqual(["e1"]);
    expect(f.articles[0]).toMatchObject({
      title: "Title e1",
      source: "Reuters",
      market: "ETH-USD",
      stage: "decide",
      outcome: "traded",
      reason: null,
      readerVersion: NEWS_CLASSIFIER.promptVersion,
      catalyst: "etf_approved",
      relevance: "direct",
      promotional: false,
      level: "high",
      side: "long",
      paperTradeId,
      claudeCalls: 1,
      // #509: bài có tiêu đề không có đoạn trích.
      excerpt: null,
    });
    expect(f.articles[0]?.claudeDoneAt).not.toBeNull();
  });

  it("covers 7d and 30d: the 3-day-old article appears only there", async () => {
    for (const p of ["7d", "30d"]) {
      const f = srExportSchema.parse((await exportOf(team, p)).json());
      expect(f.meta.period).toBe(p);
      expect(f.articles.map((a) => a.id).sort(), p).toEqual(["e1", "e2"]);
    }
  });

  it("context has H1 counts only; versions and paper trades count private versions without owners", async () => {
    const f = srExportSchema.parse((await exportOf(team)).json());
    expect(f.context).toHaveLength(1);
    expect(f.context[0]?.h1).toMatchObject({
      status: "yes",
      walletsChecked: 30,
      agreeingWallets: 1,
    });
    expect(f.versions.team.some((v) => v.isBaseline)).toBe(true);
    expect(f.versions.team.map((v) => v.name)).not.toContain("Private tester version");
    expect(f.versions.private).toEqual({ total: 1, byStatus: [{ key: "paused", n: 1 }] });
    expect(f.paperTrades.items.map((t) => t.id)).toEqual([paperTradeId]);
    expect(f.paperTrades.items[0]?.level).toBe("high");
    expect(f.paperTrades.privateVersionTrades).toBe(1);
  });

  it("mainnet is aggregates only; costs per day; sources without the raw error text", async () => {
    const f = srExportSchema.parse((await exportOf(team)).json());
    expect(f.mainnet).toEqual({
      signals: {
        total: 1,
        byLevel: [{ key: "high", n: 1 }],
        byKind: [{ key: "crypto", n: 1 }],
      },
      deliveries: { total: 1, byOutcome: [{ outcome: "accepted", reason: null, n: 1 }] },
      trades: { total: 1, byStatus: [{ key: "open", n: 1 }], byCloseReason: [] },
    });
    expect(f.costs.days).toHaveLength(1);
    expect(f.costs.days[0]).toMatchObject({ sosoRequests: 12, claudeCalls: 3 });
    expect(Number(f.costs.days[0]?.claudeCostUsd)).toBeGreaterThan(0);
    expect(f.sources).toEqual([
      {
        source: "sosovalue",
        status: "live",
        lastOkAt: ago(1),
        lastErrorAt: ago(90),
        lastCycleAt: ago(1),
        watermarkAt: null,
      },
    ]);
  });

  it("never contains emails, user / bot / account / private version ids, wallets, article bodies, URLs or raw errors", async () => {
    for (const p of ["24h", "7d", "30d"]) {
      const body = (await exportOf(team, p)).body;
      // Mẫu chung: email, địa chỉ ví 0x + 40 hex.
      expect(body, p).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(body, p).not.toMatch(/0x[0-9a-fA-F]{40}/);
      // Giá trị cụ thể của fixture.
      for (const s of [
        ...ids,
        ...emails,
        WALLET,
        WALLET.toLowerCase(),
        H1_WALLET,
        BODY,
        URL_SECRET,
        "SECRET123",
        "SOURCE-TOKEN-XYZ",
        "Private tester version",
        "4242",
      ])
        expect(body.includes(s), `${p}: ${s}`).toBe(false);
      // Không có khoá của dữ liệu cấm ở bất kỳ tầng nào.
      expect(body, p).not.toMatch(
        /"(email|userId|user_id|ownerUserId|createdBy|botId|bot_id|sodexAccountId|address|addresses|apiKey|token|signature|content|url|lastError)"\s*:/,
      );
    }
  });

  it("#509: untitled articles carry a short normalized excerpt; titled ones none; still no secrets", async () => {
    const secretBody = [
      "<p>LIT token unlock tomorrow: 12% of supply.",
      URL_SECRET,
      "contact leak@desk.test",
      WALLET,
      "sig",
      "ab".repeat(40),
      "</p>",
      "y".repeat(400),
    ].join(" ");
    await env.pool.query(
      `insert into signal_articles (id, source, url, title, content, published_at, collected_at, matched_currencies, candidates,
         content_hash, status, rule_version)
       values ('u1', 'X', null, null, $1, $2, $2, '[]', '[]', 'hash-u1', 'collected', $3)`,
      [secretBody, ago(10), NEWS_RULES.version],
    );
    await env.pool.query(
      `insert into signal_events (id, article_id, stage, outcome, rule_version, at) values (gen_random_uuid(), 'u1', 'collect', 'pass', $1, $2)`,
      [NEWS_RULES.version, ago(10)],
    );
    try {
      const r = await exportOf(team);
      const f = srExportSchema.parse(r.json());
      const u = f.articles.find((a) => a.id === "u1");
      expect(u?.title).toBeNull();
      expect(u?.excerpt).toMatch(/^LIT token unlock tomorrow: 12% of supply\. contact sig y+…$/);
      expect(Array.from(u?.excerpt ?? "").length).toBeLessThanOrEqual(280);
      expect(f.articles.find((a) => a.id === "e1")?.excerpt).toBeNull();
      for (const s of [URL_SECRET, "SECRET123", "leak@desk.test", WALLET, "abab", BODY, "<p>"])
        expect(r.body.includes(s), s).toBe(false);
      expect(r.body).not.toMatch(/0x[0-9a-fA-F]{40}/);
      expect(r.body).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    } finally {
      await env.pool.query("delete from signal_events where article_id = 'u1'");
      await env.pool.query("delete from signal_articles where id = 'u1'");
    }
  });

  it("marks a section truncated with the omitted count instead of cutting silently", async () => {
    // Vượt trần bối cảnh: thêm đúng (trần) dòng mới trong kỳ → tổng = trần + 1.
    await env.pool.query(
      `insert into signal_contexts (id, article_id, market, direction, decided_at, source, context_version, rule_version,
         h1_status, h2_status, h3_status)
       select gen_random_uuid(), 'bulk-' || g, 'ETH-USD', 'long', $1::timestamptz + (g * interval '1 millisecond'), 'live',
         'context-v2', $2, 'na', 'na', 'na'
       from generate_series(1, $3::int) g`,
      [ago(60), NEWS_RULES.version, SR_EXPORT_ROW_LIMITS.context],
    );
    const f = srExportSchema.parse((await exportOf(team)).json());
    expect(f.meta.truncated).toBe(true);
    expect(f.meta.sections.context).toEqual({
      rows: SR_EXPORT_ROW_LIMITS.context,
      total: SR_EXPORT_ROW_LIMITS.context + 1,
      omitted: 1,
      truncated: true,
      limit: SR_EXPORT_ROW_LIMITS.context,
    });
    expect(f.context).toHaveLength(SR_EXPORT_ROW_LIMITS.context);
    // Giữ các dòng mới nhất: dòng của e1 (25 phút trước) vẫn có.
    expect(f.context.some((c) => c.articleId === "e1")).toBe(true);
    expect(f.meta.sections.articles.truncated).toBe(false);
  });
});
