import { createHash } from "node:crypto";

import { signalArticles, signalPaperTrades, signalStories, type Db } from "@drift/db";
import {
  AssetKind,
  candidatesOf,
  catalystRule,
  costCheck,
  eventTooOld,
  isUsMarketOpen,
  levelOf,
  movedPct,
  NEWS_RULES,
  normalizedText,
  oneWayFeePct,
  planTrade,
  roundToTick,
  roundTripCost,
  SignalLevel,
  SignalOutcome,
  SignalReason,
  SignalStage,
  sourceTierOf,
  spreadPctOf,
  STOCK_MARKET_SET,
  storyKey,
  stripHtml,
  type Candidate,
  type Quote,
  type SignalCatalyst,
  type SourceTier,
} from "@drift/shared";
import { and, asc, eq, gte, inArray } from "drizzle-orm";
import { z } from "zod";

import { fillRandomBaselines } from "./baseline";
import {
  addUsage,
  articleUsageValues,
  weightedInput,
  type ArticleUsageValues,
  type NewsClassifier,
} from "./classifier";
import { SOSO_PAGE_SIZE, type SosoClient, type SosoNewsItem } from "./soso";
import {
  addClaudeUsage,
  addSosoRequests,
  markSource,
  newsState,
  priceBefore,
  recordEvents,
  saveNewsState,
  sosoRequestsThisMonth,
  typicalMove,
  usageToday,
  type EventInput,
} from "./store";

// Một chu kỳ của lane tin tức (#271, flow #269 v3.4): Collect → Normalize → Understand → Filter → Decide. Chỉ ghi DB của
// DeskLabs; lệnh là lệnh giấy (bảng signal_paper_trades), không có đường nào tới SoDEX.
// Chưa có danh sách market SoDEX (vừa nhận lease, SoDEX lỗi) → chu kỳ chỉ Collect: bài nằm ở trạng thái `collected` và
// được Normalize ở chu kỳ sau. Không bao giờ dò danh sách market bằng `candles_1m` (review PR #278 B1).

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const CONTENT_MAX = 6000;
/** Số lần gọi API tối đa cho một bài (lần đầu + thử lại một lần). */
const ATTEMPTS = 2;

export interface MarketInfo {
  name: string;
  tickSize: string | null;
  /** `takerFee` (tỷ lệ thô) của market; null = dùng phí mặc định. */
  takerFee: string | null;
}

export interface PipelineConfig {
  /** Đơn vị ngân sách ngày (token đầu vào quy đổi theo giá, `weightedInput`). */
  claudeDailyInputBudget: number;
  /** Số lần gọi API Claude tối đa mỗi chu kỳ, kể cả thử lại. */
  claudeMaxCallsPerCycle: number;
  sosoMaxPages: number;
  sosoMonthlyLimit: number;
  startLookbackMinutes: number;
  maxCatchUpMinutes: number;
}

export interface PipelineLog {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export interface PipelineDeps {
  db: Db;
  soso: SosoClient;
  classifier: NewsClassifier;
  quotes: { quotes: (markets: readonly string[]) => Promise<Map<string, Quote | SignalReason>> };
  /** Danh sách perps SoDEX đang giao dịch; null = chưa biết (chỉ Collect). */
  markets: () => MarketInfo[] | null;
  now: () => number;
  log: PipelineLog;
  config: PipelineConfig;
  /** Gọi sau khi mở lệnh (để watcher nạp lại ngay). */
  onTradeOpened?: () => void;
}

export interface CycleReport {
  fetched: number;
  stored: number;
  backlog: number;
  pages: number;
  normalized: number;
  classified: number;
  claudeCalls: number;
  signals: number;
  opened: number;
  baselines: number;
  /** `MARKETS_UNKNOWN` khi chu kỳ chỉ Collect. */
  collectOnly: string | null;
  skipped: Record<string, number>;
  watermarkAt: string | null;
  error?: string;
}

const candidateList = z.array(
  z.object({ symbol: z.string(), market: z.string(), kind: z.enum(["crypto", "stock"]) }),
);
const matchedList = z.array(z.object({ symbol: z.string(), name: z.string().nullable() }));

interface Signal {
  articleId: string;
  source: string;
  tier: SourceTier;
  publishedAt: number;
  collectedAt: number;
  title: string | null;
  candidate: Candidate;
  catalyst: SignalCatalyst;
}

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Mốc dưới của Collect, theo giờ DeskLabs chạy chu kỳ (không theo giờ đăng, để bài SoSoValue đưa lên trễ vẫn được phân
 * loại): lần đầu now − lookback (15 phút); sau đó `lastCycleAt − biên` (30 phút), không bao giờ cũ hơn now − maxCatchUp
 * (30 phút) kể cả sau thời gian ngừng.
 */
export function collectFloor(lastCycleAt: number | null, now: number, cfg: PipelineConfig): number {
  if (lastCycleAt === null) return now - cfg.startLookbackMinutes * MIN_MS;
  return Math.max(
    now - cfg.maxCatchUpMinutes * MIN_MS,
    lastCycleAt - NEWS_RULES.collectMarginMinutes * MIN_MS,
  );
}

export async function runNewsCycle(deps: PipelineDeps): Promise<CycleReport> {
  const { db, config: cfg } = deps;
  const now = deps.now();
  const skipped: Record<string, number> = {};
  const skip = (r: SignalReason) => {
    skipped[r] = (skipped[r] ?? 0) + 1;
  };
  const report: CycleReport = {
    fetched: 0,
    stored: 0,
    backlog: 0,
    pages: 0,
    normalized: 0,
    classified: 0,
    claudeCalls: 0,
    signals: 0,
    opened: 0,
    baselines: 0,
    collectOnly: null,
    skipped,
    watermarkAt: null,
  };

  // ── 1. Collect ────────────────────────────────────────────────────────────────────────────────────────────────
  const state = await newsState(db);
  const floor = collectFloor(state.lastCycleAt, now, cfg);
  const fetched: SosoNewsItem[] = [];
  let sourceError: string | null = null;
  for (let page = 1; page <= cfg.sosoMaxPages; page += 1) {
    if ((await sosoRequestsThisMonth(db, now)) >= cfg.sosoMonthlyLimit) {
      sourceError = "monthly_quota";
      break;
    }
    await addSosoRequests(db, now, 1);
    report.pages += 1;
    try {
      const p = await deps.soso.newsPage(page);
      fetched.push(...p.items);
      const known = await knownIds(
        db,
        p.items.map((i) => i.id),
      );
      // Trang sau chỉ khi trang đầy, cả trang đều mới và đều sau mốc dưới.
      const more =
        p.items.length >= SOSO_PAGE_SIZE &&
        p.items.every((i) => i.release_time > floor && !known.has(i.id));
      if (!more) break;
    } catch (e) {
      sourceError = e instanceof Error ? e.message : "error";
      break;
    }
  }
  const sourceOk = sourceError === null || fetched.length > 0;
  if (!sourceOk) {
    await markSource(db, "sosovalue", now, sourceError);
    deps.log.warn({ error: sourceError }, "signal research: sosovalue unavailable");
    report.error = sourceError ?? "error";
  } else await markSource(db, "sosovalue", now, null);
  report.fetched = fetched.length;

  const known = await knownIds(
    db,
    fetched.map((i) => i.id),
  );
  const fresh = [
    ...new Map(fetched.filter((i) => !known.has(i.id)).map((i) => [i.id, i])).values(),
  ].sort((a, b) => a.release_time - b.release_time);
  const events: EventInput[] = [];
  let watermark = state.watermarkAt ?? floor;
  const rows: (typeof signalArticles.$inferInsert)[] = [];
  for (const item of fresh) {
    const backlog = item.release_time <= floor;
    rows.push({
      id: item.id,
      source: (item.author ?? "").trim() || "unknown",
      url: item.original_link ?? item.source_link ?? null,
      title: item.title ?? null,
      content: stripHtml(item.content ?? "").slice(0, CONTENT_MAX),
      category: item.category ?? null,
      publishedAt: new Date(item.release_time),
      collectedAt: new Date(now),
      matchedCurrencies: item.matched_currencies,
      candidates: [],
      contentHash: hashOf(normalizedText(item.title ?? null, item.content ?? null)),
      status: backlog ? "backlog" : "collected",
      ruleVersion: NEWS_RULES.version,
    });
    if (backlog) {
      // Lưu thô, không phân loại, không giao dịch: một nhóm đếm riêng, không phải "bị loại".
      events.push({
        articleId: item.id,
        stage: SignalStage.collect,
        outcome: SignalOutcome.backlog,
        reason: SignalReason.backlog,
        at: now,
      });
      report.backlog += 1;
      continue;
    }
    watermark = Math.max(watermark, item.release_time);
    events.push({
      articleId: item.id,
      stage: SignalStage.collect,
      outcome: SignalOutcome.pass,
      detail: { delaySeconds: Math.round((now - item.release_time) / 1000) },
      at: now,
    });
  }
  await db.transaction(async (tx) => {
    if (rows.length > 0) await tx.insert(signalArticles).values(rows).onConflictDoNothing();
    await recordEvents(tx, events);
    if (sourceOk) await saveNewsState(tx, watermark, now);
  });
  report.stored = rows.length;
  report.watermarkAt = new Date(watermark).toISOString();

  // Random baseline của lệnh đã đóng (không cần danh sách market).
  report.baselines = await fillRandomBaselines(db, now);

  const markets = deps.markets();
  if (markets === null || markets.length === 0) {
    report.collectOnly = SignalReason.marketsUnknown;
    deps.log.warn(
      { reason: SignalReason.marketsUnknown, stored: report.stored },
      "signal research: SoDEX market list not known yet, collect only",
    );
    await logCycle(deps, report, now);
    return report;
  }
  const universe = new Set(markets.map((m) => m.name));
  const info = new Map(markets.map((m) => [m.name, m]));

  // ── 2. Normalize (mọi bài `collected`, kể cả của chu kỳ chỉ Collect trước đó) ─────────────────────────────────
  report.normalized = await normalizeCollected(db, universe, now, skip);

  // ── 3. Understand (FIFO, tối đa N lần gọi API / chu kỳ kể cả thử lại, trong ngân sách ngày) ───────────────────
  const pending = await db
    .select()
    .from(signalArticles)
    .where(
      and(eq(signalArticles.status, "pending"), eq(signalArticles.ruleVersion, NEWS_RULES.version)),
    )
    .orderBy(asc(signalArticles.publishedAt), asc(signalArticles.id));
  const signals: Signal[] = [];
  let used = await usageToday(db, now);
  let calls = 0;
  for (const a of pending) {
    const age = now - a.publishedAt.getTime();
    // Usage Claude của riêng bài này (#290); ghi cùng lần cập nhật trạng thái bài. Bài bỏ trước Claude để null.
    let claude: ArticleUsageValues | null = null;
    const drop = async (
      reason: SignalReason,
      classification: Record<string, unknown> | null,
      storyId: string | null = null,
    ) => {
      await db.transaction(async (tx) => {
        await tx
          .update(signalArticles)
          .set({
            status: classification === null ? "dropped" : "classified",
            classification,
            classifiedAt: classification === null ? null : new Date(now),
            ...claude,
          })
          .where(eq(signalArticles.id, a.id));
        await recordEvents(tx, [
          {
            articleId: a.id,
            storyId,
            stage: SignalStage.understand,
            outcome: SignalOutcome.drop,
            reason,
            detail: classification,
            at: now,
          },
        ]);
      });
      skip(reason);
    };
    if (age > NEWS_RULES.maxArticleAgeHours * HOUR_MS) {
      await drop(SignalReason.staleNews, null);
      continue;
    }
    if (age > NEWS_RULES.maxSourceDelayMinutes * MIN_MS) {
      await drop(SignalReason.classifierLate, null);
      continue;
    }
    const left = cfg.claudeMaxCallsPerCycle - calls;
    if (left <= 0) continue; // chờ chu kỳ sau (FIFO)
    if (weightedInput(used) >= cfg.claudeDailyInputBudget) {
      await drop(SignalReason.claudeBudget, null);
      await markSource(db, "claude", now, "daily_budget");
      continue;
    }
    const parsed = candidateList.safeParse(a.candidates);
    const candidates: Candidate[] = parsed.success ? parsed.data : [];
    const out = await deps.classifier.classify(
      {
        title: a.title,
        content: a.content ?? "",
        source: a.source,
        publishedAt: a.publishedAt.getTime(),
        candidates,
        universe: [...universe].sort(),
      },
      Math.min(ATTEMPTS, left),
    );
    calls += Math.max(1, out.usage.calls);
    claude = articleUsageValues(out);
    await addClaudeUsage(db, now, out.usage);
    used = { ...used, ...addUsage(used, out.usage) };
    report.claudeCalls += out.usage.calls;
    if (!out.ok) {
      await markSource(db, "claude", now, out.error);
      await drop(SignalReason.notUnderstood, { error: out.error });
      continue;
    }
    await markSource(db, "claude", now, null);
    report.classified += 1;
    const c = out.value;
    const classification = { ...c, ruleVersion: NEWS_RULES.version };
    const candidate = candidates.find((x) => x.market === c.market);
    let reason: SignalReason | null = null;
    if (c.catalyst === "none") reason = SignalReason.notSignalType;
    else if (candidate === undefined || c.relevance === "passing_mention")
      reason = SignalReason.passingMention;
    else if (c.promotional) reason = SignalReason.promotional;
    else if (!catalystRule(c.catalyst).kinds.includes(candidate.kind))
      reason = SignalReason.wrongAssetKind;
    else if (eventTooOld(c.eventDate, a.publishedAt.getTime())) reason = SignalReason.eventTooOld;
    const signal: Signal | null =
      candidate === undefined || c.catalyst === "none"
        ? null
        : {
            articleId: a.id,
            source: a.source,
            tier: sourceTierOf(a.source, a.category),
            publishedAt: a.publishedAt.getTime(),
            collectedAt: a.collectedAt.getTime(),
            title: a.title,
            candidate,
            catalyst: c.catalyst,
          };
    if (reason !== null || signal === null) {
      // Lỗi của BÀI (quảng cáo, nhắc qua, không thuộc danh sách, sự kiện cũ…): chỉ ghi event. Không tạo story, không thêm
      // nguồn, không khoá key (review PR #278 R1).
      await drop(reason ?? SignalReason.notSignalType, classification);
      continue;
    }
    const rule = catalystRule(signal.catalyst);
    await db.transaction(async (tx) => {
      await tx
        .update(signalArticles)
        .set({ status: "classified", classification, classifiedAt: new Date(now), ...claude })
        .where(eq(signalArticles.id, a.id));
      await recordEvents(tx, [
        {
          articleId: a.id,
          stage: SignalStage.understand,
          outcome: SignalOutcome.pass,
          detail: {
            market: signal.candidate.market,
            catalyst: signal.catalyst,
            direction: rule.direction,
            maxHoldHours: rule.maxHoldHours,
          },
          at: now,
        },
      ]);
    });
    signals.push(signal);
  }
  report.signals = signals.length;

  // ── 4–5. Filter + Decide, theo story key ──────────────────────────────────────────────────────────────────────
  const groups = new Map<string, Signal[]>();
  for (const s of signals) {
    const k = storyKey(s.candidate.market, s.catalyst);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  for (const [key, group] of groups) {
    const r = await decideStory(deps, key, group, info, now);
    for (const x of r.skipped) skip(x);
    report.opened += r.opened ? 1 : 0;
  }
  if (report.opened > 0) deps.onTradeOpened?.();
  await logCycle(deps, report, now, used);
  return report;
}

/** Một dòng log mỗi chu kỳ: bài lấy về / lưu / backlog / phân loại / bỏ theo lý do, token Claude hôm nay. */
async function logCycle(
  deps: PipelineDeps,
  report: CycleReport,
  now: number,
  used?: Awaited<ReturnType<typeof usageToday>>,
): Promise<void> {
  const { skipped, ...rest } = report;
  const today = used ?? (await usageToday(deps.db, now));
  deps.log.info(
    {
      ...rest,
      skipped,
      claudeTokensToday: {
        calls: today.calls,
        input: today.input,
        cacheWrite: today.cacheWrite,
        cacheRead: today.cacheRead,
        output: today.output,
        budgetUnits: weightedInput(today),
        budget: deps.config.claudeDailyInputBudget,
      },
    },
    "signal research news cycle",
  );
}

/** Normalize: token ứng viên trên SoDEX, bài trùng y hệt (theo hash, bài đến trước thắng), tin > 24 giờ. */
async function normalizeCollected(
  db: Db,
  universe: ReadonlySet<string>,
  now: number,
  skip: (r: SignalReason) => void,
): Promise<number> {
  const rows = await db
    .select()
    .from(signalArticles)
    .where(
      and(
        eq(signalArticles.status, "collected"),
        eq(signalArticles.ruleVersion, NEWS_RULES.version),
      ),
    )
    .orderBy(asc(signalArticles.publishedAt), asc(signalArticles.id));
  if (rows.length === 0) return 0;
  const firstByHash = await firstIdByHash(
    db,
    rows.map((r) => r.contentHash),
  );
  for (const a of rows) {
    const m = matchedList.safeParse(a.matchedCurrencies);
    const candidates = candidatesOf(m.success ? m.data : [], universe);
    const dupOf = firstByHash.get(a.contentHash);
    let reason: SignalReason | null = null;
    if (now - a.publishedAt.getTime() > NEWS_RULES.maxArticleAgeHours * HOUR_MS)
      reason = SignalReason.staleNews;
    else if (dupOf !== undefined && dupOf !== a.id) reason = SignalReason.duplicate;
    else if (candidates.length === 0) reason = SignalReason.noSodexMarket;
    await db.transaction(async (tx) => {
      await tx
        .update(signalArticles)
        .set({
          candidates,
          status: reason === null ? "pending" : "dropped",
          duplicateOf: reason === SignalReason.duplicate ? (dupOf ?? null) : null,
          updatedAt: new Date(now),
        })
        .where(eq(signalArticles.id, a.id));
      await recordEvents(tx, [
        reason === null
          ? {
              articleId: a.id,
              stage: SignalStage.normalize,
              outcome: SignalOutcome.pass,
              detail: { candidates: candidates.map((c) => c.market) },
              at: now,
            }
          : {
              articleId: a.id,
              stage: SignalStage.normalize,
              outcome: SignalOutcome.drop,
              reason,
              at: now,
            },
      ]);
    });
    if (reason !== null) skip(reason);
  }
  return rows.length;
}

async function knownIds(db: Db, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: signalArticles.id })
    .from(signalArticles)
    .where(inArray(signalArticles.id, [...new Set(ids)]));
  return new Set(rows.map((r) => r.id));
}

/** Bài đầu tiên (theo giờ đăng, rồi id) của mỗi hash, trong mọi bài đã lưu. */
async function firstIdByHash(db: Db, hashes: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (hashes.length === 0) return out;
  const rows = await db
    .select({ id: signalArticles.id, hash: signalArticles.contentHash })
    .from(signalArticles)
    .where(inArray(signalArticles.contentHash, [...new Set(hashes)]))
    .orderBy(asc(signalArticles.publishedAt), asc(signalArticles.id));
  for (const r of rows) if (!out.has(r.hash)) out.set(r.hash, r.id);
  return out;
}

const storySources = z.array(
  z.object({
    name: z.string(),
    tier: z.enum(["top", "mid", "low"]),
    articleId: z.string(),
    at: z.string(),
  }),
);
type StorySourceRef = z.infer<typeof storySources>[number];

const sourcesOf = (xs: readonly Signal[]): StorySourceRef[] =>
  xs.map((s) => ({
    name: s.source,
    tier: s.tier,
    articleId: s.articleId,
    at: new Date(s.publishedAt).toISOString(),
  }));

const windowStart = (now: number) => new Date(now - NEWS_RULES.storyWindowDays * 24 * HOUR_MS);

/** Story đang khoá key trong 7 ngày (đã vào lệnh, hoặc bị loại vì lý do không tạm thời). */
async function lockedStory(db: Db, key: string, now: number) {
  const [s] = await db
    .select()
    .from(signalStories)
    .where(
      and(
        eq(signalStories.storyKey, key),
        eq(signalStories.ruleVersion, NEWS_RULES.version),
        eq(signalStories.locked, true),
        gte(signalStories.firstSeenAt, windowStart(now)),
      ),
    )
    .orderBy(asc(signalStories.firstSeenAt))
    .limit(1);
  return s;
}

/** Các lần thử trước (không khoá, chưa vào lệnh) cùng key trong 7 ngày, cũ nhất trước. */
async function earlierAttempts(db: Db, key: string, now: number) {
  const rows = await db
    .select({ id: signalStories.id, sources: signalStories.sources })
    .from(signalStories)
    .where(
      and(
        eq(signalStories.storyKey, key),
        eq(signalStories.ruleVersion, NEWS_RULES.version),
        eq(signalStories.locked, false),
        gte(signalStories.firstSeenAt, windowStart(now)),
      ),
    )
    .orderBy(asc(signalStories.firstSeenAt));
  return rows.map((r) => {
    const p = storySources.safeParse(r.sources);
    return { id: r.id, sources: p.success ? p.data : [] };
  });
}

/** Gộp bài vào story đang khoá: thêm nguồn, tính lại "later level", gắn later High cho lệnh của story. */
async function mergeInto(
  db: Db,
  story: typeof signalStories.$inferSelect,
  group: readonly Signal[],
  now: number,
): Promise<SignalLevel> {
  const prev = storySources.safeParse(story.sources);
  const sources = [...(prev.success ? prev.data : []), ...sourcesOf(group)];
  const later = levelOf(sources);
  await db.transaction(async (tx) => {
    await tx
      .update(signalStories)
      .set({ sources, laterLevel: later, updatedAt: new Date(now) })
      .where(eq(signalStories.id, story.id));
    if (later === SignalLevel.high && story.levelAtEntry !== SignalLevel.high)
      await tx
        .update(signalPaperTrades)
        .set({ laterHigh: true, updatedAt: new Date(now) })
        .where(eq(signalPaperTrades.storyId, story.id));
    await recordEvents(
      tx,
      group.map((s) => ({
        articleId: s.articleId,
        storyId: story.id,
        stage: SignalStage.filter,
        outcome: SignalOutcome.merge,
        reason: SignalReason.sameStory,
        detail: { laterLevel: later },
        at: now,
      })),
    );
  });
  return later;
}

/**
 * Một nhóm tín hiệu cùng story key trong chu kỳ này.
 * - Story đã vào lệnh trong 7 ngày (khoá) → gộp, không bao giờ mở lại.
 * - Có lần thử trước chưa vào lệnh (bị bỏ ở Filter) → chỉ thử lại nếu bài đầu tiên được tính của câu chuyện còn trong
 *   `retryWindowMinutes` (2 giờ); quá thì gộp với lý do `STORY_TOO_OLD`. Lần thử lại: mức tính cả nguồn của lần trước,
 *   `eventAt` và `moved_before_entry` đo từ bài ĐẦU TIÊN của câu chuyện, lệnh gắn `retry`.
 * - Mở lệnh → story `entered`, khoá key. Bị bỏ ở Filter → story `skipped`, không khoá.
 */
async function decideStory(
  deps: PipelineDeps,
  key: string,
  group: readonly Signal[],
  info: ReadonlyMap<string, MarketInfo>,
  now: number,
): Promise<{ opened: boolean; skipped: SignalReason[] }> {
  const { db } = deps;
  const first = group[0];
  if (first === undefined) return { opened: false, skipped: [] };
  const ev = (
    s: Signal,
    stage: SignalStage,
    outcome: SignalOutcome,
    extra: Partial<EventInput> = {},
  ): EventInput => ({ articleId: s.articleId, stage, outcome, at: now, ...extra });

  const existing = await lockedStory(db, key, now);
  if (existing !== undefined) {
    await mergeInto(db, existing, group, now);
    return { opened: false, skipped: group.map(() => SignalReason.sameStory) };
  }

  const earlier = await earlierAttempts(db, key, now);
  const firstSource = earlier
    .flatMap((e) => e.sources)
    .reduce<StorySourceRef | null>((m, x) => (m === null || x.at < m.at ? x : m), null);
  const retry = firstSource !== null;
  const storyStart = firstSource === null ? first.publishedAt : Date.parse(firstSource.at);
  const lastAttempt = earlier.at(-1);
  if (
    retry &&
    lastAttempt !== undefined &&
    now - storyStart > NEWS_RULES.retryWindowMinutes * MIN_MS
  ) {
    const sources = [...lastAttempt.sources, ...sourcesOf(group)];
    await db.transaction(async (tx) => {
      await tx
        .update(signalStories)
        .set({ sources, laterLevel: levelOf(sources), updatedAt: new Date(now) })
        .where(eq(signalStories.id, lastAttempt.id));
      await recordEvents(
        tx,
        group.map((s) =>
          ev(s, SignalStage.filter, SignalOutcome.merge, {
            storyId: lastAttempt.id,
            reason: SignalReason.storyTooOld,
            detail: { storyStartedAt: new Date(storyStart).toISOString() },
          }),
        ),
      );
    });
    return { opened: false, skipped: group.map(() => SignalReason.storyTooOld) };
  }

  const rule = catalystRule(first.catalyst);
  const sources = [...earlier.flatMap((e) => e.sources), ...sourcesOf(group)];
  const levelAtEntry = levelOf(sources);
  const market = first.candidate.market;
  const [story] = await db
    .insert(signalStories)
    .values({
      storyKey: key,
      market,
      catalyst: first.catalyst,
      direction: rule.direction,
      firstArticleId: first.articleId,
      firstSeenAt: new Date(now),
      sources,
      levelAtEntry,
      laterLevel: levelAtEntry,
      outcome: "skipped",
      locked: false,
      ruleVersion: NEWS_RULES.version,
    })
    .returning({ id: signalStories.id });
  const storyId = story?.id ?? null;
  const merged = group
    .slice(1)
    .map((s) =>
      ev(s, SignalStage.filter, SignalOutcome.merge, { storyId, reason: SignalReason.sameStory }),
    );
  const fail = async (reason: SignalReason, detail: Record<string, unknown> = {}) => {
    await recordEvents(db, [
      ...merged,
      ev(first, SignalStage.filter, SignalOutcome.drop, {
        storyId,
        reason,
        detail: { level: levelAtEntry, ...detail },
      }),
    ]);
    return { opened: false, skipped: [reason, ...merged.map(() => SignalReason.sameStory)] };
  };

  // Nguồn đúng giờ (thường đã bị chặn trước ở Collect / Understand; giữ làm lưới an toàn).
  const delayMin = (first.collectedAt - first.publishedAt) / MIN_MS;
  if (delayMin > NEWS_RULES.maxSourceDelayMinutes)
    return fail(SignalReason.sourceLate, { delayMinutes: Math.round(delayMin) });
  // SoDEX có giá (chỉ từ marketdata).
  const quote = (await deps.quotes.quotes([market])).get(market);
  if (quote === undefined || typeof quote === "string") return fail(quote ?? SignalReason.noPrice);
  // Không có lệnh tin tức đang mở trên token này.
  const [open] = await db
    .select({ id: signalPaperTrades.id })
    .from(signalPaperTrades)
    .where(
      and(
        eq(signalPaperTrades.lane, NEWS_RULES.lane),
        eq(signalPaperTrades.label, "live"),
        eq(signalPaperTrades.market, market),
        eq(signalPaperTrades.status, "open"),
      ),
    )
    .limit(1);
  if (open !== undefined) return fail(SignalReason.tradeOpen, { openTradeId: open.id });
  // TP ≥ 2 × chi phí khứ hồi (spread đo lúc này).
  const typical = await typicalMove(db, market, rule.maxHoldHours, now);
  if (typical === null) return fail(SignalReason.notEnoughHistory);
  const fee = oneWayFeePct(info.get(market)?.takerFee ?? null, NEWS_RULES.builderFeeRate);
  const spread = spreadPctOf(quote);
  const cost = roundTripCost(fee, spread);
  const plan = planTrade({
    direction: rule.direction,
    quote,
    typicalMovePct: typical,
    oneWayFeePct: fee,
  });
  // #297: TP / SL lưu theo tick của market (giá đặt được trên SoDEX); tick không biết thì giữ nguyên.
  const tick = info.get(market)?.tickSize ?? null;
  const tpPrice = roundToTick(plan.tpPrice, tick);
  const slPrice = roundToTick(plan.slPrice, tick);
  const costFail = costCheck(plan.tpPct, cost);
  const costDetail = {
    tpPct: plan.tpPct.toFixed(4),
    costPct: cost.totalPct.toFixed(4),
    spreadPct: spread.toFixed(4),
  };
  if (costFail !== null) return fail(costFail, costDetail);

  // ── Decide: mở lệnh giấy ──────────────────────────────────────────────────────────────────────────────────
  const before = await priceBefore(db, market, storyStart);
  const moved = before === null ? null : movedPct(before, plan.entryMid);
  const outside =
    STOCK_MARKET_SET.has(market) &&
    first.candidate.kind === AssetKind.stock &&
    !isUsMarketOpen(now);
  try {
    await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(signalPaperTrades)
        .values({
          lane: NEWS_RULES.lane,
          label: "live",
          storyId,
          eventAt: new Date(storyStart),
          retry,
          seenAt: new Date(first.collectedAt),
          articleId: first.articleId,
          market,
          token: first.candidate.symbol,
          catalyst: first.catalyst,
          direction: rule.direction,
          sizeUsdc: plan.sizeUsdc.toFixed(),
          qty: plan.qty.toFixed(18),
          entryPrice: plan.entryPrice.toFixed(),
          entryMid: plan.entryMid.toFixed(),
          spreadAtEntryPct: spread.toFixed(18),
          feePct: fee.toFixed(),
          entryFee: plan.entryFee.toFixed(18),
          typicalMovePct: typical.toFixed(18),
          tpPct: plan.tpPct.toFixed(18),
          slPct: plan.slPct.toFixed(18),
          tpPrice: tpPrice.toFixed(),
          slPrice: slPrice.toFixed(),
          maxHoldUntil: new Date(now + rule.maxHoldHours * HOUR_MS),
          openedAt: new Date(now),
          movedBeforeEntryPct: moved === null ? null : moved.toFixed(18),
          levelAtEntry,
          sourcesAtEntry: sources,
          outsideMarketHours: outside,
          priceSource: quote.source,
          status: "open",
          ruleVersion: NEWS_RULES.version,
        })
        .returning({ id: signalPaperTrades.id });
      if (storyId !== null)
        await tx
          .update(signalStories)
          .set({
            outcome: "entered",
            locked: true,
            tradeId: t?.id ?? null,
            updatedAt: new Date(now),
          })
          .where(eq(signalStories.id, storyId));
      await recordEvents(tx, [
        ...merged,
        ev(first, SignalStage.filter, SignalOutcome.pass, {
          storyId,
          detail: { level: levelAtEntry, ...costDetail },
        }),
        ev(first, SignalStage.decide, SignalOutcome.open, {
          storyId,
          tradeId: t?.id ?? null,
          detail: {
            direction: rule.direction,
            entryPrice: plan.entryPrice.toFixed(),
            tpPrice: tpPrice.toFixed(),
            slPrice: slPrice.toFixed(),
            priceSource: quote.source,
            retry,
          },
        }),
      ]);
    });
  } catch (e) {
    // Chỉ mục duy nhất "một lệnh mở mỗi token" (đua với chu kỳ khác) → coi như đã có lệnh mở.
    if (isUniqueViolation(e)) return fail(SignalReason.tradeOpen);
    throw e;
  }
  deps.log.info(
    {
      market,
      catalyst: first.catalyst,
      direction: rule.direction,
      level: levelAtEntry,
      priceSource: quote.source,
    },
    "signal research paper trade opened",
  );
  return { opened: true, skipped: merged.map(() => SignalReason.sameStory) };
}

function isUniqueViolation(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x !== null && typeof x === "object" && i < 5; i++) {
    if ((x as { code?: unknown }).code === "23505") return true;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
}
