import { randomUUID } from "node:crypto";

import {
  adminUsersViewSchema,
  baselineVersionConfig,
  errorResponseSchema,
  featuresSchema,
  meSchema,
  NEWS_CLASSIFIER,
  researchArticlesPageSchema,
  researchArticleTraceSchema,
  researchClassifiersSchema,
  researchLabelNextSchema,
  researchSummarySchema,
  researchVersionCreatedSchema,
  researchVersionsSchema,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// #423 (DEC-361): Signal Research ra menu chính (BETA). Quyền "team HOẶC users.signal_research" cho phần trang
// người dùng test được dùng; phần chỉ team giữ nguyên. Version có chủ (My versions), trần 3 version chạy theo chủ, nhãn
// của tester không tính cổng. Dữ liệu bài / event do scheduler ghi; ở đây chèn thẳng.

let env: TestEnv;
let team: TestClient;
let tester: TestClient;
let tester2: TestClient;
let plain: TestClient;
let teamId: string;
let testerId: string;
let tester2Id: string;
let plainId: string;
let baselineId: string;
const base = "/api/v1/admin/signal-research";
const CURRENT = NEWS_CLASSIFIER.promptVersion;
const HYP = "One change gives a better result after fees.";
const cfg = baselineVersionConfig();

const ago = (min: number) => new Date(env.clock.now.getTime() - min * 60_000).toISOString();
const errOf = (r: { json: () => unknown }) => errorResponseSchema.parse(r.json()).error;
const create = (c: TestClient, name: string, start: boolean, from: string | null = null) =>
  c.request("POST", `${base}/versions`, {
    body: {
      name,
      config: cfg,
      start,
      hypothesis: HYP,
      ...(from === null ? {} : { savedFromVersionId: from }),
    },
    idempotencyKey: randomUUID(),
  });
const setStatus = (c: TestClient, id: string, status: string) =>
  c.request("POST", `${base}/versions/${id}/status`, {
    body: { status },
    idempotencyKey: randomUUID(),
  });
const versions = async (c: TestClient) => {
  const r = await c.request("GET", `${base}/versions`);
  expect(r.statusCode).toBe(200);
  return researchVersionsSchema.parse(r.json());
};

/** Bài tín hiệu của classifier hiện tại (qua Score), có usage Claude (chi phí biết được). */
async function signal(id: string) {
  await env.pool.query(
    `insert into signal_articles (id, source, url, title, content, published_at, collected_at, matched_currencies, candidates, content_hash,
       status, classified_at, classification, claude_calls, claude_input_tokens, claude_cache_write_tokens, claude_cache_read_tokens,
       claude_output_tokens, claude_model, claude_prompt_version, rule_version)
     values ($1, 'Reuters', null, $2, 'Body', $3, $3, '[{"symbol":"ETH","name":"Ethereum"}]',
       '[{"symbol":"ETH","market":"ETH-USD","kind":"crypto"}]', $4, 'classified', $3,
       '{"catalyst":"etf_approved","market":"ETH-USD","relevance":"direct","promotional":false}', 1, 500, 0, 4000, 100, $5, $6, 'news-v7')`,
    [id, `Title ${id}`, ago(60), `hash-${id}`, NEWS_CLASSIFIER.model, CURRENT],
  );
  for (const [stage, detail] of [
    ["collect", null],
    ["normalize", null],
    [
      "understand",
      { market: "ETH-USD", catalyst: "etf_approved", direction: "long", maxHoldHours: 72 },
    ],
  ] as const)
    await env.pool.query(
      `insert into signal_events (id, article_id, stage, outcome, detail, rule_version, at)
       values (gen_random_uuid(), $1, $2, 'pass', $3, 'news-v7', $4)`,
      [id, stage, detail === null ? null : JSON.stringify(detail), ago(59)],
    );
}

async function userId(c: TestClient, email: string) {
  return meSchema.parse((await signIn(env, c, email)).json()).id;
}

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  tester = new TestClient(env.app);
  tester2 = new TestClient(env.app);
  plain = new TestClient(env.app);
  teamId = await userId(team, `srb-team-${randomUUID()}@drift.test`);
  testerId = await userId(tester, `srb-t1-${randomUUID()}@drift.test`);
  tester2Id = await userId(tester2, `srb-t2-${randomUUID()}@drift.test`);
  plainId = await userId(plain, `srb-plain-${randomUUID()}@drift.test`);
  await env.pool.query("update users set role = 'team' where id = $1", [teamId]);
  baselineId = (await versions(team)).items.find((v) => v.isBaseline)?.id ?? "";
  await env.pool.query(
    `insert into signal_source_health (source, last_ok_at, last_cycle_at) values ('sosovalue', $1, $1)`,
    [ago(1)],
  );
  for (const id of ["b1", "b2", "b3"]) await signal(id);
});

afterAll(async () => {
  await env.close();
});

describe("flag and Users toggle (#423)", () => {
  it("users.signal_research is off by default; /features is true for team, false for others", async () => {
    const r = await env.pool.query<{ on: boolean }>(
      "select signal_research as on from users where id = $1",
      [testerId],
    );
    expect(r.rows[0]?.on).toBe(false);
    const f = async (c: TestClient) =>
      featuresSchema.parse((await c.request("GET", "/api/v1/features")).json()).signalResearch;
    expect(await f(team)).toBe(true);
    expect(await f(tester)).toBe(false);
    expect(await f(plain)).toBe(false);
  });

  it("only team turns it on / off in Users, with an audit row; then /features follows", async () => {
    const path = (id: string) => `/api/v1/admin/users/${id}/signal-research`;
    const denied = await tester.request("POST", path(testerId), { body: { enabled: true } });
    expect(denied.statusCode).toBe(403);
    for (const id of [testerId, tester2Id]) {
      const ok = await team.request("POST", path(id), { body: { enabled: true } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ signalResearch: true, paused: 0 });
    }
    const audits = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'admin.signal_research' and target = $1",
      [testerId],
    );
    expect(audits.rows[0]?.n).toBe(1);
    const f = featuresSchema.parse((await tester.request("GET", "/api/v1/features")).json());
    expect(f.signalResearch).toBe(true);
    const users = adminUsersViewSchema.parse(
      (await team.request("GET", "/api/v1/admin/users")).json(),
    );
    expect(users.items.find((u) => u.id === testerId)?.signalResearch).toBe(true);
    expect(users.items.find((u) => u.id === plainId)?.signalResearch).toBe(false);
  });
});

describe("API access: team / tester with the flag / user without it", () => {
  it("tester-allowed reads: 200 for team and tester, 403 without the flag", async () => {
    for (const path of [
      "/summary?range=1d",
      "/trades",
      "/articles?range=1d",
      "/articles/new",
      "/latency?range=1d",
      "/versions",
      "/markets",
      "/classifiers",
      "/research-wallets",
      "/labels/next",
    ]) {
      expect((await team.request("GET", `${base}${path}`)).statusCode, path).toBe(200);
      expect((await tester.request("GET", `${base}${path}`)).statusCode, path).toBe(200);
      expect((await plain.request("GET", `${base}${path}`)).statusCode, path).toBe(403);
    }
    // Ghi: không cờ → 403 trước Idempotency-Key và body.
    const noKey = await plain.request("POST", `${base}/versions`, {
      body: {},
      idempotencyKey: false,
    });
    expect(noKey.statusCode).toBe(403);
  });

  it("only the Claude cost is team only: the tester gets latency and source health (PM review #428)", async () => {
    const sum = async (c: TestClient) =>
      researchSummarySchema.parse((await c.request("GET", `${base}/summary?range=1d`)).json());
    const t = await sum(team);
    expect(t.funnel?.claudeCost).not.toBeNull();
    expect(t.sources.length).toBeGreaterThan(0);
    const s = await sum(tester);
    expect(s.funnel).not.toBeNull();
    expect(s.funnel?.claudeCost).toBeNull();
    expect(s.funnel?.claudeCostPerDay).toBeNull();
    expect(s.sources).toEqual(t.sources);
    // Cùng số bài (phần còn lại giống hệt).
    expect(s.funnel?.articlesRead).toBe(t.funnel?.articlesRead);
    const feed = async (c: TestClient) =>
      researchArticlesPageSchema.parse(
        (await c.request("GET", `${base}/articles?range=1d&show=all`)).json(),
      );
    const tf = (await feed(team)).items.find((a) => a.id === "b1");
    const sf = (await feed(tester)).items.find((a) => a.id === "b1");
    expect(tf?.claude?.costUsd).not.toBeNull();
    expect(sf?.claude).toMatchObject({ calls: 1, costUsd: null, tokens: null });
    const trace = researchArticleTraceSchema.parse(
      (await tester.request("GET", `${base}/articles/b1/trace`)).json(),
    );
    expect(trace.article.claude?.costUsd).toBeNull();
    const score = trace.steps.find((x) => x.key === "score");
    expect(score?.key === "score" ? (score.detail?.claude?.costUsd ?? null) : "missing").toBeNull();
  });
});

describe("My versions (#423)", () => {
  let mine: string;

  it("a tester saves a version they own; the team list and versions tried do not change", async () => {
    const before = await versions(team);
    const r = await create(tester, "BTC only", true, baselineId);
    expect(r.statusCode).toBe(201);
    const v = researchVersionCreatedSchema.parse(r.json());
    expect(v.owner).toBe("me");
    mine = v.id;
    const owner = await env.pool.query<{ o: string | null }>(
      "select owner_user_id as o from signal_bot_versions where id = $1",
      [mine],
    );
    expect(owner.rows[0]?.o).toBe(testerId);
    const after = await versions(team);
    expect(after.items.some((x) => x.id === mine)).toBe(false);
    expect(after.versionsTried).toBe(before.versionsTried);
    expect(after.running).toBe(before.running);
    const own = await versions(tester);
    expect(own.items.find((x) => x.id === mine)?.owner).toBe("me");
    expect(own.items.find((x) => x.id === baselineId)?.owner).toBe("team");
    // Người dùng test: Baseline + version của họ; đang chạy = chỉ của họ.
    expect(own.versionsTried).toBe(2);
    expect(own.running).toBe(1);
  });

  it("other people get 404 for a tester's version (reads, status, saving from it); the team too", async () => {
    for (const c of [tester2, team]) {
      for (const path of [
        `/summary?versionId=${mine}`,
        `/trades?versionId=${mine}`,
        `/articles?versionId=${mine}`,
        `/articles/new?versionId=${mine}`,
        `/articles/b1/trace?versionId=${mine}`,
      ])
        expect((await c.request("GET", `${base}${path}`)).statusCode, path).toBe(404);
      expect((await setStatus(c, mine, "paused")).statusCode).toBe(404);
      const from = await create(c, "Copy", false, mine);
      expect(from.statusCode).toBe(400);
      expect(errOf(from).details).toMatchObject({
        fieldErrors: { savedFromVersionId: ["not_found"] },
      });
    }
    expect((await versions(tester2)).items.some((x) => x.id === mine)).toBe(false);
    expect((await tester.request("GET", `${base}/summary?versionId=${mine}`)).statusCode).toBe(200);
  });

  it("a trade of a tester's version is 404 for others", async () => {
    const id = randomUUID();
    const story = randomUUID();
    await env.pool.query(
      `insert into signal_stories (id, story_key, market, catalyst, direction, first_article_id, first_seen_at, sources, level_at_entry,
         later_level, outcome, locked, rule_version, version_id)
       values ($1, 'ETH-USD|etf_approved', 'ETH-USD', 'etf_approved', 'long', 'b1', $2,
         '[{"name":"Reuters","tier":"top","articleId":"b1","at":"x"}]', 'medium', 'medium', 'entered', true, 'news-v7', $3)`,
      [story, ago(30), mine],
    );
    await env.pool.query(
      `insert into signal_paper_trades (id, lane, label, version_id, story_id, article_id, market, token, catalyst, direction, size_usdc, qty,
         entry_price, entry_mid, spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until,
         event_at, seen_at, opened_at, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, rule_version,
         classifier_version)
       values ($1, 'news', 'live', $2, $5, 'b1', 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 0.15, 3400, 3400, 0.01, 0.05, 0.25, 1, 1.6,
         0.8, 3454, 3372, $3::timestamptz + interval '3 days', $3, $3, $3, 'medium', '[]', false, 'book', 'open', 'news-v7', $4)`,
      [id, mine, ago(30), CURRENT, story],
    );
    expect((await tester.request("GET", `${base}/trades/${id}`)).statusCode).toBe(200);
    expect((await tester2.request("GET", `${base}/trades/${id}`)).statusCode).toBe(404);
    expect((await team.request("GET", `${base}/trades/${id}`)).statusCode).toBe(404);
    await env.pool.query("delete from signal_paper_trades where id = $1", [id]);
    await env.pool.query("delete from signal_stories where id = $1", [story]);
  });

  it("team versions are view only for a tester (403), still copyable into My versions", async () => {
    const r = await setStatus(tester, baselineId, "paused");
    expect(r.statusCode).toBe(403);
    expect(errOf(r).details).toMatchObject({ reason: "TEAM_VERSION_VIEW_ONLY" });
    const status = await env.pool.query<{ s: string }>(
      "select status as s from signal_bot_versions where id = $1",
      [baselineId],
    );
    expect(status.rows[0]?.s).toBe("running");
    expect((await setStatus(tester, mine, "paused")).statusCode).toBe(200);
    expect((await setStatus(tester, mine, "running")).statusCode).toBe(200);
  });

  it("3 running versions per owner: the team's 3 never block a tester, and a tester's 4th is refused", async () => {
    // Team: Baseline + 2 = 3 đang chạy.
    for (const n of ["T2", "T3"]) expect((await create(team, n, true)).statusCode).toBe(201);
    expect((await versions(team)).running).toBe(3);
    const teamFull = await create(team, "T4", true);
    expect(teamFull.statusCode).toBe(409);
    // Tester đã có 1 → thêm 2 nữa vẫn được dù team đủ 3.
    for (const n of ["Mine 2", "Mine 3"])
      expect((await create(tester, n, true)).statusCode).toBe(201);
    const full = await create(tester, "Mine 4", true);
    expect(full.statusCode).toBe(409);
    expect(errOf(full).details).toMatchObject({ reason: "MAX_RUNNING_VERSIONS" });
    // Tester khác có trần riêng.
    expect((await create(tester2, "Other 1", true)).statusCode).toBe(201);
    // Trigger DB cũng đếm theo chủ khi đi vòng qua service.
    const paused = await create(tester, "Mine paused", false);
    const pausedId = researchVersionCreatedSchema.parse(paused.json()).id;
    await expect(
      env.pool.query("update signal_bot_versions set status = 'running' where id = $1", [pausedId]),
    ).rejects.toThrow(/per owner/);
    await expect(
      env.pool.query("update signal_bot_versions set owner_user_id = null where id = $1", [
        pausedId,
      ]),
    ).rejects.toThrow(/immutable/);
    expect((await versions(tester)).running).toBe(3);
    expect((await versions(team)).running).toBe(3);
  });
});

describe("labels from testers (#423)", () => {
  it("tester labels are saved as tester, never count toward the gate, and show separately with agreement", async () => {
    const gateOf = async () =>
      researchClassifiersSchema
        .parse((await team.request("GET", `${base}/classifiers`)).json())
        .items.find((x) => x.classifierVersion === CURRENT);
    const before = await gateOf();
    expect(before?.labeled).toBe(0);
    // Tester gắn nhãn ngẫu nhiên (random) cho mọi bài còn lại: Right.
    for (;;) {
      const n = researchLabelNextSchema.parse(
        (await tester.request("GET", `${base}/labels/next`)).json(),
      );
      if (n.item === null) break;
      // Không có chi phí Claude cho người dùng test.
      expect(n.item.classification.claude?.costUsd ?? null).toBeNull();
      const r = await tester.request("PUT", `${base}/articles/${n.item.article.id}/label`, {
        body: { verdict: "right", labelToken: n.labelToken },
        idempotencyKey: randomUUID(),
      });
      expect(r.statusCode).toBe(200);
    }
    const rows = await env.pool.query<{ labeler: string; source: string }>(
      "select labeler, source from signal_classification_labels where labeled_by = $1",
      [testerId],
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.every((x) => x.labeler === "tester" && x.source === "random")).toBe(true);
    const mid = await gateOf();
    expect(mid?.labeled).toBe(0);
    expect(mid?.precisionPct).toBeNull();
    expect(mid?.testers).toEqual({ labeled: 3, compared: 0, agree: 0, agreePct: null });
    // Team gắn b1 Right, b2 Wrong từ trace (không token): không tính cổng, cũng không dùng để đối chiếu.
    for (const [id, verdict] of [
      ["b1", "right"],
      ["b2", "wrong"],
    ] as const) {
      const r = await team.request("PUT", `${base}/articles/${id}/label`, {
        body: verdict === "right" ? { verdict } : { verdict, reason: "other" },
        idempotencyKey: randomUUID(),
      });
      expect(r.statusCode).toBe(200);
    }
    const traced = await gateOf();
    expect(traced?.labeled).toBe(0);
    expect(traced?.traceLabeled).toBe(2);
    expect(traced?.testers).toEqual({ labeled: 3, compared: 0, agree: 0, agreePct: null });
    // Team gắn b3 qua labels/next (random) Right: vào cổng và là bài duy nhất được đối chiếu với tester.
    const n = researchLabelNextSchema.parse(
      (await team.request("GET", `${base}/labels/next`)).json(),
    );
    expect(n.item?.article.id).toBe("b3");
    const r3 = await team.request("PUT", `${base}/articles/b3/label`, {
      body: { verdict: "right", labelToken: n.labelToken },
      idempotencyKey: randomUUID(),
    });
    expect(r3.statusCode).toBe(200);
    const after = await gateOf();
    expect(after?.labeled).toBe(1);
    expect(after?.traceLabeled).toBe(2);
    expect(after?.testers).toEqual({ labeled: 3, compared: 1, agree: 1, agreePct: 100 });
    expect(after?.mostCommonMistakes).toEqual([{ reason: "other", n: 1 }]);
  });

  it("flag off: blocks the tester at once and pauses their running versions with an audit; flag on: no auto resume", async () => {
    const path = `/api/v1/admin/users/${tester2Id}/signal-research`;
    const ownRunning = async () =>
      (
        await env.pool.query<{ id: string; status: string }>(
          "select id, status from signal_bot_versions where owner_user_id = $1 order by number",
          [tester2Id],
        )
      ).rows;
    const before = await ownRunning();
    expect(before.map((v) => v.status)).toEqual(["running"]);
    const off = await team.request("POST", path, { body: { enabled: false } });
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ signalResearch: false, paused: 1 });
    expect((await tester2.request("GET", `${base}/summary`)).statusCode).toBe(403);
    expect((await ownRunning()).map((v) => v.status)).toEqual(["paused"]);
    const audit = await env.pool.query<{ user_id: string; metadata: Record<string, unknown> }>(
      "select user_id, metadata from audit_log where action = 'signal_research.version_status' and target = $1",
      [before[0]?.id],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.user_id).toBe(teamId);
    expect(audit.rows[0]?.metadata).toMatchObject({
      from: "running",
      to: "paused",
      reason: "signal_research_disabled",
      by: "flag_off",
    });
    // Version của người khác (tester, team) không bị đụng.
    const others = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from signal_bot_versions where status = 'running' and (owner_user_id is null or owner_user_id = $1)",
      [testerId],
    );
    expect(others.rows[0]?.n).toBe(6);
    // Bật lại: vào được, nhưng version vẫn paused tới khi chủ tự Resume.
    const on = await team.request("POST", path, { body: { enabled: true } });
    expect(on.json()).toEqual({ signalResearch: true, paused: 0 });
    expect((await tester2.request("GET", `${base}/summary`)).statusCode).toBe(200);
    expect((await ownRunning()).map((v) => v.status)).toEqual(["paused"]);
    expect((await setStatus(tester2, before[0]?.id ?? "", "running")).statusCode).toBe(200);
    expect((await ownRunning()).map((v) => v.status)).toEqual(["running"]);
  });
});
