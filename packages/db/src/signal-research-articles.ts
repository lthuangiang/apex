import {
  AppError,
  articleClaudeUsage,
  dec,
  ErrorCode,
  NEWS_RULES,
  sourceTierOf,
  tagName,
  type ResearchArticle,
  type ResearchArticlesPage,
  type ResearchArticlesQuery,
  type ResearchArticleTrace,
  type ResearchNewArticles,
  type ResearchNewArticlesQuery,
  type ResearchClaudeUsage,
  type ResearchDropReason,
  type ResearchMyLabel,
  type ResearchRange,
  type ResearchStage,
  type ResearchTraceCheck,
  type ResearchTraceStep,
  type ResearchTraceStory,
} from "@drift/shared";
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import type { Db } from "./client";
import type { DbTx } from "./read-only";
import {
  signalArticles,
  signalContexts,
  signalEvents,
  signalPaperTrades,
  signalStories,
} from "./schema";
import { contextFlagsOf, loadSignalContexts, signalContextOf } from "./signal-research-context";
import {
  DROP,
  newsTypeOf,
  newsTypeOrNull,
  oppositeOf,
  PRE_CLAUDE_REASONS,
  reasonLimitOf,
} from "./signal-research-keys";
import { loadMyLabel, signalClassifierOf } from "./signal-research-labels";
import {
  resolveSignalVersion,
  versionEventSql,
  versionEventWhere,
  type SignalVersionScope,
} from "./signal-research-versions";

// Feed bài và trace từng bài của Signal research (#291; hợp đồng packages/shared/src/api/signal-research.ts, thiết kế
// docs/mockups/signal-research/news-trace.html). Chỉ đọc; nơi gọi bọc trong transaction chỉ đọc. Chỉ bài của version quy
// tắc hiện tại, không có bài backlog. Mọi số lấy từ cột / event đã lưu; không lưu thì null, không bao giờ tự tính bịa.
//
// Bước dừng và kết quả của một bài suy ra từ `signal_events` của chính bài đó (một câu SQL dùng chung cho feed, bộ đếm
// của feed và `articleStops` của tổng kết, để con số trên chip lý do khớp với số bài feed trả về):
//   decide/open có → `decide` · traded; có event filter → `filter` (merge → merged, drop → dropped); có event understand
//   → `score`; có event normalize → `normalize`, TRỪ `NO_SODEX_MARKET` khi SoSoValue không gắn coin nào → `collect` với lý
//   do `noTaggedCurrency` (thiết kế: "Dropped at Collect · no coin tagged"; mã lưu vẫn là `NO_SODEX_MARKET`); còn lại
//   `collect`. Không có event drop / merge / open ở bước cuối → `waiting` (còn chờ Normalize / Claude).
// #305: bước Filter / Decide chạy riêng cho từng News bot version, nên bước dừng / kết quả của một bài là theo một version
// (`versionId`, mặc định Baseline): chỉ đọc event dùng chung (Collect / Normalize / Understand) + event của version đó.

type Q = Db | DbTx;
type ArticleRow = typeof signalArticles.$inferSelect;
type EventRow = typeof signalEvents.$inferSelect;
type StoryRow = typeof signalStories.$inferSelect;
type TradeRow = typeof signalPaperTrades.$inferSelect;

const DAY_MS = 86_400_000;
const RANGE_DAYS: Record<ResearchRange, number> = { "1d": 1, "7d": 7 };
const STAGES: readonly ResearchStage[] = ["collect", "normalize", "score", "filter", "decide"];

export const rangeSince = (now: Date, range: ResearchRange): Date =>
  new Date(now.getTime() - RANGE_DAYS[range] * DAY_MS);

const iso = (d: Date) => d.toISOString();
const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
const numOf = (s: string | null | undefined): number | null =>
  s == null ? null : dec(s).toDecimalPlaces(4).toNumber();
const decOut = (s: string): string => dec(s).toFixed();
const secsBetween = (from: Date, to: Date) =>
  Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));

// ── Câu SQL trạng thái bài ───────────────────────────────────────────────────────────────────────────────────────────

const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
/** `case code when 'X' then 'y' … end` dựng từ bảng `DROP` (một nguồn duy nhất cho TS và SQL). */
const dropCase = sql.raw(
  `case code ${[...DROP].map(([k, v]) => `when ${literal(k)} then ${literal(v)}`).join(" ")} end`,
);
const preClaude = sql.raw(PRE_CLAUDE_REASONS.map(literal).join(", "));

/**
 * Bảng tạm `st`: mỗi bài một dòng với bước dừng, kết quả, lý do API, mã nội bộ, trade, đã gửi Claude chưa. `since` null
 * = mọi bài của version hiện tại.
 */
function stateCte(
  since: Date | null,
  onlyId: string | null = null,
  scope: SignalVersionScope | null = null,
): SQL {
  const v = NEWS_RULES.version;
  return sql`
    with ev as (
      select a.id, a.published_at, a.collected_at, a.claude_calls,
        jsonb_array_length(case when jsonb_typeof(a.matched_currencies) = 'array' then a.matched_currencies else '[]'::jsonb end) as tagged,
        x.*
      from signal_articles a
      cross join lateral (
        select
          (array_agg(e.trade_id) filter (where e.stage = 'decide' and e.outcome = 'open'))[1] as trade_id,
          (array_agg(e.outcome order by e.at desc, e.id) filter (where e.stage = 'filter'))[1] as f_out,
          (array_agg(e.reason order by e.at desc, e.id) filter (where e.stage = 'filter'))[1] as f_reason,
          (array_agg(e.detail order by e.at desc, e.id) filter (where e.stage = 'filter'))[1] as f_detail,
          (array_agg(e.trade_id order by e.at desc, e.id) filter (where e.stage = 'filter'))[1] as f_trade_id,
          (array_agg(e.outcome order by e.at desc, e.id) filter (where e.stage = 'understand'))[1] as u_out,
          (array_agg(e.reason order by e.at desc, e.id) filter (where e.stage = 'understand'))[1] as u_reason,
          (array_agg(e.detail order by e.at desc, e.id) filter (where e.stage = 'understand' and e.outcome = 'pass'))[1] as u_detail,
          (array_agg(e.outcome order by e.at desc, e.id) filter (where e.stage = 'normalize'))[1] as n_out,
          (array_agg(e.reason order by e.at desc, e.id) filter (where e.stage = 'normalize'))[1] as n_reason
        from signal_events e
        where e.article_id = a.id and e.rule_version = a.rule_version and ${versionEventSql(scope, "e")}
      ) x
      where a.rule_version = ${v} and a.status <> 'backlog'
        ${since === null ? sql`` : sql`and a.collected_at >= ${since}`}
        ${onlyId === null ? sql`` : sql`and a.id = ${onlyId}`}
    ),
    s1 as (
      select ev.*,
        case
          when trade_id is not null then 'decide'
          when f_out is not null then 'filter'
          when u_out is not null then 'score'
          when n_out = 'drop' and n_reason = 'NO_SODEX_MARKET' and tagged = 0 then 'collect'
          when n_out is not null then 'normalize'
          else 'collect'
        end as stage,
        case
          when trade_id is not null then null
          when f_out is not null then f_reason
          when u_out is not null then u_reason
          else n_reason
        end as code,
        case
          when trade_id is not null then 'traded'
          when f_out = 'merge' then 'merged'
          when f_out = 'drop' or (f_out is null and u_out = 'drop')
            or (f_out is null and u_out is null and n_out = 'drop') then 'dropped'
          else 'waiting'
        end as outcome,
        coalesce(claude_calls is not null or u_out = 'pass'
          or (u_out = 'drop' and u_reason not in (${preClaude})), false) as sent_to_claude
      from ev
    ),
    st as (
      select s1.*,
        case when outcome = 'dropped' then
          case when code = 'NO_SODEX_MARKET' and tagged = 0 then 'noTaggedCurrency' else ${dropCase} end
        end as reason,
        case when outcome = 'merged' then
          case code when 'SAME_STORY' then 'sameStory' when 'STORY_TOO_OLD' then 'storyTooOld' end
        end as merge_reason
      from s1
    )`;
}

interface StateRow extends Record<string, unknown> {
  id: string;
  published_at: Date | string;
  collected_at: Date | string;
  stage: ResearchStage;
  outcome: ResearchArticle["outcome"];
  reason: ResearchDropReason | null;
  merge_reason: "sameStory" | "storyTooOld" | null;
  code: string | null;
  trade_id: string | null;
  u_detail: unknown;
  f_detail: unknown;
  f_trade_id: string | null;
  sent_to_claude: boolean;
}

/** Số bài theo bước dừng + kết quả + lý do (cho `funnel.articleStops` của tổng kết). */
export async function loadArticleStops(
  q: Q,
  since: Date | null,
  scope: SignalVersionScope | null = null,
) {
  const r = await q.execute<{
    stage: ResearchStage;
    outcome: ResearchArticle["outcome"];
    reason: ResearchDropReason | null;
    merge_reason: "sameStory" | "storyTooOld" | null;
    n: string | number;
  }>(sql`${stateCte(since, null, scope)}
    select stage, outcome, reason, merge_reason, count(*) as n from st
    group by stage, outcome, reason, merge_reason
    order by count(*) desc, stage, outcome, reason, merge_reason`);
  return r.rows.map((x) => ({
    stage: x.stage,
    outcome: x.outcome,
    reason: x.reason,
    mergeReason: x.merge_reason,
    n: Number(x.n),
  }));
}

// ── Đổi dòng → item API ──────────────────────────────────────────────────────────────────────────────────────────────

/** `name` của SoSoValue có thể là chuỗi, chuỗi JSON `{"EN": …}` hoặc object: đọc bằng `tagName` (#297). */
const matchedList = z.array(z.object({ symbol: z.string(), name: z.unknown().optional() }));
const candidateList = z.array(
  z.object({ symbol: z.string(), market: z.string(), kind: z.enum(["crypto", "stock"]) }),
);
const classificationSchema = z.looseObject({
  catalyst: z.string().optional(),
  market: z.string().nullable().optional(),
  relevance: z.string().optional(),
  promotional: z.boolean().optional(),
  eventDate: z.string().nullable().optional(),
  error: z.string().optional(),
});
const understandDetail = z.looseObject({
  market: z.string().optional(),
  direction: z.enum(["long", "short"]).optional(),
  maxHoldHours: z.number().int().nonnegative().optional(),
});
const sourceRefs = z.array(z.object({ name: z.string(), tier: z.enum(["top", "mid", "low"]) }));

const parseOr = <T>(schema: z.ZodType<T>, v: unknown, fallback: T): T => {
  const p = schema.safeParse(v);
  return p.success ? p.data : fallback;
};

function excerptOf(content: string | null): string | null {
  const s = (content ?? "").slice(0, 140).trim();
  return s === "" ? null : s;
}

function usageOf(a: ArticleRow): ResearchClaudeUsage | null {
  const u = articleClaudeUsage(a);
  return u === null
    ? null
    : {
        calls: u.calls,
        tokens: u.tokens,
        costUsd: u.costUsd,
        model: u.model,
        promptVersion: u.promptVersion,
      };
}

const SHADOW_CODES: ReadonlySet<string> = new Set(["LIMIT_OPEN", "LIMIT_DAY", "NO_BALANCE"]);
const oppositeDetail = z.looseObject({
  closed: z.boolean().optional(),
  closedTradeId: z.uuid().optional(),
  oppositeNews: z.boolean().optional(),
  openTradeId: z.uuid().optional(),
});

/** Lệnh shadow của bài khi bị giới hạn chặn (event Filter `drop` LIMIT_* / NO_BALANCE mang id lệnh shadow). */
function shadowTradeOf(code: string | null, out: string | null, tradeId: string | null) {
  return out === "drop" && code !== null && SHADOW_CODES.has(code) ? tradeId : null;
}

/**
 * Bài là tin ngược chiều trên lệnh đang mở của version (#303): Close → Filter `drop` `OPPOSITE_NEWS` (`closed`,
 * `closedTradeId`); Keep → `NEWS_TRADE_ALREADY_OPEN` với `oppositeNews` (`openTradeId`).
 */
function oppositeAt(
  code: string | null,
  out: string | null,
  detail: unknown,
): ResearchArticle["opposite"] {
  if (out !== "drop") return null;
  const d = parseOr(oppositeDetail, detail, {});
  if (code === "OPPOSITE_NEWS") return { action: "closed", tradeId: d.closedTradeId ?? null };
  if (code === "NEWS_TRADE_ALREADY_OPEN" && d.oppositeNews === true)
    return { action: "kept", tradeId: d.openTradeId ?? null };
  return null;
}

function articleItem(
  a: ArticleRow,
  s: StateRow,
  scope: SignalVersionScope | null,
  context: typeof signalContexts.$inferSelect | undefined,
): ResearchArticle {
  const cls = parseOr(classificationSchema, a.classification, {});
  const ud = parseOr(understandDetail, s.u_detail, {});
  const dropped = s.stage === "filter" && s.outcome === "dropped";
  return {
    id: a.id,
    title: (a.title ?? "").trim() === "" ? null : a.title,
    excerpt: excerptOf(a.content),
    url: a.url,
    source: a.source,
    tier: sourceTierOf(a.source, a.category),
    publishedAt: iso(a.publishedAt),
    collectedAt: iso(a.collectedAt),
    delaySecs: secsBetween(a.publishedAt, a.collectedAt),
    tagged: parseOr(matchedList, a.matchedCurrencies, []).map((m) => m.symbol),
    candidates: parseOr(candidateList, a.candidates, []).map((c) => c.market),
    asset: ud.market ?? cls.market ?? null,
    side: ud.direction ?? null,
    stage: s.stage,
    outcome: s.outcome,
    reason: s.reason,
    reasonLimit: s.outcome === "dropped" ? reasonLimitOf(s.code, s.f_detail) : null,
    mergeReason: s.merge_reason,
    sentToClaude: s.sent_to_claude,
    claude: usageOf(a),
    tradeId: s.trade_id,
    versionId: scope?.id ?? null,
    shadowTradeId: dropped ? shadowTradeOf(s.code, "drop", s.f_trade_id) : null,
    opposite: dropped ? oppositeAt(s.code, "drop", s.f_detail) : null,
    context: context === undefined ? null : contextFlagsOf(context),
  };
}

// ── Feed ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const cursorSchema = z.object({ t: z.iso.datetime(), id: z.string().min(1).max(200) });
const encodeCursor = (t: Date, id: string) =>
  Buffer.from(JSON.stringify({ t: iso(t), id })).toString("base64url");

/** Cursor hỏng hoặc bị sửa tay → 400 `VALIDATION_FAILED` (C6), không bao giờ 500 hay âm thầm về trang đầu. */
function decodeCursor(c: string): { t: Date; id: string } {
  let raw: unknown = null;
  try {
    raw = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
  } catch {
    raw = null;
  }
  const p = cursorSchema.safeParse(raw);
  if (!p.success)
    throw new AppError(ErrorCode.validationFailed, "Invalid input.", {
      fieldErrors: { cursor: ["invalid"] },
    });
  return { t: new Date(p.data.t), id: p.data.id };
}

/**
 * Feed bài, mới nhất trước theo giờ đăng (rồi id), phân trang bằng cursor (giờ đăng, id). Khoảng thời gian tính theo
 * giờ DeskLabs THU bài (`collected_at`), cùng mốc với `articleStops` của tổng kết. `check` gọi giữa các câu (deadline).
 */
export async function loadSignalResearchArticles(
  q: Q,
  query: ResearchArticlesQuery,
  now: Date,
  check: () => void = () => undefined,
): Promise<ResearchArticlesPage> {
  const scope = await resolveSignalVersion(q, query.versionId);
  check();
  const cur = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const since = rangeSince(now, query.range);
  const filters: SQL[] = [];
  if (query.show === "traded") filters.push(sql`outcome = 'traded'`);
  if (query.show === "dropped") filters.push(sql`outcome = 'dropped'`);
  if (query.show === "claude") filters.push(sql`sent_to_claude`);
  if (query.stage !== undefined) filters.push(sql`stage = ${query.stage}`);
  if (query.reason !== undefined) filters.push(sql`reason = ${query.reason}`);
  const where = filters.length === 0 ? sql`true` : sql.join(filters, sql` and `);

  const counts = await q.execute<{ total: string | number; n_all: string | number }>(
    sql`${stateCte(since, null, scope)} select count(*) filter (where ${where}) as total, count(*) as n_all from st`,
  );
  check();
  const page = await q.execute<StateRow>(sql`${stateCte(since, null, scope)}
    select * from st
    where ${where}
      ${cur === null ? sql`` : sql`and (published_at, id) < (${cur.t}::timestamptz, ${cur.id}::text)`}
    order by published_at desc, id desc
    limit ${query.limit + 1}`);
  check();
  const rows = page.rows.slice(0, query.limit);
  const ids = rows.map((r) => r.id);
  const articles =
    ids.length === 0
      ? new Map<string, ArticleRow>()
      : new Map(
          (await q.select().from(signalArticles).where(inArray(signalArticles.id, ids))).map(
            (a) => [a.id, a],
          ),
        );
  const contexts = await loadSignalContexts(q, ids);
  check();
  const items = rows.flatMap((r) => {
    const a = articles.get(r.id);
    return a === undefined ? [] : [articleItem(a, r, scope, contexts.get(r.id))];
  });
  const last = rows.at(-1);
  const c = counts.rows[0];
  return {
    items,
    nextCursor:
      page.rows.length > query.limit && last !== undefined
        ? encodeCursor(toDate(last.published_at), last.id)
        : null,
    total: Number(c?.total ?? 0),
    totalInRange: Number(c?.n_all ?? 0),
  };
}

// ── Bài mới (#345) ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Bài còn chờ (chưa xong phễu) thu trong khoảng này giữ con trỏ lại; cũ hơn thì coi như kẹt, con trỏ đi qua. */
export const NEW_ARTICLES_PIN_MS = 15 * 60_000;

// Con trỏ của bài mới: (giờ thu, id) của bài cuối đã đi qua. `id` rỗng khi chưa có bài nào (lần đầu, bảng trống).
const sinceSchema = z.object({ t: z.iso.datetime(), id: z.string().max(200) });

function decodeSince(c: string): { t: Date; id: string } {
  let raw: unknown = null;
  try {
    raw = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
  } catch {
    raw = null;
  }
  const p = sinceSchema.safeParse(raw);
  if (!p.success)
    throw new AppError(ErrorCode.validationFailed, "Invalid input.", {
      fieldErrors: { since: ["invalid"] },
    });
  return { t: new Date(p.data.t), id: p.data.id };
}

/**
 * Bài mới cho hiệu ứng bài rơi xuống phễu (#345). Lần đầu (không có `since`): không trả bài, con trỏ ở bài mới nhất của
 * version quy tắc hiện tại. Sau đó: bài thu sau con trỏ, cũ trước mới, chỉ bài đã xong phễu theo `versionId`. Con trỏ đi
 * tới bài cuối liền mạch đã xong; bài còn chờ thu trong `NEW_ARTICLES_PIN_MS` giữ con trỏ lại (bài sau nó vẫn được trả,
 * web bỏ bài trùng theo id). So sánh giờ ở mức mili giây (con trỏ là ISO).
 */
export async function loadSignalResearchNewArticles(
  q: Q,
  query: ResearchNewArticlesQuery,
  now: Date,
  check: () => void = () => undefined,
): Promise<ResearchNewArticles> {
  const scope = await resolveSignalVersion(q, query.versionId);
  check();
  if (query.since === undefined) {
    const last = await q
      .select({ t: signalArticles.collectedAt, id: signalArticles.id })
      .from(signalArticles)
      .where(
        and(
          eq(signalArticles.ruleVersion, NEWS_RULES.version),
          sql`${signalArticles.status} <> 'backlog'`,
        ),
      )
      .orderBy(sql`${signalArticles.collectedAt} desc, ${signalArticles.id} desc`)
      .limit(1);
    const row = last[0];
    return { items: [], since: encodeCursor(row?.t ?? now, row?.id ?? "") };
  }
  const cur = decodeSince(query.since);
  const page = await q.execute<StateRow>(sql`${stateCte(cur.t, null, scope)}
    select * from st
    where (date_trunc('milliseconds', collected_at), id) > (${cur.t}::timestamptz, ${cur.id}::text)
    order by collected_at asc, id asc
    limit ${query.limit}`);
  check();
  let since = cur;
  let pinned = false;
  const settled: StateRow[] = [];
  for (const r of page.rows) {
    const t = toDate(r.collected_at);
    if (r.outcome === "waiting") {
      if (now.getTime() - t.getTime() < NEW_ARTICLES_PIN_MS) pinned = true;
    } else settled.push(r);
    if (!pinned) since = { t, id: r.id };
  }
  const ids = settled.map((r) => r.id);
  const articles =
    ids.length === 0
      ? new Map<string, ArticleRow>()
      : new Map(
          (await q.select().from(signalArticles).where(inArray(signalArticles.id, ids))).map(
            (a) => [a.id, a],
          ),
        );
  const contexts = await loadSignalContexts(q, ids);
  check();
  const items = settled.flatMap((r) => {
    const a = articles.get(r.id);
    return a === undefined ? [] : [articleItem(a, r, scope, contexts.get(r.id))];
  });
  return { items, since: encodeCursor(since.t, since.id) };
}

// ── Trace ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const filterDetail = z.looseObject({
  level: z.enum(["high", "medium", "low"]).optional(),
  tpPct: z.string().optional(),
  costPct: z.string().optional(),
  spreadPct: z.string().optional(),
  delayMinutes: z.number().optional(),
  openTradeId: z.uuid().optional(),
  laterLevel: z.enum(["high", "medium", "low"]).optional(),
  storyStartedAt: z.string().optional(),
});
const decideDetail = z.looseObject({ retry: z.boolean().optional() });

type CheckKey = ResearchTraceCheck["key"];
/** Thứ tự kiểm của pipeline (`decideStory`). */
const CHECK_ORDER: readonly CheckKey[] = [
  "sourceLive",
  "priceAvailable",
  "noOpenTrade",
  "tpVsCost",
];
const FAILED_CHECK: ReadonlyMap<string, CheckKey> = new Map<string, CheckKey>([
  ["SOURCE_LATE", "sourceLive"],
  ["NO_SODEX_PRICE", "priceAvailable"],
  ["NO_BOOK_DATA", "priceAvailable"],
  // Thiếu lịch sử giá để tính biến động: cùng nhóm "không có giá" như lý do API `noPrice` và trang chi tiết lệnh.
  ["NOT_ENOUGH_HISTORY", "priceAvailable"],
  ["NEWS_TRADE_ALREADY_OPEN", "noOpenTrade"],
  ["TOO_THIN_TO_TRADE", "tpVsCost"],
  ["MOVE_TOO_SMALL_FOR_COST", "tpVsCost"],
]);

const levelOf = (v: string | null | undefined): "high" | "medium" | "low" | null =>
  v === "high" || v === "medium" || v === "low" ? v : null;

function checksOf(
  a: ArticleRow,
  e: EventRow,
  cfg: SignalVersionScope["config"] | undefined,
): ResearchTraceCheck[] {
  const d = parseOr(filterDetail, e.detail, {});
  const failed = e.outcome === "drop" && e.reason !== null ? FAILED_CHECK.get(e.reason) : undefined;
  if (e.outcome === "drop" && failed === undefined) return [];
  const tp = numOf(d.tpPct);
  const cost = numOf(d.costPct);
  const out: ResearchTraceCheck[] = [];
  for (const key of CHECK_ORDER) {
    const ok = failed !== key;
    const base: ResearchTraceCheck = {
      key,
      ok,
      code: ok ? null : e.reason,
      value: null,
      limit: null,
      costPct: null,
      spreadPct: null,
      openTradeId: null,
    };
    if (key === "sourceLive")
      out.push({
        ...base,
        value: d.delayMinutes ?? Math.round(secsBetween(a.publishedAt, a.collectedAt) / 60),
        limit: cfg?.maxSourceDelayMinutes ?? NEWS_RULES.maxSourceDelayMinutes,
      });
    else if (key === "tpVsCost")
      out.push({
        ...base,
        value: tp,
        limit:
          d.costPct === undefined
            ? null
            : dec(d.costPct)
                .mul(cfg?.minTpCostMultiple ?? NEWS_RULES.minTpCostMultiple)
                .toDecimalPlaces(4)
                .toNumber(),
        costPct: cost,
        spreadPct: numOf(d.spreadPct),
      });
    else if (key === "noOpenTrade")
      out.push({ ...base, openTradeId: ok ? null : (d.openTradeId ?? null) });
    else out.push(base);
    if (!ok) break;
  }
  return out;
}

function storyOf(a: ArticleRow, story: StoryRow): ResearchTraceStory {
  const refs = parseOr(sourceRefs, story.sources, []);
  return {
    id: story.id,
    key: story.storyKey,
    market: story.market,
    newsType: newsTypeOf(story.catalyst),
    isNew: story.firstArticleId === a.id,
    sources: new Set(refs.map((r) => r.name.toLowerCase())).size,
    levelAtEntry: levelOf(story.levelAtEntry) ?? "low",
    laterLevel: levelOf(story.laterLevel) ?? "low",
    outcome: story.outcome === "entered" ? "entered" : "skipped",
    tradeId: story.tradeId,
  };
}

/**
 * Năm bước của một bài, từ các event đã lưu của nó. Bước trước bước dừng: `pass`; bước dừng: theo kết quả (`waiting`
 * → `pass` của bước cuối đã qua); sau đó: `notReached` với `detail` null.
 */
function stepsOf(input: {
  a: ArticleRow;
  s: StateRow;
  events: readonly EventRow[];
  story: StoryRow | null;
  trade: TradeRow | null;
  dupOf: ArticleRow | null;
  labelable: boolean;
  label: ResearchMyLabel | null;
  scope: SignalVersionScope | null;
}): ResearchTraceStep[] {
  const { a, s, events, story, trade, dupOf } = input;
  const stop = STAGES.indexOf(s.stage);
  const internal: Record<ResearchStage, string> = {
    collect: "collect",
    normalize: "normalize",
    score: "understand",
    filter: "filter",
    decide: "decide",
  };
  const lastOf = (st: ResearchStage) =>
    events.filter((e) => e.stage === internal[st]).at(-1) ?? null;
  const status = (i: number): ResearchTraceStep["status"] => {
    if (i < stop) return "pass";
    if (i > stop) return "notReached";
    if (s.outcome === "dropped") return "drop";
    if (s.outcome === "merged") return "merge";
    return "pass";
  };
  const base = (i: number, ev: EventRow | null) => {
    const st = status(i);
    const atStop = i === stop;
    return {
      status: st,
      at: st === "notReached" || ev === null ? null : iso(ev.at),
      reason: atStop && st === "drop" ? s.reason : null,
      mergeReason: atStop && st === "merge" ? s.merge_reason : null,
      code: atStop && (st === "drop" || st === "merge") ? s.code : null,
    };
  };
  const cls = parseOr(classificationSchema, a.classification, {});
  const fEv = lastOf("filter");
  const uEv = lastOf("score");
  const ud = parseOr(
    understandDetail,
    uEv !== null && uEv.outcome === "pass" ? uEv.detail : null,
    {},
  );
  const fd = parseOr(filterDetail, fEv?.detail ?? null, {});
  const collectEv =
    s.stage === "collect" && s.outcome === "dropped" ? lastOf("normalize") : lastOf("collect");

  const steps: ResearchTraceStep[] = [];
  steps.push({
    key: "collect",
    ...base(0, collectEv),
    detail: {
      publishedAt: iso(a.publishedAt),
      collectedAt: iso(a.collectedAt),
      delaySecs: secsBetween(a.publishedAt, a.collectedAt),
      source: a.source,
      tier: sourceTierOf(a.source, a.category),
      url: a.url,
      tagged: parseOr(matchedList, a.matchedCurrencies, []).map((m) => ({
        symbol: m.symbol,
        name: tagName(m.name),
      })),
    },
  });
  const nb = base(1, lastOf("normalize"));
  steps.push({
    key: "normalize",
    ...nb,
    detail:
      nb.status === "notReached"
        ? null
        : {
            candidates: parseOr(candidateList, a.candidates, []),
            duplicateOf:
              dupOf === null
                ? null
                : {
                    id: dupOf.id,
                    title: (dupOf.title ?? "").trim() === "" ? null : dupOf.title,
                    excerpt: excerptOf(dupOf.content),
                    publishedAt: iso(dupOf.publishedAt),
                  },
            story: story === null ? null : storyOf(a, story),
          },
  });
  const sb = base(2, uEv);
  const merged = s.outcome === "merged";
  const levelSources =
    trade !== null
      ? parseOr(sourceRefs, trade.sourcesAtEntry, [])
      : story !== null
        ? parseOr(sourceRefs, story.sources, [])
        : null;
  steps.push({
    key: "score",
    ...sb,
    detail:
      sb.status === "notReached"
        ? null
        : {
            sentToClaude: s.sent_to_claude,
            signalType: cls.catalyst === undefined ? null : cls.catalyst !== "none",
            newsType: newsTypeOrNull(cls.catalyst),
            side:
              ud.direction ??
              (story === null ? null : story.direction === "short" ? "short" : "long"),
            maxHoldHours: ud.maxHoldHours ?? null,
            asset: ud.market ?? cls.market ?? null,
            relevance:
              cls.relevance === "direct"
                ? "direct"
                : cls.relevance === "passing_mention"
                  ? "passingMention"
                  : null,
            promotional: cls.promotional ?? null,
            eventDate: cls.eventDate ?? null,
            error: cls.error ?? null,
            level: merged
              ? null
              : (levelOf(fd.level) ?? (trade === null ? null : levelOf(trade.levelAtEntry))),
            laterLevel: story === null ? null : levelOf(story.laterLevel),
            levelSources,
            claude: usageOf(a),
            labelable: input.labelable,
            label: input.label,
          },
  });
  const fb = base(3, fEv);
  steps.push({
    key: "filter",
    ...fb,
    detail:
      fb.status === "notReached" || fEv === null
        ? null
        : {
            level: merged ? null : levelOf(fd.level),
            checks: merged ? [] : checksOf(a, fEv, input.scope?.config),
            laterLevel: merged ? levelOf(fd.laterLevel) : null,
            reasonLimit: fEv.outcome === "drop" ? reasonLimitOf(fEv.reason, fEv.detail) : null,
            shadowTradeId: shadowTradeOf(fEv.reason, fEv.outcome, fEv.tradeId),
            opposite: oppositeAt(fEv.reason, fEv.outcome, fEv.detail),
            storyStartedAt:
              merged &&
              fd.storyStartedAt !== undefined &&
              !Number.isNaN(Date.parse(fd.storyStartedAt))
                ? new Date(fd.storyStartedAt).toISOString()
                : null,
          },
  });
  const dEv = lastOf("decide");
  const db = base(4, dEv);
  const dd = parseOr(decideDetail, dEv?.detail ?? null, {});
  steps.push({
    key: "decide",
    ...db,
    detail:
      db.status === "notReached" || trade === null
        ? null
        : {
            tradeId: trade.id,
            side: trade.direction === "short" ? "short" : "long",
            sizeUsdc: decOut(trade.sizeUsdc),
            entry: decOut(trade.entryPrice),
            openedAt: iso(trade.openedAt),
            tp: decOut(trade.tpPrice),
            tpPct: numOf(trade.tpPct),
            sl: decOut(trade.slPrice),
            slPct: numOf(trade.slPct),
            maxHoldHours: Math.round(
              (trade.maxHoldUntil.getTime() - trade.openedAt.getTime()) / 3_600_000,
            ),
            maxHoldUntil: iso(trade.maxHoldUntil),
            priceSource:
              trade.priceSource === "book"
                ? "book"
                : trade.priceSource === "last_spread"
                  ? "lastSpread"
                  : null,
            retry: dd.retry ?? trade.retry,
            movedBeforePct: numOf(trade.movedBeforeEntryPct),
            status: trade.status === "closed" ? "closed" : "open",
            random:
              trade.randomDoneAt === null
                ? null
                : {
                    longPct: numOf(trade.randomLongPct),
                    shortPct: numOf(trade.randomShortPct),
                    pct: numOf(trade.randomPct),
                    longShare: numOf(trade.randomLongShare),
                  },
            opposite: oppositeOf(trade),
          },
  });
  return steps;
}

/**
 * Trace một bài (id SoSoValue). null = không có, bài backlog, hoặc bài của version quy tắc khác. `viewerId` (#304): thẻ
 * Score kèm nhãn của chính người xem; trace KHÔNG ẩn kết quả lệnh (chỉ luồng `labels/next` ẩn).
 */
export async function loadSignalResearchArticleTrace(
  q: Q,
  id: string,
  check: () => void = () => undefined,
  viewerId: string | null = null,
  versionId?: string,
): Promise<ResearchArticleTrace | null> {
  if (id.length === 0 || id.length > 200) return null;
  const scope = await resolveSignalVersion(q, versionId);
  const st = await q.execute<StateRow>(sql`${stateCte(null, id, scope)} select * from st`);
  const s = st.rows[0];
  if (s === undefined) return null;
  check();
  const [a] = await q.select().from(signalArticles).where(eq(signalArticles.id, id));
  if (a === undefined) return null;
  const events = await q
    .select()
    .from(signalEvents)
    .where(
      and(
        eq(signalEvents.articleId, id),
        eq(signalEvents.ruleVersion, a.ruleVersion),
        versionEventWhere(scope),
      ),
    )
    .orderBy(asc(signalEvents.at), asc(signalEvents.id));
  check();
  const storyId =
    events.findLast((e) => e.stage === "filter" && e.storyId !== null)?.storyId ?? null;
  const [story] =
    storyId === null
      ? []
      : await q.select().from(signalStories).where(eq(signalStories.id, storyId));
  const [trade] =
    s.trade_id === null
      ? []
      : await q.select().from(signalPaperTrades).where(eq(signalPaperTrades.id, s.trade_id));
  const [dupOf] =
    a.duplicateOf === null
      ? []
      : await q.select().from(signalArticles).where(eq(signalArticles.id, a.duplicateOf));
  const labelable = (await signalClassifierOf(q, id)) !== null;
  const label = viewerId === null ? null : await loadMyLabel(q, id, viewerId);
  const context = (await loadSignalContexts(q, [id])).get(id);
  check();
  return {
    article: articleItem(a, s, scope, context),
    context: context === undefined ? null : signalContextOf(context),
    steps: stepsOf({
      a,
      s,
      events,
      story: story ?? null,
      trade: trade ?? null,
      dupOf: dupOf ?? null,
      labelable,
      label,
      scope,
    }),
  };
}
