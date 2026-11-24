import { randomUUID } from "node:crypto";

import { errorResponseSchema, meSchema, researchNewArticlesSchema } from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #345: `GET /articles/new?since=` cho hiệu ứng bài mới rơi xuống phễu. Gọi endpoint thật (DB thật của test env); bài và
// event chèn thẳng như scheduler ghi.

let env: TestEnv;
let team: TestClient;
let user: TestClient;
const base = "/api/v1/admin/signal-research";
const path = `${base}/articles/new`;

const ago = (min: number) => new Date(env.clock.now.getTime() - min * 60_000).toISOString();

async function article(id: string, collectedMinAgo: number) {
  await env.pool.query(
    `insert into signal_articles (id, source, title, content, published_at, collected_at, matched_currencies, candidates, content_hash,
       status, classification, rule_version)
     values ($1, 'Reuters', $2, 'Body', $3, $3, '[{"symbol":"ETH","name":"Ethereum"}]',
       '[{"symbol":"ETH","market":"ETH-USD","kind":"crypto"}]', $4, 'classified', null, 'news-v5')`,
    [id, `Title ${id}`, ago(collectedMinAgo), `hash-${id}`],
  );
}

async function event(articleId: string, stage: string, outcome: string, reason: string | null) {
  await env.pool.query(
    `insert into signal_events (id, article_id, stage, outcome, reason, detail, rule_version, at)
     values (gen_random_uuid(), $1, $2, $3, $4, null, 'news-v5', $5)`,
    [articleId, stage, outcome, reason, ago(0)],
  );
}

/** Bài bị loại ở Normalize (đã xong phễu). */
async function dropped(id: string, collectedMinAgo: number) {
  await article(id, collectedMinAgo);
  await event(id, "collect", "pass", null);
  await event(id, "normalize", "drop", "NO_SODEX_MARKET");
}

async function poll(since?: string) {
  const r = await team.request(
    "GET",
    since === undefined ? path : `${path}?since=${encodeURIComponent(since)}`,
  );
  expect(r.statusCode).toBe(200);
  expect(r.headers["cache-control"]).toBe("no-store");
  return researchNewArticlesSchema.parse(r.json());
}

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  user = new TestClient(env.app);
  const teamId = meSchema.parse(
    (await signIn(env, team, `new-${randomUUID()}@drift.test`)).json(),
  ).id;
  await env.pool.query("update users set role = 'team' where id = $1", [teamId]);
  await signIn(env, user, `new-user-${randomUUID()}@drift.test`);
});

afterAll(async () => {
  await env.close();
});

describe("GET /articles/new (#345)", () => {
  it("401 signed out, 403 for non-team users before the query is parsed", async () => {
    const anon = new TestClient(env.app);
    expect((await anon.request("GET", path)).statusCode).toBe(401);
    expect((await user.request("GET", path)).statusCode).toBe(403);
    expect((await user.request("GET", `${path}?since=bad&limit=abc`)).statusCode).toBe(403);
  });

  it("a bad or tampered since cursor is a 400 VALIDATION_FAILED", async () => {
    const tampered = Buffer.from(JSON.stringify({ t: "yesterday", id: "x" })).toString("base64url");
    for (const c of ["not-a-cursor", tampered]) {
      const r = await team.request("GET", `${path}?since=${c}`);
      expect(r.statusCode).toBe(400);
      expect(errorResponseSchema.parse(r.json()).error.code).toBe("VALIDATION_FAILED");
    }
  });

  it("first call returns no items and a cursor at the newest article; later calls return only what came after, once", async () => {
    await dropped("new-old", 30);
    const first = await poll();
    expect(first.items).toEqual([]);

    // Không có gì mới: con trỏ giữ nguyên.
    const idle = await poll(first.since);
    expect(idle.items).toEqual([]);
    expect(idle.since).toBe(first.since);

    await dropped("new-b", 5);
    await dropped("new-a", 6);
    const next = await poll(first.since);
    // Cũ trước mới (theo giờ thu), bài đã có trước lần đầu không trả.
    expect(next.items.map((a) => a.id)).toEqual(["new-a", "new-b"]);
    expect(next.items[0]?.stage).toBe("normalize");
    expect(next.items[0]?.outcome).toBe("dropped");

    const again = await poll(next.since);
    expect(again.items).toEqual([]);
  });

  it("a recent article still in the funnel holds the cursor until it settles; old stuck ones do not", async () => {
    // Đồng hồ đi 30 phút: bài treo (thu 20 phút trước, sau con trỏ, vẫn chờ) quá 15 phút nên không giữ con trỏ.
    env.clock.now = new Date(env.clock.now.getTime() + 30 * 60_000);
    const start = (await poll()).since;
    await article("new-stuck", 20);
    await event("new-stuck", "collect", "pass", null);
    // Bài mới còn chờ Normalize, rồi một bài đã xong sau nó.
    await article("new-wait", 3);
    await event("new-wait", "collect", "pass", null);
    await dropped("new-after", 2);

    const p1 = await poll(start);
    expect(p1.items.map((a) => a.id)).toEqual(["new-after"]);
    // Con trỏ dừng trước bài còn chờ: lần sau bài sau nó trả lại (web bỏ trùng theo id).
    const p2 = await poll(p1.since);
    expect(p2.items.map((a) => a.id)).toEqual(["new-after"]);

    await event("new-wait", "normalize", "drop", "NO_SODEX_MARKET");
    const p3 = await poll(p1.since);
    expect(p3.items.map((a) => a.id)).toEqual(["new-wait", "new-after"]);
    const p4 = await poll(p3.since);
    expect(p4.items).toEqual([]);
  });

  it("limit caps the page and the cursor moves only past what was returned", async () => {
    const start = (await poll()).since;
    for (let i = 0; i < 3; i++) await dropped(`new-lim-${String(i)}`, 1 - i * 0.1);
    const r = await team.request("GET", `${path}?since=${encodeURIComponent(start)}&limit=2`);
    expect(r.statusCode).toBe(200);
    const p1 = researchNewArticlesSchema.parse(r.json());
    expect(p1.items.map((a) => a.id)).toEqual(["new-lim-0", "new-lim-1"]);
    const p2 = await poll(p1.since);
    expect(p2.items.map((a) => a.id)).toEqual(["new-lim-2"]);
  });
});
