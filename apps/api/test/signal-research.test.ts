import { randomUUID } from "node:crypto";

import {
  errorResponseSchema,
  meSchema,
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
     values ('art-1', 'Bloomberg', 'SEC delays SOL ETF', '2026-11-18T10:00:00Z', '2026-11-18T10:03:00Z', '[]', '[]', 'h', 'classified', 'news-v2')`,
  );
  await env.pool.query(
    `insert into signal_stories (id, story_key, market, catalyst, direction, first_article_id, first_seen_at, sources, level_at_entry, later_level, outcome, locked, rule_version)
     values ($1, 'SOL-USD|etf_delayed_or_rejected', 'SOL-USD', 'etf_delayed_or_rejected', 'short', 'art-1', '2026-11-18T10:03:00Z',
             '[{"name":"Bloomberg","tier":"top","articleId":"art-1","at":"2026-11-18T10:00:00.000Z"}]', 'medium', 'medium', 'entered', true, 'news-v2')`,
    [storyId],
  );
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, story_id, article_id, market, token, catalyst, direction, size_usdc, qty, entry_price, entry_mid,
       spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until, event_at, seen_at, opened_at,
       moved_before_entry_pct, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, exit_price, exit_reason, exited_at,
       exit_fee, result_usdc, result_pct, rule_version)
     values ($1, 'news', $2, 'art-1', 'SOL-USD', 'SOL', 'etf_delayed_or_rejected', 'short', 500, 3.5, 142.18, 142.2, 0.03, 0.05, 0.25, 1.33,
       2, 1, 139.34, 143.6, '2026-11-20T10:03:00Z', '2026-11-18T10:00:00Z', '2026-11-18T10:03:00Z', '2026-11-18T10:03:05Z', -0.6, 'medium',
       '[{"name":"Bloomberg","tier":"top"}]', false, 'book', 'closed', 139.3, 'take_profit', '2026-11-19T09:12:00Z', 0.24, 9.5, 1.9, 'news-v2')`,
    [tradeId, storyId],
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
    expect(summary.funnel?.outcomes).toEqual({ closed: 1, tp: 1, sl: 0, maxHold: 0, open: 0 });
    expect(summary.rows[0]).toMatchObject({
      type: "news",
      label: "live",
      rulesVersion: 2,
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

    const p = await team.request("GET", `${base}/trades?limit=1&show=all&tz=Asia%2FHo_Chi_Minh`);
    const page = researchTradesPageSchema.parse(p.json());
    expect(page.items[0]).toMatchObject({
      id: tradeId,
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
