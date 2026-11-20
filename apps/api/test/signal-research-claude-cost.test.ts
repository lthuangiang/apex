import { randomUUID } from "node:crypto";

import { claudeCostUsd, meSchema, NEWS_CLASSIFIER, researchSummarySchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #343: chi phí Claude của phễu tính trong ĐÚNG cửa sổ của phễu (1d = 24 giờ, 7d = 7 ngày, theo `collected_at`), cộng
// từ chi phí đã lưu của từng bài (DEC-326), cùng tập bài với "articles read". Trước đây 1d lấy bảng ngày UTC hiện tại,
// nên đầu ngày UTC (chưa có lượt Claude nào) hiện "Not available" dù 24 giờ qua có số.

let env: TestEnv;
let team: TestClient;
const base = "/api/v1/admin/signal-research";
// 01:30 UTC: cửa sổ 24 giờ vắt qua 0h UTC.
const NOW = new Date("2026-11-20T01:30:00Z");
const at = (iso: string) => new Date(iso).toISOString();

async function article(
  id: string,
  collected: string,
  usage: [number, number, number, number, number] | "unknown" | "old" | null,
) {
  const u = Array.isArray(usage) ? usage : null;
  await env.pool.query(
    `insert into signal_articles (id, source, title, published_at, collected_at, matched_currencies, candidates, content_hash, status,
       classified_at, claude_calls, claude_input_tokens, claude_cache_write_tokens, claude_cache_read_tokens, claude_output_tokens,
       claude_model, claude_prompt_version, rule_version)
     values ($1, 'Reuters', $1, $2, $2, '[]', '[]', $1, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'news-v3')`,
    [
      id,
      at(collected),
      usage === null ? "dropped" : "classified",
      usage === null ? null : at(collected),
      u?.[0] ?? (usage === "unknown" ? 1 : null),
      u?.[1] ?? null,
      u?.[2] ?? null,
      u?.[3] ?? null,
      u?.[4] ?? null,
      u === null && usage !== "unknown" ? null : NEWS_CLASSIFIER.model,
      u === null && usage !== "unknown" ? null : NEWS_CLASSIFIER.promptVersion,
    ],
  );
}

const cost = (input: number, cacheRead: number, output: number) =>
  claudeCostUsd({ input, cacheWrite: 0, cacheRead, output });

async function summary(range: "1d" | "7d") {
  const r = await team.request("GET", `${base}/summary?range=${range}`);
  expect(r.statusCode).toBe(200);
  return researchSummarySchema.parse(r.json()).funnel;
}

beforeAll(async () => {
  env = await startTestEnv();
  env.clock.now = NOW;
  team = new TestClient(env.app);
  const me = meSchema.parse((await signIn(env, team, `sr-cost-${randomUUID()}@drift.test`)).json());
  await env.pool.query("update users set role = 'team' where id = $1", [me.id]);
  // Ngày UTC hôm trước, trong 24 giờ.
  await article("c-1", "2026-11-19T20:00:00Z", [1, 500, 0, 4000, 100]);
  await article("c-2", "2026-11-19T23:50:00Z", [2, 600, 0, 4000, 120]);
  // Sau 0h UTC.
  await article("c-3", "2026-11-20T00:10:00Z", [1, 400, 0, 4000, 90]);
  // Không qua Claude (bỏ ở Normalize): không tính, không làm thành "Not available".
  await article("c-4", "2026-11-20T00:20:00Z", null);
  // Gọi Claude nhưng không biết token (lỗi mạng).
  await article("c-5", "2026-11-19T22:00:00Z", "unknown");
  // Ngoài 24 giờ, trong 7 ngày; bài trước khi lưu usage (đã phân loại, không có claude_calls).
  await article("c-6", "2026-11-17T10:00:00Z", [1, 700, 0, 4000, 110]);
  await article("c-7", "2026-11-16T10:00:00Z", "old");
  // Ngoài 7 ngày.
  await article("c-8", "2026-11-10T10:00:00Z", [1, 900, 0, 4000, 150]);
  // Bảng ngày UTC: hôm nay chưa có lượt Claude nào (cách tính cũ ra "Not available").
  await env.pool.query(
    `insert into signal_research_usage (day, claude_calls, claude_input_tokens, claude_output_tokens)
     values ('2026-11-19', 4, 1500, 310)`,
  );
});

afterAll(async () => {
  await env.close();
});

describe("Claude cost in the funnel window (#343)", () => {
  it("1d = the last 24 hours across 0h UTC, summed per article, same articles as articles read", async () => {
    const f = await summary("1d");
    expect(f?.articlesRead).toBe(5);
    const usd = cost(500, 4000, 100)
      .add(cost(600, 4000, 120))
      .add(cost(400, 4000, 90));
    expect(f?.claudeCost).toEqual({
      usd: usd.toDecimalPlaces(6).toFixed(),
      articles: 4,
      unknown: 1,
    });
  });

  it("7d = the last 7 days; an old classified article without usage is counted as unknown, never as 0", async () => {
    const f = await summary("7d");
    expect(f?.articlesRead).toBe(7);
    const usd = cost(500, 4000, 100)
      .add(cost(600, 4000, 120))
      .add(cost(400, 4000, 90))
      .add(cost(700, 4000, 110));
    expect(f?.claudeCost).toEqual({
      usd: usd.toDecimalPlaces(6).toFixed(),
      articles: 6,
      unknown: 2,
    });
  });

  it("a window with articles but no Claude call is $0 (a real number); no articles at all is null", async () => {
    env.clock.now = new Date("2026-11-20T00:40:00Z");
    await env.pool.query(
      "delete from signal_articles where id in ('c-1','c-2','c-3','c-5','c-6','c-7')",
    );
    const f = await summary("1d");
    expect(f?.claudeCost).toEqual({ usd: "0", articles: 0, unknown: 0 });
    env.clock.now = new Date("2026-11-22T00:40:00Z");
    expect((await summary("1d"))?.claudeCost).toBeNull();
    env.clock.now = NOW;
  });
});
