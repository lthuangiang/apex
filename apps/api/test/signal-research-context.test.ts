import { randomUUID } from "node:crypto";

import {
  meSchema,
  researchArticlesPageSchema,
  researchArticleTraceSchema,
  researchSummarySchema,
  SIGNAL_CONTEXT_VERSION,
  type ResearchContextSummary,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Signal context (#329; #330–#332) qua API: thẻ bước 4 của trace, cờ gọn trong feed, khối "Does context help?" của tổng
// kết. Snapshot do scheduler ghi lúc quyết định; ở đây chèn thẳng.

let env: TestEnv;
let team: TestClient;
let teamId: string;
const base = "/api/v1/admin/signal-research";
const CLS = "ctx-cls";

const ago = (min: number) => new Date(env.clock.now.getTime() - min * 60_000).toISOString();

interface Ctx {
  h1: string;
  h2: string;
  h3: string;
  source?: "live" | "backfilled";
}

async function snapshot(articleId: string, decidedAt: string, c: Ctx) {
  await env.pool.query(
    `insert into signal_contexts (id, article_id, market, direction, decided_at, source, context_version, rule_version,
       h1_status, h1_wallets_checked, h1_agreeing_wallets, h1_opposing_wallets, h1_agreeing_usdc, h1_first_at,
       h2_status, h2_funding_rate, h2_funding_time, h2_percentile, h2_samples, h2_payer, h2_interval_hours,
       h3_status, h3_moved_pct, h3_typical_move_pct, volume_vs_24h, range_breakout)
     values (gen_random_uuid(), $1, 'ETH-USD', 'long', $2, $3, 'context-v1', 'news-v3',
       $4, 214, 2, 0, 1400000, $2::timestamptz - interval '39 minutes',
       $5, 0.0001, $2::timestamptz - interval '2 hours', 56, 90, 'long', 8,
       $6, 0.2, 0.6, 1.8, 'none')`,
    [articleId, decidedAt, c.source ?? "live", c.h1, c.h2, c.h3],
  );
}

/**
 * `n` lệnh đã đóng của version (classifier đã qua cổng), mỗi 7 giờ một lệnh từ `from`; kết quả `centre` ± nhiễu nhỏ; mỗi
 * lệnh có bài `prefix-g` và snapshot `ctx` (null = không có snapshot).
 */
async function bulk(
  versionId: string,
  prefix: string,
  n: number,
  from: string,
  centre: number,
  ctx: Ctx | null,
) {
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, label, version_id, article_id, market, token, catalyst, direction, size_usdc, qty,
       entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price,
       max_hold_until, event_at, seen_at, opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status,
       exit_price, exit_reason, exited_at, exit_fee, result_usdc, result_pct, random_pct, rule_version, classifier_version)
     select gen_random_uuid(), 'news', 'live', $1, $2 || '-' || g, 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 0.15, 3400, 3400,
       0.01, 0.05, 0.25, 1, 1.6, 0.8, 3454, 3372, t + interval '3 days', t, t, t, 'medium', '[]', false, 'book', 'closed', 3450,
       'take_profit', t + interval '30 minutes', 0.25, r * 5, r, 0, 'news-v3', $3
     from (select g, $4::timestamptz + (g * interval '7 hours') as t, ($5::numeric + ((g % 5) - 2) * 0.1) as r
             from generate_series(1, $6::int) g) s`,
    [versionId, prefix, CLS, from, centre, n],
  );
  if (ctx === null) return;
  for (let g = 1; g <= n; g++)
    await snapshot(
      `${prefix}-${String(g)}`,
      new Date(Date.parse(from) + g * 7 * 3_600_000).toISOString(),
      ctx,
    );
}

async function event(articleId: string, stage: string, outcome: string, versionId?: string) {
  await env.pool.query(
    `insert into signal_events (id, article_id, stage, outcome, detail, rule_version, version_id, at)
     values (gen_random_uuid(), $1, $2, $3, $4, 'news-v3', $5, $6)`,
    [
      articleId,
      stage,
      outcome,
      stage === "understand" && outcome === "pass"
        ? JSON.stringify({ market: "ETH-USD", direction: "long", maxHoldHours: 72 })
        : null,
      versionId ?? null,
      ago(59),
    ],
  );
}

async function article(id: string) {
  await env.pool.query(
    `insert into signal_articles (id, source, title, content, published_at, collected_at, matched_currencies, candidates, content_hash,
       status, classification, claude_prompt_version, rule_version)
     values ($1, 'Reuters', $2, 'Body', $3, $3, '[{"symbol":"ETH","name":"Ethereum"}]',
       '[{"symbol":"ETH","market":"ETH-USD","kind":"crypto"}]', $4, 'classified',
       '{"catalyst":"etf_approved","market":"ETH-USD","relevance":"direct","promotional":false}', $5, 'news-v3')`,
    [id, `Title ${id}`, ago(60), `hash-${id}`, CLS],
  );
}

async function summary(versionId?: string): Promise<ResearchContextSummary> {
  const r = await team.request(
    "GET",
    `${base}/summary${versionId === undefined ? "" : `?versionId=${versionId}`}`,
  );
  expect(r.statusCode).toBe(200);
  const s = researchSummarySchema.parse(r.json());
  if (s.context === null) throw new Error("no context block");
  return s.context;
}

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  teamId = meSchema.parse((await signIn(env, team, `ctx-${randomUUID()}@drift.test`)).json()).id;
  await env.pool.query("update users set role = 'team' where id = $1", [teamId]);
  // Classifier của các lệnh đã qua cổng precision (50 nhãn Right) → lệnh được tính.
  await env.pool.query(
    `insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict)
     select gen_random_uuid(), 'lbl-' || g, $1, $2, 'right' from generate_series(1, 50) g`,
    [CLS, teamId],
  );
});

afterAll(async () => {
  await env.close();
});

describe("trace step 4 and feed flags (#329)", () => {
  it("returns the saved context card between Score and Filter, and compact flags in the feed", async () => {
    await article("ctx-a1");
    await event("ctx-a1", "collect", "pass");
    await event("ctx-a1", "normalize", "pass");
    await event("ctx-a1", "understand", "pass");
    await event("ctx-a1", "filter", "drop");
    await snapshot("ctx-a1", ago(58), { h1: "yes", h2: "no", h3: "na" });
    // Bài bị loại ở Score: không tới bước 4, không có snapshot.
    await article("ctx-a2");
    await event("ctx-a2", "collect", "pass");
    await event("ctx-a2", "normalize", "pass");
    await event("ctx-a2", "understand", "drop");

    const r = await team.request("GET", `${base}/articles/ctx-a1/trace`);
    expect(r.statusCode).toBe(200);
    const tr = researchArticleTraceSchema.parse(r.json());
    expect(tr.steps.map((s) => s.key)).toEqual([
      "collect",
      "normalize",
      "score",
      "filter",
      "decide",
    ]);
    expect(tr.context).toEqual({
      decidedAt: ago(58),
      source: "live",
      contextVersion: SIGNAL_CONTEXT_VERSION,
      market: "ETH-USD",
      side: "long",
      h1: {
        status: "yes",
        walletsChecked: 214,
        agreeingWallets: 2,
        opposingWallets: 0,
        agreeingUsdc: "1400000",
        firstAt: new Date(Date.parse(ago(58)) - 39 * 60_000).toISOString(),
        windowMinutes: 60,
      },
      h2: {
        status: "no",
        fundingRate: "0.0001",
        fundingTime: new Date(Date.parse(ago(58)) - 2 * 3_600_000).toISOString(),
        intervalHours: 8,
        percentile: 56,
        samples: 90,
        payer: "long",
        thresholdPercentile: 20,
        lookbackDays: 30,
      },
      h3: { status: "na", movedPct: 0.2, typicalMovePct: 0.6, thresholdPct: 0.6 },
      exploratory: { volumeVs24h: 1.8, rangeBreakout: "none" },
    });
    expect(tr.article.context).toEqual({ source: "live", h1: "yes", h2: "no", h3: "na" });

    const none = researchArticleTraceSchema.parse(
      (await team.request("GET", `${base}/articles/ctx-a2/trace`)).json(),
    );
    expect(none.context).toBeNull();
    expect(none.article.context).toBeNull();

    const feed = researchArticlesPageSchema.parse(
      (await team.request("GET", `${base}/articles?range=7d`)).json(),
    );
    const byId = new Map(feed.items.map((i) => [i.id, i.context]));
    expect(byId.get("ctx-a1")).toEqual({ source: "live", h1: "yes", h2: "no", h3: "na" });
    expect(byId.get("ctx-a2")).toBeNull();
  });
});

describe("summary context block (#329)", () => {
  it("compares with / without per question, collecting until each group has 30 closed trades", async () => {
    const versionId = randomUUID();
    await env.pool.query(
      `insert into signal_bot_versions (id, number, name, config, status, created_at, updated_at, status_changed_at)
       select $1, 40, 'Ctx', config, 'stopped', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
         from signal_bot_versions where is_baseline`,
      [versionId],
    );
    const from = "2026-09-01T00:00:00Z";
    await bulk(versionId, "ctx-w", 30, from, 1, { h1: "yes", h2: "yes", h3: "no" });
    await bulk(versionId, "ctx-o", 29, from, 0, { h1: "no", h2: "no", h3: "no" });
    await bulk(versionId, "ctx-n", 5, from, 5, { h1: "na", h2: "na", h3: "yes" });
    await bulk(versionId, "ctx-x", 2, from, 9, null);
    await bulk(versionId, "ctx-b", 1, from, 9, {
      h1: "yes",
      h2: "yes",
      h3: "yes",
      source: "backfilled",
    });

    let c = await summary(versionId);
    expect(c).toMatchObject({
      contextVersion: SIGNAL_CONTEXT_VERSION,
      source: "live",
      minClosedPerGroup: 30,
      closedWithoutLiveSnapshot: 3,
      // Độ phủ gồm cả snapshot của bài ctx-a1 (trace ở trên).
      coverage: {
        signals: 65,
        whale: 60,
        funding: 60,
        priceRun: 64,
        backfilled: 1,
        openInterest: "notAvailable",
      },
    });
    const q = (k: "h1" | "h2" | "h3") => c.questions.find((x) => x.key === k);
    // 30 có / 29 không: chưa so, không lộ trung bình hay khoảng; `na` không vào nhóm nào.
    expect(q("h1")).toEqual({
      key: "h1",
      with: { closed: 30, avgPct: null },
      without: { closed: 29, avgPct: null },
      diffPct: null,
      range: null,
      clusters: 0,
      status: "collecting",
      needWith: 0,
      needWithout: 1,
    });
    expect(q("h2")).toMatchObject({ status: "collecting", needWithout: 1 });
    expect(q("h3")).toMatchObject({
      status: "collecting",
      with: { closed: 5 },
      without: { closed: 59 },
      needWith: 25,
      needWithout: 0,
    });

    // Lệnh thứ 30 "không" (H1 = against tính vào nhóm không) → đủ mẫu: có tốt hơn rõ ràng.
    await bulk(versionId, "ctx-o2", 1, "2026-09-20T00:00:00Z", 0, {
      h1: "against",
      h2: "no",
      h3: "no",
    });
    c = await summary(versionId);
    const h1 = q("h1");
    expect(h1).toMatchObject({
      status: "better_with",
      with: { closed: 30, avgPct: 1 },
      without: { closed: 30 },
      needWith: 0,
      needWithout: 0,
    });
    expect(h1?.without.avgPct).toBeCloseTo(0.0033, 4);
    expect(h1?.diffPct).toBeCloseTo(0.9967, 4);
    expect(h1?.range?.lo).toBeGreaterThan(0);
    expect(h1?.clusters).toBeGreaterThan(1);
    expect(q("h2")?.status).toBe("better_with");
    expect(q("h3")?.status).toBe("collecting");
  });
});
