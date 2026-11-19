import {
  AppError,
  claudeCostUsd,
  classifierGate,
  dec,
  Decimal,
  ErrorCode,
  funnelSteps,
  GATE_MIN_CLOSED,
  gateStatus,
  NEWS_RULES,
  paperBalance,
  RESEARCH_BOT_START_USDC,
  SOURCE_HEALTH,
  summarizeByDay,
  tradesNeeded,
  type DayObs,
  type DaySummary,
  type ClassifierGate,
  type ResearchFact,
  type ResearchLevelRow,
  type ResearchNeeds,
  type ResearchDropReason,
  type ResearchRange,
  type ResearchStep,
  type ResearchSummary,
  type ResearchTrade,
  type ResearchTradeDetail,
  type ResearchTradesPage,
  type ResearchTradesQuery,
  type SignalSourceKey,
  type TradeDirection,
  botVersionConfigSchema,
  type BotVersionConfig,
  exitPriceOf,
  type SrQuotesSnapshot,
  unrealizedUsdc,
} from "@drift/shared";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  lt,
  min,
  or,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import { z } from "zod";

import type { Db } from "./client";
import type { DbTx } from "./read-only";
import {
  signalArticles,
  signalBotVersions,
  signalEvents,
  signalPaperTrades,
  signalResearchUsage,
  signalSourceHealth,
  signalStories,
} from "./schema";
import { loadArticleStops, rangeSince } from "./signal-research-articles";
import { loadContextSummary } from "./signal-research-context";
import { DROP, newsTypeOf, oppositeOf, reasonLimitOf } from "./signal-research-keys";
import { classifierStatusOf, loadClassifierGates } from "./signal-research-labels";
import {
  resolveSignalVersion,
  versionEventWhere,
  versionStoryWhere,
  versionTradeWhere,
  type SignalVersionScope,
} from "./signal-research-versions";

// Báo cáo Signal research (#271; hợp đồng: packages/shared/src/api/signal-research.ts, UI #273), dùng chung cho CLI của
// scheduler và endpoint team của api. Chỉ đọc; nơi gọi bọc trong transaction chỉ đọc. Chỉ tính version quy tắc hiện tại
// (`NEWS_RULES.version`), như cổng của #263. Hiện chỉ lane News · live có dữ liệu. Thiếu số → null, không bao giờ 0.
// Ngoại lệ (#298): danh sách lệnh và chi tiết một lệnh hiện cả lệnh của version cũ (lịch sử); tổng kết, chẩn đoán và
// cổng chỉ đếm version hiện tại.
// #304 (DEC-328 mục 2): số thống kê dùng cho cổng (dòng tổng kết, bảng mức, Long / Short) chỉ tính lệnh đã đóng có
// classifier đã qua cổng precision (≥ 50 nhãn, ≥ 80%); số dư, lệnh mở, phễu và kết quả theo loại vẫn tính mọi lệnh.
// #305: tổng kết, danh sách lệnh, feed và trace lọc theo một News bot version (`versionId`, mặc định Baseline; Baseline gồm
// cả dòng `version_id` null ghi trước khi có version). Bước dùng chung (Collect / Normalize / Understand) không đổi theo
// version; Filter / Decide / Watch, story và lệnh là của riêng version.

type Q = Db | DbTx;
type TradeRow = typeof signalPaperTrades.$inferSelect;
type ArticleRow = typeof signalArticles.$inferSelect;
type StoryRow = typeof signalStories.$inferSelect;
type EventRow = typeof signalEvents.$inferSelect;

const DAY_MS = 86_400_000;
const POLL_SECS = 300;

const iso = (d: Date) => d.toISOString();
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const num = (d: Decimal | null | undefined): number | null =>
  d == null ? null : d.toDecimalPlaces(4).toNumber();
const numOf = (s: string | null): number | null => (s === null ? null : num(dec(s)));
const decOut = (s: string | null): string | null => (s === null ? null : dec(s).toFixed());
/**
 * Bid / ask SoDEX theo market (bản chụp Redis `sr:quotes` do watcher của scheduler ghi, api truyền vào; #308). Không
 * truyền / thiếu market / giá cũ → không tính lãi / lỗ chưa chốt (null), không bao giờ 0 hay giá cũ.
 */
export type ExitQuotes = () => Promise<SrQuotesSnapshot>;

/**
 * Lãi / lỗ chưa chốt của một lệnh đang mở theo giá thoát thật (Long → bid, Short → ask) còn mới; null khi đã đóng, thiếu
 * giá hoặc giá cũ hơn ngưỡng fresh (`exitPriceOf`).
 */
function openPnl(t: TradeRow, px: SrQuotesSnapshot, now: number): Decimal | null {
  if (t.status === "closed") return null;
  const direction = t.direction === "short" ? "short" : "long";
  return unrealizedUsdc(
    {
      direction,
      entryPrice: t.entryPrice,
      qty: t.qty,
      sizeUsdc: t.sizeUsdc,
      entryFee: t.entryFee,
      feePct: t.feePct,
    },
    exitPriceOf(direction, px[t.market], now),
  );
}

async function pricesOf(
  prices: ExitQuotes | undefined,
  rows: readonly TradeRow[],
): Promise<SrQuotesSnapshot> {
  if (prices === undefined || !rows.some((t) => t.status !== "closed")) return {};
  try {
    return await prices();
  } catch {
    // Redis lỗi: không có giá thì không có lãi / lỗ chưa chốt (hiện "Open"), tổng kết vẫn trả về.
    return {};
  }
}

const costOf = (t: TradeRow) => dec(t.feePct).mul(2).add(dec(t.spreadAtEntryPct));
const liveNews = (scope: SignalVersionScope | null) =>
  and(
    eq(signalPaperTrades.ruleVersion, NEWS_RULES.version),
    eq(signalPaperTrades.lane, NEWS_RULES.lane),
    eq(signalPaperTrades.label, "live"),
    versionTradeWhere(scope),
  );
/** Lệnh News · live của MỌI version quy tắc (#298): chỉ cho danh sách / chi tiết lệnh, không bao giờ cho tổng kết hay cổng. */
const liveNewsHistory = () =>
  and(eq(signalPaperTrades.lane, NEWS_RULES.lane), eq(signalPaperTrades.label, "live"));
/** #305: chi tiết một lệnh mở được cả lệnh shadow (theo dõi giả định), để web hiện kết quả "would have". */
const newsTradeOrShadow = () =>
  and(
    eq(signalPaperTrades.lane, NEWS_RULES.lane),
    inArray(signalPaperTrades.label, ["live", "shadow"]),
  );
/** "news-v2" → 2; dạng lạ → version hiện tại. */
const versionNumberOf = (v: string): number => {
  const m = /^news-v(\d+)$/.exec(v);
  return m?.[1] === undefined ? NEWS_RULES.versionNumber : Number(m[1]);
};

const level = (v: string | null): "high" | "medium" | "low" =>
  v === "high" ? "high" : v === "medium" ? "medium" : "low";
const side = (v: string): TradeDirection => (v === "short" ? "short" : "long");

const sourceRefs = z.array(
  z.object({
    name: z.string(),
    tier: z.enum(["top", "mid", "low"]),
    articleId: z.string().optional(),
    at: z.string().optional(),
  }),
);
const refsOf = (v: unknown) => {
  const p = sourceRefs.safeParse(v);
  return p.success ? p.data : [];
};
const distinctSources = (v: unknown) => new Set(refsOf(v).map((s) => s.name.toLowerCase())).size;
const topSources = (v: unknown) =>
  new Set(
    refsOf(v)
      .filter((s) => s.tier === "top")
      .map((s) => s.name.toLowerCase()),
  ).size;
const filterDetail = z.looseObject({
  tpPct: z.string().optional(),
  costPct: z.string().optional(),
});
const classification = z.looseObject({ eventDate: z.string().nullable().optional() });

// ── Tổng kết ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Câu chuyện "logic" (review PR #278 R3): mỗi lần thử của cùng story key là một dòng `signal_stories`, nhưng chỉ tính MỘT
 * câu chuyện cho mỗi key trong mỗi cửa sổ 7 ngày (tính từ dòng đầu của chuỗi). Mức của câu chuyện = mức của dòng đã vào
 * lệnh nếu có, không thì của lần thử cuối. `rows` phải xếp theo key rồi thời gian.
 */
export function logicalStories(
  rows: readonly { key: string; at: Date; entry: string; later: string; locked: boolean }[],
): { key: string; entry: string; later: string }[] {
  const out: { key: string; entry: string; later: string }[] = [];
  let chain: (typeof rows)[number][] = [];
  const flush = () => {
    const rep = chain.find((r) => r.locked) ?? chain.at(-1);
    if (rep !== undefined) out.push({ key: rep.key, entry: rep.entry, later: rep.later });
    chain = [];
  };
  for (const r of rows) {
    const start = chain[0];
    if (
      start !== undefined &&
      (start.key !== r.key ||
        r.at.getTime() - start.at.getTime() > NEWS_RULES.storyWindowDays * DAY_MS)
    )
      flush();
    chain.push(r);
  }
  flush();
  return out;
}

export interface SummaryLimits {
  sosoMonthlyLimit: number;
  claudeDailyInputBudget: number;
}

/** Hết hạn mức SoSoValue tháng: nguồn "Delayed" (chủ ý ngừng gọi), không phải "Down". */
export const SOSO_MONTHLY_QUOTA_ERROR = "monthly_quota";

function sourceStatus(
  key: SignalSourceKey,
  lastOk: Date | null,
  lastErr: Date | null,
  now: number,
  lastError: string | null = null,
): "live" | "delayed" | "down" {
  if (
    lastError === SOSO_MONTHLY_QUOTA_ERROR &&
    lastErr !== null &&
    (lastOk === null || lastErr > lastOk)
  )
    return "delayed";
  if (lastOk === null) return "down";
  const age = now - lastOk.getTime();
  const t = SOURCE_HEALTH[key];
  if (lastErr !== null && lastErr > lastOk && age > t.liveMs) return "down";
  if (age <= t.liveMs) return "live";
  return age <= t.delayedMs ? "delayed" : "down";
}

/** Chi phí một ngày, cùng công thức với chi phí từng bài (`claudeCostUsd` của `@drift/shared`). */
function dailyClaudeCostUsd(u: typeof signalResearchUsage.$inferSelect): Decimal {
  return claudeCostUsd({
    input: u.claudeInputTokens,
    cacheWrite: u.claudeCacheWriteTokens,
    cacheRead: u.claudeCacheReadTokens,
    output: u.claudeOutputTokens,
  });
}

/**
 * "Còn thiếu gì": < 100 lệnh đóng → `pooled` (còn bao nhiêu, ước số tuần theo nhịp hiện tại); đủ 100: qua cổng →
 * `passed`; trung bình sau phí ≤ 0 → `losesAfterFees`; khoảng 95% chưa trên 0 → `rangeBelowZero` (cần bao nhiêu lệnh);
 * còn lại → `moreTrades`.
 */
function needsOf(input: {
  closed: number;
  status: "collecting" | "failing" | "passing";
  after: DaySummary;
  diff: DaySummary | null;
  weeksRunning: number | null;
}): ResearchNeeds {
  const { closed } = input;
  if (closed < GATE_MIN_CLOSED) {
    const more = GATE_MIN_CLOSED - closed;
    const pace = input.weeksRunning === null || closed === 0 ? null : closed / input.weeksRunning;
    return { kind: "pooled", more, weeks: pace === null ? null : Math.ceil(more / pace) };
  }
  if (input.status === "passing") return { kind: "passed" };
  if (input.after.mean?.lte(0) === true) return { kind: "losesAfterFees" };
  const needed = tradesNeeded(input.diff);
  if (input.after.ciLow?.lte(0) === true && needed !== null)
    return { kind: "rangeBelowZero", needed };
  return {
    kind: "moreTrades",
    more: Math.max(0, (needed ?? GATE_MIN_CLOSED) - closed),
    fundingDays: null,
  };
}

/**
 * Tổng kết. Chỉ đọc cột đã lưu (random baseline do scheduler tính một lần mỗi lệnh), không phát lại nến. `check` (tuỳ
 * chọn) được gọi giữa các câu để transaction dừng khi quá trần tổng thời gian (`readOnlyTx` `deadlineMs`).
 */
export async function loadSignalResearchSummary(
  q: Q,
  now: Date,
  limits: SummaryLimits,
  check: () => void = () => undefined,
  range?: ResearchRange,
  prices?: ExitQuotes,
  versionId?: string,
): Promise<ResearchSummary> {
  const v = NEWS_RULES.version;
  const scope = await resolveSignalVersion(q, versionId);
  check();
  const nowMs = now.getTime();
  const today = utcDay(nowMs);
  // #291: `range` chỉ đổi phễu (`funnel`); bảng mức, cổng, Long / Short luôn tính mọi lệnh của version hiện tại.
  const since = range === undefined ? null : rangeSince(now, range);

  const usage = await q
    .select()
    .from(signalResearchUsage)
    .where(gte(signalResearchUsage.day, utcDay(nowMs - 6 * DAY_MS)));
  check();
  const [month] = await q
    .select({ n: sum(signalResearchUsage.sosoRequests) })
    .from(signalResearchUsage)
    .where(gte(signalResearchUsage.day, `${today.slice(0, 7)}-01`));
  check();
  const health = new Map((await q.select().from(signalSourceHealth)).map((x) => [x.source, x]));
  check();
  const [articles] = await q
    .select({ n: count(), since: min(signalArticles.collectedAt) })
    .from(signalArticles)
    .where(eq(signalArticles.ruleVersion, v));
  const enabledSince = articles?.since ?? null;
  check();
  const [articlesInRange] =
    since === null
      ? [articles]
      : await q
          .select({ n: count() })
          .from(signalArticles)
          .where(and(eq(signalArticles.ruleVersion, v), gte(signalArticles.collectedAt, since)));
  check();
  const [delay] = await q
    .select({
      secs: sql<
        string | null
      >`percentile_cont(0.5) within group (order by extract(epoch from ${signalArticles.collectedAt} - ${signalArticles.publishedAt}))`,
    })
    .from(signalArticles)
    .where(
      and(
        eq(signalArticles.ruleVersion, v),
        sql`${signalArticles.status} <> 'backlog'`,
        since === null ? undefined : gte(signalArticles.collectedAt, since),
      ),
    );
  check();
  const grouped = await q
    .select({
      stage: signalEvents.stage,
      outcome: signalEvents.outcome,
      reason: signalEvents.reason,
      n: count(),
    })
    .from(signalEvents)
    .where(
      and(
        eq(signalEvents.ruleVersion, v),
        since === null ? undefined : gte(signalEvents.at, since),
        versionEventWhere(scope),
      ),
    )
    .groupBy(signalEvents.stage, signalEvents.outcome, signalEvents.reason);
  check();
  const storyRows = await q
    .select({
      key: signalStories.storyKey,
      at: signalStories.firstSeenAt,
      entry: signalStories.levelAtEntry,
      later: signalStories.laterLevel,
      locked: signalStories.locked,
    })
    .from(signalStories)
    .where(and(eq(signalStories.ruleVersion, v), versionStoryWhere(scope)))
    .orderBy(asc(signalStories.storyKey), asc(signalStories.firstSeenAt));
  const stories = logicalStories(storyRows);
  const funnelStories =
    since === null ? stories : logicalStories(storyRows.filter((r) => r.at >= since));
  check();
  const articleStops = await loadArticleStops(q, since, scope);
  check();
  const all = await q
    .select()
    .from(signalPaperTrades)
    .where(liveNews(scope))
    .orderBy(asc(signalPaperTrades.openedAt));
  const closed = all.filter((t) => t.status === "closed" && t.resultPct !== null);
  check();
  const gates = await loadClassifierGates(q);
  const statusOf = (t: TradeRow) => classifierStatusOf(gates, t.classifierVersion);
  const counted = closed.filter((t) => statusOf(t) === "passed");
  const notCounted = new Map<string | null, TradeRow[]>();
  for (const t of closed) {
    if (statusOf(t) === "passed") continue;
    notCounted.set(t.classifierVersion, [...(notCounted.get(t.classifierVersion) ?? []), t]);
  }
  const openRows = all.filter((t) => t.status !== "closed");
  const open = openRows.length;
  // #297: số dư = 10 000 + kết quả đã chốt; lãi / lỗ chưa chốt chỉ khi có giá SoDEX của MỌI lệnh đang mở.
  const px = await pricesOf(prices, openRows);
  const realized = paperBalance(
    all.flatMap((t) => (t.status === "closed" && t.resultUsdc !== null ? [t.resultUsdc] : [])),
  );
  const openPnls = openRows.map((t) => openPnl(t, px, now.getTime()));
  const unrealized =
    open === 0 || openPnls.some((x) => x === null)
      ? null
      : openPnls.reduce<Decimal>((acc, x) => acc.add(x ?? 0), new Decimal(0));
  // Phễu theo khoảng (#297): cùng đơn vị với `articleStops` (bài THU trong khoảng). Lệnh tính theo bài đã mở nó
  // (`seen_at` = giờ thu bài đó), không theo giờ mở lệnh, để Long + Short khớp số bài tới Decide.
  const inRange = since === null ? all : all.filter((t) => t.seenAt >= since);
  const steps = funnelSteps(articleStops);
  const closedInRange = inRange.filter((t) => t.status === "closed" && t.resultPct !== null);

  const drops = (stages: readonly string[]) => {
    const by = new Map<ResearchDropReason, number>();
    for (const g of grouped) {
      if (!stages.includes(g.stage) || g.outcome !== "drop" || g.reason === null) continue;
      const r = DROP.get(g.reason);
      // Trùng y hệt không phải "bị loại" ở tổng kết cũ (#271); feed bài đếm nó riêng trong `articleStops` (#291).
      if (r !== undefined && r !== "duplicate") by.set(r, (by.get(r) ?? 0) + g.n);
    }
    const reasons = [...by].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n);
    return { n: reasons.reduce((s, r) => s + r.n, 0), reasons };
  };

  // Random baseline đã lưu khi lệnh đóng (M4); khoảng 95% và cổng theo bootstrap ngày vào lệnh (M5, DEC-321).
  const at = (t: TradeRow) => t.openedAt.getTime();
  const obs = (rows: readonly TradeRow[], v: (t: TradeRow) => string | null): DayObs[] =>
    rows.flatMap((t) => {
      const x = v(t);
      return x === null ? [] : [{ v: dec(x), at: at(t) }];
    });
  const compare = (rows: readonly TradeRow[]) => {
    const results = obs(rows, (t) => t.resultPct);
    const after = summarizeByDay(results);
    const random = summarizeByDay(obs(rows, (t) => t.randomPct));
    const diff = summarizeByDay(
      obs(rows, (t) =>
        t.resultPct === null || t.randomPct === null
          ? null
          : dec(t.resultPct).sub(dec(t.randomPct)).toFixed(),
      ),
    );
    const avgCost =
      rows.length === 0
        ? null
        : rows.reduce((s, t) => s.add(costOf(t)), new Decimal(0)).div(rows.length);
    return {
      after,
      diff: diff.n === 0 ? null : diff,
      avgPct: num(after.mean),
      randomPct: num(random.mean),
      diffPct: num(diff.mean),
      range:
        after.ciLow === null || after.ciHigh === null
          ? null
          : { lo: num(after.ciLow) ?? 0, hi: num(after.ciHigh) ?? 0 },
      clusters: after.clusters,
      status: gateStatus({ results, avgCostPct: avgCost, difference: diff.n === 0 ? null : diff }),
    };
  };
  const overall = compare(counted);
  const weeksRunning =
    enabledSince === null ? null : Math.max((nowMs - enabledSince.getTime()) / (7 * DAY_MS), 1 / 7);

  const storiesAt = (lv: string) => stories.filter((s) => s.entry === lv).length;
  const funnelStoriesAt = (lv: string) => funnelStories.filter((s) => s.entry === lv).length;
  const levels: ResearchLevelRow[] = (["high", "medium", "low"] as const).map((lv) => {
    const trades = all.filter((t) => t.levelAtEntry === lv);
    const done = counted.filter((t) => t.levelAtEntry === lv);
    const c = compare(done);
    const needed = tradesNeeded(c.diff);
    return {
      level: lv,
      signals: storiesAt(lv),
      trades: trades.length,
      closed: done.length,
      long: trades.filter((t) => t.direction === "long").length,
      short: trades.filter((t) => t.direction === "short").length,
      laterHigh:
        lv === "high" ? null : stories.filter((s) => s.entry === lv && s.later === "high").length,
      avgPct: c.avgPct,
      randomPct: c.randomPct,
      diffPct: c.diffPct,
      status: c.status,
      needMore:
        done.length < GATE_MIN_CLOSED
          ? GATE_MIN_CLOSED - done.length
          : needed === null
            ? null
            : Math.max(0, needed - done.length),
    };
  });

  const sources: ResearchSummary["sources"] = [];
  for (const [key, api] of [
    ["sosovalue", "sosoNews"],
    ["claude", "claude"],
    ["sodex_prices", "sodexPrices"],
  ] as const) {
    const h = health.get(key);
    if (h === undefined) continue;
    sources.push({
      key: api,
      mode: "live",
      status: sourceStatus(key, h.lastOkAt, h.lastErrorAt, nowMs, h.lastError),
      lastAt: h.lastOkAt === null ? null : iso(h.lastOkAt),
      gap: null,
    });
  }
  const soso = health.get("sosovalue");
  // `1d`: chi phí của ngày UTC hiện tại (bảng ngày không chia được theo giờ); còn lại: trung bình 7 ngày có gọi Claude.
  const costs = usage
    .filter((u) => u.claudeCalls > 0 && (range !== "1d" || u.day === today))
    .map(dailyClaudeCostUsd);
  const avgEntryCost =
    all.length === 0
      ? null
      : all.reduce((s, t) => s.add(costOf(t)), new Decimal(0)).div(all.length);
  const on = enabledSince !== null;
  // #329: "Does context help?" trên cùng tập lệnh với cổng chính (lệnh đã đóng được tính).
  const context = on ? await loadContextSummary(q, scope, counted) : null;
  check();

  return {
    computedAt: iso(now),
    version:
      scope === null
        ? null
        : { id: scope.id, number: scope.number, name: scope.name, isBaseline: scope.isBaseline },
    sources,
    bots: on
      ? [
          {
            type: "news",
            mode: "live",
            state:
              soso?.lastCycleAt != null &&
              nowMs - soso.lastCycleAt.getTime() <= SOURCE_HEALTH.sosovalue.delayedMs
                ? "running"
                : "paused",
            balance: realized.toDecimalPlaces(6).toFixed(),
            realized: realized.sub(dec(RESEARCH_BOT_START_USDC)).toDecimalPlaces(6).toFixed(),
            unrealized: unrealized === null ? null : unrealized.toDecimalPlaces(6).toFixed(),
            openTrades: open,
            rulesVersion: NEWS_RULES.versionNumber,
            lastRun: null,
          },
        ]
      : [],
    funnel: on
      ? {
          days:
            range === "1d"
              ? 1
              : range === "7d"
                ? 7
                : Math.max(1, Math.ceil((nowMs - enabledSince.getTime()) / DAY_MS)),
          delayMedianSecs: delay?.secs == null ? null : Math.round(Number(delay.secs)),
          pollSecs: POLL_SECS,
          claudeCostPerDay:
            costs.length === 0
              ? null
              : costs
                  .reduce((s, c) => s.add(c), new Decimal(0))
                  .div(costs.length)
                  .toDecimalPlaces(4)
                  .toFixed(),
          articlesRead: articlesInRange?.n ?? null,
          soso: { used: Number(month?.n ?? 0), limit: limits.sosoMonthlyLimit },
          collected: steps[0]?.in ?? 0,
          stories: funnelStories.length,
          // #297: số bài (cùng đơn vị, cùng khoảng với `articleStops`), không phải số event.
          merged: steps[3]?.merged ?? 0,
          signals: steps[2]?.passed ?? 0,
          levels: {
            high: funnelStoriesAt("high"),
            medium: funnelStoriesAt("medium"),
            low: funnelStoriesAt("low"),
          },
          passed: steps[3]?.passed ?? 0,
          long: inRange.filter((t) => t.direction === "long").length,
          short: inRange.filter((t) => t.direction === "short").length,
          sizeUsdc: dec(scope?.config?.sizeUsdc ?? NEWS_RULES.sizeUsdc).toFixed(),
          drops: { score: drops(["normalize", "understand"]), filter: drops(["filter"]) },
          articleStops,
          outcomes: {
            closed: closedInRange.length,
            tp: closedInRange.filter((t) => t.exitReason === "take_profit").length,
            sl: closedInRange.filter((t) => t.exitReason === "stop_loss").length,
            maxHold: closedInRange.filter((t) => t.exitReason === "max_hold").length,
            opposite: closedInRange.filter((t) => t.exitReason === "opposite_news").length,
            open: inRange.filter((t) => t.status !== "closed").length,
          },
        }
      : null,
    newsRulesVersion: on ? NEWS_RULES.versionNumber : null,
    levels: on ? levels : [],
    costPct: num(avgEntryCost),
    rows: on
      ? [
          {
            type: "news",
            label: "live",
            rulesVersion: NEWS_RULES.versionNumber,
            closed: closed.length,
            opened: all.length,
            avgPct: overall.avgPct,
            randomPct: overall.randomPct,
            diffPct: overall.diffPct,
            range: overall.range,
            clusters: overall.clusters,
            status: overall.status,
            needs: needsOf({
              closed: counted.length,
              status: overall.status,
              after: overall.after,
              diff: overall.diff,
              weeksRunning,
            }),
            classifiers: {
              counted: counted.length,
              notCounted: [...notCounted].map(([version, rows]) => {
                const g =
                  version === null
                    ? null
                    : (gates.get(version) ?? classifierGate({ labeled: 0, right: 0 }));
                return {
                  classifierVersion: version,
                  closed: rows.length,
                  status: g === null ? ("unknown" as const) : g.status,
                  labeled: g?.labeled ?? 0,
                  precisionPct: g?.precisionPct ?? null,
                  labelsToGo: g?.labelsToGo ?? null,
                };
              }),
            },
          },
        ]
      : [],
    directions: on
      ? (["long", "short"] as const).map((side) => {
          const c = compare(counted.filter((t) => t.direction === side));
          return {
            side,
            closed: c.after.n,
            avgPct: c.avgPct,
            randomPct: c.randomPct,
            diffPct: c.diffPct,
            range: c.range,
            clusters: c.clusters,
          };
        })
      : [],
    risk: null,
    assets: [...new Set(all.map((t) => t.market))].sort(),
    context,
  };
}

/** Số liệu thô cho CLI: lý do nội bộ, phân bố loại tin, Claude theo ngày, baseline. */
export async function loadSignalResearchDiagnostics(q: Q, now: Date) {
  const v = NEWS_RULES.version;
  const steps = await q
    .select({
      stage: signalEvents.stage,
      outcome: signalEvents.outcome,
      reason: signalEvents.reason,
      n: count(),
    })
    .from(signalEvents)
    .where(eq(signalEvents.ruleVersion, v))
    .groupBy(signalEvents.stage, signalEvents.outcome, signalEvents.reason)
    .orderBy(signalEvents.stage, signalEvents.outcome, desc(count()));
  const catalyst = sql<string>`${signalArticles.classification}->>'catalyst'`;
  const catalysts = await q
    .select({ catalyst, n: count() })
    .from(signalArticles)
    .where(
      and(eq(signalArticles.ruleVersion, v), sql`${signalArticles.classification} ? 'catalyst'`),
    )
    .groupBy(catalyst)
    .orderBy(desc(count()));
  const usage = await q
    .select()
    .from(signalResearchUsage)
    .where(gte(signalResearchUsage.day, utcDay(now.getTime() - 6 * DAY_MS)))
    .orderBy(desc(signalResearchUsage.day));
  const closed = (
    await q
      .select()
      .from(signalPaperTrades)
      // #305: baseline của CLI chỉ tính lệnh Baseline, như tổng kết mặc định.
      .where(liveNews(await resolveSignalVersion(q, undefined)))
      .orderBy(asc(signalPaperTrades.openedAt))
  ).filter((t) => t.status === "closed");
  const withRandom = closed.filter((t) => t.randomPct !== null && t.resultPct !== null);
  const s = (vals: (t: TradeRow) => string | null) => {
    const r = summarizeByDay(
      withRandom.flatMap((t) => {
        const x = vals(t);
        return x === null ? [] : [{ v: dec(x), at: t.openedAt.getTime() }];
      }),
    );
    return r.n === 0
      ? null
      : {
          n: r.n,
          clusters: r.clusters,
          meanPct: num(r.mean),
          lowPct: num(r.ciLow),
          highPct: num(r.ciHigh),
        };
  };
  const lastShare = closed.findLast((t) => t.randomLongShare !== null)?.randomLongShare ?? null;
  return {
    steps,
    catalysts,
    claudeDays: usage.map((u) => ({
      day: u.day,
      sosoRequests: u.sosoRequests,
      calls: u.claudeCalls,
      inputTokens: u.claudeInputTokens,
      cacheWriteTokens: u.claudeCacheWriteTokens,
      cacheReadTokens: u.claudeCacheReadTokens,
      outputTokens: u.claudeOutputTokens,
      costUsd: dailyClaudeCostUsd(u).toDecimalPlaces(4).toFixed(),
    })),
    /** Lưu thô, không phân loại (cũ hơn mốc dưới của Collect): nhóm đếm riêng, không phải "bị loại". */
    backlog: steps
      .filter((x) => x.stage === "collect" && x.outcome === "backlog")
      .reduce((a, x) => a + x.n, 0),
    baseline: {
      n: withRandom.length,
      /** Đã đóng nhưng chưa có random: chờ hết cửa sổ giữ, hoặc thiếu nến. */
      pending: closed.filter((t) => t.randomDoneAt === null).length,
      missingCandles: closed.filter((t) => t.randomDoneAt !== null && t.randomPct === null).length,
      latestLongShare: numOf(lastShare),
      newsResult: s((t) => t.resultPct),
      randomEntry: s((t) => t.randomPct),
      difference: s((t) =>
        t.resultPct === null || t.randomPct === null
          ? null
          : dec(t.resultPct).sub(dec(t.randomPct)).toFixed(),
      ),
    },
  };
}

// ── Danh sách lệnh / tín hiệu bị bỏ ───────────────────────────────────────────────────────────────────────────────

interface Ctx {
  articles: Map<string, ArticleRow>;
  stories: Map<string, StoryRow>;
  /** #304: cổng precision theo classifier. */
  gates: ReadonlyMap<string, ClassifierGate>;
  /** #305: config (bất biến) của mọi version, để lấy giới hạn / bội số chi phí của đúng version. */
  configs: ReadonlyMap<string, BotVersionConfig>;
  /** #305: lệnh shadow theo id (tín hiệu bị giới hạn chặn). */
  shadows: ReadonlyMap<string, TradeRow>;
}

async function contextOf(
  q: Q,
  articleIds: readonly string[],
  storyIds: readonly string[],
  shadowIds: readonly string[] = [],
): Promise<Ctx> {
  const a =
    articleIds.length === 0
      ? []
      : await q
          .select()
          .from(signalArticles)
          .where(inArray(signalArticles.id, [...new Set(articleIds)]));
  const s =
    storyIds.length === 0
      ? []
      : await q
          .select()
          .from(signalStories)
          .where(inArray(signalStories.id, [...new Set(storyIds)]));
  const sh =
    shadowIds.length === 0
      ? []
      : await q
          .select()
          .from(signalPaperTrades)
          .where(
            and(
              inArray(signalPaperTrades.id, [...new Set(shadowIds)]),
              eq(signalPaperTrades.label, "shadow"),
            ),
          );
  const configs = new Map<string, BotVersionConfig>();
  for (const r of await q
    .select({ id: signalBotVersions.id, config: signalBotVersions.config })
    .from(signalBotVersions)) {
    const p = botVersionConfigSchema.safeParse(r.config);
    if (p.success) configs.set(r.id, p.data);
  }
  return {
    articles: new Map(a.map((x) => [x.id, x])),
    stories: new Map(s.map((x) => [x.id, x])),
    gates: await loadClassifierGates(q),
    configs,
    shadows: new Map(sh.map((x) => [x.id, x])),
  };
}

const SHADOW_REASON: ReadonlyMap<string, "limitOpen" | "limitDay" | "noBalance"> = new Map([
  ["LIMIT_OPEN", "limitOpen"],
  ["LIMIT_DAY", "limitDay"],
  ["NO_BALANCE", "noBalance"],
] as const);

/** Lý do + N của "Limit: N open" / "Limit: N per day" của một lệnh shadow, từ config bất biến của version. */
function shadowOf(t: TradeRow, ctx: Ctx): ResearchTrade["shadow"] {
  if (t.label !== "shadow") return null;
  const reason = t.shadowReason === null ? undefined : SHADOW_REASON.get(t.shadowReason);
  if (reason === undefined) return null;
  const cfg = t.versionId === null ? undefined : ctx.configs.get(t.versionId);
  const limit =
    reason === "limitOpen"
      ? (cfg?.maxOpenTrades ?? null)
      : reason === "limitDay"
        ? (cfg?.maxNewTradesPerDay ?? null)
        : null;
  return { reason, limit };
}

function headlineOf(a: ArticleRow | undefined): string {
  const title = a?.title?.trim() ?? "";
  return title !== "" ? title : (a?.content ?? "").slice(0, 140).trim();
}

function whatOf(
  story: StoryRow | undefined,
  a: ArticleRow | undefined,
  catalyst: string,
  entrySources: unknown,
) {
  const atEntry = distinctSources(entrySources);
  const later = story === undefined ? 0 : distinctSources(story.sources);
  return {
    type: "news" as const,
    headline: headlineOf(a),
    newsType: newsTypeOf(catalyst),
    levelAtEntry: story === undefined ? null : level(story.levelAtEntry),
    sources: atEntry === 0 ? null : atEntry,
    topTier: atEntry === 0 ? null : topSources(entrySources),
    later:
      story === undefined || later <= atEntry
        ? null
        : { level: level(story.laterLevel), sources: later },
  };
}

function outcomeOf(r: string | null): "tp" | "sl" | "maxHold" | "opposite" | "open" {
  if (r === "take_profit") return "tp";
  if (r === "stop_loss") return "sl";
  if (r === "max_hold") return "maxHold";
  // #303: News bot version chọn "Close at market" khi có tin ngược chiều.
  if (r === "opposite_news") return "opposite";
  return "open";
}

function tradeItem(t: TradeRow, ctx: Ctx, now: number, px: SrQuotesSnapshot = {}): ResearchTrade {
  const a = t.articleId === null ? undefined : ctx.articles.get(t.articleId);
  const story = t.storyId === null ? undefined : ctx.stories.get(t.storyId);
  const done = t.status === "closed";
  return {
    id: t.id,
    versionId: t.versionId,
    articleId: t.articleId,
    type: "news",
    label: "live",
    asset: t.market,
    side: side(t.direction),
    seenAt: iso(t.seenAt),
    delayKind: "afterRelease",
    delaySecs: Math.max(0, Math.round((t.seenAt.getTime() - t.eventAt.getTime()) / 1000)),
    what: whatOf(story, a, t.catalyst, t.sourcesAtEntry),
    skipped: null,
    retry: t.retry,
    movedBeforePct: numOf(t.movedBeforeEntryPct),
    entry: decOut(t.entryPrice),
    tp: decOut(t.tpPrice),
    tpPct: numOf(t.tpPct),
    sl: decOut(t.slPrice),
    slPct: numOf(t.slPct),
    maxHoldHours: Math.round((t.maxHoldUntil.getTime() - t.openedAt.getTime()) / 3_600_000),
    classifier: {
      version: t.classifierVersion,
      status: classifierStatusOf(ctx.gates, t.classifierVersion),
    },
    result: {
      pnl: done && t.resultUsdc !== null ? dec(t.resultUsdc).toDecimalPlaces(6).toFixed() : null,
      unrealized: openPnl(t, px, now)?.toDecimalPlaces(6).toFixed() ?? null,
      outcome: outcomeOf(t.exitReason),
      leftSecs: done ? null : Math.max(0, Math.round((t.maxHoldUntil.getTime() - now) / 1000)),
    },
    shadow: shadowOf(t, ctx),
    opposite: oppositeOf(t),
  };
}

function skippedItem(e: EventRow, ctx: Ctx): ResearchTrade | null {
  const story = e.storyId === null ? undefined : ctx.stories.get(e.storyId);
  const a = e.articleId === null ? undefined : ctx.articles.get(e.articleId);
  const reason = e.reason === null ? undefined : DROP.get(e.reason);
  if (story === undefined || a === undefined || reason === undefined) return null;
  const d = filterDetail.safeParse(e.detail ?? {});
  const tp = d.success && d.data.tpPct !== undefined ? numOf(d.data.tpPct) : null;
  const cost = d.success && d.data.costPct !== undefined ? dec(d.data.costPct) : null;
  const multiple =
    (e.versionId === null ? undefined : ctx.configs.get(e.versionId))?.minTpCostMultiple ??
    NEWS_RULES.minTpCostMultiple;
  const sh =
    e.tradeId !== null && e.reason !== null && SHADOW_REASON.has(e.reason)
      ? ctx.shadows.get(e.tradeId)
      : undefined;
  return {
    id: e.id,
    versionId: e.versionId,
    articleId: e.articleId,
    type: "news",
    label: "live",
    asset: story.market,
    side: side(story.direction),
    seenAt: iso(a.collectedAt),
    delayKind: "afterRelease",
    delaySecs: Math.max(0, Math.round((a.collectedAt.getTime() - a.publishedAt.getTime()) / 1000)),
    what: whatOf(story, a, story.catalyst, story.sources),
    skipped: {
      reason,
      tpPct: tp,
      neededPct: cost === null ? null : num(cost.mul(multiple)),
      limit: reasonLimitOf(e.reason, e.detail),
      shadow:
        sh === undefined
          ? null
          : {
              tradeId: sh.id,
              outcome: outcomeOf(sh.exitReason),
              pnl:
                sh.status === "closed" && sh.resultUsdc !== null
                  ? dec(sh.resultUsdc).toDecimalPlaces(6).toFixed()
                  : null,
            },
    },
    retry: false,
    movedBeforePct: null,
    entry: null,
    tp: null,
    tpPct: tp,
    sl: null,
    slPct: null,
    maxHoldHours: null,
    classifier: null,
    result: null,
    shadow: null,
    opposite: null,
  };
}

const cursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() });
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
 * Danh sách (mới nhất trước), phân trang bằng cursor (thời điểm, id). `entered` = lệnh giấy; `skipped` = tín hiệu bị
 * bỏ ở Filter kèm lý do; `all` = cả hai, trộn theo thời điểm. Loại / nhãn chưa có dữ liệu (replay) → trang rỗng.
 * Cursor hỏng → 400.
 */
export async function loadSignalResearchTrades(
  q: Q,
  query: ResearchTradesQuery,
  now: Date,
  prices?: ExitQuotes,
): Promise<ResearchTradesPage> {
  // Version không tồn tại → 404 kể cả khi loại / nhãn không có dữ liệu.
  const scope = await resolveSignalVersion(q, query.versionId);
  if ((query.type !== undefined && query.type !== "news") || query.label === "replay")
    return { items: [], nextCursor: null };
  const cur = query.cursor === undefined ? null : decodeCursor(query.cursor);
  const take = query.limit + 1;
  interface Row {
    t: Date;
    id: string;
    trade?: TradeRow;
    event?: EventRow;
  }
  const rows: Row[] = [];
  if (query.show !== "skipped") {
    const where: (SQL | undefined)[] = [liveNewsHistory(), versionTradeWhere(scope)];
    if (query.asset !== undefined) where.push(eq(signalPaperTrades.market, query.asset));
    if (cur !== null)
      where.push(
        or(
          lt(signalPaperTrades.openedAt, cur.t),
          and(eq(signalPaperTrades.openedAt, cur.t), lt(signalPaperTrades.id, cur.id)),
        ),
      );
    const ts = await q
      .select()
      .from(signalPaperTrades)
      .where(and(...where))
      .orderBy(desc(signalPaperTrades.openedAt), desc(signalPaperTrades.id))
      .limit(take);
    rows.push(...ts.map((trade) => ({ t: trade.openedAt, id: trade.id, trade })));
  }
  if (query.show !== "entered") {
    const where: (SQL | undefined)[] = [
      eq(signalEvents.stage, "filter"),
      eq(signalEvents.outcome, "drop"),
      versionEventWhere(scope),
    ];
    if (query.asset !== undefined)
      where.push(
        sql`${signalEvents.storyId} in (select ${signalStories.id} from ${signalStories} where ${signalStories.market} = ${query.asset})`,
      );
    if (cur !== null)
      where.push(
        or(
          lt(signalEvents.at, cur.t),
          and(eq(signalEvents.at, cur.t), lt(signalEvents.id, cur.id)),
        ),
      );
    const es = await q
      .select()
      .from(signalEvents)
      .where(and(...where))
      .orderBy(desc(signalEvents.at), desc(signalEvents.id))
      .limit(take);
    rows.push(...es.map((event) => ({ t: event.at, id: event.id, event })));
  }
  rows.sort((a, b) => b.t.getTime() - a.t.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const page = rows.slice(0, query.limit);
  const ids = (pick: (r: Row) => string | null | undefined) =>
    page.map(pick).filter((x): x is string => typeof x === "string");
  const ctx = await contextOf(
    q,
    ids((r) => r.trade?.articleId ?? r.event?.articleId),
    ids((r) => r.trade?.storyId ?? r.event?.storyId),
    ids((r) => r.event?.tradeId),
  );
  const nowMs = now.getTime();
  const px = await pricesOf(
    prices,
    page.flatMap((r) => (r.trade === undefined ? [] : [r.trade])),
  );
  const items = page.flatMap((r) => {
    if (r.trade !== undefined) return [tradeItem(r.trade, ctx, nowMs, px)];
    const s = r.event === undefined ? null : skippedItem(r.event, ctx);
    return s === null ? [] : [s];
  });
  const last = page.at(-1);
  return {
    items,
    nextCursor:
      rows.length > query.limit && last !== undefined ? encodeCursor(last.t, last.id) : null,
  };
}

// ── Chi tiết ──────────────────────────────────────────────────────────────────────────────────────────────────────

type CheckKey = "sourceLive" | "newStory" | "priceAvailable" | "noOpenTrade" | "tpVsCost";
const CHECK_ORDER: readonly CheckKey[] = [
  "sourceLive",
  "newStory",
  "priceAvailable",
  "noOpenTrade",
  "tpVsCost",
];
const FAILED_CHECK: ReadonlyMap<string, CheckKey> = new Map<string, CheckKey>([
  ["SOURCE_LATE", "sourceLive"],
  ["SAME_STORY", "newStory"],
  ["NO_SODEX_PRICE", "priceAvailable"],
  ["NO_BOOK_DATA", "priceAvailable"],
  ["NOT_ENOUGH_HISTORY", "priceAvailable"],
  ["NEWS_TRADE_ALREADY_OPEN", "noOpenTrade"],
  ["TOO_THIN_TO_TRADE", "tpVsCost"],
  ["MOVE_TOO_SMALL_FOR_COST", "tpVsCost"],
]);

function stepsOf(input: {
  a: ArticleRow;
  story: StoryRow;
  trade: TradeRow | null;
  skip: EventRow | null;
}): ResearchStep[] {
  const { a, story, trade, skip } = input;
  const blank = { score: null, level: null, parts: [], checks: [], notes: [] };
  const nEntry = distinctSources(trade === null ? story.sources : trade.sourcesAtEntry);
  const nLater = distinctSources(story.sources);
  const cls = classification.safeParse(a.classification);
  const steps: ResearchStep[] = [
    {
      ...blank,
      key: "received",
      facts: [
        { key: "published", at: iso(a.publishedAt) },
        {
          key: "collected",
          at: iso(a.collectedAt),
          secs: Math.max(0, Math.round((a.collectedAt.getTime() - a.publishedAt.getTime()) / 1000)),
        },
        { key: "source", text: a.source, source: "sosoNews" },
      ],
    },
    {
      ...blank,
      key: "understood",
      level: level(story.levelAtEntry),
      facts: [
        { key: "newsType", newsType: newsTypeOf(story.catalyst) },
        { key: "market", text: story.market },
        { key: "direction", side: side(story.direction) },
        { key: "eventDate", text: cls.success ? (cls.data.eventDate ?? null) : null },
        { key: "levelAtEntry", level: level(story.levelAtEntry), n: nEntry },
        ...(nLater > nEntry
          ? [{ key: "laterLevel" as const, level: level(story.laterLevel), n: nLater }]
          : []),
      ],
    },
  ];
  const failed = skip?.reason == null ? null : (FAILED_CHECK.get(skip.reason) ?? null);
  const d = filterDetail.safeParse(skip?.detail ?? {});
  const fromDetail = (k: "tpPct" | "costPct") =>
    d.success && d.data[k] !== undefined ? numOf(d.data[k]) : null;
  const checks: ResearchStep["checks"] = [];
  for (const key of CHECK_ORDER) {
    const ok = failed !== key;
    if (key === "tpVsCost")
      checks.push({
        key,
        ok,
        pct: trade !== null ? numOf(trade.tpPct) : fromDetail("tpPct"),
        cost: trade !== null ? num(costOf(trade)) : fromDetail("costPct"),
      });
    else checks.push({ key, ok });
    if (!ok) break;
  }
  steps.push({ ...blank, key: "checks", checks, facts: [] });
  if (trade === null) return steps;
  steps.push({
    ...blank,
    key: "trade",
    facts: [
      { key: "entry", price: decOut(trade.entryPrice), at: iso(trade.openedAt) },
      { key: "size", usd: dec(trade.sizeUsdc).toFixed() },
      { key: "tp", price: decOut(trade.tpPrice), pct: numOf(trade.tpPct) },
      { key: "sl", price: decOut(trade.slPrice), pct: numOf(trade.slPct) },
      {
        key: "maxHold",
        hours: Math.round((trade.maxHoldUntil.getTime() - trade.openedAt.getTime()) / 3_600_000),
        at: iso(trade.maxHoldUntil),
      },
      { key: "movedBeforeEntry", pct: numOf(trade.movedBeforeEntryPct) },
    ],
  });
  if (trade.status !== "closed") return steps;
  const fees =
    trade.exitFee === null
      ? null
      : dec(trade.entryFee).add(dec(trade.exitFee)).toDecimalPlaces(6).toFixed();
  const exitOutcome = outcomeOf(trade.exitReason);
  const grossPct =
    trade.exitPrice === null
      ? null
      : dec(trade.exitPrice)
          .sub(dec(trade.entryPrice))
          .div(dec(trade.entryPrice))
          .mul(100)
          .mul(trade.direction === "short" ? -1 : 1);
  const grossUsd =
    trade.exitPrice === null
      ? null
      : dec(trade.exitPrice)
          .sub(dec(trade.entryPrice))
          .mul(dec(trade.qty))
          .mul(trade.direction === "short" ? -1 : 1);
  const facts: ResearchFact[] = [
    {
      key: "exit",
      price: decOut(trade.exitPrice),
      at: trade.exitedAt === null ? null : iso(trade.exitedAt),
      outcome: exitOutcome === "open" ? null : exitOutcome,
      usd: trade.resultUsdc === null ? null : dec(trade.resultUsdc).toDecimalPlaces(6).toFixed(),
      pct: numOf(trade.resultPct),
    },
    // Giá đã chạy từ lúc vào tới lúc ra theo chiều lệnh, và kết quả tiền trước phí.
    {
      key: "priceMove",
      pct: grossPct === null ? null : num(grossPct),
      usd: grossUsd === null ? null : grossUsd.toDecimalPlaces(6).toFixed(),
    },
    // Phí là chi phí dương (phí vào + ra); web tự hiện dấu trừ.
    { key: "fees", usd: fees },
    // MFE / MAE theo giá giữa, % theo chiều lệnh; null khi chưa đo được.
    { key: "best", pct: numOf(trade.mfePct) },
    { key: "worst", pct: numOf(trade.maePct) },
    { key: "random", pct: numOf(trade.randomPct) },
  ];
  steps.push({ ...blank, key: "result", facts });
  return steps;
}

/** Một lệnh giấy (id lệnh) hoặc một tín hiệu bị bỏ ở Filter (id event) và các bước nó đã đi qua. null = không có. */
export async function loadSignalResearchTrade(
  q: Q,
  id: string,
  now: Date,
  prices?: ExitQuotes,
): Promise<ResearchTradeDetail | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [trade] = await q
    .select()
    .from(signalPaperTrades)
    .where(and(eq(signalPaperTrades.id, id), newsTradeOrShadow()));
  let skip: EventRow | null = null;
  if (trade === undefined) {
    const [e] = await q
      .select()
      .from(signalEvents)
      .where(
        and(
          eq(signalEvents.id, id),
          eq(signalEvents.stage, "filter"),
          eq(signalEvents.outcome, "drop"),
        ),
      );
    if (e === undefined) return null;
    skip = e;
  }
  const articleId = trade?.articleId ?? skip?.articleId ?? null;
  const storyId = trade?.storyId ?? skip?.storyId ?? null;
  if (articleId === null || storyId === null) return null;
  const ctx = await contextOf(
    q,
    [articleId],
    [storyId],
    skip?.tradeId == null ? [] : [skip.tradeId],
  );
  const a = ctx.articles.get(articleId);
  const story = ctx.stories.get(storyId);
  if (a === undefined || story === undefined) return null;

  const item =
    trade !== undefined
      ? tradeItem(trade, ctx, now.getTime(), await pricesOf(prices, [trade]))
      : skip === null
        ? null
        : skippedItem(skip, ctx);
  if (item === null) return null;
  const end = trade?.exitedAt?.getTime() ?? now.getTime();
  return {
    trade: item,
    rulesVersion: versionNumberOf(trade?.ruleVersion ?? story.ruleVersion),
    sizeUsdc: trade === undefined ? null : dec(trade.sizeUsdc).toFixed(),
    heldSecs:
      trade === undefined ? null : Math.max(0, Math.round((end - trade.openedAt.getTime()) / 1000)),
    steps: stepsOf({ a, story, trade: trade ?? null, skip }),
  };
}
