import { randomUUID } from "node:crypto";

import {
  errorResponseSchema,
  meSchema,
  researchSummarySchema,
  researchTradesPageSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #321 / #344 qua API: lệnh của quy tắc cũ (news-v2) chỉ hiện khi bật "Show older rules", có số version quy tắc để web gắn
// nhãn "Rules v2 · not counted"; tổng kết đếm chúng (`olderRules`), cho mốc bắt đầu quy tắc hiện tại (`newsRulesSince`),
// và chi phí một lệnh lấy từ bước kiểm TP vs chi phí khi chưa có lệnh v3 nào.

let env: TestEnv;
let team: TestClient;
const base = "/api/v1/admin/signal-research";
const v2Trade = randomUUID();
const v3Trade = randomUUID();

async function article(id: string, rule: string, collectedAt: string) {
  await env.pool.query(
    `insert into signal_articles (id, source, title, published_at, collected_at, matched_currencies, candidates, content_hash, status, rule_version)
     values ($1, 'Bloomberg', $2, $3::timestamptz - interval '3 minutes', $3, '[]', '[]', $4, 'classified', $5)`,
    [id, `Title ${id}`, collectedAt, `h-${id}`, rule],
  );
}

async function trade(id: string, articleId: string, rule: string, openedAt: string) {
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, label, article_id, market, token, catalyst, direction, size_usdc, qty, entry_price, entry_mid,
       spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until, event_at, seen_at, opened_at,
       level_at_entry, sources_at_entry, outside_market_hours, price_source, status, exit_price, exit_reason, exited_at,
       exit_fee, result_usdc, result_pct, rule_version)
     values ($1, 'news', 'live', $2, 'SOL-USD', 'SOL', 'etf_approved', 'long', 500, 3.5, 142.18, 142.2, 0.03, 0.05, 0.25, 1.33,
       2, 1, 145, 140.8, $3::timestamptz + interval '3 days', $3, $3, $3, 'medium', '[]', false, 'book', 'closed', 145, 'take_profit',
       $3::timestamptz + interval '1 hour', 0.25, 9.5, 1.9, $4)`,
    [id, articleId, openedAt, rule],
  );
}

async function summary(versionId?: string) {
  const r = await team.request(
    "GET",
    `${base}/summary${versionId === undefined ? "" : `?versionId=${versionId}`}`,
  );
  expect(r.statusCode).toBe(200);
  return researchSummarySchema.parse(r.json());
}

async function trades(qs: string) {
  const r = await team.request("GET", `${base}/trades?${qs}`);
  expect(r.statusCode).toBe(200);
  return researchTradesPageSchema.parse(r.json());
}

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, team, `sr-old-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
});

afterAll(async () => {
  await env.close();
});

describe("older rules and cost of a trade (#321, #344)", () => {
  it("cost of a trade: null until a v3 signal reaches the cost check, then from that check, then from v3 trades", async () => {
    await article("v3-first", "news-v3", "2026-11-18T08:00:00Z");
    let s = await summary();
    expect(s.newsRulesSince).toBe("2026-11-18T08:00:00.000Z");
    expect(s.costPct).toBeNull();
    expect(s.olderRules).toEqual({ trades: 0, versions: [] });

    // Một tín hiệu v3 bị bỏ ở bước kiểm TP vs chi phí (event Filter mang `costPct`).
    await article("v3-skip", "news-v3", "2026-11-18T09:00:00Z");
    await env.pool.query(
      `insert into signal_events (id, article_id, stage, outcome, reason, detail, rule_version, at)
       values (gen_random_uuid(), 'v3-skip', 'filter', 'drop', 'MOVE_TOO_SMALL_FOR_COST',
               '{"level":"medium","tpPct":"0.1500","costPct":"0.1200","spreadPct":"0.0200"}', 'news-v3', '2026-11-18T09:00:05Z')`,
    );
    // Event của quy tắc cũ không bao giờ vào chi phí của v3.
    await article("v2-skip", "news-v2", "2026-11-17T09:00:00Z");
    await env.pool.query(
      `insert into signal_events (id, article_id, stage, outcome, reason, detail, rule_version, at)
       values (gen_random_uuid(), 'v2-skip', 'filter', 'drop', 'MOVE_TOO_SMALL_FOR_COST',
               '{"tpPct":"0.1","costPct":"0.9000"}', 'news-v2', '2026-11-17T09:00:05Z')`,
    );
    s = await summary();
    expect(s.costPct).toBe(0.12);

    // Lệnh v3 đầu tiên: chi phí thật của lệnh (phí 0.05% × 2 + spread 0.03%).
    await article("v3-trade", "news-v3", "2026-11-18T10:00:00Z");
    await trade(v3Trade, "v3-trade", "news-v3", "2026-11-18T10:00:05Z");
    s = await summary();
    expect(s.costPct).toBe(0.13);
  });

  it("v2 trades: counted in olderRules, left out of the list unless olderRules=true, tagged with their rules version", async () => {
    await article("v2-trade", "news-v2", "2026-11-17T10:00:00Z");
    await trade(v2Trade, "v2-trade", "news-v2", "2026-11-17T10:00:05Z");

    const s = await summary();
    expect(s.newsRulesVersion).toBe(3);
    expect(s.olderRules).toEqual({ trades: 1, versions: [2] });
    // Lệnh v2 không bao giờ vào tổng kết.
    expect(s.rows[0]).toMatchObject({ rulesVersion: 3, opened: 1 });

    const def = await trades("show=all");
    expect(ids(def)).toContain(v3Trade);
    expect(ids(def)).not.toContain(v2Trade);
    // Tín hiệu bị bỏ của v2 cũng chỉ hiện khi bật.
    expect(def.items.every((i) => i.rulesVersion === 3)).toBe(true);
    expect(ids(await trades("show=entered&olderRules=false"))).not.toContain(v2Trade);

    const all = await trades("show=entered&olderRules=true");
    expect(all.items.map((i) => [i.id, i.rulesVersion])).toEqual([
      [v3Trade, 3],
      [v2Trade, 2],
    ]);

    const bad = await team.request("GET", `${base}/trades?olderRules=yes`);
    expect(bad.statusCode).toBe(400);
    expect(errorResponseSchema.parse(bad.json()).error.code).toBe("VALIDATION_FAILED");
  });

  it("a saved version has no v2 history: olderRules is 0 and the toggle adds nothing", async () => {
    const versionId = randomUUID();
    await env.pool.query(
      `insert into signal_bot_versions (id, number, name, config, status, created_at, updated_at, status_changed_at)
       select $1, 7, 'Strict', config, 'stopped', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z', '2026-11-18T00:00:00Z'
         from signal_bot_versions where is_baseline`,
      [versionId],
    );
    const s = await summary(versionId);
    expect(s.olderRules).toEqual({ trades: 0, versions: [] });
    expect(ids(await trades(`show=entered&olderRules=true&versionId=${versionId}`))).not.toContain(
      v2Trade,
    );
  });
});

function ids(p: { items: { id: string }[] }) {
  return p.items.map((i) => i.id);
}
