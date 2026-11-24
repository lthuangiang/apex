import { randomUUID } from "node:crypto";

import { meSchema, researchArticleTraceSchema, type ResearchArticleTrace } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #375 (UI): trace một bài trả mốc độ trễ của bài (`latency`) cho dòng thời gian trong thẻ Collect. Endpoint thật trên Postgres
// thật của test env; bài, event và lệnh chèn thẳng như scheduler ghi (mốc đồng hồ do test đặt).

let env: TestEnv;
let team: TestClient;
const base = "/api/v1/admin/signal-research";

const at = (minAgo: number, plusMs = 0) =>
  new Date(env.clock.now.getTime() - minAgo * 60_000 + plusMs).toISOString();

async function article(id: string, claudeDoneMs: number | null) {
  await env.pool.query(
    `insert into signal_articles (id, source, title, content, published_at, collected_at, matched_currencies, candidates, content_hash,
       status, rule_version, claude_started_at, claude_done_at)
     values ($1, 'Reuters', $1, 'Body', $2::timestamptz - interval '4 minutes', $2, '[{"symbol":"ETH","name":"Ethereum"}]',
       '[{"symbol":"ETH","market":"ETH-USD","kind":"crypto"}]', $1, 'classified', 'news-v5', $3, $4)`,
    [
      id,
      at(30),
      claudeDoneMs === null ? null : at(30),
      claudeDoneMs === null ? null : at(30, claudeDoneMs),
    ],
  );
  for (const stage of ["collect", "normalize"]) await event(id, stage, "pass", null);
}

async function event(
  articleId: string,
  stage: string,
  outcome: string,
  decidedMs: number | null,
  extra: { tradeId?: string; reason?: string; detail?: unknown } = {},
) {
  await env.pool.query(
    `insert into signal_events (id, article_id, stage, outcome, reason, detail, trade_id, rule_version, at, decided_clock_at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, 'news-v5', $7, $8)`,
    [
      articleId,
      stage,
      outcome,
      extra.reason ?? null,
      extra.detail === undefined ? null : JSON.stringify(extra.detail),
      extra.tradeId ?? null,
      at(30),
      decidedMs === null ? null : at(30, decidedMs),
    ],
  );
}

async function trade(articleId: string, decidedMs: number, openedMs: number): Promise<string> {
  const r = await env.pool.query<{ id: string }>(
    `insert into signal_paper_trades (id, lane, label, article_id, market, token, catalyst, direction, size_usdc, qty,
       entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price,
       max_hold_until, event_at, seen_at, opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status,
       rule_version, decided_clock_at, opened_clock_at)
     values (gen_random_uuid(), 'news', 'live', $1, 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 0.15, 3400, 3400,
       0.01, 0.05, 0.25, 1, 1.6, 0.8, 3454, 3372, $2::timestamptz + interval '3 days', $2, $2, $2, 'medium', '[]', false, 'book',
       'open', 'news-v5', $3, $4) returning id`,
    [articleId, at(30), at(30, decidedMs), at(30, openedMs)],
  );
  const id = r.rows[0]?.id;
  if (id === undefined) throw new Error("trade not inserted");
  return id;
}

async function trace(id: string): Promise<ResearchArticleTrace> {
  const r = await team.request("GET", `${base}/articles/${id}/trace`);
  expect(r.statusCode).toBe(200);
  return researchArticleTraceSchema.parse(r.json());
}

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  const teamId = meSchema.parse(
    (await signIn(env, team, `tl-${randomUUID()}@drift.test`)).json(),
  ).id;
  await env.pool.query("update users set role = 'team' where id = $1", [teamId]);
});

afterAll(async () => {
  await env.close();
});

describe("trace latency (#375)", () => {
  it("a traded article: Claude done, first decision, opened, all from the scheduler clock", async () => {
    await article("tl-open", 8_000);
    await event("tl-open", "understand", "pass", null, {
      detail: { market: "ETH-USD", direction: "long", maxHoldHours: 72 },
    });
    const tradeId = await trade("tl-open", 9_000, 9_040);
    await event("tl-open", "filter", "pass", 9_000);
    await event("tl-open", "decide", "open", 9_000, { tradeId });
    const l = (await trace("tl-open")).latency;
    expect(l).toEqual({
      claudeDoneAt: at(30, 8_000),
      decidedAt: at(30, 9_000),
      decision: "open",
      openedAt: at(30, 9_040),
    });
  });

  it("an article the version did not trade: decision noTrade, no open time", async () => {
    await article("tl-drop", 6_000);
    await event("tl-drop", "understand", "pass", null, {
      detail: { market: "ETH-USD", direction: "long", maxHoldHours: 72 },
    });
    await event("tl-drop", "filter", "drop", 7_500, { reason: "MOVE_TOO_SMALL_FOR_COST" });
    expect((await trace("tl-drop")).latency).toEqual({
      claudeDoneAt: at(30, 6_000),
      decidedAt: at(30, 7_500),
      decision: "noTrade",
      openedAt: null,
    });
  });

  it("an article from before the clocks (migration 0054): every mark is null, never 0", async () => {
    await article("tl-old", null);
    await event("tl-old", "understand", "drop", null, { reason: "NOT_A_SIGNAL_TYPE" });
    expect((await trace("tl-old")).latency).toEqual({
      claudeDoneAt: null,
      decidedAt: null,
      decision: null,
      openedAt: null,
    });
  });
});
