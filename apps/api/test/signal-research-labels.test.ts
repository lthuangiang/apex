import { randomUUID } from "node:crypto";

import {
  errorResponseSchema,
  LABEL_TOKEN_TTL_MIN,
  meSchema,
  NEWS_CLASSIFIER,
  researchArticlesPageSchema,
  researchArticleTraceSchema,
  researchClassifiersSchema,
  researchLabelNextSchema,
  researchLabelSavedSchema,
  researchSummarySchema,
  researchTradesPageSchema,
  wilsonInterval,
} from "@drift/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { signIn, startTestEnv, TestClient, type TestEnv } from "./helpers";

// Nhãn phân loại và cổng precision của classifier (#304, DEC-328 mục 2). Dữ liệu bài / event / lệnh do scheduler ghi; ở
// đây chèn thẳng. Classifier hiện tại = NEWS_CLASSIFIER.promptVersion.

let env: TestEnv;
let team: TestClient;
let team2: TestClient;
let user: TestClient;
let teamId: string;
let team2Id: string;
const base = "/api/v1/admin/signal-research";
const CURRENT = NEWS_CLASSIFIER.promptVersion;
const storyId = randomUUID();
const s1Trade = randomUUID();

const ago = (min: number) => new Date(env.clock.now.getTime() - min * 60_000).toISOString();
const cls = {
  catalyst: "etf_approved",
  market: "ETH-USD",
  relevance: "direct",
  promotional: false,
  eventDate: "2026-10-27",
};

async function article(
  id: string,
  o: { promptVersion: string | null; classification: object; min?: number },
) {
  await env.pool.query(
    `insert into signal_articles (id, source, url, title, content, published_at, collected_at, matched_currencies, candidates, content_hash,
       status, classification, claude_calls, claude_input_tokens, claude_cache_write_tokens, claude_cache_read_tokens, claude_output_tokens,
       claude_model, claude_prompt_version, rule_version)
     values ($1, 'Reuters', $2, $3, $4, $5, $5, '[{"symbol":"ETH","name":"Ethereum"}]', '[{"symbol":"ETH","market":"ETH-USD","kind":"crypto"}]',
       $6, 'classified', $7, 1, 500, 0, 4000, 100, $8, $9, 'news-v3')`,
    [
      id,
      `https://example.test/${id}`,
      `Title ${id}`,
      `Body of ${id}`,
      ago(o.min ?? 60),
      `hash-${id}`,
      JSON.stringify(o.classification),
      o.promptVersion === null ? null : NEWS_CLASSIFIER.model,
      o.promptVersion,
    ],
  );
}

async function event(
  articleId: string,
  stage: string,
  outcome: string,
  extra: { reason?: string; detail?: object; storyId?: string; tradeId?: string } = {},
) {
  await env.pool.query(
    `insert into signal_events (id, article_id, story_id, trade_id, stage, outcome, reason, detail, rule_version, at)
     values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, 'news-v3', $8)`,
    [
      articleId,
      extra.storyId ?? null,
      extra.tradeId ?? null,
      stage,
      outcome,
      extra.reason ?? null,
      extra.detail === undefined ? null : JSON.stringify(extra.detail),
      ago(59),
    ],
  );
}

/** Bài qua Score (event Understand `pass`). */
async function signal(id: string, promptVersion: string | null = CURRENT) {
  await article(id, { promptVersion, classification: cls });
  await event(id, "collect", "pass");
  await event(id, "normalize", "pass");
  await event(id, "understand", "pass", {
    detail: { market: "ETH-USD", catalyst: "etf_approved", direction: "long", maxHoldHours: 72 },
  });
}

async function trade(id: string, o: { articleId: string; classifier: string | null; pct: number }) {
  await env.pool.query(
    `insert into signal_paper_trades (id, lane, story_id, article_id, market, token, catalyst, direction, size_usdc, qty, entry_price, entry_mid,
       spread_at_entry_pct, fee_pct, entry_fee, typical_move_pct, tp_pct, sl_pct, tp_price, sl_price, max_hold_until, event_at, seen_at, opened_at,
       moved_before_entry_pct, level_at_entry, sources_at_entry, outside_market_hours, price_source, status, exit_price, exit_reason, exited_at,
       exit_fee, result_usdc, result_pct, rule_version, classifier_version)
     values ($1, 'news', $2, $3, 'ETH-USD', 'ETH', 'etf_approved', 'long', 500, 0.15, 3400, 3400, 0.01, 0.05, 0.25, 1,
       1.6, 0.8, 3454, 3372, $4, $5, $5, $5, 0.1, 'medium', '[{"name":"Reuters","tier":"top"}]', false, 'book', 'closed', 3450,
       'take_profit', $6, 0.25, $7, $8, 'news-v3', $9)`,
    [
      id,
      storyId,
      o.articleId,
      ago(-72 * 60),
      ago(60),
      ago(10),
      String(o.pct * 5),
      String(o.pct),
      o.classifier,
    ],
  );
}

/**
 * Nhãn chèn thẳng cho một classifier giả: `right` bài Right, còn lại Wrong (lý do `other`). Mặc định `random` (#348: chỉ
 * nhãn random tính cổng).
 */
async function bulkLabels(
  version: string,
  right: number,
  total: number,
  source: "random" | "trace" = "random",
) {
  await env.pool.query(
    `insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict, reason, source)
     select gen_random_uuid(), $1 || '-' || g, $1, $2,
       case when g <= $3 then 'right' else 'wrong' end, case when g <= $3 then null else 'other' end, $5
     from generate_series(1, $4::int) g`,
    [version, teamId, right, total, source],
  );
}

const next = async (c: TestClient) =>
  researchLabelNextSchema.parse((await c.request("GET", `${base}/labels/next`)).json());

const put = (c: TestClient, id: string, body: unknown, key?: string) =>
  c.request("PUT", `${base}/articles/${id}/label`, {
    body,
    ...(key === undefined ? {} : { idempotencyKey: key }),
  });

beforeAll(async () => {
  env = await startTestEnv();
  team = new TestClient(env.app);
  teamId = meSchema.parse((await signIn(env, team, `lb-${randomUUID()}@drift.test`)).json()).id;
  team2 = new TestClient(env.app);
  team2Id = meSchema.parse((await signIn(env, team2, `lb2-${randomUUID()}@drift.test`)).json()).id;
  await env.pool.query("update users set role = 'team' where id = any($1)", [[teamId, team2Id]]);
  user = new TestClient(env.app);
  await signIn(env, user, `lb-user-${randomUUID()}@drift.test`);

  await env.pool.query(
    `insert into signal_stories (id, story_key, market, catalyst, direction, first_article_id, first_seen_at, sources, level_at_entry, later_level,
       outcome, locked, rule_version)
     values ($1, 'ETH-USD|etf_approved', 'ETH-USD', 'etf_approved', 'long', 's1', $2, '[{"name":"Reuters","tier":"top","articleId":"s1","at":"x"}]',
       'medium', 'medium', 'entered', true, 'news-v3')`,
    [storyId, ago(60)],
  );
  // Ba tín hiệu của classifier hiện tại; s1 đã mở một lệnh (đã đóng, kết quả +1.2%).
  for (const id of ["s1", "s2", "s3"]) await signal(id);
  await event("s1", "filter", "pass", { storyId, detail: { level: "medium" } });
  await event("s1", "decide", "open", { storyId, tradeId: s1Trade });
  await trade(s1Trade, { articleId: "s1", classifier: CURRENT, pct: 1.2 });
  // Không phải tín hiệu: Claude trả "none"; có loại tin nhưng bị loại ở Score; tín hiệu của classifier cũ.
  await article("n-none", { promptVersion: CURRENT, classification: { ...cls, catalyst: "none" } });
  await event("n-none", "understand", "drop", { reason: "NOT_A_SIGNAL_TYPE" });
  await article("n-drop", { promptVersion: CURRENT, classification: cls });
  await event("n-drop", "understand", "drop", { reason: "PASSING_MENTION" });
  await signal("old-1", "news-classifier-v1");
});

afterAll(async () => {
  await env.close();
});

describe("classification labels (#304)", () => {
  it("401 signed out, 403 for non-team users, role checked before the body and Idempotency-Key", async () => {
    const anon = new TestClient(env.app);
    for (const r of [`${base}/labels/next`, `${base}/classifiers`]) {
      expect((await anon.request("GET", r)).statusCode).toBe(401);
      expect((await user.request("GET", r)).statusCode).toBe(403);
    }
    expect((await put(anon, "s1", { verdict: "right" })).statusCode).toBe(401);
    expect((await put(user, "s1", { verdict: "right" })).statusCode).toBe(403);
    expect((await put(user, "s1", { verdict: "nope" })).statusCode).toBe(403);
    const noKey = await user.request("PUT", `${base}/articles/s1/label`, {
      body: { verdict: "right" },
      idempotencyKey: false,
    });
    expect(noKey.statusCode).toBe(403);
    const n = await env.pool.query("select count(*)::int as n from signal_classification_labels");
    expect(n.rows[0]).toEqual({ n: 0 });
  });

  it("labels/next picks only current-classifier signals and never sends a trade result", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i += 1) {
      const r = await team.request("GET", `${base}/labels/next`);
      expect(r.statusCode).toBe(200);
      expect(r.headers["cache-control"]).toBe("no-store");
      const raw = r.json<Record<string, unknown>>();
      const next = researchLabelNextSchema.parse(raw);
      expect(next.remaining).toBe(3);
      if (next.item !== null) seen.add(next.item.article.id);
      // Không có trường kết quả nào (kể cả null): chỉ đúng các khoá này.
      expect(Object.keys(raw).sort()).toEqual(["item", "labelToken", "remaining"]);
      expect(next.labelToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const item = raw.item as Record<string, Record<string, unknown>>;
      expect(Object.keys(item).sort()).toEqual(["article", "classification"]);
      expect(Object.keys(item.article ?? {}).sort()).toEqual(
        ["content", "id", "publishedAt", "source", "tagged", "tier", "title", "url"].sort(),
      );
      expect(Object.keys(item.classification ?? {}).sort()).toEqual(
        [
          "asset",
          "claude",
          "classifierVersion",
          "eventDate",
          "newsType",
          "promotional",
          "relevance",
        ].sort(),
      );
      // labelToken là chuỗi ngẫu nhiên (base64url) nên có thể tình cờ chứa "pnl" / "level"…; định dạng và tập khoá đã kiểm ở trên, nên chỉ dò trên phần còn lại.
      const rest = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "labelToken"));
      expect(JSON.stringify(rest)).not.toMatch(/trade|result|outcome|stage|level|pnl/i);
    }
    // 30 lần ngẫu nhiên trên 3 bài: gần như chắc chắn thấy đủ (xác suất trượt ≈ 3 × (2/3)^30 < 1e-5).
    expect([...seen].sort()).toEqual(["s1", "s2", "s3"]);
  });

  it("validates the body: Wrong needs a reason, Right has none, note is capped, Idempotency-Key required", async () => {
    for (const body of [
      { verdict: "wrong" },
      { verdict: "wrong", reason: null },
      { verdict: "right", reason: "other" },
      { verdict: "wrong", reason: "made_up" },
      { verdict: "right", note: "x".repeat(501) },
      { verdict: "right", extra: true },
    ]) {
      const r = await put(team, "s1", body);
      expect(r.statusCode).toBe(400);
      expect(errorResponseSchema.parse(r.json()).error.code).toBe("VALIDATION_FAILED");
    }
    const noKey = await team.request("PUT", `${base}/articles/s1/label`, {
      body: { verdict: "right" },
      idempotencyKey: false,
    });
    expect(noKey.statusCode).toBe(400);
    expect((await put(team, "missing", { verdict: "right" })).statusCode).toBe(404);
    for (const id of ["n-none", "n-drop"]) {
      const r = await put(team, id, { verdict: "right" });
      expect(r.statusCode).toBe(409);
      expect(errorResponseSchema.parse(r.json()).error.details).toMatchObject({
        reason: "NOT_A_SIGNAL",
      });
    }
  });

  it("saves, replays the same key, updates in place (one label per person per article) and audits each save", async () => {
    const key = randomUUID();
    const first = await put(team, "s1", { verdict: "right", note: "  looks fine  " }, key);
    expect(first.statusCode).toBe(200);
    const saved = researchLabelSavedSchema.parse(first.json());
    expect(saved.label).toMatchObject({
      classifierVersion: CURRENT,
      verdict: "right",
      reason: null,
      note: "looks fine",
      // #306: chỉ 4 ký tự hex cuối id người gắn ("··a91f"), không lộ id đầy đủ.
      labeledBy: teamId.replace(/-/g, "").slice(-4),
      // #348: không có token của labels/next → trace.
      source: "trace",
    });
    expect(JSON.stringify(first.json())).not.toContain(teamId);
    // Sau khi lưu mới có kết quả lệnh.
    expect(saved.trades).toEqual([
      expect.objectContaining({
        tradeId: s1Trade,
        status: "closed",
        outcome: "tp",
        resultPct: 1.2,
        resultUsdc: "6",
      }),
    ]);
    const replay = await put(team, "s1", { verdict: "right", note: "  looks fine  " }, key);
    expect(replay.headers["idempotent-replayed"]).toBe("true");
    expect(replay.json()).toEqual(first.json());

    const upd = await put(team, "s1", { verdict: "wrong", reason: "wrong_asset" });
    expect(upd.statusCode).toBe(200);
    expect(researchLabelSavedSchema.parse(upd.json()).label).toMatchObject({
      verdict: "wrong",
      reason: "wrong_asset",
      note: null,
    });
    const rows = await env.pool.query(
      "select verdict, reason from signal_classification_labels where article_id = 's1'",
    );
    expect(rows.rows).toEqual([{ verdict: "wrong", reason: "wrong_asset" }]);
    const audit = await env.pool.query(
      `select user_id, metadata from audit_log where action = 'signal_research.label_saved' and target = 's1' order by occurred_at, id`,
    );
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows[1]).toMatchObject({
      user_id: teamId,
      metadata: {
        verdict: "wrong",
        reason: "wrong_asset",
        hasNote: false,
        source: "trace",
        tokenRejected: false,
        previous: { verdict: "right", reason: null, source: "trace" },
      },
    });
    expect(JSON.stringify(audit.rows)).not.toContain("looks fine");
  });

  it("labels/next skips what the caller labelled (others still get it), then runs out", async () => {
    await put(team, "s2", { verdict: "right" });
    for (let i = 0; i < 5; i += 1) {
      const n = researchLabelNextSchema.parse(
        (await team.request("GET", `${base}/labels/next`)).json(),
      );
      expect(n).toMatchObject({ remaining: 1, item: { article: { id: "s3" } } });
    }
    const other = researchLabelNextSchema.parse(
      (await team2.request("GET", `${base}/labels/next`)).json(),
    );
    expect(other.remaining).toBe(3);
    await put(team, "s3", { verdict: "right" });
    expect(
      researchLabelNextSchema.parse((await team.request("GET", `${base}/labels/next`)).json()),
    ).toEqual({ item: null, remaining: 0, labelToken: null });
  });

  it("an older classifier's signal can be labelled from the trace, under that classifier", async () => {
    const r = await put(team, "old-1", { verdict: "wrong", reason: "person_not_company" });
    expect(researchLabelSavedSchema.parse(r.json()).label.classifierVersion).toBe(
      "news-classifier-v1",
    );
  });

  it("trace shows the caller's own label on the Score card, and whether the article can be labelled", async () => {
    const score = async (c: TestClient, id: string) => {
      const t = researchArticleTraceSchema.parse(
        (await c.request("GET", `${base}/articles/${id}/trace`)).json(),
      );
      const s = t.steps.find((x) => x.key === "score");
      return s?.key === "score" ? s.detail : null;
    };
    expect(await score(team, "s1")).toMatchObject({
      labelable: true,
      label: {
        verdict: "wrong",
        reason: "wrong_asset",
        labeledBy: teamId.replace(/-/g, "").slice(-4),
      },
    });
    expect(await score(team2, "s1")).toMatchObject({ labelable: true, label: null });
    expect(await score(team, "n-none")).toMatchObject({ labelable: false, label: null });
  });

  it("precision per classifier counts random labels only; mistakes count random and trace labels", async () => {
    // team đã gắn s1 Wrong, s2 Right, s3 Right từ trace (không token) → không tính. team2 gắn ngẫu nhiên qua labels/next:
    // s2 Wrong, s1 / s3 Right → 2 / 3.
    const verdicts: Record<string, object> = {
      s1: { verdict: "right" },
      s2: { verdict: "wrong", reason: "person_not_company" },
      s3: { verdict: "right" },
    };
    for (let i = 0; i < 3; i += 1) {
      const n = await next(team2);
      const id = n.item?.article.id ?? "";
      const r = await put(team2, id, { ...verdicts[id], labelToken: n.labelToken });
      expect(researchLabelSavedSchema.parse(r.json()).label.source).toBe("random");
    }
    expect(await next(team2)).toEqual({ item: null, remaining: 0, labelToken: null });
    const c = researchClassifiersSchema.parse(
      (await team.request("GET", `${base}/classifiers`)).json(),
    );
    expect(c.gate).toEqual({ minLabels: 50, minPrecisionPct: 80 });
    expect(c.items[0]).toMatchObject({
      classifierVersion: CURRENT,
      current: true,
      signals: 3,
      labeled: 3,
      right: 2,
      traceLabeled: 3,
      precisionPct: 66.67,
      interval: wilsonInterval(2, 3),
      passes: false,
      status: "underPrecision",
      labelsToGo: 47,
      // person_not_company từ nhãn random của team2, wrong_asset từ nhãn trace của team.
      mostCommonMistakes: [
        { reason: "person_not_company", n: 1 },
        { reason: "wrong_asset", n: 1 },
      ],
    });
    // Classifier cũ chỉ có nhãn trace: không có precision, hiện riêng "from traces".
    expect(c.items.find((x) => x.classifierVersion === "news-classifier-v1")).toMatchObject({
      current: false,
      signals: 1,
      labeled: 0,
      right: 0,
      traceLabeled: 1,
      precisionPct: null,
      interval: null,
      status: "needsLabels",
      mostCommonMistakes: [{ reason: "person_not_company", n: 1 }],
    });
  });

  it("per-article majority among random labels, a tie counts as wrong", async () => {
    await env.pool.query(
      `insert into signal_classification_labels (id, article_id, classifier_version, labeled_by, verdict, reason, source)
       values (gen_random_uuid(), 'tie-1', 'cls-tie', $1, 'right', null, 'random'),
              (gen_random_uuid(), 'tie-1', 'cls-tie', $2, 'wrong', 'other', 'random'),
              (gen_random_uuid(), 'tie-2', 'cls-tie', $1, 'right', null, 'random'),
              (gen_random_uuid(), 'tie-2', 'cls-tie', $2, 'wrong', 'other', 'trace')`,
      [teamId, team2Id],
    );
    const c = researchClassifiersSchema.parse(
      (await team.request("GET", `${base}/classifiers`)).json(),
    );
    // tie-1: hoà → Wrong; tie-2: chỉ nhãn random Right được tính → Right.
    expect(c.items.find((x) => x.classifierVersion === "cls-tie")).toMatchObject({
      labeled: 2,
      right: 1,
      traceLabeled: 1,
      mostCommonMistakes: [{ reason: "other", n: 2 }],
    });
  });

  it("gate edges: 49 vs 50 labels, 78% (39 / 50) vs 80% (40 / 50); trace labels never fill the gate", async () => {
    await bulkLabels("cls-trace", 50, 50, "trace");
    await bulkLabels("cls-49", 49, 49);
    await bulkLabels("cls-50", 50, 50);
    await bulkLabels("cls-39", 39, 50);
    await bulkLabels("cls-40", 40, 50);
    const c = researchClassifiersSchema.parse(
      (await team.request("GET", `${base}/classifiers`)).json(),
    );
    const of = (v: string) => c.items.find((x) => x.classifierVersion === v);
    expect(of("cls-49")).toMatchObject({ passes: false, status: "needsLabels", labelsToGo: 1 });
    expect(of("cls-50")).toMatchObject({ passes: true, status: "passed", labelsToGo: 0 });
    expect(of("cls-39")).toMatchObject({
      passes: false,
      status: "underPrecision",
      precisionPct: 78,
    });
    expect(of("cls-40")).toMatchObject({
      passes: true,
      precisionPct: 80,
      interval: { lo: 66.96, hi: 88.76 },
    });
    expect(of("cls-trace")).toMatchObject({
      labeled: 0,
      traceLabeled: 50,
      passes: false,
      status: "needsLabels",
      labelsToGo: 50,
    });
  });

  it("the gate only counts trades whose classifier passed; the rest are listed as not counted", async () => {
    await signal("p-1", "cls-50");
    await signal("f-1", "cls-39");
    const tPass = randomUUID();
    const tFail = randomUUID();
    await trade(tPass, { articleId: "p-1", classifier: "cls-50", pct: 2 });
    await trade(tFail, { articleId: "f-1", classifier: "cls-39", pct: -1 });
    const s = researchSummarySchema.parse((await team.request("GET", `${base}/summary`)).json());
    const row = s.rows[0];
    expect(row).toMatchObject({ closed: 3, avgPct: 2, needs: { kind: "pooled", more: 99 } });
    expect(row?.classifiers?.counted).toBe(1);
    expect(row?.classifiers?.notCounted).toEqual(
      expect.arrayContaining([
        {
          classifierVersion: "cls-39",
          closed: 1,
          status: "underPrecision",
          labeled: 50,
          precisionPct: 78,
          labelsToGo: 0,
        },
        {
          classifierVersion: CURRENT,
          closed: 1,
          status: "underPrecision",
          labeled: 3,
          precisionPct: 66.67,
          labelsToGo: 47,
        },
      ]),
    );
    expect(row?.classifiers?.notCounted).toHaveLength(2);
    expect(s.directions.find((d) => d.side === "long")).toMatchObject({ closed: 1, avgPct: 2 });
    expect(s.levels.find((l) => l.level === "medium")).toMatchObject({ trades: 3, closed: 1 });
    // Số dư / kết quả theo loại vẫn tính mọi lệnh.
    expect(s.funnel?.outcomes.closed).toBe(3);

    const page = researchTradesPageSchema.parse(
      (await team.request("GET", `${base}/trades?limit=10`)).json(),
    );
    const byId = new Map(page.items.map((t) => [t.id, t.classifier]));
    expect(byId.get(tPass)).toEqual({ version: "cls-50", status: "passed" });
    expect(byId.get(tFail)).toEqual({ version: "cls-39", status: "underPrecision" });
    expect(byId.get(s1Trade)).toEqual({ version: CURRENT, status: "underPrecision" });
  });
});

describe("label source: only a served labels/next token makes a label random (#348)", () => {
  let team3: TestClient;
  let team4: TestClient;
  let team3Id: string;
  let leaked = { article: "", token: "" };

  beforeAll(async () => {
    team3 = new TestClient(env.app);
    team3Id = meSchema.parse(
      (await signIn(env, team3, `lb3-${randomUUID()}@drift.test`)).json(),
    ).id;
    team4 = new TestClient(env.app);
    const team4Id = meSchema.parse(
      (await signIn(env, team4, `lb4-${randomUUID()}@drift.test`)).json(),
    ).id;
    await env.pool.query("update users set role = 'team' where id = any($1)", [[team3Id, team4Id]]);
  });

  const sourceOf = async (articleId: string, userId: string) =>
    (
      await env.pool.query<{ source: string }>(
        "select source from signal_classification_labels where article_id = $1 and labeled_by = $2",
        [articleId, userId],
      )
    ).rows[0]?.source;
  const usedAt = async (token: string) =>
    (
      await env.pool.query<{ used_at: Date | null }>(
        "select used_at from signal_label_tokens where token_hash = encode(sha256(convert_to($1, 'UTF8')), 'hex')",
        [token],
      )
    ).rows[0]?.used_at;
  const saved = (r: { json: () => unknown }) => researchLabelSavedSchema.parse(r.json()).label;

  it("stores only the token hash; a forged token or a token for another article saves as trace", async () => {
    const n1 = await next(team3);
    const a = n1.item?.article.id ?? "";
    const t1 = n1.labelToken ?? "";
    leaked = { article: a, token: t1 };
    const raw = await env.pool.query("select * from signal_label_tokens");
    expect(JSON.stringify(raw.rows)).not.toContain(t1);

    // Token giả đúng định dạng: vẫn lưu, nhưng là trace; audit ghi tokenRejected.
    const forged = await put(team3, a, { verdict: "right", labelToken: "A".repeat(43) });
    expect(forged.statusCode).toBe(200);
    expect(saved(forged).source).toBe("trace");
    // Bài đã có nhãn thì token thật cũng không "nâng" lên random, và token không bị tiêu.
    const late = await put(team3, a, { verdict: "right", note: "again", labelToken: t1 });
    expect(saved(late).source).toBe("trace");
    expect(await usedAt(t1)).toBeNull();
    const audit = await env.pool.query<{ metadata: Record<string, unknown> }>(
      `select metadata from audit_log where action = 'signal_research.label_saved' and target = $1 and user_id = $2
       order by occurred_at, id`,
      [a, team3Id],
    );
    expect(audit.rows.map((r) => [r.metadata.source, r.metadata.tokenRejected])).toEqual([
      ["trace", true],
      ["trace", true],
    ]);

    // Token của bài B dùng cho bài C → trace, token vẫn còn; dùng đúng bài B → random.
    const n2 = await next(team3);
    const b = n2.item?.article.id ?? "";
    const t2 = n2.labelToken ?? "";
    const c = ["s1", "s2", "s3"].find((x) => x !== a && x !== b) ?? "";
    expect(saved(await put(team3, c, { verdict: "right", labelToken: t2 })).source).toBe("trace");
    expect(await usedAt(t2)).toBeNull();
    expect(saved(await put(team3, b, { verdict: "right", labelToken: t2 })).source).toBe("random");
    expect(await usedAt(t2)).not.toBeNull();

    // Sửa ghi chú, giữ Right → vẫn random; đổi sang Wrong (có thể đã thấy kết quả lệnh) → trace, và không quay lại random.
    expect(saved(await put(team3, b, { verdict: "right", note: "typo fix" })).source).toBe(
      "random",
    );
    expect(
      saved(await put(team3, b, { verdict: "wrong", reason: "other", labelToken: t2 })).source,
    ).toBe("trace");
    expect(saved(await put(team3, b, { verdict: "right" })).source).toBe("trace");
    expect(await sourceOf(b, team3Id)).toBe("trace");
  });

  it("a token only works for the user it was issued to, and only until it expires", async () => {
    // Token còn hạn, chưa dùng của team3 cho bài a (test trước) do team4 gửi (team4 chưa gắn bài a) → trace, không tiêu.
    expect(
      saved(await put(team4, leaked.article, { verdict: "right", labelToken: leaked.token }))
        .source,
    ).toBe("trace");
    expect(await usedAt(leaked.token)).toBeNull();
    expect(await next(team3)).toEqual({ item: null, remaining: 0, labelToken: null });

    // Hết hạn (> LABEL_TOKEN_TTL_MIN phút) → trace, không tiêu.
    const n4 = await next(team4);
    const x = n4.item?.article.id ?? "";
    const t4 = n4.labelToken ?? "";
    const start = env.clock.now;
    env.clock.now = new Date(start.getTime() + (LABEL_TOKEN_TTL_MIN + 1) * 60_000);
    try {
      expect(saved(await put(team4, x, { verdict: "right", labelToken: t4 })).source).toBe("trace");
    } finally {
      env.clock.now = start;
    }
    expect(await usedAt(t4)).toBeNull();

    // Bài cuối, token còn hạn → random.
    const n5 = await next(team4);
    expect(n5.remaining).toBe(1);
    const y = n5.item?.article.id ?? "";
    expect(saved(await put(team4, y, { verdict: "right", labelToken: n5.labelToken })).source).toBe(
      "random",
    );
  });

  it("trace labels never move the gate: the current classifier still counts team2's 3 random labels", async () => {
    const c = researchClassifiersSchema.parse(
      (await team.request("GET", `${base}/classifiers`)).json(),
    );
    // Random: team2 s1 / s2 / s3 (2 Right) + team4 một bài (Right). Theo bài: s2 có hoà → Wrong, nên vẫn 2 / 3 Right.
    // Mọi nhãn trace (team, team3, team4) không đổi gì.
    const cur = c.items.find((r) => r.current);
    expect(cur).toMatchObject({ labeled: 3, right: 2, traceLabeled: 3, precisionPct: 66.67 });
    const random = await env.pool.query<{ n: number }>(
      "select count(*)::int as n from signal_classification_labels where source = 'random' and classifier_version = $1",
      [CURRENT],
    );
    expect(random.rows[0]?.n).toBe(4);
  });
});

describe("filter reason codes of News bot versions (#303) map to API reasons", () => {
  const CODES = {
    NEWS_TYPE_OFF: "newsTypeOff",
    ASSET_NOT_IN_VERSION: "assetNotInVersion",
    LEVEL_TOO_LOW: "levelTooLow",
    LIMIT_OPEN: "limitOpen",
    LIMIT_DAY: "limitDay",
    NO_BALANCE: "noBalance",
    OPPOSITE_NEWS: "oppositeNews",
  } as const;

  /** #304: giới hạn của version lưu trong detail (dòng mới); `r-old-*` là dòng cũ không có số. */
  const DETAIL: Partial<Record<keyof typeof CODES, object>> = {
    LIMIT_OPEN: { maxOpenTrades: 20, maxNewTradesPerDay: null },
    LIMIT_DAY: { maxOpenTrades: 20, maxNewTradesPerDay: 5 },
    // Mã khác không bao giờ có N, kể cả khi detail có giới hạn.
    NO_BALANCE: { maxOpenTrades: 20, maxNewTradesPerDay: 5 },
  };

  async function dropped(id: string, code: string, detail?: object) {
    // Không có version prompt → không phải tín hiệu gắn nhãn được, không ảnh hưởng các test nhãn.
    await article(id, { promptVersion: null, classification: cls, min: 30 });
    await event(id, "understand", "pass", { detail: { market: "ETH-USD" } });
    await event(id, "filter", "drop", {
      reason: code,
      storyId,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  beforeAll(async () => {
    for (const code of Object.keys(CODES) as (keyof typeof CODES)[])
      await dropped(`r-${code}`, code, DETAIL[code]);
    await dropped("r-old-LIMIT_OPEN", "LIMIT_OPEN");
    await dropped("r-old-LIMIT_DAY", "LIMIT_DAY", { maxOpenTrades: 20, maxNewTradesPerDay: 0 });
  });

  it("the article feed and the skipped-signal list show the mapped reason", async () => {
    const feed = researchArticlesPageSchema.parse(
      (await team.request("GET", `${base}/articles?show=dropped&limit=100`)).json(),
    );
    for (const [code, reason] of Object.entries(CODES))
      expect(feed.items.find((a) => a.id === `r-${code}`)).toMatchObject({
        stage: "filter",
        outcome: "dropped",
        reason,
      });
    const skipped = researchTradesPageSchema.parse(
      (await team.request("GET", `${base}/trades?show=skipped&limit=100`)).json(),
    );
    expect(skipped.items.map((t) => t.skipped?.reason).sort()).toEqual(
      [...Object.values(CODES), "limitDay", "limitOpen"].sort(),
    );
  });

  it("limit reasons carry the version's N when stored, null (never 0) on old rows", async () => {
    const feed = researchArticlesPageSchema.parse(
      (await team.request("GET", `${base}/articles?show=dropped&limit=100`)).json(),
    );
    const limitOf = (id: string) => feed.items.find((a) => a.id === id)?.reasonLimit;
    expect(limitOf("r-LIMIT_OPEN")).toBe(20);
    expect(limitOf("r-LIMIT_DAY")).toBe(5);
    expect(limitOf("r-NO_BALANCE")).toBeNull();
    expect(limitOf("r-old-LIMIT_OPEN")).toBeNull();
    expect(limitOf("r-old-LIMIT_DAY")).toBeNull();

    const skipped = researchTradesPageSchema.parse(
      (await team.request("GET", `${base}/trades?show=skipped&limit=100`)).json(),
    );
    const limits = skipped.items
      .filter((t) => t.skipped?.reason === "limitOpen" || t.skipped?.reason === "limitDay")
      .map((t) => `${t.skipped?.reason ?? ""}:${String(t.skipped?.limit)}`)
      .sort();
    expect(limits).toEqual(["limitDay:5", "limitDay:null", "limitOpen:20", "limitOpen:null"]);

    const filterOf = async (id: string) => {
      const tr = researchArticleTraceSchema.parse(
        (await team.request("GET", `${base}/articles/${id}/trace`)).json(),
      );
      const f = tr.steps.find((x) => x.key === "filter");
      return f?.key === "filter" ? f : null;
    };
    expect(await filterOf("r-LIMIT_OPEN")).toMatchObject({
      status: "drop",
      reason: "limitOpen",
      detail: { reasonLimit: 20 },
    });
    expect(await filterOf("r-old-LIMIT_OPEN")).toMatchObject({
      reason: "limitOpen",
      detail: { reasonLimit: null },
    });
  });
});
