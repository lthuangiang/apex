import { randomUUID } from "node:crypto";

import {
  MARKET_STATE_VERSION,
  meSchema,
  researchArticleTraceSchema,
  researchSummarySchema,
  researchTradesPageSchema,
  SIGNAL_CONTEXT_VERSION,
  type ResearchMarketSplit,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Trạng thái thị trường lúc quyết định (Catalyst P0, #376) qua API: trong trace (chip thẻ Decide), từng lệnh ("Market at
// entry") và tổng kết (By market, nhóm < 30 lệnh đóng không có trung bình). Snapshot do scheduler ghi; ở đây chèn thẳng.

let env: TestEnv;
let team: TestClient;
const base = "/api/v1/admin/signal-research";
const CLS = "mkt-cls";

const ago = (min: number) => new Date(env.clock.now.getTime() - min * 60_000).toISOString();

interface Mkt {
  /** null = snapshot ghi trước #376 (không có market_version). */
  recorded: boolean;
  /** Mặc định `live`. */
  source?: "live" | "backfilled";
  btc: string | null;
  trend: "up" | "flat" | "down" | null;
  move: string | null;
  pctl: string | null;
  vol: "low" | "normal" | "high" | null;
}
const STATE = (trend: Mkt["trend"], vol: Mkt["vol"]): Mkt => ({
  recorded: true,
  btc: trend === "up" ? "2.4" : trend === "down" ? "-2.4" : trend === null ? null : "0.3",
  trend,
  move: vol === null ? null : "1.2",
  pctl: vol === "high" ? "81" : vol === "low" ? "12" : vol === null ? null : "50",
  vol,
});
const OLD: Mkt = { recorded: false, btc: null, trend: null, move: null, pctl: null, vol: null };

async function snapshot(articleId: string, decidedAt: string, m: Mkt) {
  await env.pool.query(
    `insert into signal_contexts (id, article_id, market, direction, decided_at, source, context_version, rule_version,
       h1_status, h2_status, h3_status, market_version, market_btc_change_24h_pct, market_btc_trend, market_vol_4h_pct,
       market_vol_percentile, market_volatility)
     values (gen_random_uuid(), $1, 'ETH-USD', 'long', $2, $10, $3, 'news-v7', 'na', 'na', 'na', $4, $5, $6, $7, $8, $9)`,
    [
      articleId,
      decidedAt,
      SIGNAL_CONTEXT_VERSION,
      m.recorded ? MARKET_STATE_VERSION : null,
      m.btc,
      m.trend,
      m.move,
      m.pctl,
      m.vol,
      m.source ?? "live",
    ],
  );
}

/** `n` lệnh đã đóng của version (classifier đã qua cổng), kết quả `pct` %; mỗi lệnh có bài `prefix-g` và snapshot `m`. */
async function bulk(
  versionId: string,
  prefix: string,
  n: number,
  pct: number,
  m: Mkt | null,
  cls: string = CLS,
) {
  const from = "2026-09-01T00:00:00Z";
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, label, version_id, article_id, market, token, catalyst, direction, size_usdc, qty,
       entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price,
       max_hold_until, event_at, seen_at, opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status,
       exit_price, exit_reason, exited_at, exit_fee, result_usdc, result_pct, random_pct, rule_version, classifier_version)
     select gen_random_uuid(), 'news', 'live', $1, $2 || '-' || g, 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 0.15, 3400, 3400,
       0.01, 0.05, 0.25, 1, 1.6, 0.8, 3454, 3372, t + interval '3 days', t, t, t, 'medium', '[]', false, 'book', 'closed', 3450,
       'take_profit', t + interval '30 minutes', 0.25, $5::numeric * 5, $5::numeric, 0, 'news-v7', $3
     from (select g, $4::timestamptz + (g * interval '7 hours') as t from generate_series(1, $6::int) g) s`,
    [versionId, prefix, cls, from, pct, n],
  );
  if (m === null) return;
  for (let g = 1; g <= n; g++)
    await snapshot(
      `${prefix}-${String(g)}`,
      new Date(Date.parse(from) + g * 7 * 3_600_000).toISOString(),
      m,
    );
}

async function version(n: number): Promise<string> {
  const id = randomUUID();
  await env.pool.query(
    `insert into signal_bot_versions (id, number, name, config, status, created_at, updated_at, status_changed_at)
     select $1, $2, 'Mkt', config, 'stopped', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z'
       from signal_bot_versions where is_baseline`,
    [id, n],
  );
  return id;
}

async function split(
  versionId: string,
  source: "live" | "backfilled" = "live",
): Promise<ResearchMarketSplit> {
  const r = await team.request("GET", `${base}/summary?versionId=${versionId}`);
  expect(r.statusCode).toBe(200);
  const body = researchSummarySchema.parse(r.json());
  const s = source === "live" ? body.marketSplit : body.marketSplitBackfilled;
  if (s === null) throw new Error("no market split");
  return s;
}

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  const teamId = meSchema.parse(
    (await signIn(env, team, `mkt-${randomUUID()}@drift.test`)).json(),
  ).id;
  await env.pool.query("update users set role = 'team' where id = $1", [teamId]);
  // Classifier đã qua cổng precision (50 nhãn Right, nguồn random) → lệnh được tính.
  await env.pool.query(
    `insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict, source)
     select gen_random_uuid(), 'lbl-' || g, $1, $2, 'right', 'random' from generate_series(1, 50) g`,
    [CLS, teamId],
  );
});

afterAll(async () => {
  await env.close();
});

describe("market state in the trace (#376)", () => {
  it("returns the saved state on the step 4 card; null before #376; null fields when data was missing", async () => {
    for (const [id, m] of [
      ["mkt-a1", STATE("down", "high")],
      ["mkt-old", OLD],
      ["mkt-na", STATE(null, null)],
    ] as const) {
      await env.pool.query(
        `insert into signal_articles (id, source, title, content, published_at, collected_at, matched_currencies, candidates,
           content_hash, status, classification, claude_prompt_version, rule_version)
         values ($1, 'Reuters', $1, 'Body', $2, $2, '[]', '[]', $3, 'classified',
           '{"catalyst":"etf_approved","market":"ETH-USD","relevance":"direct","promotional":false}', $4, 'news-v7')`,
        [id, ago(60), `hash-${id}`, CLS],
      );
      for (const [stage, outcome] of [
        ["collect", "pass"],
        ["normalize", "pass"],
        ["understand", "pass"],
        ["filter", "drop"],
      ])
        await env.pool.query(
          `insert into signal_events (id, article_id, stage, outcome, rule_version, at)
           values (gen_random_uuid(), $1, $2, $3, 'news-v7', $4)`,
          [id, stage, outcome, ago(59)],
        );
      await snapshot(id, ago(58), m);
    }
    const trace = async (id: string) =>
      researchArticleTraceSchema.parse(
        (await team.request("GET", `${base}/articles/${id}/trace`)).json(),
      ).context?.marketState;
    expect(await trace("mkt-a1")).toEqual({
      btcChange24hPct: -2.4,
      btcTrend: "down",
      volMovePct: 1.2,
      volPercentile: 81,
      volatility: "high",
    });
    expect(await trace("mkt-old")).toBeNull();
    expect(await trace("mkt-na")).toEqual({
      btcChange24hPct: null,
      btcTrend: null,
      volMovePct: null,
      volPercentile: null,
      volatility: null,
    });
  });
});

describe("market state per trade and the By market split (#376)", () => {
  it("each trade carries its state; groups under 30 closed trades show no average", async () => {
    const v = await version(50);
    await bulk(v, "up-high", 30, 1, STATE("up", "high"));
    await bulk(v, "down-low", 29, -1, STATE("down", "low"));
    await bulk(v, "flat-na", 3, 0.5, STATE("flat", null));
    await bulk(v, "old", 4, 2, OLD);
    await bulk(v, "none", 2, 2, null);

    const s = await split(v);
    expect(s.minClosedPerGroup).toBe(30);
    expect(s.btcTrend).toEqual([
      { key: "up", closed: 30, avgPct: 1, need: 0 },
      { key: "flat", closed: 3, avgPct: null, need: 27 },
      { key: "down", closed: 29, avgPct: null, need: 1 },
    ]);
    expect(s.volatility).toEqual([
      { key: "low", closed: 29, avgPct: null, need: 1 },
      { key: "normal", closed: 0, avgPct: null, need: 30 },
      { key: "high", closed: 30, avgPct: 1, need: 0 },
    ]);
    // Trước #376 (không version) và không có snapshot: "Not recorded"; có ghi mà thiếu volatility: "Not available".
    expect(s.notRecorded).toBe(6);
    expect(s.btcNotAvailable).toBe(0);
    expect(s.volNotAvailable).toBe(3);

    const page = researchTradesPageSchema.parse(
      (await team.request("GET", `${base}/trades?versionId=${v}&limit=100`)).json(),
    );
    const byArticle = new Map(page.items.map((t) => [t.articleId, t.marketState]));
    expect(byArticle.get("up-high-1")).toMatchObject({ btcTrend: "up", volatility: "high" });
    expect(byArticle.get("flat-na-1")).toMatchObject({ btcTrend: "flat", volatility: null });
    expect(byArticle.get("old-1")).toBeNull();
    expect(byArticle.get("none-1")).toBeNull();
  });
});

describe("live and backfilled market splits stay apart (review #381)", () => {
  it("each block only counts snapshots of its own source", async () => {
    const v = await version(51);
    await bulk(v, "live-up", 30, 1, STATE("up", "normal"));
    await bulk(v, "bf-down", 30, -1, { ...STATE("down", "low"), source: "backfilled" });

    const live = await split(v, "live");
    expect(live.source).toBe("live");
    expect(live.btcTrend.map((g) => [g.key, g.closed, g.avgPct])).toEqual([
      ["up", 30, 1],
      ["flat", 0, null],
      ["down", 0, null],
    ]);
    // Lệnh chỉ có snapshot backfilled: không có trạng thái của nguồn live.
    expect(live.notRecorded).toBe(30);

    const bf = await split(v, "backfilled");
    expect(bf.source).toBe("backfilled");
    expect(bf.btcTrend.map((g) => [g.key, g.closed, g.avgPct])).toEqual([
      ["up", 0, null],
      ["flat", 0, null],
      ["down", 30, -1],
    ]);
    expect(bf.volatility.find((g) => g.key === "low")).toMatchObject({ closed: 30, avgPct: -1 });
    expect(bf.notRecorded).toBe(30);
  });
});

describe("By market adds up to Overall (review #388)", () => {
  it("each table of each source sums to the counted closed trades of Overall", async () => {
    const v = await version(52);
    await bulk(v, "s-up", 12, 1, STATE("up", "high"));
    await bulk(v, "s-flat-na", 5, 0.5, STATE("flat", null));
    await bulk(v, "s-btc-na", 3, 0.2, STATE(null, "low"));
    await bulk(v, "s-bf", 9, -1, { ...STATE("down", "normal"), source: "backfilled" });
    await bulk(v, "s-old", 4, 2, OLD);
    await bulk(v, "s-none", 2, 2, null);
    // Classifier chưa qua cổng nhãn: lệnh đóng nhưng không được tính, ở cả Overall lẫn By market.
    await bulk(v, "s-uncounted", 6, 3, STATE("up", "high"), "mkt-cls-unlabeled");

    const r = await team.request("GET", `${base}/summary?versionId=${v}`);
    expect(r.statusCode).toBe(200);
    const body = researchSummarySchema.parse(r.json());
    const news = body.rows.find((x) => x.type === "news" && x.label === "live");
    const counted = news?.classifiers?.counted;
    expect(counted).toBe(35);
    for (const s of [body.marketSplit, body.marketSplitBackfilled]) {
      if (s === null) throw new Error("no market split");
      const sum = (gs: readonly { closed: number }[], na: number) =>
        gs.reduce((a, g) => a + g.closed, 0) + na + s.notRecorded;
      expect(sum(s.btcTrend, s.btcNotAvailable)).toBe(counted);
      expect(sum(s.volatility, s.volNotAvailable)).toBe(counted);
    }
  });
});
