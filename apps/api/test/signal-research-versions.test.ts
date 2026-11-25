import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  baselineVersionConfig,
  errorResponseSchema,
  meSchema,
  NEWS_CLASSIFIER,
  researchArticlesPageSchema,
  researchArticleTraceSchema,
  researchMarketsSchema,
  researchSummarySchema,
  researchTradeDetailSchema,
  researchTradesPageSchema,
  researchVersionCreatedSchema,
  researchVersionSchema,
  srMarketsSnapshot,
  researchVersionsSchema,
  type BotVersionConfig,
  type ResearchVersion,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// API News bot versions (#305, DEC-328 / DEC-331). Dữ liệu lệnh / event do scheduler ghi; ở đây chèn thẳng. Migration 0047
// seed Baseline (v3, running). Classifier hiện tại = NEWS_CLASSIFIER.promptVersion.

let env: TestEnv;
let team: TestClient;
let user: TestClient;
let teamId: string;
let baselineId: string;
let v4: ResearchVersion;
const base = "/api/v1/admin/signal-research";
const CURRENT = NEWS_CLASSIFIER.promptVersion;
/** #377: mọi version mới cần một giả thuyết (một câu). */
const HYP = "One change gives a better result after fees.";
const cfg = baselineVersionConfig();
const onlyCfg: BotVersionConfig = {
  ...cfg,
  minLevel: "medium",
  assets: { mode: "only", markets: ["BTC-USD", "ETH-USD"], crypto: true, stocks: true },
};

const ago = (min: number) => new Date(env.clock.now.getTime() - min * 60_000).toISOString();
const post = (c: TestClient, path: string, body: unknown, key?: string) =>
  c.request("POST", `${base}${path}`, {
    body,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });
const errOf = (r: { json: () => unknown }) => errorResponseSchema.parse(r.json()).error;
const list = async () => {
  const r = await team.request("GET", `${base}/versions`);
  expect(r.statusCode).toBe(200);
  return researchVersionsSchema.parse(r.json());
};
const item = async (id: string) => {
  const v = (await list()).items.find((x) => x.id === id);
  if (v === undefined) throw new Error(`version ${id} missing`);
  return v;
};
const count = async (sql: string, params: unknown[] = []) =>
  Number((await env.pool.query<{ n: number }>(sql, params)).rows[0]?.n);

/** Bản chụp `sr:markets` giả do scheduler ghi `minutesAgo` phút trước (null = chưa có). */
function setMarkets(minutesAgo: number | null) {
  env.srMarkets.value =
    minutesAgo === null
      ? null
      : JSON.stringify(
          srMarketsSnapshot(
            [
              { name: "SOL-USD", status: "TRADING", baseCoin: "SOL", displayName: "Solana" },
              { name: "NVDA-USD", status: "TRADING" },
              { name: "BTC-USD", status: "TRADING", baseCoin: "BTC" },
              { name: "KIOXIA-USD", status: "HALT" },
              { name: "ETH-USD", status: "TRADING", baseCoin: "ETH" },
            ],
            new Date(env.clock.now.getTime() - minutesAgo * 60_000),
          ),
        );
}

/** Version chèn thẳng (đã dừng, để không đụng giới hạn 3 version chạy). */
async function insertVersion(number: number, createdAt: string): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into signal_bot_versions (id, number, name, config, status, created_at, updated_at, status_changed_at)
     values ($1, $2, $3, $4, 'stopped', $5, $5, $5)`,
    [id, number, `Bulk ${String(number)}`, JSON.stringify(cfg), createdAt],
  );
  return id;
}

interface TradeOpts {
  id?: string;
  versionId: string | null;
  label?: "live" | "shadow";
  status?: "open" | "closed";
  classifier?: string | null;
  openedAt: string;
  exitedAt?: string | null;
  resultPct?: string | null;
  exitReason?: string | null;
  shadowReason?: string | null;
  articleId?: string | null;
  storyId?: string | null;
  market?: string;
  opposite?: { at: string; resultUsdc: string; resultPct: string } | null;
}

async function trade(o: TradeOpts): Promise<string> {
  const id = o.id ?? randomUUID();
  const status = o.status ?? "closed";
  const pct = o.resultPct ?? (status === "closed" ? "1" : null);
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, label, version_id, story_id, article_id, market, token, catalyst, direction, size_usdc, qty,
       entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until,
       event_at, seen_at, opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, exit_price, exit_reason,
       exited_at, exit_fee, result_usdc, result_pct, random_pct, rule_version, classifier_version, shadow_reason,
       opposite_at, opposite_exit_price, opposite_result_usdc, opposite_result_pct)
     values ($1, 'news', $2, $3, $4, $5, $6, 'ETH', 'etf_approved', 'long', 500, 0.15, 3400, 3400, 0.01, 0.05, 0.25, 1, 1.6, 0.8,
       3454, 3372, $7::timestamptz + interval '3 days', $7, $7, $7, 'medium', '[]', false, 'book', $8,
       case when $8 = 'closed' then 3450 end, $9, $10, case when $8 = 'closed' then 0.25 end, $11, $12, 0, 'news-v6', $13, $14,
       $15, case when $15::timestamptz is not null then 3420 end, $16, $17)`,
    [
      id,
      o.label ?? "live",
      o.versionId,
      o.storyId ?? null,
      o.articleId ?? null,
      o.market ?? "ETH-USD",
      o.openedAt,
      status,
      status === "closed" ? (o.exitReason ?? "take_profit") : null,
      status === "closed" ? (o.exitedAt ?? o.openedAt) : null,
      pct === null ? null : String(Number(pct) * 5),
      pct,
      o.classifier === undefined ? CURRENT : o.classifier,
      o.shadowReason ?? null,
      o.opposite?.at ?? null,
      o.opposite?.resultUsdc ?? null,
      o.opposite?.resultPct ?? null,
    ],
  );
  return id;
}

/** `n` lệnh đã đóng của classifier hiện tại, mỗi giờ một lệnh từ `from` (trải nhiều ngày), kết quả `pct` %. */
async function bulkTrades(versionId: string, n: number, from: string, pct: string) {
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, label, version_id, market, token, catalyst, direction, size_usdc, qty, entry_price, entry_mid,
       spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until, event_at, seen_at,
       opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, exit_price, exit_reason, exited_at, exit_fee,
       result_usdc, result_pct, random_pct, rule_version, classifier_version)
     select gen_random_uuid(), 'news', 'live', $1, 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 0.15, 3400, 3400, 0.01, 0.05, 0.25, 1,
       1.6, 0.8, 3454, 3372, t + interval '3 days', t, t, t, 'medium', '[]', false, 'book', 'closed', 3450, 'take_profit',
       t + interval '30 minutes', 0.25, $3::numeric * 5, $3::numeric, 0, 'news-v6', $4
     from (select $2::timestamptz + (g * interval '3 hours') as t from generate_series(1, $5::int) g) s`,
    [versionId, from, pct, CURRENT, n],
  );
}

async function article(id: string) {
  await env.pool.query(
    `insert into signal_articles (id, source, url, title, content, published_at, collected_at, matched_currencies, candidates, content_hash,
       status, classification, claude_prompt_version, rule_version)
     values ($1, 'Reuters', null, $2, 'Body', $3, $3, '[{"symbol":"ETH","name":"Ethereum"}]',
       '[{"symbol":"ETH","market":"ETH-USD","kind":"crypto"}]', $4, 'classified',
       '{"catalyst":"etf_approved","market":"ETH-USD","relevance":"direct","promotional":false}', $5, 'news-v6')`,
    [id, `Title ${id}`, ago(60), `hash-${id}`, CURRENT],
  );
}

async function event(
  articleId: string,
  stage: string,
  outcome: string,
  extra: {
    reason?: string;
    detail?: object;
    storyId?: string;
    tradeId?: string;
    versionId?: string;
    min?: number;
  } = {},
) {
  await env.pool.query(
    `insert into signal_events (id, article_id, story_id, trade_id, stage, outcome, reason, detail, rule_version, version_id, at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'news-v6', $8, $9)`,
    [
      articleId,
      extra.storyId ?? null,
      extra.tradeId ?? null,
      stage,
      outcome,
      extra.reason ?? null,
      extra.detail === undefined ? null : JSON.stringify(extra.detail),
      extra.versionId ?? null,
      ago(extra.min ?? 59),
    ],
  );
}

async function story(id: string, versionId: string | null, outcome: string) {
  await env.pool.query(
    `insert into signal_stories (id, story_key, market, catalyst, direction, first_article_id, first_seen_at, sources, level_at_entry,
       later_level, outcome, locked, rule_version, version_id)
     values ($1, 'ETH-USD|etf_approved', 'ETH-USD', 'etf_approved', 'long', 'va1', $2, '[{"name":"Reuters","tier":"top"}]',
       'medium', 'medium', $3, true, 'news-v6', $4)`,
    [id, ago(60), outcome, versionId],
  );
}

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  teamId = meSchema.parse((await signIn(env, team, `ver-${randomUUID()}@drift.test`)).json()).id;
  await env.pool.query("update users set role = 'team' where id = $1", [teamId]);
  user = new TestClient(env.app);
  await signIn(env, user, `ver-user-${randomUUID()}@drift.test`);
  setMarkets(1);
  const b = await env.pool.query<{ id: string }>(
    "select id from signal_bot_versions where is_baseline",
  );
  baselineId = b.rows[0]?.id ?? "";
});

afterAll(async () => {
  await env.close();
});

describe("News bot versions API (#305)", () => {
  it("401 signed out, 403 for non-team users, role checked before the body and Idempotency-Key", async () => {
    const anon = new TestClient(env.app);
    for (const r of [`${base}/versions`, `${base}/markets`]) {
      expect((await anon.request("GET", r)).statusCode).toBe(401);
      expect((await user.request("GET", r)).statusCode).toBe(403);
    }
    const body = { name: "x", config: cfg, start: false, hypothesis: HYP };
    expect((await post(anon, "/versions", body)).statusCode).toBe(401);
    expect((await post(user, "/versions", body)).statusCode).toBe(403);
    expect((await post(user, "/versions", { nope: true })).statusCode).toBe(403);
    const noKey = await user.request("POST", `${base}/versions`, { body, idempotencyKey: false });
    expect(noKey.statusCode).toBe(403);
    const st = await post(user, `/versions/${baselineId}/status`, { status: "paused" });
    expect(st.statusCode).toBe(403);
    expect(await count("select count(*)::int as n from signal_bot_versions")).toBe(1);
    expect(
      await count("select count(*)::int as n from signal_bot_versions where status = 'running'"),
    ).toBe(1);
  });

  it("lists the seeded Baseline", async () => {
    const r = await team.request("GET", `${base}/versions`);
    expect(r.headers["cache-control"]).toBe("no-store");
    const l = researchVersionsSchema.parse(r.json());
    expect(l).toMatchObject({ running: 1, maxRunning: 3, versionsTried: 1, extraCheck: false });
    expect(l.classifier).toMatchObject({ current: CURRENT, labeled: 0, passes: false });
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({
      id: baselineId,
      number: 3,
      name: "Baseline",
      isBaseline: true,
      status: "running",
      createdBy: null,
      savedFrom: null,
      changedFromPrevious: null,
      config: cfg,
      balance: "10000",
      available: "10000",
      openTrades: 0,
      maxOpenTrades: 20,
      effectiveMaxOpen: 20,
      todayTrades: 0,
      maxNewTradesPerDay: null,
      blockedByLimit: 0,
      closed: 0,
      counted: 0,
      avgPct: null,
      gate: { status: "waits_for_labels", segmentClosed: 0, notCounted: [] },
    });
  });

  it("markets: read only from the scheduler's sr:markets snapshot; missing → null + stale, old → stale", async () => {
    const get = async () => {
      const r = await team.request("GET", `${base}/markets`);
      expect(r.statusCode).toBe(200);
      return researchMarketsSchema.parse(r.json());
    };
    setMarkets(null);
    expect(await get()).toEqual({ items: null, updatedAt: null, stale: true });
    env.srMarkets.value = "{not json";
    expect(await get()).toEqual({ items: null, updatedAt: null, stale: true });
    setMarkets(1);
    const fresh = await get();
    expect(fresh.stale).toBe(false);
    expect(fresh.updatedAt).toBe(new Date(env.clock.now.getTime() - 60_000).toISOString());
    expect(fresh.items?.map((x) => [x.market, x.kind, x.status])).toEqual([
      ["BTC-USD", "crypto", "TRADING"],
      ["ETH-USD", "crypto", "TRADING"],
      ["SOL-USD", "crypto", "TRADING"],
      ["KIOXIA-USD", "stock", "HALT"],
      ["NVDA-USD", "stock", "TRADING"],
    ]);
    expect(fresh.items?.find((x) => x.market === "SOL-USD")).toEqual({
      market: "SOL-USD",
      base: "SOL",
      displayName: "Solana",
      kind: "crypto",
      status: "TRADING",
    });
    expect(fresh.items?.find((x) => x.market === "NVDA-USD")).toMatchObject({
      base: "NVDA",
      displayName: null,
    });
    setMarkets(16);
    const old = await get();
    expect(old.stale).toBe(true);
    expect(old.items).toHaveLength(5);
    setMarkets(1);
  });

  it("rejects an invalid version: TP under 1× cost, unknown market, unknown parent, extra keys", async () => {
    const bad = [
      { name: "x", config: { ...cfg, minTpCostMultiple: "0.5" }, start: false, hypothesis: HYP },
      { name: "", config: cfg, start: false, hypothesis: HYP },
      { name: "x", config: cfg },
      { name: "x", config: cfg, start: false, hypothesis: HYP, extra: 1 },
      {
        name: "x",
        config: { ...cfg, assets: { mode: "only", markets: [], crypto: true, stocks: true } },
        start: false,
        hypothesis: HYP,
      },
    ];
    for (const body of bad) {
      const r = await post(team, "/versions", body);
      expect(r.statusCode).toBe(400);
      expect(errOf(r).code).toBe("VALIDATION_FAILED");
    }
    const tp = errOf(await post(team, "/versions", bad[0]));
    expect(Object.keys((tp.details as { fieldErrors: object }).fieldErrors)).toEqual([
      "config.minTpCostMultiple",
    ]);
    const unknown = await post(team, "/versions", {
      name: "x",
      config: {
        ...cfg,
        assets: { mode: "except", markets: ["FOO-USD", "ETH-USD"], crypto: true, stocks: true },
      },
      start: false,
      hypothesis: HYP,
    });
    expect(unknown.statusCode).toBe(400);
    expect(errOf(unknown).details).toMatchObject({
      fieldErrors: { "config.assets.markets": ["not_listed"] },
      markets: ["FOO-USD"],
    });
    const parent = await post(team, "/versions", {
      name: "x",
      config: cfg,
      start: false,
      hypothesis: HYP,
      savedFromVersionId: randomUUID(),
    });
    expect(parent.statusCode).toBe(400);
    expect(errOf(parent).details).toMatchObject({
      fieldErrors: { savedFromVersionId: ["not_found"] },
    });
    expect(await count("select count(*)::int as n from signal_bot_versions")).toBe(1);
  });

  it("creates an immutable version from Baseline, audits it and replays the same Idempotency-Key", async () => {
    const key = randomUUID();
    const body = {
      name: "Strict subject",
      config: onlyCfg,
      start: true,
      hypothesis: HYP,
      savedFromVersionId: baselineId,
    };
    const r = await post(team, "/versions", body, key);
    expect(r.statusCode).toBe(201);
    const created = researchVersionCreatedSchema.parse(r.json());
    expect(created.warnings).toEqual([]);
    v4 = researchVersionSchema.parse(created);
    expect(v4).toMatchObject({
      number: 4,
      name: "Strict subject",
      status: "running",
      isBaseline: false,
      createdAt: env.clock.now.toISOString(),
      createdBy: teamId.replace(/-/g, "").slice(-4),
      savedFrom: { id: baselineId, number: 3 },
      config: onlyCfg,
      maxOpenTrades: 20,
      effectiveMaxOpen: 2,
      classifier: { current: CURRENT, segmentStart: env.clock.now.toISOString(), used: [] },
    });
    expect(v4.changedFromPrevious).toEqual([
      { field: "minLevel", from: "low", to: "medium" },
      { field: "assetMode", from: "all", to: "only" },
      { field: "assets", added: ["BTC-USD", "ETH-USD"], removed: [] },
    ]);
    const again = await post(team, "/versions", body, key);
    expect(again.statusCode).toBe(201);
    expect(researchVersionSchema.parse(again.json()).id).toBe(v4.id);
    expect(await count("select count(*)::int as n from signal_bot_versions")).toBe(2);
    expect(
      await count(
        "select count(*)::int as n from audit_log where action = 'signal_research.version_created' and target = $1 and user_id = $2",
        [v4.id, teamId],
      ),
    ).toBe(1);
    const l = await list();
    expect(l).toMatchObject({ running: 2, versionsTried: 2, extraCheck: false, repeatTrades: 100 });
    expect(l.items.map((x) => x.number)).toEqual([4, 3]);
  });

  it("at most 3 running: the 4th start is 409 MAX_RUNNING_VERSIONS, saving paused still works", async () => {
    const v5 = await post(team, "/versions", {
      name: "Wider stops",
      config: { ...cfg, slMultiple: "1" },
      start: true,
      hypothesis: HYP,
    });
    expect(v5.statusCode).toBe(201);
    // Baseline + 2 version đã lưu = 3 → kiểm tra thêm chưa bật (409 bên dưới không lưu gì nên không tính).
    expect(await list()).toMatchObject({ versionsTried: 3, extraCheck: false });
    const fourth = await post(team, "/versions", {
      name: "Too many",
      config: cfg,
      start: true,
      hypothesis: HYP,
    });
    expect(fourth.statusCode).toBe(409);
    expect(errOf(fourth)).toMatchObject({
      code: "STATE_CONFLICT",
      message: "Pause or stop a version first.",
      details: { reason: "MAX_RUNNING_VERSIONS", max: 3 },
    });
    const paused = await post(team, "/versions", {
      name: "Later",
      config: cfg,
      start: false,
      hypothesis: HYP,
    });
    expect(paused.statusCode).toBe(201);
    expect(researchVersionSchema.parse(paused.json())).toMatchObject({
      number: 6,
      status: "paused",
      savedFrom: null,
      changedFromPrevious: null,
    });
    // Baseline + 3 version đã lưu (kể cả paused) = 4 → bật.
    expect(await list()).toMatchObject({ running: 3, versionsTried: 4, extraCheck: true });
  });

  it("status transitions follow #303 and are audited; config has no update route", async () => {
    const l = await list();
    const v6 = l.items.find((x) => x.number === 6);
    if (v6 === undefined) throw new Error("v6 missing");
    const resume = await post(team, `/versions/${v6.id}/status`, { status: "running" });
    expect(resume.statusCode).toBe(409);
    expect(errOf(resume).details).toMatchObject({ reason: "MAX_RUNNING_VERSIONS" });
    const retire = await post(team, `/versions/${v6.id}/status`, { status: "retired" });
    expect(retire.statusCode).toBe(409);
    expect(errOf(retire)).toMatchObject({
      code: "STATE_CONFLICT",
      details: { from: "paused", to: "retired" },
    });

    const pause = await post(team, `/versions/${v4.id}/status`, { status: "paused" });
    expect(pause.statusCode).toBe(200);
    expect(researchVersionSchema.parse(pause.json())).toMatchObject({
      id: v4.id,
      status: "paused",
    });
    expect((await post(team, `/versions/${v6.id}/status`, { status: "running" })).statusCode).toBe(
      200,
    );
    expect((await post(team, `/versions/${v6.id}/status`, { status: "stopped" })).statusCode).toBe(
      200,
    );
    expect((await post(team, `/versions/${v6.id}/status`, { status: "retired" })).statusCode).toBe(
      200,
    );
    expect((await post(team, `/versions/${v4.id}/status`, { status: "running" })).statusCode).toBe(
      200,
    );
    expect(
      await count(
        "select count(*)::int as n from audit_log where action = 'signal_research.version_status' and target = $1",
        [v6.id],
      ),
    ).toBe(3);

    expect(
      (await post(team, `/versions/${randomUUID()}/status`, { status: "paused" })).statusCode,
    ).toBe(404);
    expect((await post(team, "/versions/not-a-uuid/status", { status: "paused" })).statusCode).toBe(
      400,
    );
    expect((await post(team, `/versions/${v4.id}/status`, { status: "deleted" })).statusCode).toBe(
      400,
    );
    for (const method of ["PUT", "DELETE"] as const) {
      const r = await team.request(method, `${base}/versions/${v4.id}`, { body: { config: cfg } });
      expect(r.statusCode).toBe(404);
    }
    expect((await item(v4.id)).config).toEqual(onlyCfg);
  });

  it("list counts: open / today / blocked by limit / closed, balance; gate waits for labels or is not counted", async () => {
    const now = env.clock.now.getTime();
    const at = (min: number) => new Date(now + min * 60_000).toISOString();
    await trade({ versionId: v4.id, status: "open", openedAt: at(10) });
    await trade({ versionId: v4.id, status: "closed", openedAt: at(20), resultPct: "2" });
    await trade({ versionId: v4.id, status: "closed", openedAt: at(30), resultPct: "-1" });
    await trade({
      versionId: v4.id,
      label: "shadow",
      shadowReason: "LIMIT_OPEN",
      status: "open",
      openedAt: at(40),
    });
    await trade({
      versionId: v4.id,
      label: "shadow",
      shadowReason: "LIMIT_DAY",
      status: "closed",
      openedAt: at(50),
    });
    // Lệnh trước khi có version (news-v3, version_id null) thuộc Baseline; classifier cũ chưa qua.
    await trade({
      versionId: null,
      status: "closed",
      openedAt: ago(600),
      classifier: "news-classifier-v1",
    });
    const x = await item(v4.id);
    expect(x).toMatchObject({
      openTrades: 1,
      todayTrades: 3,
      blockedByLimit: 2,
      closed: 2,
      counted: 0,
      // 10 000 + 2 % × 5 − 1 % × 5 (result_usdc = pct × 5 trong test); available trừ 500 đang mở.
      balance: "10005",
      available: "9505",
      classifier: { used: [CURRENT] },
      gate: {
        status: "waits_for_labels",
        segmentClosed: 2,
        classifierStatus: "needsLabels",
        labelsToGo: 50,
      },
    });
    expect(x.gate.notCounted).toEqual([
      { classifierVersion: CURRENT, closed: 2, status: "needsLabels", labelsToGo: 50 },
    ]);
    const b = await item(baselineId);
    expect(b).toMatchObject({
      closed: 1,
      blockedByLimit: 0,
      gate: { status: "not_counted", segmentClosed: 0 },
    });
    expect(b.gate.notCounted).toEqual([
      { classifierVersion: "news-classifier-v1", closed: 1, status: "needsLabels", labelsToGo: 50 },
    ]);
  });

  it("gate once the classifier passed: collecting, passes, fails and needs_repeat (> 3 versions tried)", async () => {
    const from = "2026-09-01T00:00:00Z";
    const repeatPending = await insertVersion(20, from);
    const repeated = await insertVersion(21, from);
    const failing = await insertVersion(22, from);
    await bulkTrades(repeatPending, 130, "2026-09-02T00:00:00Z", "1");
    await bulkTrades(repeated, 200, "2026-09-02T00:00:00Z", "1");
    await bulkTrades(failing, 120, "2026-09-02T00:00:00Z", "-1");
    // 50 nhãn Right cho classifier hiện tại → cổng nhãn qua.
    await env.pool.query(
      `insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict, source)
       select gen_random_uuid(), 'lbl-' || g, $1, $2, 'right', 'random' from generate_series(1, 50) g`,
      [CURRENT, teamId],
    );
    const l = await list();
    // Baseline + v4, v5, v6 + 3 version chèn thẳng = 7 version đã lưu.
    expect(l).toMatchObject({ versionsTried: 7, extraCheck: true });
    expect(l.classifier).toMatchObject({
      labeled: 50,
      passes: true,
      status: "passed",
      labelsToGo: 0,
    });
    const by = (id: string) => l.items.find((v) => v.id === id);
    expect(by(v4.id)).toMatchObject({
      counted: 2,
      avgPct: 0.5,
      gate: { status: "collecting", notCounted: [] },
    });
    expect(by(repeatPending)).toMatchObject({
      closed: 130,
      counted: 130,
      avgPct: 1,
      gate: { status: "needs_repeat", firstPassAt: 100, repeat: { closed: 30, needed: 100 } },
    });
    expect(by(repeated)).toMatchObject({
      counted: 200,
      gate: { status: "passes", firstPassAt: 100, repeat: { closed: 100, needed: 100 } },
    });
    expect(by(failing)).toMatchObject({
      counted: 120,
      gate: { status: "fails", firstPassAt: null, repeat: null },
    });
    // Baseline: classifier hiện tại đã qua nhưng đoạn đếm mới chưa có lệnh; lệnh của classifier cũ vẫn không tính.
    expect(by(baselineId)?.gate).toMatchObject({
      status: "collecting",
      segmentClosed: 0,
      notCounted: [{ classifierVersion: "news-classifier-v1", closed: 1, status: "needsLabels" }],
    });
  });

  it("versionId filters summary, trades, feed and trace; shadow and opposite-news fields", async () => {
    const storyB = randomUUID();
    const storyV = randomUUID();
    await story(storyB, null, "entered");
    await story(storyV, v4.id, "shadow");
    // va1: dùng chung tới Score; Baseline (dòng trước version) mở lệnh; v4 bị Max open trades chặn → lệnh shadow.
    await article("va1");
    await event("va1", "collect", "pass");
    await event("va1", "normalize", "pass");
    await event("va1", "understand", "pass", {
      detail: { market: "ETH-USD", direction: "long", maxHoldHours: 72 },
    });
    const baseTrade = await trade({
      versionId: null,
      status: "open",
      openedAt: ago(58),
      articleId: "va1",
      storyId: storyB,
    });
    await event("va1", "filter", "pass", { storyId: storyB, detail: { level: "medium" } });
    await event("va1", "decide", "open", { storyId: storyB, tradeId: baseTrade });
    const shadow = await trade({
      versionId: v4.id,
      label: "shadow",
      shadowReason: "LIMIT_OPEN",
      status: "closed",
      resultPct: "1.5",
      openedAt: ago(58),
      articleId: "va1",
      storyId: storyV,
    });
    await event("va1", "filter", "drop", {
      storyId: storyV,
      tradeId: shadow,
      versionId: v4.id,
      reason: "LIMIT_OPEN",
      detail: { level: "medium", maxOpenTrades: 20, shadowTradeId: shadow },
    });
    // va2: tin ngược chiều; v4 (Close) đóng lệnh đang mở của nó.
    const closedByNews = await trade({
      versionId: v4.id,
      status: "closed",
      exitReason: "opposite_news",
      openedAt: ago(120),
      resultPct: "-0.4",
      opposite: { at: ago(30), resultUsdc: "-2", resultPct: "-0.4" },
    });
    const kept = await trade({
      versionId: v4.id,
      status: "open",
      openedAt: ago(110),
      market: "BTC-USD",
      opposite: { at: ago(30), resultUsdc: "3.5", resultPct: "0.7" },
    });
    await article("va2");
    await event("va2", "collect", "pass");
    await event("va2", "normalize", "pass");
    await event("va2", "understand", "pass", { detail: { market: "ETH-USD", direction: "short" } });
    await event("va2", "filter", "drop", {
      versionId: v4.id,
      reason: "OPPOSITE_NEWS",
      detail: { closed: true, closedTradeId: closedByNews, closedTradeIds: [closedByNews] },
    });

    // Tổng kết
    const sumB = researchSummarySchema.parse((await team.request("GET", `${base}/summary`)).json());
    expect(sumB.version).toEqual({ id: baselineId, number: 3, name: "Baseline", isBaseline: true });
    expect(sumB.bots[0]?.openTrades).toBe(1);
    const sumV = researchSummarySchema.parse(
      (await team.request("GET", `${base}/summary?versionId=${v4.id}`)).json(),
    );
    expect(sumV.version).toMatchObject({ id: v4.id, number: 4, isBaseline: false });
    expect(sumV.bots[0]?.openTrades).toBe(2);
    expect(sumV.funnel?.outcomes.opposite).toBe(1);

    // Danh sách lệnh: chỉ lệnh thật của version; tín hiệu bị chặn mang lệnh shadow.
    const tV = researchTradesPageSchema.parse(
      (await team.request("GET", `${base}/trades?versionId=${v4.id}&show=all&limit=100`)).json(),
    );
    expect(tV.items.every((x) => x.versionId === v4.id)).toBe(true);
    expect(tV.items.some((x) => x.id === shadow)).toBe(false);
    expect(tV.items.find((x) => x.id === closedByNews)?.opposite).toMatchObject({
      action: "closed",
      resultUsdc: "-2",
      resultPct: -0.4,
      exitPrice: "3420",
    });
    expect(tV.items.find((x) => x.id === kept)?.opposite).toMatchObject({
      action: "kept",
      resultPct: 0.7,
    });
    const skip = tV.items.find((x) => x.skipped !== null);
    expect(skip?.skipped).toEqual({
      reason: "limitOpen",
      tpPct: null,
      neededPct: null,
      limit: 20,
      shadow: { tradeId: shadow, outcome: "tp", pnl: "7.5" },
    });
    const tB = researchTradesPageSchema.parse(
      (await team.request("GET", `${base}/trades?show=all&limit=100`)).json(),
    );
    expect(tB.items.some((x) => x.versionId === v4.id)).toBe(false);
    expect(tB.items.some((x) => x.id === baseTrade)).toBe(true);
    const d = researchTradeDetailSchema.parse(
      (await team.request("GET", `${base}/trades/${shadow}`)).json(),
    );
    expect(d.trade).toMatchObject({ versionId: v4.id, shadow: { reason: "limitOpen", limit: 20 } });

    // Feed + trace: cùng bài, bước dừng theo version.
    const fB = researchArticlesPageSchema.parse(
      (await team.request("GET", `${base}/articles`)).json(),
    );
    expect(fB.items.find((a) => a.id === "va1")).toMatchObject({
      outcome: "traded",
      tradeId: baseTrade,
      versionId: baselineId,
      shadowTradeId: null,
    });
    expect(fB.items.find((a) => a.id === "va2")).toMatchObject({
      stage: "score",
      outcome: "waiting",
    });
    const fV = researchArticlesPageSchema.parse(
      (await team.request("GET", `${base}/articles?versionId=${v4.id}`)).json(),
    );
    expect(fV.items.find((a) => a.id === "va1")).toMatchObject({
      stage: "filter",
      outcome: "dropped",
      reason: "limitOpen",
      reasonLimit: 20,
      versionId: v4.id,
      shadowTradeId: shadow,
      opposite: null,
    });
    expect(fV.items.find((a) => a.id === "va2")).toMatchObject({
      reason: "oppositeNews",
      opposite: { action: "closed", tradeId: closedByNews },
    });
    const trV = researchArticleTraceSchema.parse(
      (await team.request("GET", `${base}/articles/va1/trace?versionId=${v4.id}`)).json(),
    );
    const filter = trV.steps[3];
    expect(filter?.key === "filter" ? filter.detail : null).toMatchObject({
      reasonLimit: 20,
      shadowTradeId: shadow,
      opposite: null,
    });
    expect(trV.steps[4]?.status).toBe("notReached");
    const trB = researchArticleTraceSchema.parse(
      (await team.request("GET", `${base}/articles/va1/trace`)).json(),
    );
    const decide = trB.steps[4];
    expect(decide?.key === "decide" ? decide.detail : null).toMatchObject({
      tradeId: baseTrade,
      opposite: null,
    });

    for (const path of ["/summary", "/trades", "/articles", "/articles/va1/trace"]) {
      expect(
        (await team.request("GET", `${base}${path}?versionId=${randomUUID()}`)).statusCode,
      ).toBe(404);
      expect((await team.request("GET", `${base}${path}?versionId=nope`)).statusCode).toBe(400);
    }
  });

  it("version create: missing market list → 503, stale → saved with a warning, stale + unknown market → 400", async () => {
    const before = await count("select count(*)::int as n from signal_bot_versions");
    const withAssets = (markets: string[]) => ({
      name: "Assets check",
      config: { ...cfg, assets: { mode: "except", markets, crypto: true, stocks: true } },
      start: false,
      hypothesis: HYP,
    });
    setMarkets(null);
    const missing = await post(team, "/versions", withAssets(["BTC-USD"]));
    expect(missing.statusCode).toBe(503);
    expect(errOf(missing)).toMatchObject({
      code: "MARKET_LIST_UNAVAILABLE",
      details: { reason: "MARKET_LIST_MISSING" },
    });
    expect(await count("select count(*)::int as n from signal_bot_versions")).toBe(before);
    // 503 xảy ra trước mọi ghi nên key được giải phóng (PRE_SIDE_EFFECT_CODES): cùng key thử lại thành công khi
    // scheduler đã ghi bản chụp.
    const key = randomUUID();
    expect((await post(team, "/versions", withAssets(["BTC-USD"]), key)).statusCode).toBe(503);
    setMarkets(1);
    const retried = await post(team, "/versions", withAssets(["BTC-USD"]), key);
    expect(retried.statusCode).toBe(201);
    expect(researchVersionCreatedSchema.parse(retried.json()).warnings).toEqual([]);
    setMarkets(null);
    // Không có danh sách tài sản thì không cần bản chụp.
    const noList = await post(team, "/versions", {
      name: "All assets",
      config: cfg,
      start: false,
      hypothesis: HYP,
    });
    expect(noList.statusCode).toBe(201);
    expect(researchVersionCreatedSchema.parse(noList.json()).warnings).toEqual([]);

    setMarkets(30);
    const staleUnknown = await post(team, "/versions", withAssets(["BTC-USD", "NEW-USD"]));
    expect(staleUnknown.statusCode).toBe(400);
    expect(errOf(staleUnknown).details).toMatchObject({
      fieldErrors: { "config.assets.markets": ["not_listed"] },
      markets: ["NEW-USD"],
    });
    const stale = await post(team, "/versions", withAssets(["BTC-USD", "KIOXIA-USD"]));
    expect(stale.statusCode).toBe(201);
    expect(researchVersionCreatedSchema.parse(stale.json())).toMatchObject({
      status: "paused",
      warnings: ["market_list_stale"],
    });
    expect(await count("select count(*)::int as n from signal_bot_versions")).toBe(before + 3);
    setMarkets(1);
  });
});

describe("signal research API module never reaches SoDEX (DEC-322 / DEC-327)", () => {
  const dir = join(import.meta.dirname, "../src/modules/signal-research");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(dir, f));
  it.each(files)("%s imports nothing that can reach SoDEX", (file) => {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/from\s+"([^"]+)"/g))
      expect(m[1] ?? "").not.toMatch(/@drift\/sodex|signer|gateway|engine/i);
    expect(src).not.toMatch(
      /HttpGateway|SignedWriteClient|SodexRestClient|getPerpsSymbols|sodex\.dev/,
    );
  });
  it("finds the module files", () => {
    expect(files.length).toBeGreaterThan(0);
  });
});
