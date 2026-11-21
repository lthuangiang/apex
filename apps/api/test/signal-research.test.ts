import { randomUUID } from "node:crypto";

import {
  claudeCostUsd,
  errorResponseSchema,
  funnelSteps,
  meSchema,
  NEWS_CLASSIFIER,
  researchArticlesPageSchema,
  researchArticleTraceSchema,
  researchSummarySchema,
  researchTradeDetailSchema,
  researchTradesPageSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Signal research (#271): endpoint team, chỉ đọc. Dữ liệu do scheduler ghi; ở đây chèn thẳng một lệnh đã đóng.

let env: TestEnv;
let team: TestClient;
let user: TestClient;
const base = "/api/v1/admin/signal-research";
const tradeId = randomUUID();
const storyId = randomUUID();

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, team, `sr-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
  user = new TestClient(env.app);
  await signIn(env, user, `sr-user-${randomUUID()}@drift.test`);
  await env.pool.query(
    `insert into signal_articles (id, source, title, published_at, collected_at, matched_currencies, candidates, content_hash, status, rule_version)
     values ('art-1', 'Bloomberg', 'SEC delays SOL ETF', '2026-11-18T10:00:00Z', '2026-11-18T10:03:00Z', '[]', '[]', 'h', 'classified', 'news-v4')`,
  );
  await env.pool.query(
    `insert into signal_stories (id, story_key, market, catalyst, direction, first_article_id, first_seen_at, sources, level_at_entry, later_level, outcome, locked, rule_version)
     values ($1, 'SOL-USD|etf_delayed_or_rejected', 'SOL-USD', 'etf_delayed_or_rejected', 'short', 'art-1', '2026-11-18T10:03:00Z',
             '[{"name":"Bloomberg","tier":"top","articleId":"art-1","at":"2026-11-18T10:00:00.000Z"}]', 'medium', 'medium', 'entered', true, 'news-v4')`,
    [storyId],
  );
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, story_id, article_id, market, token, catalyst, direction, size_usdc, qty, entry_price, entry_mid,
       spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until, event_at, seen_at, opened_at,
       moved_before_entry_pct, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, exit_price, exit_reason, exited_at,
       exit_fee, result_usdc, result_pct, rule_version, classifier_version)
     values ($1, 'news', $2, 'art-1', 'SOL-USD', 'SOL', 'etf_delayed_or_rejected', 'short', 500, 3.5, 142.18, 142.2, 0.03, 0.05, 0.25, 1.33,
       2, 1, 139.34, 143.6, '2026-11-20T10:03:00Z', '2026-11-18T10:00:00Z', '2026-11-18T10:03:00Z', '2026-11-18T10:03:05Z', -0.6, 'medium',
       '[{"name":"Bloomberg","tier":"top"}]', false, 'book', 'closed', 139.3, 'take_profit', '2026-11-19T09:12:00Z', 0.24, 9.5, 1.9, 'news-v4',
       'cls-passed')`,
    [tradeId, storyId],
  );
  // #304: lệnh chỉ tính cổng khi classifier của nó đã qua (≥ 50 nhãn, ≥ 80%): 50 nhãn Right (random, #348) cho classifier của lệnh này.
  await env.pool.query(
    `insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict, source)
     select gen_random_uuid(), 'lbl-' || g, 'cls-passed', $1, 'right', 'random' from generate_series(1, 50) g`,
    [me.id],
  );
});

afterAll(async () => {
  await env.close();
});

describe("signal research (team only, read-only)", () => {
  it("401 signed out, 403 for non-team users", async () => {
    const anon = new TestClient(env.app);
    for (const r of [`${base}/summary`, `${base}/trades`, `${base}/trades/${tradeId}`]) {
      expect((await anon.request("GET", r)).statusCode).toBe(401);
      expect((await user.request("GET", r)).statusCode).toBe(403);
    }
  });

  it("checks the role before validating the query (403, not 400)", async () => {
    for (const r of [
      `${base}/trades?limit=abc`,
      `${base}/trades?cursor=not-a-cursor`,
      `${base}/trades?show=nope`,
      `${base}/summary?tz=${"x".repeat(100)}`,
    ])
      expect((await user.request("GET", r)).statusCode).toBe(403);
  });

  it("a bad or tampered cursor is a 400 VALIDATION_FAILED, never a 500 or page 1", async () => {
    const tampered = Buffer.from(
      JSON.stringify({ t: "2026-11-18T10:00:00.000Z", id: "x" }),
    ).toString("base64url");
    for (const c of ["not-a-cursor", tampered]) {
      const r = await team.request("GET", `${base}/trades?cursor=${c}`);
      expect(r.statusCode).toBe(400);
      expect(errorResponseSchema.parse(r.json()).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("returns the summary, a cursor page and the trade detail", async () => {
    const s = await team.request("GET", `${base}/summary`);
    expect(s.statusCode).toBe(200);
    expect(s.headers["cache-control"]).toBe("no-store");
    const summary = researchSummarySchema.parse(s.json());
    expect(summary.funnel?.outcomes).toEqual({
      closed: 1,
      tp: 1,
      sl: 0,
      maxHold: 0,
      opposite: 0,
      open: 0,
    });
    expect(summary.rows[0]).toMatchObject({
      type: "news",
      label: "live",
      rulesVersion: 4,
      closed: 1,
      avgPct: 1.9,
      status: "collecting",
      clusters: 1,
      needs: { kind: "pooled", more: 99 },
    });
    expect(summary.directions).toEqual([
      expect.objectContaining({ side: "long", closed: 0, avgPct: null }),
      expect.objectContaining({ side: "short", closed: 1, avgPct: 1.9, randomPct: null }),
    ]);
    // Không có nến cho lệnh này → so với ngẫu nhiên không tính được: null (không bao giờ 0).
    expect(summary.rows[0]?.randomPct).toBeNull();
    expect(summary.levels.find((l) => l.level === "medium")).toMatchObject({ trades: 1, short: 1 });
    expect(summary.sources).toEqual([]);
    expect(summary.assets).toEqual(["SOL-USD"]);
    // #297: số dư = 10 000 + kết quả đã chốt (9.5); không có lệnh mở → không có lãi / lỗ chưa chốt.
    expect(summary.bots[0]).toMatchObject({
      type: "news",
      balance: "10009.5",
      realized: "9.5",
      unrealized: null,
      openTrades: 0,
    });

    const p = await team.request("GET", `${base}/trades?limit=1&show=all&tz=Asia%2FHo_Chi_Minh`);
    const page = researchTradesPageSchema.parse(p.json());
    expect(page.items[0]).toMatchObject({
      id: tradeId,
      articleId: "art-1",
      type: "news",
      label: "live",
      delaySecs: 180,
      what: {
        type: "news",
        headline: "SEC delays SOL ETF",
        newsType: "etfDelayed",
        levelAtEntry: "medium",
      },
      result: { pnl: "9.5", outcome: "tp" },
    });
    expect(page.nextCursor).toBeNull();
    const whales = researchTradesPageSchema.parse(
      (await team.request("GET", `${base}/trades?type=whales`)).json(),
    );
    expect(whales.items).toEqual([]);
    expect((await team.request("GET", `${base}/trades?limit=500`)).statusCode).toBe(400);

    const d = await team.request("GET", `${base}/trades/${tradeId}`);
    const detail = researchTradeDetailSchema.parse(d.json());
    expect(detail.steps.map((x) => x.key)).toEqual([
      "received",
      "understood",
      "checks",
      "trade",
      "result",
    ]);
    expect(detail.heldSecs).toBeGreaterThan(0);
    expect((await team.request("GET", `${base}/trades/${randomUUID()}`)).statusCode).toBe(404);
  });
});

// ── Feed bài và trace (#291) ─────────────────────────────────────────────────────────────────────────────────────────

describe("signal research articles feed and trace (#291)", () => {
  const ago = (min: number) => new Date(env.clock.now.getTime() - min * 60_000).toISOString();
  const story1 = randomUUID();
  const story2 = randomUUID();
  const trade2 = randomUUID();
  const ETH_CAND = '[{"symbol":"ETH","market":"ETH-USD","kind":"crypto"}]';

  interface ArticleFixture {
    id: string;
    title?: string | null;
    content?: string | null;
    source?: string;
    published: number;
    collected: number;
    matched?: string;
    candidates?: string;
    status: string;
    classification?: object | null;
    duplicateOf?: string | null;
    usage?: [number, number | null, number | null, number | null, number | null] | null;
    ruleVersion?: string;
  }
  async function article(a: ArticleFixture) {
    const u = a.usage ?? null;
    await env.pool.query(
      `insert into signal_articles (id, source, url, title, content, published_at, collected_at, matched_currencies, candidates, content_hash,
         status, duplicate_of, classification, claude_calls, claude_input_tokens, claude_cache_write_tokens, claude_cache_read_tokens,
         claude_output_tokens, claude_model, claude_prompt_version, rule_version)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [
        a.id,
        a.source ?? "Reuters",
        `https://example.test/${a.id}`,
        a.title === undefined ? `Title ${a.id}` : a.title,
        a.content ?? `Body of ${a.id}`,
        ago(a.published),
        ago(a.collected),
        a.matched ?? '[{"symbol":"ETH","name":"Ethereum"}]',
        a.candidates ?? "[]",
        `hash-${a.id}`,
        a.status,
        a.duplicateOf ?? null,
        a.classification === undefined || a.classification === null
          ? null
          : JSON.stringify(a.classification),
        u?.[0] ?? null,
        u?.[1] ?? null,
        u?.[2] ?? null,
        u?.[3] ?? null,
        u?.[4] ?? null,
        u === null ? null : NEWS_CLASSIFIER.model,
        u === null ? null : NEWS_CLASSIFIER.promptVersion,
        a.ruleVersion ?? "news-v4",
      ],
    );
  }
  async function event(
    articleId: string,
    min: number,
    stage: string,
    outcome: string,
    extra: { reason?: string; detail?: object; storyId?: string; tradeId?: string } = {},
  ) {
    await env.pool.query(
      `insert into signal_events (id, article_id, story_id, trade_id, stage, outcome, reason, detail, rule_version, at)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'news-v4', $8)`,
      [
        articleId,
        extra.storyId ?? null,
        extra.tradeId ?? null,
        stage,
        outcome,
        extra.reason ?? null,
        extra.detail === undefined ? null : JSON.stringify(extra.detail),
        ago(min),
      ],
    );
  }
  const ethCls = {
    catalyst: "etf_approved",
    market: "ETH-USD",
    relevance: "direct",
    promotional: false,
    eventDate: null,
  };

  beforeAll(async () => {
    // 1. Vào lệnh (Long ETH), 2. gộp vào cùng câu chuyện.
    await article({
      id: "a-trade",
      published: 104,
      collected: 100,
      candidates: ETH_CAND,
      status: "classified",
      classification: ethCls,
      usage: [1, 512, 0, 4635, 118],
    });
    await article({
      id: "a-merged",
      source: "CoinDesk",
      published: 60,
      collected: 55,
      candidates: ETH_CAND,
      status: "classified",
      classification: ethCls,
      usage: [1, 500, 0, 4635, 100],
    });
    await env.pool.query(
      `insert into signal_stories (id, story_key, market, catalyst, direction, first_article_id, first_seen_at, sources, level_at_entry, later_level,
         outcome, locked, trade_id, rule_version)
       values ($1, 'ETH-USD|etf_approved', 'ETH-USD', 'etf_approved', 'long', 'a-trade', $2,
         '[{"name":"Reuters","tier":"top","articleId":"a-trade","at":"x"},{"name":"CoinDesk","tier":"top","articleId":"a-merged","at":"y"}]',
         'medium', 'high', 'entered', true, $3, 'news-v4')`,
      [story1, ago(100), trade2],
    );
    await env.pool.query(
      `insert into signal_paper_trades (id, lane, story_id, article_id, market, token, catalyst, direction, size_usdc, qty, entry_price, entry_mid,
         spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until, event_at, seen_at, opened_at,
         moved_before_entry_pct, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, rule_version)
       values ($1, 'news', $2, 'a-trade', 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 0.1465, 3412.5, 3412.3, 0.011, 0.05, 0.25, 1.07,
         1.6, 0.8, 3467.1, 3385.2, $3, $4, $5, $5, 0.3, 'medium', '[{"name":"Reuters","tier":"top"}]', false, 'book', 'open', 'news-v4')`,
      [trade2, story1, ago(100 - 72 * 60), ago(104), ago(100)],
    );
    for (const id of ["a-trade", "a-merged"]) {
      const at = id === "a-trade" ? 100 : 55;
      await event(id, at, "collect", "pass");
      await event(id, at, "normalize", "pass", { detail: { candidates: ["ETH-USD"] } });
      await event(id, at, "understand", "pass", {
        detail: {
          market: "ETH-USD",
          catalyst: "etf_approved",
          direction: "long",
          maxHoldHours: 72,
        },
      });
    }
    await event("a-trade", 100, "filter", "pass", {
      storyId: story1,
      detail: { level: "medium", tpPct: "1.6000", costPct: "0.1000", spreadPct: "0.0110" },
    });
    await event("a-trade", 100, "decide", "open", {
      storyId: story1,
      tradeId: trade2,
      detail: { direction: "long", retry: false },
    });
    await event("a-merged", 55, "filter", "merge", {
      storyId: story1,
      reason: "SAME_STORY",
      detail: { laterLevel: "high" },
    });

    // 3. Bị bỏ ở Filter: TP dưới 2 × chi phí.
    await article({
      id: "a-filter",
      published: 90,
      collected: 85,
      matched: '[{"symbol":"SOL","name":"Solana"}]',
      candidates: '[{"symbol":"SOL","market":"SOL-USD","kind":"crypto"}]',
      status: "classified",
      classification: { ...ethCls, catalyst: "hack_exploit", market: "SOL-USD" },
      usage: [1, 600, 0, 4635, 90],
    });
    await env.pool.query(
      `insert into signal_stories (id, story_key, market, catalyst, direction, first_article_id, first_seen_at, sources, level_at_entry, later_level,
         outcome, locked, rule_version)
       values ($1, 'SOL-USD|hack_exploit', 'SOL-USD', 'hack_exploit', 'short', 'a-filter', $2,
         '[{"name":"Reuters","tier":"mid","articleId":"a-filter","at":"x"}]', 'low', 'low', 'skipped', false, 'news-v4')`,
      [story2, ago(85)],
    );
    await event("a-filter", 85, "collect", "pass");
    await event("a-filter", 85, "normalize", "pass");
    await event("a-filter", 85, "understand", "pass", {
      detail: { market: "SOL-USD", catalyst: "hack_exploit", direction: "short", maxHoldHours: 24 },
    });
    await event("a-filter", 85, "filter", "drop", {
      storyId: story2,
      reason: "MOVE_TOO_SMALL_FOR_COST",
      detail: { level: "low", tpPct: "0.1500", costPct: "0.1000", spreadPct: "0.0200" },
    });

    // 4. Bị loại ở Score: quảng cáo (có usage). 8. Bài cũ trước 0045: qua Claude nhưng không có usage.
    // 12. Chờ Claude quá lâu: bỏ trước Claude.
    await article({
      id: "a-promo",
      published: 80,
      collected: 75,
      matched: '[{"symbol":"DOGE","name":"Dogecoin"}]',
      candidates: '[{"symbol":"DOGE","market":"DOGE-USD","kind":"crypto"}]',
      status: "classified",
      classification: {
        catalyst: "none",
        market: "DOGE-USD",
        relevance: "direct",
        promotional: true,
        eventDate: null,
      },
      usage: [1, 402, 0, 4635, 88],
    });
    await article({
      id: "a-old",
      published: 70,
      collected: 66,
      candidates: ETH_CAND,
      status: "classified",
      classification: { ...ethCls, catalyst: "none" },
    });
    await article({
      id: "a-late",
      published: 65,
      collected: 64,
      candidates: ETH_CAND,
      status: "dropped",
    });
    for (const [id, at] of [
      ["a-promo", 75],
      ["a-old", 66],
      ["a-late", 64],
    ] as const) {
      await event(id, at, "collect", "pass");
      await event(id, at, "normalize", "pass");
    }
    await event("a-promo", 75, "understand", "drop", { reason: "PROMOTIONAL" });
    await event("a-old", 66, "understand", "drop", { reason: "NOT_A_SIGNAL_TYPE" });
    await event("a-late", 30, "understand", "drop", { reason: "CLASSIFIER_LATE" });

    // 5. Không có trên SoDEX, 6. không gắn coin nào (tin flash, không tiêu đề), 7. trùng y hệt bài gốc đang chờ Claude.
    await article({
      id: "a-kntq",
      published: 50,
      collected: 47,
      matched: '[{"symbol":"KNTQ","name":null}]',
      status: "dropped",
    });
    await article({
      id: "a-gold",
      title: null,
      content: "Spot gold broke below the 3700 threshold",
      published: 45,
      collected: 43,
      matched: "[]",
      status: "dropped",
    });
    await article({
      id: "a-orig",
      published: 42,
      collected: 40,
      candidates: ETH_CAND,
      status: "pending",
    });
    await article({
      id: "a-dup",
      published: 41,
      collected: 40,
      status: "dropped",
      duplicateOf: "a-orig",
    });
    for (const [id, at] of [
      ["a-kntq", 47],
      ["a-gold", 43],
      ["a-orig", 40],
      ["a-dup", 40],
    ] as const)
      await event(id, at, "collect", "pass");
    await event("a-kntq", 47, "normalize", "drop", { reason: "NO_SODEX_MARKET" });
    await event("a-gold", 43, "normalize", "drop", { reason: "NO_SODEX_MARKET" });
    await event("a-orig", 40, "normalize", "pass");
    await event("a-dup", 40, "normalize", "drop", { reason: "DUPLICATE" });

    // Ngoài 1 ngày nhưng trong 7 ngày; backlog; version cũ.
    await article({
      id: "a-week",
      published: 3 * 1440 + 5,
      collected: 3 * 1440,
      matched: '[{"symbol":"XYZ","name":null}]',
      status: "dropped",
    });
    await event("a-week", 3 * 1440, "normalize", "drop", { reason: "NO_SODEX_MARKET" });
    await article({ id: "a-backlog", published: 300, collected: 20, status: "backlog" });
    await event("a-backlog", 20, "collect", "backlog", { reason: "BACKLOG_NOT_CLASSIFIED" });
    await article({
      id: "a-v1",
      published: 10,
      collected: 9,
      status: "pending",
      ruleVersion: "news-v1",
    });
  });

  /** Mới nhất trước (theo giờ đăng). */
  const IN_DAY = [
    "a-dup",
    "a-orig",
    "a-gold",
    "a-kntq",
    "a-merged",
    "a-late",
    "a-old",
    "a-promo",
    "a-filter",
    "a-trade",
  ];
  const feed = async (qs: string) => {
    const r = await team.request("GET", `${base}/articles?${qs}`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    return researchArticlesPageSchema.parse(r.json());
  };
  const trace = async (id: string) => {
    const r = await team.request("GET", `${base}/articles/${id}/trace`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toBe("no-store");
    return researchArticleTraceSchema.parse(r.json());
  };
  const byKey = (t: Awaited<ReturnType<typeof trace>>) =>
    Object.fromEntries(t.steps.map((s) => [s.key, s]));

  it("401 signed out, 403 for non-team users, role checked before the query", async () => {
    const anon = new TestClient(env.app);
    for (const r of [`${base}/articles`, `${base}/articles/a-trade/trace`]) {
      expect((await anon.request("GET", r)).statusCode).toBe(401);
      expect((await user.request("GET", r)).statusCode).toBe(403);
    }
    for (const r of [
      `${base}/articles?range=30d`,
      `${base}/articles?show=nope&limit=abc`,
      `${base}/articles?cursor=bad`,
      `${base}/summary?range=nope`,
    ])
      expect((await user.request("GET", r)).statusCode).toBe(403);
  });

  it("validates the query: bad range / stage / reason / limit / cursor are 400 VALIDATION_FAILED", async () => {
    const tampered = Buffer.from(JSON.stringify({ t: "nope", id: "a" })).toString("base64url");
    for (const qs of [
      "range=30d",
      "stage=understand",
      "reason=BACKLOG_NOT_CLASSIFIED",
      "limit=500",
      "cursor=not-a-cursor",
      `cursor=${tampered}`,
    ]) {
      const r = await team.request("GET", `${base}/articles?${qs}`);
      expect(r.statusCode).toBe(400);
      expect(errorResponseSchema.parse(r.json()).error.code).toBe("VALIDATION_FAILED");
    }
    expect((await team.request("GET", `${base}/summary?range=30d`)).statusCode).toBe(400);
  });

  it("lists the last day newest first, without backlog or other rule versions; 7 days adds older ones", async () => {
    const day = await feed("range=1d&limit=100");
    const ids = day.items.map((x) => x.id);
    // art-1 (khối đầu file) nằm sau "now" của đồng hồ test nên cũng trong khoảng; là bài chờ ở Collect.
    expect(ids.filter((x) => x !== "art-1")).toEqual(IN_DAY);
    expect(day.total).toBe(IN_DAY.length + 1);
    expect(day.totalInRange).toBe(IN_DAY.length + 1);
    expect(ids).not.toContain("a-backlog");
    expect(ids).not.toContain("a-v1");
    const week = await feed("range=7d&limit=100");
    expect(week.items.map((x) => x.id)).toContain("a-week");
    expect(week.totalInRange).toBe(IN_DAY.length + 2);
    // Mặc định 1 ngày.
    expect((await feed("")).totalInRange).toBe(day.totalInRange);
  });

  it("pages with a cursor without gaps or repeats", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const p: Awaited<ReturnType<typeof feed>> = await feed(
        `range=1d&limit=3${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      seen.push(...p.items.map((x) => x.id));
      expect(p.total).toBe(IN_DAY.length + 1);
      cursor = p.nextCursor;
      if (cursor === null) break;
    }
    expect(seen.filter((x) => x !== "art-1")).toEqual(IN_DAY);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("filters by show / stage / reason, with N of M counts", async () => {
    const ids = async (qs: string) => {
      const p = await feed(`range=1d&limit=100&${qs}`);
      expect(p.total).toBe(p.items.length);
      expect(p.totalInRange).toBe(IN_DAY.length + 1);
      return p.items.map((x) => x.id);
    };
    expect(await ids("show=traded")).toEqual(["a-trade"]);
    expect(await ids("show=dropped")).toEqual([
      "a-dup",
      "a-gold",
      "a-kntq",
      "a-late",
      "a-old",
      "a-promo",
      "a-filter",
    ]);
    expect(await ids("show=claude")).toEqual([
      "a-merged",
      "a-old",
      "a-promo",
      "a-filter",
      "a-trade",
    ]);
    expect(await ids("stage=decide")).toEqual(["a-trade"]);
    expect(await ids("stage=filter")).toEqual(["a-merged", "a-filter"]);
    expect(await ids("stage=score")).toEqual(["a-late", "a-old", "a-promo"]);
    expect(await ids("stage=normalize")).toEqual(["a-dup", "a-orig", "a-kntq"]);
    expect(await ids("stage=collect&show=dropped")).toEqual(["a-gold"]);
    expect(await ids("reason=noTaggedCurrency")).toEqual(["a-gold"]);
    expect(await ids("reason=notOnSodex")).toEqual(["a-kntq"]);
    expect(await ids("reason=duplicate")).toEqual(["a-dup"]);
    expect(await ids("reason=notCatalyst")).toEqual(["a-old"]);
    expect(await ids("reason=tpUnderCost")).toEqual(["a-filter"]);
    expect(await ids("reason=sourceLate")).toEqual(["a-late"]);
  });

  it("returns the item fields: stage, outcome, reason, Claude usage (null on old rows), trade", async () => {
    const items = new Map((await feed("range=1d&limit=100")).items.map((x) => [x.id, x]));
    const cost = claudeCostUsd({
      input: 512,
      cacheWrite: 0,
      cacheRead: 4635,
      output: 118,
    }).toFixed();
    expect(items.get("a-trade")).toMatchObject({
      title: "Title a-trade",
      source: "Reuters",
      delaySecs: 240,
      tagged: ["ETH"],
      candidates: ["ETH-USD"],
      asset: "ETH-USD",
      side: "long",
      stage: "decide",
      outcome: "traded",
      reason: null,
      sentToClaude: true,
      claude: {
        calls: 1,
        tokens: { input: 512, cacheWrite: 0, cacheRead: 4635, output: 118 },
        costUsd: cost,
        model: NEWS_CLASSIFIER.model,
      },
      tradeId: trade2,
    });
    expect(items.get("a-merged")).toMatchObject({
      stage: "filter",
      outcome: "merged",
      reason: null,
      mergeReason: "sameStory",
      tradeId: null,
    });
    expect(items.get("a-gold")).toMatchObject({
      title: null,
      excerpt: "Spot gold broke below the 3700 threshold",
      tagged: [],
      stage: "collect",
      outcome: "dropped",
      reason: "noTaggedCurrency",
      sentToClaude: false,
      claude: null,
    });
    expect(items.get("a-old")).toMatchObject({
      sentToClaude: true,
      claude: null,
      reason: "notCatalyst",
    });
    expect(items.get("a-late")).toMatchObject({
      sentToClaude: false,
      claude: null,
      stage: "score",
    });
    expect(items.get("a-orig")).toMatchObject({
      stage: "normalize",
      outcome: "waiting",
      reason: null,
    });
  });

  it("traces a traded article through all five steps", async () => {
    const t = await trace("a-trade");
    expect(t.article.id).toBe("a-trade");
    const s = byKey(t);
    expect(t.steps.map((x) => [x.key, x.status])).toEqual([
      ["collect", "pass"],
      ["normalize", "pass"],
      ["score", "pass"],
      ["filter", "pass"],
      ["decide", "pass"],
    ]);
    expect(s.collect).toMatchObject({
      detail: {
        source: "Reuters",
        tier: "top",
        delaySecs: 240,
        tagged: [{ symbol: "ETH", name: "Ethereum" }],
      },
    });
    expect(s.normalize).toMatchObject({
      detail: {
        candidates: [{ symbol: "ETH", market: "ETH-USD", kind: "crypto" }],
        duplicateOf: null,
        story: {
          id: story1,
          isNew: true,
          sources: 2,
          levelAtEntry: "medium",
          laterLevel: "high",
          outcome: "entered",
          tradeId: trade2,
        },
      },
    });
    expect(s.score).toMatchObject({
      detail: {
        sentToClaude: true,
        signalType: true,
        newsType: "etfApproved",
        side: "long",
        maxHoldHours: 72,
        asset: "ETH-USD",
        relevance: "direct",
        promotional: false,
        level: "medium",
        levelSources: [{ name: "Reuters", tier: "top" }],
        claude: { calls: 1, model: NEWS_CLASSIFIER.model },
      },
    });
    expect(s.filter).toMatchObject({
      detail: {
        level: "medium",
        checks: [
          { key: "sourceLive", ok: true, value: 4, limit: 30 },
          { key: "priceAvailable", ok: true },
          { key: "noOpenTrade", ok: true },
          { key: "tpVsCost", ok: true, value: 1.6, limit: 0.2, costPct: 0.1, spreadPct: 0.011 },
        ],
      },
    });
    expect(s.decide).toMatchObject({
      detail: {
        tradeId: trade2,
        side: "long",
        sizeUsdc: "500",
        entry: "3412.5",
        tp: "3467.1",
        tpPct: 1.6,
        sl: "3385.2",
        slPct: 0.8,
        maxHoldHours: 72,
        priceSource: "book",
        retry: false,
        status: "open",
        random: null,
      },
    });
  });

  it("traces an article dropped at each step, and a merged one", async () => {
    const gold = byKey(await trace("a-gold"));
    expect(gold.collect).toMatchObject({
      status: "drop",
      reason: "noTaggedCurrency",
      code: "NO_SODEX_MARKET",
    });
    expect(gold.normalize).toMatchObject({ status: "notReached", detail: null, at: null });

    const dup = byKey(await trace("a-dup"));
    expect(dup.normalize).toMatchObject({
      status: "drop",
      reason: "duplicate",
      code: "DUPLICATE",
      detail: { duplicateOf: { id: "a-orig", title: "Title a-orig" }, story: null },
    });
    expect(dup.score).toMatchObject({ status: "notReached", detail: null });

    const kntq = byKey(await trace("a-kntq"));
    expect(kntq.collect?.status).toBe("pass");
    expect(kntq.normalize).toMatchObject({
      status: "drop",
      reason: "notOnSodex",
      detail: { candidates: [] },
    });

    const promo = byKey(await trace("a-promo"));
    expect(promo.score).toMatchObject({
      status: "drop",
      reason: "promotional",
      code: "PROMOTIONAL",
      detail: {
        signalType: false,
        newsType: null,
        promotional: true,
        level: null,
        levelSources: null,
      },
    });
    expect(promo.filter).toMatchObject({ status: "notReached", detail: null });

    const old = byKey(await trace("a-old"));
    expect(old.score).toMatchObject({
      status: "drop",
      detail: { sentToClaude: true, claude: null },
    });

    const filter = byKey(await trace("a-filter"));
    expect(filter.filter).toMatchObject({
      status: "drop",
      reason: "tpUnderCost",
      code: "MOVE_TOO_SMALL_FOR_COST",
      detail: {
        level: "low",
        checks: [
          { key: "sourceLive", ok: true },
          { key: "priceAvailable", ok: true },
          { key: "noOpenTrade", ok: true },
          { key: "tpVsCost", ok: false, code: "MOVE_TOO_SMALL_FOR_COST", value: 0.15, limit: 0.2 },
        ],
      },
    });
    expect(filter.score).toMatchObject({
      detail: { side: "short", newsType: "hack", level: "low" },
    });
    expect(filter.decide).toMatchObject({ status: "notReached", detail: null });

    const merged = byKey(await trace("a-merged"));
    expect(merged.filter).toMatchObject({
      status: "merge",
      mergeReason: "sameStory",
      code: "SAME_STORY",
      detail: { level: null, checks: [], laterLevel: "high" },
    });
    expect(merged.normalize).toMatchObject({ detail: { story: { id: story1, isNew: false } } });
    expect(merged.decide?.status).toBe("notReached");

    const waiting = byKey(await trace("a-orig"));
    expect(waiting.normalize?.status).toBe("pass");
    expect(waiting.score).toMatchObject({ status: "notReached", detail: null });
  });

  it("404 for an unknown, backlog or other-version article", async () => {
    for (const id of ["nope", "a-backlog", "a-v1"]) {
      const r = await team.request("GET", `${base}/articles/${id}/trace`);
      expect(r.statusCode).toBe(404);
      expect(errorResponseSchema.parse(r.json()).error.code).toBe("NOT_FOUND");
    }
  });

  it("summary range switches the funnel and its per-article stop counts match the feed", async () => {
    const get = async (qs: string) => {
      const r = await team.request("GET", `${base}/summary${qs}`);
      expect(r.statusCode).toBe(200);
      return researchSummarySchema.parse(r.json());
    };
    const day = await get("?range=1d");
    const week = await get("?range=7d");
    const all = await get("");
    expect(day.funnel?.days).toBe(1);
    expect(week.funnel?.days).toBe(7);
    const stop = (s: typeof day, reason: string) =>
      s.funnel?.articleStops.find((x) => x.reason === reason)?.n ?? null;
    expect(stop(day, "notOnSodex")).toBe(1);
    expect(stop(week, "notOnSodex")).toBe(2);
    expect(stop(all, "notOnSodex")).toBe(2);
    expect(stop(day, "noTaggedCurrency")).toBe(1);
    expect(stop(day, "duplicate")).toBe(1);
    expect(day.funnel?.articleStops.find((x) => x.outcome === "traded")).toMatchObject({
      stage: "decide",
      n: 1,
    });
    expect(day.funnel?.articleStops.find((x) => x.outcome === "merged")).toMatchObject({
      stage: "filter",
      mergeReason: "sameStory",
      n: 1,
    });
    // Tổng kết cũ: trùng y hệt vẫn không phải "bị loại".
    expect(day.funnel?.drops.score.reasons.map((r) => r.reason)).not.toContain("duplicate");
    // Bảng mức / cổng không đổi theo khoảng.
    expect(day.rows).toEqual(all.rows);
  });

  it("#297: every funnel count is the same unit (articles collected in range): in − out = next", async () => {
    const r = await team.request("GET", `${base}/summary?range=1d`);
    const f = researchSummarySchema.parse(r.json()).funnel;
    if (f === null) throw new Error("funnel");
    const steps = funnelSteps(f.articleStops);
    for (const [i, st] of steps.entries()) {
      expect(st.in - st.dropped - st.merged - st.waiting).toBe(st.passed);
      if (i > 0) expect(st.in).toBe(steps[i - 1]?.passed);
    }
    // Trường cũ của phễu giờ cùng đơn vị với articleStops.
    expect(f.collected).toBe(steps[0]?.in);
    expect(f.signals).toBe(steps[2]?.passed);
    expect(f.passed).toBe(steps[3]?.passed);
    expect(f.merged).toBe(1);
    // Trong ngày: a-gold, a-kntq, a-dup bị Normalize loại; a-orig chờ Claude; a-late, a-old, a-promo bị Score loại;
    // a-filter bị Filter loại, a-merged gộp; a-trade mở lệnh (Long).
    expect(steps.map((x) => [x.in, x.passed])).toEqual([
      [steps[0]?.in, steps[0]?.in],
      [steps[0]?.in, (steps[0]?.in ?? 0) - 3 - (steps[1]?.waiting ?? 0)],
      [steps[1]?.passed, 3],
      [3, 1],
      [1, 1],
    ]);
    expect(f.long).toBe(1);
  });

  it("#394: cycleMinutes and the SoSoValue monthly limit come from the scheduler's sr:lane snapshot; missing or broken → null", async () => {
    const summary = async () =>
      researchSummarySchema.parse((await team.request("GET", `${base}/summary?range=1d`)).json());
    try {
      env.srLane.value = JSON.stringify({
        cycleMinutes: 1,
        sosoMonthlyLimit: 60_000,
        updatedAt: env.clock.now.toISOString(),
      });
      const one = await summary();
      expect(one.cycleMinutes).toBe(1);
      expect(one.funnel?.soso?.limit).toBe(60_000);
      expect(one.funnel).not.toHaveProperty("pollSecs");

      env.srLane.value = JSON.stringify({
        cycleMinutes: 5,
        sosoMonthlyLimit: 9_500,
        updatedAt: env.clock.now.toISOString(),
      });
      expect((await summary()).cycleMinutes).toBe(5);

      // Ngoài 1–5, JSON hỏng: không đoán chu kỳ; trần tháng về mặc định.
      for (const bad of [
        JSON.stringify({ cycleMinutes: 7, sosoMonthlyLimit: 9_500, updatedAt: "x" }),
        "{not json",
      ]) {
        env.srLane.value = bad;
        const s = await summary();
        expect(s.cycleMinutes).toBeNull();
        expect(s.funnel?.soso?.limit).toBe(9_500);
      }
    } finally {
      env.srLane.value = null;
    }
    // Scheduler không ghi (lane tắt, key hết hạn): null → web "Not available".
    expect((await summary()).cycleMinutes).toBeNull();
  });

  it("#297/#308: open trades are marked at the real exit price (Long → bid); stale or no price → null, never 0", async () => {
    const nowMs = env.clock.now.getTime();
    const quotes = (q: object) => {
      env.srQuotes.value = JSON.stringify({ "ETH-USD": q });
    };
    const openUnrealized = async () => {
      const s = researchSummarySchema.parse(
        (await team.request("GET", `${base}/summary?range=1d`)).json(),
      );
      const p = researchTradesPageSchema.parse(
        (await team.request("GET", `${base}/trades?limit=100`)).json(),
      );
      return { s, p, trade: p.items.find((x) => x.id === trade2)?.result };
    };
    // Long đóng theo bid 3500 (không theo ask 3510 hay giá giữa).
    quotes({ bid: "3500", ask: "3510", source: "book", at: nowMs - 1_000 });
    try {
      const { s, p, trade } = await openUnrealized();
      // 0.1465 × (3500 − 3412.5) − 0.25 − 0.1465 × 3500 × 0.05% = 12.312375
      expect(s.bots[0]).toMatchObject({
        balance: "10009.5",
        realized: "9.5",
        unrealized: "12.312375",
        openTrades: 1,
      });
      expect(trade).toMatchObject({ pnl: null, unrealized: "12.312375", outcome: "open" });
      // Lệnh đã đóng không có lãi / lỗ chưa chốt.
      expect(p.items.find((x) => x.id === tradeId)?.result?.unrealized).toBeNull();

      // Sổ cũ hơn NEWS_RULES.bookFreshMs (5 s) → bỏ, không dùng giá cũ.
      quotes({ bid: "3500", ask: "3510", source: "book", at: nowMs - 6_000 });
      const stale = await openUnrealized();
      expect(stale.s.bots[0]).toMatchObject({ balance: "10009.5", unrealized: null });
      expect(stale.trade?.unrealized).toBeNull();

      // Giá gần nhất ± nửa spread: ngưỡng NEWS_RULES.lastPriceFreshMs (15 s).
      quotes({ bid: "3500", ask: "3510", source: "last_spread", at: nowMs - 10_000 });
      expect((await openUnrealized()).trade?.unrealized).toBe("12.312375");
      quotes({ bid: "3500", ask: "3510", source: "last_spread", at: nowMs - 16_000 });
      expect((await openUnrealized()).trade?.unrealized).toBeNull();

      // Thiếu ask (mục sai dạng) → market đó không có giá.
      quotes({ bid: "3500", source: "book", at: nowMs });
      expect((await openUnrealized()).trade?.unrealized).toBeNull();

      // Parse từng mục: mục lỗi của market khác không làm mất giá của ETH-USD; mục lỗi chỉ bỏ market đó (log tên market,
      // không log giá trị).
      const good = { bid: "3500", ask: "3510", source: "book", at: nowMs - 1_000 };
      const logsBefore = env.logs.length;
      env.srQuotes.value = JSON.stringify({
        "ETH-USD": good,
        "SOL-USD": { bid: "9", ask: "secret-ish", source: "book", at: nowMs },
      });
      const mixed = await openUnrealized();
      expect(mixed.trade?.unrealized).toBe("12.312375");
      expect(mixed.s.bots[0]?.unrealized).toBe("12.312375");
      const warn = env.logs.slice(logsBefore).join("");
      expect(warn).toContain("signal research quotes snapshot has invalid entries");
      expect(warn).toContain("SOL-USD");
      expect(warn).not.toContain("secret-ish");
      env.srQuotes.value = JSON.stringify({ "ETH-USD": { ...good, ask: "x" }, "SOL-USD": good });
      expect((await openUnrealized()).trade?.unrealized).toBeNull();

      // Cả giá trị hỏng (không phải JSON / không phải object) → không có giá nào.
      env.srQuotes.value = `{"ETH-USD": ${JSON.stringify(good)}`;
      expect((await openUnrealized()).trade?.unrealized).toBeNull();
      env.srQuotes.value = JSON.stringify([good]);
      expect((await openUnrealized()).trade?.unrealized).toBeNull();
    } finally {
      env.srQuotes.value = null;
    }
    const { s, trade } = await openUnrealized();
    expect(s.bots[0]).toMatchObject({ balance: "10009.5", unrealized: null });
    expect(trade?.unrealized).toBeNull();
  });

  it("#297: SoSoValue stock tag names read EN, never raw JSON; Claude shows in Sources", async () => {
    await article({
      id: "a-stock",
      published: 30,
      collected: 25,
      matched:
        '[{"symbol":"BTC","name":"BITCOIN"},{"symbol":"GPUS","name":"{\\"EN\\": \\"HYPERSCALE DATA INC\\"}"},{"symbol":"NVDA","name":{"EN":"NVIDIA CORPORATION"}}]',
      status: "collected",
    });
    await env.pool.query(
      `insert into signal_source_health (source, last_ok_at, last_cycle_at) values ('claude', $1, $1)
       on conflict (source) do update set last_ok_at = excluded.last_ok_at`,
      [env.clock.now.toISOString()],
    );
    try {
      const tr = await trace("a-stock");
      const collect = tr.steps[0];
      expect(collect?.key === "collect" ? collect.detail.tagged : null).toEqual([
        { symbol: "BTC", name: "BITCOIN" },
        { symbol: "GPUS", name: "HYPERSCALE DATA INC" },
        { symbol: "NVDA", name: "NVIDIA CORPORATION" },
      ]);
      const s = researchSummarySchema.parse((await team.request("GET", `${base}/summary`)).json());
      expect(s.sources.find((x) => x.key === "claude")).toMatchObject({
        mode: "live",
        status: "live",
      });
    } finally {
      await env.pool.query("delete from signal_articles where id = 'a-stock'");
      await env.pool.query("delete from signal_source_health where source = 'claude'");
    }
  });

  it("trades carry the article id for the Trace button", async () => {
    const p = researchTradesPageSchema.parse(
      (await team.request("GET", `${base}/trades?show=all&limit=100`)).json(),
    );
    expect(p.items.find((x) => x.id === trade2)?.articleId).toBe("a-trade");
    expect(p.items.find((x) => x.asset === "SOL-USD" && x.skipped !== null)?.articleId).toBe(
      "a-filter",
    );
  });
});
