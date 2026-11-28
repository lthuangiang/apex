import { randomUUID } from "node:crypto";

import {
  meSchema,
  researchArticlesPageSchema,
  researchArticleTraceSchema,
  researchSummarySchema,
  researchTradesPageSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #413 (DEC-357) qua API thật: đổi version Rules chỉ reset phần đếm, không ẩn dữ liệu. Feed và
// phễu theo khoảng gồm bài của mọi version (gắn version), trace bài cũ đọc theo luật của chính bài, danh sách lệnh có
// Current / All rules, còn Is it working? (dòng tổng kết, cổng) chỉ tính version hiện tại.

let env: TestEnv;
let team: TestClient;
const base = "/api/v1/admin/signal-research";
const MIN = 60_000;
const DAY = 1440 * MIN;
const v3Trade = randomUUID();
const v4Trade = randomUUID();

const ago = (ms: number) => new Date(env.clock.now.getTime() - ms).toISOString();

async function article(id: string, rule: string, collectedMsAgo: number, prompt: string | null) {
  await env.pool.query(
    `insert into signal_articles (id, source, title, published_at, collected_at, matched_currencies, candidates, content_hash,
       status, rule_version, claude_prompt_version, classified_at)
     values ($1, 'Coindesk', $2, $3::timestamptz - interval '3 minutes', $3, '[{"symbol":"BTC","name":null}]',
       '[{"symbol":"BTC","market":"BTC-USD","kind":"crypto"}]', $4, 'classified', $5, $6, $3)`,
    [id, `Title ${id}`, ago(collectedMsAgo), `h-${id}`, rule, prompt],
  );
}

async function event(
  articleId: string,
  rule: string,
  msAgo: number,
  stage: string,
  outcome: string,
  extra: { reason?: string; detail?: object; tradeId?: string } = {},
) {
  await env.pool.query(
    `insert into signal_events (id, article_id, stage, outcome, reason, detail, rule_version, at, trade_id)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      articleId,
      stage,
      outcome,
      extra.reason ?? null,
      extra.detail === undefined ? null : JSON.stringify(extra.detail),
      rule,
      ago(msAgo),
      extra.tradeId ?? null,
    ],
  );
}

async function trade(id: string, articleId: string, rule: string, msAgo: number) {
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, label, article_id, market, token, catalyst, direction, size_usdc, qty, entry_price, entry_mid,
       spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until, event_at, seen_at, opened_at,
       level_at_entry, sources_at_entry, outside_market_hours, price_source, status, exit_price, exit_reason, exited_at,
       exit_fee, result_usdc, result_pct, rule_version)
     values ($1, 'news', 'live', $2, 'BTC-USD', 'BTC', 'hack_exploit', 'short', 500, 0.005, 100000, 100000, 0.01, 0.05, 0.25, 1.2,
       2, 1, 98000, 101000, $3::timestamptz + interval '1 day', $3, $3, $3, 'low', '[]', false, 'book', 'closed', 101000, 'stop_loss',
       $3::timestamptz + interval '1 hour', 0.25, -5.65, -1.13, $4)`,
    [id, articleId, ago(msAgo), rule],
  );
}

async function get<T>(path: string, schema: { parse: (v: unknown) => T }): Promise<T> {
  const r = await team.request("GET", `${base}${path}`);
  expect(r.statusCode, r.body).toBe(200);
  return schema.parse(r.json());
}

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, team, `sr-hist-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set role = 'team' where id = $1", [me.id]);

  // Rules v3 · reader v3: hai bài 3 ngày và 2 ngày trước, một bài mở lệnh short (đóng ở stop loss), một bài bị bỏ ở Filter.
  await article("h-v3-trade", "news-v3", 3 * DAY, "news-classifier-v3");
  await event("h-v3-trade", "news-v3", 3 * DAY, "collect", "pass");
  await event("h-v3-trade", "news-v3", 3 * DAY - MIN, "normalize", "pass");
  await event("h-v3-trade", "news-v3", 3 * DAY - 2 * MIN, "understand", "pass", {
    detail: { market: "BTC-USD", direction: "short", maxHoldHours: 24 },
  });
  await trade(v3Trade, "h-v3-trade", "news-v3", 3 * DAY - 3 * MIN);
  await event("h-v3-trade", "news-v3", 3 * DAY - 3 * MIN, "decide", "open", { tradeId: v3Trade });

  await article("h-v3-skip", "news-v3", 2 * DAY, "news-classifier-v3");
  await event("h-v3-skip", "news-v3", 2 * DAY, "collect", "pass");
  await event("h-v3-skip", "news-v3", 2 * DAY - MIN, "normalize", "pass");
  await event("h-v3-skip", "news-v3", 2 * DAY - 2 * MIN, "understand", "pass", {
    detail: { market: "BTC-USD", direction: "long", maxHoldHours: 24 },
  });
  await event("h-v3-skip", "news-v3", 2 * DAY - 3 * MIN, "filter", "drop", {
    reason: "MOVE_TOO_SMALL_FOR_COST",
    detail: { level: "low", tpPct: "0.1500", costPct: "0.2000", spreadPct: "0.0100" },
  });
  // Một event lạc của version khác trên cùng bài (ví dụ ghi sau khi đổi version): trace và feed không bao giờ đọc nó.
  await event("h-v3-skip", "news-v6", DAY - 20 * MIN, "filter", "merge", {
    reason: "SAME_STORY",
  });

  // Rules v4 · reader v4: bắt đầu 1 ngày trước; một bài mở lệnh, một bài bị bỏ ở Normalize.
  await article("h-v4-trade", "news-v6", DAY - 10 * MIN, "news-classifier-v4");
  await event("h-v4-trade", "news-v6", DAY - 10 * MIN, "collect", "pass");
  await event("h-v4-trade", "news-v6", DAY - 11 * MIN, "normalize", "pass");
  await event("h-v4-trade", "news-v6", DAY - 12 * MIN, "understand", "pass", {
    detail: { market: "BTC-USD", direction: "short", maxHoldHours: 24 },
  });
  await trade(v4Trade, "h-v4-trade", "news-v6", DAY - 13 * MIN);
  await event("h-v4-trade", "news-v6", DAY - 13 * MIN, "decide", "open", { tradeId: v4Trade });

  await article("h-v4-drop", "news-v6", 2 * 60 * MIN, null);
  await event("h-v4-drop", "news-v6", 2 * 60 * MIN, "collect", "pass");
  await event("h-v4-drop", "news-v6", 2 * 60 * MIN - MIN, "normalize", "drop", {
    reason: "NO_SODEX_MARKET",
  });
});

afterAll(async () => {
  await env.close();
});

describe("history across Rules versions (#413)", () => {
  it("the 30-day feed shows articles of every Rules version, each with its version and reader", async () => {
    const p = await get("/articles?range=30d&limit=100", researchArticlesPageSchema);
    expect(p.items.map((x) => [x.id, x.rulesVersion, x.readerVersion])).toEqual([
      ["h-v4-drop", 6, null],
      ["h-v4-trade", 6, "news-classifier-v4"],
      ["h-v3-skip", 3, "news-classifier-v3"],
      ["h-v3-trade", 3, "news-classifier-v3"],
    ]);
    expect(p.totalInRange).toBe(4);
    // Bước dừng của bài v3 theo event v3 của chính nó (event v4 lạc không biến nó thành "merged").
    const skip = p.items.find((x) => x.id === "h-v3-skip");
    expect(skip).toMatchObject({ stage: "filter", outcome: "dropped", reason: "tpUnderCost" });
    // 24 giờ chỉ còn bài v4.
    const day = await get("/articles?range=1d&limit=100", researchArticlesPageSchema);
    expect(day.items.map((x) => x.id)).toEqual(["h-v4-drop", "h-v4-trade"]);
  });

  it("the funnel by period counts every Rules version and says how many ran on each", async () => {
    const month = await get("/summary?range=30d", researchSummarySchema);
    expect(month.funnel?.days).toBe(30);
    expect(month.funnel?.rules).toEqual([
      { v: 3, articles: 2 },
      { v: 6, articles: 2 },
    ]);
    // Số trên phễu khớp câu tóm tắt: 4 bài thu, 2 lệnh (1 short của v3, 1 short của v4).
    expect(month.funnel?.collected).toBe(4);
    expect(month.funnel?.short).toBe(2);
    expect(month.funnel?.long).toBe(0);
    // Mốc bắt đầu từng version = event sớm nhất của version đó; reader = prompt của bài phân loại sớm nhất.
    expect(month.rulesHistory).toEqual([
      { v: 3, startedAt: ago(3 * DAY), reader: "news-classifier-v3" },
      { v: 6, startedAt: ago(DAY - 10 * MIN), reader: "news-classifier-v4" },
    ]);
    const day = await get("/summary?range=1d", researchSummarySchema);
    expect(day.funnel?.rules).toEqual([{ v: 6, articles: 2 }]);
    expect(day.funnel?.collected).toBe(2);
  });

  it("Is it working? and the counted rows stay on the current Rules version only", async () => {
    const s = await get("/summary?range=30d", researchSummarySchema);
    expect(s.newsRulesVersion).toBe(6);
    expect(s.rows[0]).toMatchObject({ rulesVersion: 6, opened: 1, closed: 1 });
    expect(s.olderRules).toEqual({ trades: 1, versions: [3] });
  });

  it("the trace of a v3 article reads its own v3 steps, with its trade", async () => {
    const t = await get("/articles/h-v3-trade/trace", researchArticleTraceSchema);
    expect(t.article).toMatchObject({
      rulesVersion: 3,
      readerVersion: "news-classifier-v3",
      stage: "decide",
      outcome: "traded",
      tradeId: v3Trade,
    });
    const decide = t.steps.find((x) => x.key === "decide");
    expect(decide?.status).toBe("pass");
    const skip = await get("/articles/h-v3-skip/trace", researchArticleTraceSchema);
    expect(skip.article).toMatchObject({
      rulesVersion: 3,
      outcome: "dropped",
      reason: "tpUnderCost",
    });
  });

  it("Paper trades: Current rules by default, All rules adds the v3 trade with its version", async () => {
    const cur = await get("/trades?show=entered", researchTradesPageSchema);
    expect(cur.items.map((x) => [x.id, x.rulesVersion])).toEqual([[v4Trade, 6]]);
    const all = await get("/trades?show=entered&olderRules=true", researchTradesPageSchema);
    expect(all.items.map((x) => [x.id, x.rulesVersion])).toEqual([
      [v4Trade, 6],
      [v3Trade, 3],
    ]);
  });
});
