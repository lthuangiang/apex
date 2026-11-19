import { createHash } from "node:crypto";

import {
  noteClassifierVersion,
  runningSignalBotVersions,
  signalArticles,
  signalPaperTrades,
  signalStories,
  type Db,
  type SignalBotVersion,
} from "@drift/db";
import {
  AssetKind,
  assetAllowed,
  assetInText,
  availableBalance,
  candidatesOf,
  catalystRule,
  closeResult,
  costCheck,
  dec,
  eventTooOld,
  isUsMarketOpen,
  levelAtLeast,
  levelOf,
  limitBlock,
  movedPct,
  NEWS_CLASSIFIER,
  NEWS_RULES,
  normalizedText,
  oneWayFeePct,
  OppositeNewsPolicy,
  PaperExitReason,
  planTrade,
  roundToTick,
  roundTripCost,
  SignalLevel,
  SignalOutcome,
  SignalReason,
  SignalStage,
  smallTreasury,
  sourceTierOf,
  spreadPctOf,
  NEWS_ASSET_MAP_VERSION,
  STOCK_MARKET_SET,
  storyKey,
  stripHtml,
  TradeDirection,
  treasuryOnMajorAsset,
  versionHoldHours,
  type Candidate,
  type Decimal,
  type Quote,
  type SignalCatalyst,
  type SourceTier,
} from "@drift/shared";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
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
  /** Lệnh thật đã mở, cộng mọi version. */
  opened: number;
  /** Tín hiệu bị giới hạn / số dư chặn, chỉ theo dõi giả định (shadow). */
  shadows: number;
  /** Lệnh đóng vì tin ngược chiều (version chọn Close at market). */
  oppositeClosed: number;
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
const matchedOf = (v: unknown) => {
  const p = matchedList.safeParse(v);
  return p.success ? p.data : [];
};

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
    shadows: 0,
    oppositeClosed: 0,
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
            detail: { ...classification, assetMapVersion: NEWS_ASSET_MAP_VERSION },
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
    // Cờ "small treasury?" (#298): tin treasury mà Claude không trích được số tiền; chỉ để phân tích sau.
    const small = c.catalyst !== "none" && smallTreasury(c.catalyst, c.treasuryAmount);
    const classification = {
      ...c,
      ruleVersion: NEWS_RULES.version,
      ...(small ? { smallTreasury: true } : {}),
    };
    const candidate = candidates.find((x) => x.market === c.market);
    let reason: SignalReason | null = null;
    if (c.catalyst === "none") reason = SignalReason.notSignalType;
    else if (candidate === undefined || c.relevance === "passing_mention")
      reason = SignalReason.passingMention;
    else if (c.promotional) reason = SignalReason.promotional;
    else if (!catalystRule(c.catalyst).kinds.includes(candidate.kind))
      reason = SignalReason.wrongAssetKind;
    // news-v3 (#298): kiểm tất định sau Claude. Tài sản phải được viết trong bài (tag SoSoValue thôi chưa đủ);
    // treasury trên BTC / ETH không giao dịch.
    else if (!assetInText(a.title, a.content, candidate, matchedOf(a.matchedCurrencies)))
      reason = SignalReason.assetNotInText;
    else if (treasuryOnMajorAsset(c.catalyst, candidate.market))
      reason = SignalReason.treasuryMajorAsset;
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
            ...(small ? { smallTreasury: true } : {}),
            assetMapVersion: NEWS_ASSET_MAP_VERSION,
          },
          at: now,
        },
      ]);
    });
    signals.push(signal);
  }
  report.signals = signals.length;

  if (report.classified > 0)
    await noteClassifierVersion(db, {
      promptVersion: NEWS_CLASSIFIER.promptVersion,
      model: NEWS_CLASSIFIER.model,
      at: new Date(now),
    });

  // ── 4–5. Filter + Decide, riêng cho từng News bot version đang chạy (#303, DEC-328), theo story key ─────────────
  const groups = new Map<string, Signal[]>();
  for (const s of signals) {
    const k = storyKey(s.candidate.market, s.catalyst);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  if (groups.size > 0) {
    const { versions, invalid } = await runningSignalBotVersions(db);
    if (invalid.length > 0)
      deps.log.warn(
        { versionIds: invalid },
        "signal research: bot version config invalid, skipped",
      );
    const ctx = cycleContext(deps, info, now);
    for (const v of versions)
      for (const [key, group] of groups) {
        const r = await decideStory(deps, ctx, v, key, group);
        for (const x of r.skipped) skip(x);
        report.opened += r.opened ? 1 : 0;
        report.shadows += r.shadow ? 1 : 0;
        report.oppositeClosed += r.oppositeClosed;
      }
  }
  if (report.opened + report.shadows + report.oppositeClosed > 0) deps.onTradeOpened?.();
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
              detail: {
                candidates: candidates.map((c) => c.market),
                assetMapVersion: NEWS_ASSET_MAP_VERSION,
              },
              at: now,
            }
          : {
              articleId: a.id,
              stage: SignalStage.normalize,
              outcome: SignalOutcome.drop,
              reason,
              detail: { assetMapVersion: NEWS_ASSET_MAP_VERSION },
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

/** Story đang khoá key trong 7 ngày của version này (đã vào lệnh thật hoặc lệnh shadow). */
async function lockedStory(db: Db, versionId: string, key: string, now: number) {
  const [s] = await db
    .select()
    .from(signalStories)
    .where(
      and(
        eq(signalStories.versionId, versionId),
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

/** Các lần thử trước (không khoá, chưa vào lệnh) cùng key của version này trong 7 ngày, cũ nhất trước. */
async function earlierAttempts(db: Db, versionId: string, key: string, now: number) {
  const rows = await db
    .select({ id: signalStories.id, sources: signalStories.sources })
    .from(signalStories)
    .where(
      and(
        eq(signalStories.versionId, versionId),
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
  versionId: string,
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
        versionId,
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

/** Bộ nhớ đệm trong một chu kỳ: giá và biến động thường gặp dùng chung cho mọi version. */
interface CycleContext {
  deps: PipelineDeps;
  info: ReadonlyMap<string, MarketInfo>;
  now: number;
  quote: (market: string) => Promise<Quote | SignalReason>;
  typical: (market: string, holdHours: number) => Promise<Decimal | null>;
}

function cycleContext(
  deps: PipelineDeps,
  info: ReadonlyMap<string, MarketInfo>,
  now: number,
): CycleContext {
  const quotes = new Map<string, Promise<Quote | SignalReason>>();
  const typicals = new Map<string, Promise<Decimal | null>>();
  return {
    deps,
    info,
    now,
    quote: (market) => {
      let q = quotes.get(market);
      if (q === undefined) {
        q = deps.quotes.quotes([market]).then((m) => m.get(market) ?? SignalReason.noPrice);
        quotes.set(market, q);
      }
      return q;
    },
    typical: (market, holdHours) => {
      const k = `${market}|${String(holdHours)}`;
      let t = typicals.get(k);
      if (t === undefined) {
        t = typicalMove(deps.db, market, holdHours, now);
        typicals.set(k, t);
      }
      return t;
    },
  };
}

type TradeRow = typeof signalPaperTrades.$inferSelect;

const directionOf = (d: string) => (d === "short" ? TradeDirection.short : TradeDirection.long);

/**
 * Tin ngược chiều trên lệnh đang mở của version (#303, DEC-328 mục 5): luôn ghi kết quả giả định nếu đóng lúc này (giá thị
 * trường như watcher: long theo bid, short theo ask, sau phí; chỉ lần đầu tiên); version chọn Close thì đóng thật với lý do
 * `opposite_news`. Trả true khi đã đóng.
 */
async function onOppositeNews(
  db: Db,
  input: {
    trade: TradeRow;
    quote: Quote;
    storyId: string | null;
    articleId: string;
    versionId: string;
    close: boolean;
    now: number;
  },
): Promise<boolean> {
  const { trade: t, quote, now } = input;
  const direction = directionOf(t.direction);
  const px = direction === TradeDirection.long ? quote.bid : quote.ask;
  const r = closeResult({
    direction,
    entryPrice: t.entryPrice,
    exitPrice: px,
    qty: t.qty,
    sizeUsdc: t.sizeUsdc,
    entryFee: t.entryFee,
    feePct: t.feePct,
  });
  const shadowClose =
    t.oppositeAt === null
      ? {
          oppositeStoryId: input.storyId,
          oppositeAt: new Date(now),
          oppositeExitPrice: px.toFixed(),
          oppositeResultUsdc: r.resultUsdc.toFixed(18),
          oppositeResultPct: r.resultPct.toFixed(18),
        }
      : {};
  if (!input.close) {
    if (t.oppositeAt === null)
      await db
        .update(signalPaperTrades)
        .set({ ...shadowClose, updatedAt: new Date(now) })
        .where(eq(signalPaperTrades.id, t.id));
    return false;
  }
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(signalPaperTrades)
      .set({
        ...shadowClose,
        status: "closed",
        exitPrice: px.toFixed(),
        exitReason: PaperExitReason.oppositeNews,
        exitedAt: new Date(now),
        exitFee: r.exitFee.toFixed(18),
        resultUsdc: r.resultUsdc.toFixed(18),
        resultPct: r.resultPct.toFixed(18),
        updatedAt: new Date(now),
      })
      .where(and(eq(signalPaperTrades.id, t.id), eq(signalPaperTrades.status, "open")))
      .returning({ id: signalPaperTrades.id });
    if (rows.length === 0) return false;
    await recordEvents(tx, [
      {
        articleId: t.articleId,
        storyId: t.storyId,
        tradeId: t.id,
        versionId: input.versionId,
        stage: SignalStage.watch,
        outcome: SignalOutcome.close,
        reason: SignalReason.oppositeNews,
        detail: {
          exitPrice: px.toFixed(),
          resultUsdc: r.resultUsdc.toDecimalPlaces(6).toFixed(),
          priceSource: quote.source,
          oppositeStoryId: input.storyId,
          oppositeArticleId: input.articleId,
          ...(t.label === "shadow" ? { shadow: true } : {}),
        },
        at: now,
      },
    ]);
    return true;
  });
}

/** Lệnh thật đang mở, lệnh mở trong ngày UTC và số dư giả còn dùng được của version (lệnh shadow không tính). */
async function versionBook(db: Db, versionId: string, now: number) {
  const dayStart = new Date(Math.floor(now / (24 * HOUR_MS)) * 24 * HOUR_MS);
  const [r] = await db
    .select({
      open: sql<number>`count(*) filter (where ${signalPaperTrades.status} = 'open')::int`,
      today: sql<number>`count(*) filter (where ${signalPaperTrades.openedAt} >= ${dayStart})::int`,
      openSize: sql<string>`coalesce(sum(${signalPaperTrades.sizeUsdc}) filter (where ${signalPaperTrades.status} = 'open'), 0)::text`,
      closedResult: sql<string>`coalesce(sum(${signalPaperTrades.resultUsdc}) filter (where ${signalPaperTrades.status} = 'closed'), 0)::text`,
    })
    .from(signalPaperTrades)
    .where(
      and(
        eq(signalPaperTrades.versionId, versionId),
        eq(signalPaperTrades.lane, NEWS_RULES.lane),
        eq(signalPaperTrades.label, "live"),
      ),
    );
  return {
    openTrades: r?.open ?? 0,
    openedToday: r?.today ?? 0,
    available: availableBalance({
      closedResultUsdc: dec(r?.closedResult ?? "0"),
      openSizeUsdc: dec(r?.openSize ?? "0"),
    }),
  };
}

interface StoryResult {
  opened: boolean;
  shadow: boolean;
  oppositeClosed: number;
  skipped: SignalReason[];
}

/**
 * Một nhóm tín hiệu cùng story key trong chu kỳ này, cho MỘT News bot version (#303). Story, khoá key, lần thử lại và
 * lệnh đều riêng từng version.
 * - Loại tin tắt / tài sản không thuộc version → chỉ ghi event, không tạo story.
 * - Story đã vào lệnh (thật hoặc shadow) trong 7 ngày (khoá) → gộp, không bao giờ mở lại.
 * - Có lần thử trước chưa vào lệnh (bị bỏ ở Filter) → chỉ thử lại nếu bài đầu tiên được tính của câu chuyện còn trong
 *   `retryWindowMinutes` (2 giờ); quá thì gộp với lý do `STORY_TOO_OLD`. Lần thử lại: mức tính cả nguồn của lần trước,
 *   `eventAt` và `moved_before_entry` đo từ bài ĐẦU TIÊN của câu chuyện, lệnh gắn `retry`.
 * - Level dưới mức của version → `LEVEL_TOO_LOW` (story không khoá, bài sau nâng level vẫn thử lại được trong 2 giờ).
 * - Tin ngược chiều trên lệnh đang mở → ghi kết quả đóng giả định; Close → chỉ đóng, không bao giờ đảo chiều (DEC-328,
 *   review PR #312): tín hiệu mới bỏ `OPPOSITE_NEWS` (`closed: true`) và story khoá; Keep → bỏ `NEWS_TRADE_ALREADY_OPEN`.
 * - Qua Filter nhưng bị Max open trades / Max new trades per day / số dư giả chặn → lệnh shadow (ngoài balance), story khoá.
 */
async function decideStory(
  deps: PipelineDeps,
  ctx: CycleContext,
  v: SignalBotVersion,
  key: string,
  group: readonly Signal[],
): Promise<StoryResult> {
  const { db } = deps;
  const { now, info } = ctx;
  const cfg = v.config;
  const none: StoryResult = { opened: false, shadow: false, oppositeClosed: 0, skipped: [] };
  const first = group[0];
  if (first === undefined) return none;
  const ev = (
    s: Signal,
    stage: SignalStage,
    outcome: SignalOutcome,
    extra: Partial<EventInput> = {},
  ): EventInput => ({ articleId: s.articleId, stage, outcome, at: now, versionId: v.id, ...extra });

  // Bộ lọc của version, trước story (giống lỗi của bài đối với version này: không tạo story, không khoá).
  const holdHours = versionHoldHours(cfg, first.catalyst);
  const market = first.candidate.market;
  const versionDrop =
    holdHours === null
      ? SignalReason.newsTypeOff
      : !assetAllowed(cfg.assets, market, first.candidate.kind)
        ? SignalReason.assetNotInVersion
        : null;
  if (versionDrop !== null || holdHours === null) {
    const reason = versionDrop ?? SignalReason.newsTypeOff;
    await recordEvents(
      db,
      group.map((s) => ev(s, SignalStage.filter, SignalOutcome.drop, { reason })),
    );
    return { ...none, skipped: group.map(() => reason) };
  }

  const existing = await lockedStory(db, v.id, key, now);
  if (existing !== undefined) {
    await mergeInto(db, v.id, existing, group, now);
    return { ...none, skipped: group.map(() => SignalReason.sameStory) };
  }

  const earlier = await earlierAttempts(db, v.id, key, now);
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
    return { ...none, skipped: group.map(() => SignalReason.storyTooOld) };
  }

  const direction = catalystRule(first.catalyst).direction;
  const sources = [...earlier.flatMap((e) => e.sources), ...sourcesOf(group)];
  const levelAtEntry = levelOf(sources);
  const [story] = await db
    .insert(signalStories)
    .values({
      storyKey: key,
      market,
      catalyst: first.catalyst,
      direction,
      firstArticleId: first.articleId,
      firstSeenAt: new Date(now),
      sources,
      levelAtEntry,
      laterLevel: levelAtEntry,
      outcome: "skipped",
      locked: false,
      ruleVersion: NEWS_RULES.version,
      versionId: v.id,
    })
    .returning({ id: signalStories.id });
  const storyId = story?.id ?? null;
  const merged = group
    .slice(1)
    .map((s) =>
      ev(s, SignalStage.filter, SignalOutcome.merge, { storyId, reason: SignalReason.sameStory }),
    );
  let oppositeClosed = 0;
  const fail = async (reason: SignalReason, detail: Record<string, unknown> = {}) => {
    await recordEvents(db, [
      ...merged,
      ev(first, SignalStage.filter, SignalOutcome.drop, {
        storyId,
        reason,
        detail: { level: levelAtEntry, ...detail },
      }),
    ]);
    return {
      ...none,
      oppositeClosed,
      skipped: [reason, ...merged.map(() => SignalReason.sameStory)],
    };
  };

  // Level tối thiểu của version.
  if (!levelAtLeast(levelAtEntry, cfg.minLevel))
    return fail(SignalReason.levelTooLow, { minLevel: cfg.minLevel });
  // Nguồn đúng giờ theo version (classifier đã bỏ bài trễ hơn mức chung `NEWS_RULES.maxSourceDelayMinutes`).
  const delayMin = (first.collectedAt - first.publishedAt) / MIN_MS;
  if (delayMin > cfg.maxSourceDelayMinutes)
    return fail(SignalReason.sourceLate, { delayMinutes: Math.round(delayMin) });
  // SoDEX có giá (chỉ từ marketdata).
  const quote = await ctx.quote(market);
  if (typeof quote === "string") return fail(quote);

  // Lệnh đang mở của version trên token này (thật và shadow). Tin ngược chiều → kết quả đóng giả định, Close → đóng.
  const openRows = await db
    .select()
    .from(signalPaperTrades)
    .where(
      and(
        eq(signalPaperTrades.versionId, v.id),
        eq(signalPaperTrades.lane, NEWS_RULES.lane),
        inArray(signalPaperTrades.label, ["live", "shadow"]),
        eq(signalPaperTrades.market, market),
        eq(signalPaperTrades.status, "open"),
      ),
    );
  let openLive: TradeRow | undefined;
  let openShadow: TradeRow | undefined;
  const closedIds: string[] = [];
  for (const t of openRows) {
    if (t.direction !== direction) {
      const closed = await onOppositeNews(db, {
        trade: t,
        quote,
        storyId,
        articleId: first.articleId,
        versionId: v.id,
        close: cfg.onOppositeNews === OppositeNewsPolicy.close,
        now,
      });
      if (closed) {
        oppositeClosed += 1;
        closedIds.push(t.id);
        continue;
      }
    }
    if (t.label === "shadow") openShadow = t;
    else openLive = t;
  }
  if (closedIds.length > 0) {
    // Close chỉ đóng, không đảo chiều: tín hiệu ngược chiều đã được xử lý (đóng lệnh), story khoá như mọi tín hiệu đã
    // dùng, không mở lệnh theo chiều mới.
    if (storyId !== null)
      await db
        .update(signalStories)
        .set({ outcome: "opposite_news", locked: true, updatedAt: new Date(now) })
        .where(eq(signalStories.id, storyId));
    return fail(SignalReason.oppositeNews, {
      closed: true,
      closedTradeId: closedIds[0],
      closedTradeIds: closedIds,
    });
  }
  if (openLive !== undefined)
    return fail(SignalReason.tradeOpen, {
      openTradeId: openLive.id,
      ...(openLive.direction !== direction ? { oppositeNews: true } : {}),
    });

  // TP ≥ bội số × chi phí khứ hồi (spread đo lúc này), theo tham số của version.
  const typical = await ctx.typical(market, holdHours);
  if (typical === null) return fail(SignalReason.notEnoughHistory);
  const fee = oneWayFeePct(info.get(market)?.takerFee ?? null, NEWS_RULES.builderFeeRate);
  const spread = spreadPctOf(quote);
  const cost = roundTripCost(fee, spread);
  const plan = planTrade({
    direction,
    quote,
    typicalMovePct: typical,
    oneWayFeePct: fee,
    sizeUsdc: cfg.sizeUsdc,
    tpMultiple: cfg.tpMultiple,
    slMultiple: cfg.slMultiple,
  });
  // #297: TP / SL lưu theo tick của market (giá đặt được trên SoDEX); tick không biết thì giữ nguyên.
  const tick = info.get(market)?.tickSize ?? null;
  const tpPrice = roundToTick(plan.tpPrice, tick);
  const slPrice = roundToTick(plan.slPrice, tick);
  const costFail = costCheck(plan.tpPct, cost, cfg.minTpCostMultiple);
  const costDetail = {
    tpPct: plan.tpPct.toFixed(4),
    costPct: cost.totalPct.toFixed(4),
    spreadPct: spread.toFixed(4),
  };
  if (costFail !== null) return fail(costFail, costDetail);

  // Giới hạn của version: chặn thì chỉ theo dõi giả định (shadow), ngoài balance.
  const book = await versionBook(db, v.id, now);
  const blocked = limitBlock({ cfg, ...book });
  if (blocked !== null && openShadow !== undefined)
    // Đã có lệnh shadow đang mở trên token này: không mở thêm (một lệnh mỗi version × token, kể cả shadow).
    // #304: mang giới hạn của version để API hiện "Limit: N open" / "Limit: N per day".
    return fail(blocked, {
      openShadowTradeId: openShadow.id,
      ...costDetail,
      maxOpenTrades: cfg.maxOpenTrades,
      maxNewTradesPerDay: cfg.maxNewTradesPerDay,
    });

  // ── Decide: mở lệnh giấy (thật hoặc shadow) ──────────────────────────────────────────────────────────────────
  const before = await priceBefore(db, market, storyStart);
  const moved = before === null ? null : movedPct(before, plan.entryMid);
  const outside =
    STOCK_MARKET_SET.has(market) &&
    first.candidate.kind === AssetKind.stock &&
    !isUsMarketOpen(now);
  const shadow = blocked !== null;
  try {
    await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(signalPaperTrades)
        .values({
          lane: NEWS_RULES.lane,
          label: shadow ? "shadow" : "live",
          shadowReason: blocked,
          versionId: v.id,
          classifierVersion: NEWS_CLASSIFIER.promptVersion,
          storyId,
          eventAt: new Date(storyStart),
          retry,
          seenAt: new Date(first.collectedAt),
          articleId: first.articleId,
          market,
          token: first.candidate.symbol,
          catalyst: first.catalyst,
          direction,
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
          maxHoldUntil: new Date(now + holdHours * HOUR_MS),
          openedAt: new Date(now),
          movedBeforeEntryPct: moved === null ? null : moved.toFixed(18),
          levelAtEntry,
          sourcesAtEntry: sources,
          outsideMarketHours: outside,
          priceSource: quote.source,
          status: "open",
          ruleVersion: NEWS_RULES.version,
          assetMapVersion: NEWS_ASSET_MAP_VERSION,
        })
        .returning({ id: signalPaperTrades.id });
      const tradeId = t?.id ?? null;
      if (storyId !== null)
        await tx
          .update(signalStories)
          .set({
            outcome: shadow ? "shadow" : "entered",
            locked: true,
            tradeId,
            updatedAt: new Date(now),
          })
          .where(eq(signalStories.id, storyId));
      const tradeDetail = {
        direction,
        entryPrice: plan.entryPrice.toFixed(),
        tpPrice: tpPrice.toFixed(),
        slPrice: slPrice.toFixed(),
        priceSource: quote.source,
        retry,
      };
      await recordEvents(
        tx,
        shadow
          ? [
              ...merged,
              // Bị chặn: không vào lệnh (Filter drop với lý do giới hạn), lệnh shadow theo dõi giả định.
              ev(first, SignalStage.filter, SignalOutcome.drop, {
                storyId,
                tradeId,
                reason: blocked,
                detail: {
                  level: levelAtEntry,
                  ...costDetail,
                  shadowTradeId: tradeId,
                  openTrades: book.openTrades,
                  maxOpenTrades: cfg.maxOpenTrades,
                  openedToday: book.openedToday,
                  maxNewTradesPerDay: cfg.maxNewTradesPerDay,
                  available: book.available.toFixed(),
                  ...tradeDetail,
                },
              }),
            ]
          : [
              ...merged,
              ev(first, SignalStage.filter, SignalOutcome.pass, {
                storyId,
                detail: { level: levelAtEntry, ...costDetail },
              }),
              ev(first, SignalStage.decide, SignalOutcome.open, {
                storyId,
                tradeId,
                detail: tradeDetail,
              }),
            ],
      );
    });
  } catch (e) {
    // Chỉ mục duy nhất "một lệnh mở mỗi version × token" (đua với chu kỳ khác) → coi như đã có lệnh mở.
    if (isUniqueViolation(e)) return fail(SignalReason.tradeOpen);
    throw e;
  }
  deps.log.info(
    {
      version: v.number,
      market,
      catalyst: first.catalyst,
      direction,
      level: levelAtEntry,
      priceSource: quote.source,
      ...(shadow ? { shadow: blocked } : {}),
    },
    shadow ? "signal research shadow trade opened" : "signal research paper trade opened",
  );
  return {
    opened: !shadow,
    shadow,
    oppositeClosed,
    skipped: [...(blocked !== null ? [blocked] : []), ...merged.map(() => SignalReason.sameStory)],
  };
}

function isUniqueViolation(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x !== null && typeof x === "object" && i < 5; i++) {
    if ((x as { code?: unknown }).code === "23505") return true;
    x = (x as { cause?: unknown }).cause;
  }
  return false;
}
