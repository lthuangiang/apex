import { randomUUID } from "node:crypto";

import { meSchema, researchLatencySchema, type ResearchLatency } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #375: `GET /latency` (độ trễ theo chặng) gọi endpoint thật trên Postgres thật của test env. Bài, event và lệnh chèn thẳng
// như scheduler ghi; mốc đồng hồ (`claude_done_at`, `decided_clock_at`, `opened_clock_at`) do test đặt.

let env: TestEnv;
let team: TestClient;
let user: TestClient;
const path = "/api/v1/admin/signal-research/latency";

const at = (minAgo: number, plusMs = 0) =>
  new Date(env.clock.now.getTime() - minAgo * 60_000 + plusMs).toISOString();

interface Art {
  id: string;
  /** Phút trước "now" lúc thu bài. */
  collected: number;
  /** ms từ giờ đăng tới lúc thu. */
  delayMs: number;
  /** ms từ lúc thu tới Claude xong; null = không qua Claude. */
  claudeMs?: number | null;
  status?: string;
}

async function article(a: Art) {
  const collectedAt = at(a.collected);
  await env.pool.query(
    `insert into signal_articles (id, source, title, content, published_at, collected_at, matched_currencies, candidates, content_hash,
       status, rule_version, claude_started_at, claude_done_at)
     values ($1, 'Reuters', $1, 'Body', $2::timestamptz - ($3 || ' milliseconds')::interval, $2, '[]', '[]', $1, $4, 'news-v7',
       $5, $6)`,
    [
      a.id,
      collectedAt,
      String(a.delayMs),
      a.status ?? "classified",
      a.claudeMs == null ? null : collectedAt,
      a.claudeMs == null ? null : at(a.collected, a.claudeMs),
    ],
  );
}

/** Event Filter / Decide với mốc quyết định = Claude done + `ms`. `at` là giờ chu kỳ (= giờ thu). */
async function decided(
  articleId: string,
  collected: number,
  claudeMs: number,
  ms: number,
  stage = "filter",
) {
  await env.pool.query(
    `insert into signal_events (id, article_id, stage, outcome, rule_version, at, decided_clock_at)
     values (gen_random_uuid(), $1, $2, 'pass', 'news-v7', $3, $4)`,
    [articleId, stage, at(collected), at(collected, claudeMs + ms)],
  );
}

/** Lệnh paper (`label` live / shadow) với mốc decided → opened cách nhau `ms`. */
async function trade(articleId: string, collected: number, ms: number, label = "live") {
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, label, article_id, market, token, catalyst, direction, size_usdc, qty,
       entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price,
       max_hold_until, event_at, seen_at, opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status,
       rule_version, decided_clock_at, opened_clock_at)
     values (gen_random_uuid(), 'news', $1, $2, 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 0.15, 3400, 3400,
       0.01, 0.05, 0.25, 1, 1.6, 0.8, 3454, 3372, $3::timestamptz + interval '3 days', $3, $3, $3, 'medium', '[]', false, 'book',
       'open', 'news-v7', $4, $5)`,
    [label, articleId, at(collected), at(collected, 60_000), at(collected, 60_000 + ms)],
  );
}

async function latency(query = ""): Promise<ResearchLatency> {
  const r = await team.request("GET", `${path}${query}`);
  expect(r.statusCode).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  return researchLatencySchema.parse(r.json());
}

const stage = (l: ResearchLatency, key: string) => l.stages.find((s) => s.key === key);

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  user = new TestClient(env.app);
  const teamId = meSchema.parse(
    (await signIn(env, team, `lat-${randomUUID()}@drift.test`)).json(),
  ).id;
  await env.pool.query("update users set role = 'team' where id = $1", [teamId]);
  await signIn(env, user, `lat-user-${randomUUID()}@drift.test`);
});

afterAll(async () => {
  await env.close();
});

describe("GET /latency (#375)", () => {
  it("401 signed out, 403 for non-team users before the query is parsed", async () => {
    const anon = new TestClient(env.app);
    expect((await anon.request("GET", path)).statusCode).toBe(401);
    expect((await user.request("GET", path)).statusCode).toBe(403);
    expect((await user.request("GET", `${path}?range=nope`)).statusCode).toBe(403);
    expect((await team.request("GET", `${path}?range=nope`)).statusCode).toBe(400);
  });

  it("no data yet: every median is null (never 0); the source → SoSoValue stage is always null", async () => {
    const l = await latency();
    expect(l.range).toBe("1d");
    expect(l.stages.map((s) => s.key)).toEqual([
      "sourceToSoso",
      "publishedToCollected",
      "collectedToClaudeDone",
      "claudeDoneToDecided",
      "decidedToOpened",
    ]);
    expect(stage(l, "sourceToSoso")).toEqual({ key: "sourceToSoso", medianMs: null, n: null });
    for (const s of l.stages.slice(1)) expect(s).toMatchObject({ medianMs: null, n: 0 });
    expect(l.total).toBeNull();
  });

  it("medians per stage with the number of articles measured; backlog, shadow and old articles are left out", async () => {
    // Ba bài trong 1 ngày: delay 60 / 120 / 300 s; Claude 4 / 8 s (bài 3 không qua Claude).
    await article({ id: "lat-1", collected: 30, delayMs: 60_000, claudeMs: 4_000 });
    await article({ id: "lat-2", collected: 20, delayMs: 120_000, claudeMs: 8_000 });
    await article({
      id: "lat-3",
      collected: 10,
      delayMs: 300_000,
      claudeMs: null,
      status: "dropped",
    });
    // Backlog không tính.
    await article({ id: "lat-bk", collected: 5, delayMs: 9_000_000, status: "backlog" });
    // Bài 3 ngày trước: chỉ vào cửa sổ 7 ngày.
    await article({ id: "lat-old", collected: 3 * 24 * 60, delayMs: 600_000, claudeMs: 20_000 });

    // Quyết định: bài 1 sau 1.5 s (Filter) rồi Decide sau 2 s → lấy lần đầu (1.5 s); bài 2 sau 3.5 s.
    await decided("lat-1", 30, 4_000, 1_500);
    await decided("lat-1", 30, 4_000, 2_000, "decide");
    await decided("lat-2", 20, 8_000, 3_500);
    // Lệnh: bài 1 mở sau 40 ms; shadow của bài 2 không tính.
    await trade("lat-1", 30, 40);
    await trade("lat-2", 20, 999, "shadow");

    const d1 = await latency("?range=1d");
    expect(stage(d1, "publishedToCollected")).toEqual({
      key: "publishedToCollected",
      medianMs: 120_000,
      n: 3,
    });
    expect(stage(d1, "collectedToClaudeDone")).toMatchObject({ medianMs: 6_000, n: 2 });
    expect(stage(d1, "claudeDoneToDecided")).toMatchObject({ medianMs: 2_500, n: 2 });
    expect(stage(d1, "decidedToOpened")).toMatchObject({ medianMs: 40, n: 1 });
    expect(stage(d1, "sourceToSoso")).toMatchObject({ medianMs: null, n: null });
    // Tổng published → opened chỉ của bài đủ mọi chặng (bài 1: 60 s chờ + 60.04 s tới lúc ghi lệnh); bài 2 chỉ có shadow.
    expect(d1.total).toEqual({ medianMs: 120_040, n: 1 });

    const d7 = await latency("?range=7d");
    expect(d7.range).toBe("7d");
    // + bài cũ (600 s, Claude 20 s): 4 bài → median 60/120/300/600 = 210 s; Claude 4/8/20 = 8 s.
    expect(stage(d7, "publishedToCollected")).toMatchObject({ medianMs: 210_000, n: 4 });
    expect(stage(d7, "collectedToClaudeDone")).toMatchObject({ medianMs: 8_000, n: 3 });
  });

  it("total: median of the full time over articles with every leg; an article missing a leg is left out", async () => {
    // Đủ mọi chặng: chờ 30 s, Claude 2 s, quyết định, lệnh live (ghi 60.1 s sau lúc thu) → tổng 90.1 s.
    await article({ id: "lat-4", collected: 15, delayMs: 30_000, claudeMs: 2_000 });
    await decided("lat-4", 15, 2_000, 500);
    await trade("lat-4", 15, 100);
    // Thiếu Claude done (bài cũ): có quyết định và lệnh nhưng không tính.
    await article({ id: "lat-5", collected: 14, delayMs: 1_000, claudeMs: null });
    await decided("lat-5", 14, 0, 500);
    await trade("lat-5", 14, 10);
    // Thiếu mốc quyết định: có Claude và lệnh nhưng không tính.
    await article({ id: "lat-6", collected: 13, delayMs: 1_000, claudeMs: 1_000 });
    await trade("lat-6", 13, 10);

    const d1 = await latency("?range=1d");
    // lat-1 (120.04 s) và lat-4 (90.1 s) → median 105.07 s, n = 2. Không phải tổng các median từng chặng.
    expect(d1.total).toEqual({ medianMs: 105_070, n: 2 });
  });

  it("an unknown version is a 404", async () => {
    const r = await team.request("GET", `${path}?versionId=${randomUUID()}`);
    expect(r.statusCode).toBe(404);
  });
});
