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
  SOSO_RATE_LIMITED_ERROR,
  sourceTierOf,
  spreadPctOf,
  NEWS_ASSET_MAP_VERSION,
  STOCK_MARKET_SET,
  storyKey,
  storyStartOf,
  storyTooOld,
  stripHtml,
  TradeDirection,
  etfOnMajorAsset,
  listingOnMajorAsset,
  marketsByMention,
  meetsMinOrder,
  paperEventShare,
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
import { captureSignalContext, type ContextSignal } from "./context";
import { publishNewsSignals } from "./news-signals";
import type { QuoteDiag } from "./prices";
import {
  isSosoRateLimited,
  SOSO_PAGE_SIZE,
  type SosoClient,
  type SosoNewsItem,
  type SosoRateLimiter,
} from "./soso";
import {
  addClaudeUsage,
  addSosoRequests,
  adoptInFlightArticles,
  earlierAttempts,
  markSource,
  movedBeforeEntry,
  newsState,
  recordEvents,
  saveNewsState,
  sosoRequestsThisMonth,
  storySources,
  storyWindowStart,
  typicalMove,
  usageToday,
  type EventInput,
  type StorySourceRef,
} from "./store";

// Một chu kỳ của lane tin tức (#271, flow #269 v3.4): Collect → Normalize → Understand → Context (#329, chỉ ghi) → Filter →
// Decide. Chỉ ghi DB của DeskLabs; lệnh là lệnh giấy (bảng signal_paper_trades), không có đường nào tới SoDEX.
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
  /**
   * #530: lot / min size / min notional của market SoDEX (cùng nguồn với bot mainnet), cho kiểm cỡ tối thiểu của phần chia
   * trong sự kiện nhiều coin. Thiếu (null / không có) = không biết: sự kiện nhiều coin bỏ coin đó (không mở lệnh).
   */
  stepSize?: string | null;
  minQuantity?: string | null;
  minNotional?: string | null;
}

export interface PipelineConfig {
  /** Đơn vị ngân sách ngày (token đầu vào quy đổi theo giá, `weightedInput`). */
  claudeDailyInputBudget: number;
  /**
   * Số lần gọi API Claude tối đa của MỘT chu kỳ, kể cả thử lại (đã chia theo độ dài chu kỳ: `claudeCallsForCycle`).
   */
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
  quotes: {
    quotes: (markets: readonly string[]) => Promise<Map<string, Quote | SignalReason>>;
    /** #507: giá cho bước quyết định (thêm sổ REST qua marketdata); thiếu thì dùng `quotes`. */
    decisionQuote?: (market: string) => Promise<Quote | SignalReason>;
    /** #507 phần D: chẩn đoán của lần `decisionQuote` gần nhất, ghi vào `detail` khi không có giá. */
    diag?: (market: string) => QuoteDiag | undefined;
  };
  /** Danh sách perps SoDEX đang giao dịch; null = chưa biết (chỉ Collect). */
  markets: () => MarketInfo[] | null;
  now: () => number;
  log: PipelineLog;
  config: PipelineConfig;
  /**
   * #394: trần 20 request SoSoValue / phút trượt, dùng chung giữa các chu kỳ. Thiếu (test cũ) → không chặn phía DeskLabs
   * (429 / 42901 của SoSoValue vẫn được xử lý).
   */
  sosoLimiter?: Pick<SosoRateLimiter, "tryTake">;
  /** Gọi sau khi mở lệnh (để watcher nạp lại ngay). */
  onTradeOpened?: () => void;
  /**
   * Bước 4 · Context (#329): chụp ngữ cảnh của mỗi tín hiệu trước Filter. Mặc định `captureSignalContext`; null = không
   * chụp (test so quyết định có / không có bước này). Chỉ ghi, không bao giờ đổi quyết định.
   */
  captureContext?:
    ((db: Db, s: ContextSignal, decidedAt: number, quote: Quote | null) => Promise<void>) | null;
  /**
   * #419 PR 4: ghi tín hiệu dùng chung cho bot `news_signal` mainnet (`news_signals`) và phát chuông NATS. Thiếu / null =
   * tắt (`SIGNAL_NEWS_PUBLISH_ENABLED` không bật). Chỉ ghi, không bao giờ đổi quyết định của research versions.
   */
  newsSignals?: {
    notify: (id: string) => void;
    /**
     * #530 PR2 (`SIGNAL_NEWS_EVENT_SPLIT_ENABLED`, mặc định tắt): bật = một dòng mỗi coin của sự kiện (`event_coins` = k);
     * tắt / thiếu = một dòng cho coin chính của bài, `event_key` null, `event_coins` 1.
     */
    eventSplit?: boolean;
  } | null;
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
  /** Snapshot ngữ cảnh đã chụp ở bước 4 (#329). */
  contexts: number;
  /** Dòng `news_signals` mới của chu kỳ (#419); 0 khi tắt. */
  newsSignals: number;
  baselines: number;
  /** `MARKETS_UNKNOWN` khi chu kỳ chỉ Collect. */
  collectOnly: string | null;
  /**
   * #394: chu kỳ dừng vì giới hạn tốc độ: `sosovalue` (HTTP 429 / code 42901) hoặc `local` (DeskLabs tự chặn ở 20 / phút).
   * Không lưu bài nào, con trỏ không tiến, chu kỳ sau mới thử lại.
   */
  rateLimited?: "sosovalue" | "local";
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
  /**
   * #530 (news-v6): sự kiện nhiều coin. `eventKey` null = tín hiệu một coin; `eventCoins` = số coin của sự kiện qua các
   * kiểm tất định ở Understand (lệnh giấy và bot mainnet chia cỡ lệnh cho số này). `sameEvent` = bài đăng lại của một sự
   * kiện nhiều coin đã xét: không bao giờ mở câu chuyện mới (`SAME_EVENT`), không ghi tín hiệu mainnet.
   */
  eventKey: string | null;
  eventCoins: number;
  sameEvent: boolean;
  /**
   * #530: coin của bài đăng lại đã qua Understand ở bài đầu của sự kiện và bài đăng lại còn trong `retryWindowMinutes` tính
   * từ bài đầu: tín hiệu mainnet được ghi (lần thử lại, cùng `eventKey` / `eventCoins` = k của bài đầu). Lệnh giấy thử lại
   * theo đúng luật câu chuyện (cần lần thử trước của version); cờ này không dùng ở đó.
   */
  retryable: boolean;
  /** #530: coin chính của bài (coin đầu bài nêu trong các coin qua Understand); tín hiệu mainnet khi tắt chia sự kiện. */
  primary: boolean;
}

/** #530: kiểm tất định của một coin sau Claude (loại tài sản, có trong bài, luật BTC / ETH); null = qua. */
function coinCheck(
  catalyst: SignalCatalyst,
  c: Candidate,
  title: string | null,
  content: string | null,
  matched: ReturnType<typeof matchedOf>,
): SignalReason | null {
  if (!catalystRule(catalyst).kinds.includes(c.kind)) return SignalReason.wrongAssetKind;
  // news-v3 (#298): tài sản phải được viết trong bài (tag SoSoValue thôi chưa đủ); treasury trên BTC / ETH không giao dịch.
  if (!assetInText(title, content, c, matched)) return SignalReason.assetNotInText;
  if (treasuryOnMajorAsset(catalyst, c.market)) return SignalReason.treasuryMajorAsset;
  // news-v4 (#395): tin ETF trên BTC / ETH không giao dịch.
  if (etfOnMajorAsset(catalyst, c.market)) return SignalReason.etfMajorAsset;
  // news-v5 (#506): tin listing trên BTC / ETH không giao dịch.
  if (listingOnMajorAsset(catalyst, c.market)) return SignalReason.listingMajorAsset;
  return null;
}

/**
 * #530: sự kiện nhiều coin đã xét trong `sameEventWindowHours` có cùng loại tin và ít nhất một coin trùng với `markets`;
 * trả khoá sự kiện, hoặc null. Chỉ bài mở sự kiện (có `classification.event`, nêu ≥ 2 coin) được tính; sự kiện một coin đi
 * theo luật câu chuyện như trước (`SAME_STORY`, thử lại trong `retryWindowMinutes`).
 */
async function sameEventOf(
  db: Db,
  articleId: string,
  catalyst: SignalCatalyst,
  markets: readonly string[],
  now: number,
): Promise<{ key: string; coins: number; markets: string[]; firstAt: number } | null> {
  if (markets.length === 0) return null;
  const since = new Date(now - NEWS_RULES.sameEventWindowHours * HOUR_MS);
  const list = sql.join(
    markets.map((m) => sql`${m}`),
    sql`, `,
  );
  const rows = await db.execute<{
    key: string;
    coins: string | number | null;
    markets: unknown;
    first_at: Date | string;
  }>(sql`
    select a.classification->'event'->>'key' as key, a.classification->>'eventCoins' as coins,
           a.classification->'eventMarkets' as markets, a.published_at as first_at
      from signal_articles a
     where a.rule_version = ${NEWS_RULES.version}
       and a.id <> ${articleId}
       and a.classified_at >= ${since}
       and a.classification->'event'->>'catalyst' = ${catalyst}
       and exists (
         select 1 from jsonb_array_elements_text(a.classification->'event'->'markets') m
          where m in (${list}))
     order by a.classified_at, a.id
     limit 1`);
  const r = rows.rows[0];
  if (r === undefined) return null;
  const coins = Number(r.coins);
  return {
    key: r.key,
    // k của bài đầu (số coin qua Understand); bài đầu mà mọi coin đều rớt có k = 0, không bao giờ mở lệnh (an toàn).
    coins: Number.isInteger(coins) && coins >= 1 ? coins : 0,
    markets: Array.isArray(r.markets)
      ? r.markets.filter((m): m is string => typeof m === "string")
      : [],
    firstAt: r.first_at instanceof Date ? r.first_at.getTime() : Date.parse(r.first_at),
  };
}

/** Gom tín hiệu theo story key (market × loại tin), giữ thứ tự xuất hiện. */
function groupsOf(signals: readonly Signal[]): Map<string, Signal[]> {
  const groups = new Map<string, Signal[]>();
  for (const s of signals) {
    const k = storyKey(s.candidate.market, s.catalyst);
    groups.set(k, [...(groups.get(k) ?? []), s]);
  }
  return groups;
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
    contexts: 0,
    newsSignals: 0,
    baselines: 0,
    collectOnly: null,
    skipped,
    watermarkAt: null,
  };

  // #395: bài `collected` / `pending` của rule version cũ (còn dở lúc deploy) chạy tiếp theo version hiện tại.
  const adopted = await adoptInFlightArticles(db);
  if (adopted > 0)
    deps.log.info(
      { adopted, ruleVersion: NEWS_RULES.version },
      "signal research: in-flight articles moved to current rules",
    );

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
    // #394: trần 20 request / phút của key, đếm cả trang sau. Hết lượt → dừng như bị 429, không gửi request.
    if (deps.sosoLimiter !== undefined && !deps.sosoLimiter.tryTake()) {
      report.rateLimited = "local";
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
      // Trang sau chỉ khi trang đầy, cả trang đều mới và đều sau mốc dưới, và SoSoValue chưa báo hết lượt.
      const more =
        p.items.length >= SOSO_PAGE_SIZE &&
        p.items.every((i) => i.release_time > floor && !known.has(i.id)) &&
        p.rateRemaining !== 0;
      if (!more) break;
    } catch (e) {
      // #394: 429 / 42901 → dừng ngay, không thử lại trong chu kỳ này.
      if (isSosoRateLimited(e)) report.rateLimited = "sosovalue";
      else sourceError = e instanceof Error ? e.message : "error";
      break;
    }
  }
  if (report.rateLimited !== undefined) {
    // Bỏ cả các trang đã lấy trong chu kỳ này: lưu một phần sẽ làm chu kỳ sau thấy trang 1 "đã biết" và không đọc tiếp
    // trang 2 (mất bài). Không lưu gì, không đổi watermark / lastCycleAt, không Normalize → Decide; chu kỳ sau làm lại.
    await markSource(db, "sosovalue", now, SOSO_RATE_LIMITED_ERROR);
    deps.log.warn(
      { error: SOSO_RATE_LIMITED_ERROR, by: report.rateLimited, pages: report.pages },
      "signal research: sosovalue rate limited, waiting for the next cycle",
    );
    report.error = SOSO_RATE_LIMITED_ERROR;
    await logCycle(deps, report, now);
    return report;
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
    let claude: (ArticleUsageValues & { claudeStartedAt: Date; claudeDoneAt: Date }) | null = null;
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
    // #375: đọc lại đồng hồ quanh lần classify (`now` là giờ bắt đầu chu kỳ, dùng chung cả chu kỳ).
    const claudeStartedAt = deps.now();
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
    const claudeDoneAt = deps.now();
    calls += Math.max(1, out.usage.calls);
    claude = {
      ...articleUsageValues(out),
      claudeStartedAt: new Date(claudeStartedAt),
      claudeDoneAt: new Date(claudeDoneAt),
    };
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
    // Kiểm cấp bài (một lần cho cả bài, theo market chính như trước).
    let reason: SignalReason | null = null;
    if (c.catalyst === "none") reason = SignalReason.notSignalType;
    else if (candidate === undefined || c.relevance === "passing_mention")
      reason = SignalReason.passingMention;
    else if (c.promotional) reason = SignalReason.promotional;
    else if (eventTooOld(c.eventDate, a.publishedAt.getTime())) reason = SignalReason.eventTooOld;
    if (reason !== null || candidate === undefined || c.catalyst === "none") {
      // Lỗi của BÀI (quảng cáo, nhắc qua, không thuộc danh sách, sự kiện cũ…): chỉ ghi event. Không tạo story, không thêm
      // nguồn, không khoá key (review PR #278 R1).
      await drop(reason ?? SignalReason.notSignalType, classification);
      continue;
    }
    const catalyst: SignalCatalyst = c.catalyst;
    const matched = matchedOf(a.matchedCurrencies);
    // #530 (news-v6): mọi coin của sự kiện (reader v7 trả `markets`; bài trước v7 chỉ có `market`), xếp theo thứ tự bài
    // nêu. Bài nêu hơn `eventMaxCoins` coin là bài tổng hợp: cả bài `PASSING_MENTION`, không cắt lấy vài coin đầu.
    const listed = marketsByMention(
      a.title,
      a.content,
      (c.markets ?? [candidate.market]).flatMap((m) => {
        const x = candidates.find((y) => y.market === m);
        return x === undefined ? [] : [x];
      }),
      matched,
    );
    if (listed.length > NEWS_RULES.eventMaxCoins) {
      await drop(SignalReason.passingMention, {
        ...classification,
        eventCoinsListed: listed.length,
      });
      continue;
    }
    // Kiểm tất định từng coin; coin rớt không tính vào số coin của sự kiện (k), ghi vào `eventDropped`.
    const checked = listed.map((x) => ({
      c: x,
      reason: coinCheck(catalyst, x, a.title, a.content, matched),
    }));
    const passed = checked.filter((x) => x.reason === null).map((x) => x.c);
    const eventDropped = checked.flatMap((x) =>
      x.reason === null ? [] : [{ market: x.c.market, reason: x.reason }],
    );
    // Bài đăng lại của một sự kiện nhiều coin đã xét (cùng loại tin, trong 24 giờ, có ít nhất một coin trùng): mọi coin
    // của bài là `SAME_EVENT`, kể cả coin mới.
    const earlierEvent = await sameEventOf(
      db,
      a.id,
      catalyst,
      listed.map((x) => x.market),
      now,
    );
    // Bài mở sự kiện nhiều coin (nêu ≥ 2 coin, kể cả coin rớt ở kiểm từng coin): ghi để nhận ra bài đăng lại.
    const event =
      earlierEvent === null && listed.length >= 2
        ? { key: `evt:${a.id}`, catalyst, markets: listed.map((x) => x.market) }
        : null;
    const eventInfo = {
      ...(event === null ? {} : { event }),
      ...(listed.length >= 2 || earlierEvent !== null
        ? {
            eventMarkets: passed.map((x) => x.market),
            eventCoins: passed.length,
            ...(eventDropped.length > 0 ? { eventDropped } : {}),
            ...(earlierEvent === null ? {} : { sameEventOf: earlierEvent.key }),
          }
        : {}),
    };
    if (passed.length === 0) {
      // Mọi coin rớt ở kiểm từng coin: lý do của coin đầu (một coin: đúng như trước).
      await drop(eventDropped[0]?.reason ?? SignalReason.notSignalType, {
        ...classification,
        ...eventInfo,
      });
      continue;
    }
    const k = passed.length;
    const eventKey = earlierEvent?.key ?? (k >= 2 ? (event?.key ?? null) : null);
    // Bài đăng lại dùng lại k của bài đầu (lần thử lại chia đúng phần của sự kiện, không lấy đủ cỡ).
    const coinsOf = earlierEvent === null ? k : earlierEvent.coins;
    const inRetry =
      earlierEvent !== null && now - earlierEvent.firstAt <= NEWS_RULES.retryWindowMinutes * MIN_MS;
    const made: Signal[] = passed.map((x, i) => ({
      articleId: a.id,
      source: a.source,
      tier: sourceTierOf(a.source, a.category),
      publishedAt: a.publishedAt.getTime(),
      collectedAt: a.collectedAt.getTime(),
      title: a.title,
      candidate: x,
      catalyst,
      eventKey,
      eventCoins: coinsOf,
      sameEvent: earlierEvent !== null,
      retryable: inRetry && earlierEvent.markets.includes(x.market),
      primary: i === 0,
    }));
    const first = made[0];
    if (first === undefined) continue;
    const rule = catalystRule(catalyst);
    await db.transaction(async (tx) => {
      await tx
        .update(signalArticles)
        .set({
          status: "classified",
          classification: { ...classification, ...eventInfo },
          classifiedAt: new Date(now),
          ...claude,
        })
        .where(eq(signalArticles.id, a.id));
      await recordEvents(tx, [
        {
          articleId: a.id,
          stage: SignalStage.understand,
          outcome: SignalOutcome.pass,
          detail: {
            market: first.candidate.market,
            catalyst,
            direction: rule.direction,
            maxHoldHours: rule.maxHoldHours,
            ...(small ? { smallTreasury: true } : {}),
            ...eventInfo,
            ...(eventKey === null ? {} : { eventKey }),
            assetMapVersion: NEWS_ASSET_MAP_VERSION,
          },
          at: now,
        },
      ]);
    });
    signals.push(...made);
  }
  report.signals = signals.length;

  if (report.classified > 0)
    await noteClassifierVersion(db, {
      promptVersion: NEWS_CLASSIFIER.promptVersion,
      model: NEWS_CLASSIFIER.model,
      at: new Date(now),
    });

  const ctx = cycleContext(deps, info, now);
  const groups = groupsOf(signals);
  // ── Tín hiệu mainnet (#419): ghi ngay sau Understand, trước Context / Filter, để độ trễ tới engine thấp nhất. Lỗi chỉ log;
  // báo giá đọc riêng nên quyết định của research versions không đổi.
  const publisher = deps.newsSignals ?? null;
  // #530 PR2: chia sự kiện cho mainnet chỉ khi `SIGNAL_NEWS_EVENT_SPLIT_ENABLED` bật. Tắt: chỉ coin chính của mỗi bài, một
  // coin (`event_key` null, `event_coins` 1, cả lần thử lại), như trước PR1. Lệnh giấy bên dưới vẫn chia ở cả hai trạng thái.
  const published =
    publisher?.eventSplit === true
      ? groups
      : groupsOf(
          signals.filter((s) => s.primary).map((s) => ({ ...s, eventKey: null, eventCoins: 1 })),
        );
  if (publisher !== null && published.size > 0) {
    try {
      report.newsSignals = await publishNewsSignals(
        {
          db,
          now: deps.now,
          quotes: deps.quotes,
          typical: ctx.typical,
          notify: publisher.notify,
          log: deps.log,
        },
        now,
        published,
      );
    } catch (e) {
      deps.log.warn(
        { err: e instanceof Error ? { name: e.name, message: e.message } : String(e) },
        "news signals not written",
      );
    }
  }

  // ── 4. Context (#329): ngữ cảnh lúc quyết định của mọi tín hiệu (kể cả tín hiệu sẽ bị loại / shadow), trước Filter.
  report.contexts = await captureContexts(deps, ctx, groups);

  // ── 5–6. Filter + Decide, riêng cho từng News bot version đang chạy (#303, DEC-328), theo story key ─────────────
  if (groups.size > 0) {
    const { versions, invalid } = await runningSignalBotVersions(db);
    if (invalid.length > 0)
      deps.log.warn(
        { versionIds: invalid },
        "signal research: bot version config invalid, skipped",
      );
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

/**
 * Mốc bắt đầu story cho H3 của bước 4 (review PR #349): cùng hàm `storyStartOf` với Decide, trên các lần thử trước của MỌI
 * version (bước 4 chạy trước Filter, không theo version). Lần thử trước đã quá cửa sổ thử lại thì version có lần thử đó gộp
 * `STORY_TOO_OLD` (không có lệnh), còn version chưa từng thử sẽ vào lệnh với mốc = bài đầu nhóm: dùng mốc đó. Nhờ vậy H3
 * bằng `moved_before_entry` của mọi lệnh mở từ nhóm này, trừ version được lưu khi story đang dở (chưa thấy bài đầu).
 */
async function contextStoryStart(
  db: Db,
  key: string,
  group: readonly Signal[],
  now: number,
): Promise<number | null> {
  const first = group[0];
  if (first === undefined) return null;
  const earlier = await earlierAttempts(db, null, key, now);
  const s = storyStartOf(
    earlier.flatMap((e) => e.sources.map((x) => Date.parse(x.at))),
    first.publishedAt,
  );
  return s.retry && storyTooOld(s.start, now) ? first.publishedAt : s.start;
}

/**
 * Bước 4 · Context: chụp ngữ cảnh từng tín hiệu tại `now` (giờ quyết định của chu kỳ). Báo giá lấy qua bộ nhớ đệm của chu kỳ
 * (cùng báo giá Decide dùng, nên không đổi giá vào lệnh). Lỗi ở đây chỉ ghi log: không bao giờ chặn Filter / Decide.
 */
async function captureContexts(
  deps: PipelineDeps,
  ctx: CycleContext,
  groups: ReadonlyMap<string, readonly Signal[]>,
): Promise<number> {
  const capture = deps.captureContext === undefined ? captureSignalContext : deps.captureContext;
  if (capture === null) return 0;
  let n = 0;
  for (const [key, group] of groups) {
    let storyStartAt: number | null = null;
    try {
      storyStartAt = await contextStoryStart(deps.db, key, group, ctx.now);
    } catch (e) {
      deps.log.warn(
        { storyKey: key, error: e instanceof Error ? e.message : "error" },
        "signal research: context capture failed",
      );
      continue;
    }
    for (const s of group) {
      try {
        const q = await ctx.quote(s.candidate.market);
        await capture(
          deps.db,
          {
            articleId: s.articleId,
            market: s.candidate.market,
            direction: catalystRule(s.catalyst).direction,
            storyStartAt: storyStartAt ?? s.publishedAt,
          },
          ctx.now,
          typeof q === "string" ? null : q,
        );
        n += 1;
      } catch (e) {
        deps.log.warn(
          { articleId: s.articleId, error: e instanceof Error ? e.message : "error" },
          "signal research: context capture failed",
        );
      }
    }
  }
  return n;
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

const sourcesOf = (xs: readonly Signal[]): StorySourceRef[] =>
  xs.map((s) => ({
    name: s.source,
    tier: s.tier,
    articleId: s.articleId,
    at: new Date(s.publishedAt).toISOString(),
  }));

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
        gte(signalStories.firstSeenAt, storyWindowStart(now)),
      ),
    )
    .orderBy(asc(signalStories.firstSeenAt))
    .limit(1);
  return s;
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
        q =
          deps.quotes.decisionQuote?.(market) ??
          deps.quotes.quotes([market]).then((m) => m.get(market) ?? SignalReason.noPrice);
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
  ): EventInput => ({
    articleId: s.articleId,
    stage,
    outcome,
    at: now,
    versionId: v.id,
    // #375: giờ đồng hồ thật lúc quyết định cho bài này (đo chặng Claude done → decided).
    decidedClockAt: deps.now(),
    ...extra,
  });

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
  // #530 (news-v6): bài đăng lại của một sự kiện nhiều coin đã xét lẽ ra mở câu chuyện MỚI cho coin này (không có câu chuyện
  // khoá, không có lần thử trước): bỏ ở Filter với `SAME_EVENT` (không tạo story), không vào lệnh. Có lần thử trước (coin bị bỏ ở Filter của bài đầu, câu
  // chuyện đã tạo) thì đi đúng luật thử lại hiện có: thử lại trong `retryWindowMinutes`, quá thì `STORY_TOO_OLD`.
  // k của bài đầu = 0 (mọi coin của bài đầu rớt ở Understand) thì không có phần nào để chia: cũng bỏ, không vào lệnh.
  if (first.sameEvent && (earlier.length === 0 || first.eventCoins < 1)) {
    await recordEvents(
      db,
      group.map((s) =>
        ev(s, SignalStage.filter, SignalOutcome.drop, {
          reason: SignalReason.sameEvent,
          detail: { eventKey: s.eventKey },
        }),
      ),
    );
    return { ...none, skipped: group.map(() => SignalReason.sameEvent) };
  }
  // #312: mốc bắt đầu story; H3 của bước 4 dùng cùng hàm (`storyStartOf`) nên cùng con số với `moved_before_entry`.
  const { start: storyStart, retry } = storyStartOf(
    earlier.flatMap((e) => e.sources.map((x) => Date.parse(x.at))),
    first.publishedAt,
  );
  const lastAttempt = earlier.at(-1);
  if (retry && lastAttempt !== undefined && storyTooOld(storyStart, now)) {
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
  if (typeof quote === "string") {
    // #507 phần D: không có giá → ghi thiếu gì (tuổi sổ / giá gần nhất, mẫu spread, tick size, kết quả sổ REST).
    if (quote !== SignalReason.noPrice && quote !== SignalReason.noBookData) return fail(quote);
    const d = ctx.deps.quotes.diag?.(market);
    return fail(quote, {
      bookAgeMs: d?.bookAgeMs ?? null,
      lastAgeMs: d?.lastAgeMs ?? null,
      spreadSamples: d?.spreadSamples ?? null,
      tickSize: d?.tickSize ?? null,
      rest: d?.rest ?? null,
    });
  }

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
  // #530 (news-v6): sự kiện nhiều coin chia cỡ lệnh của version cho số coin (k), làm tròn xuống tới cent; một coin như cũ.
  const share = paperEventShare(cfg.sizeUsdc, first.eventCoins);
  const plan = planTrade({
    direction,
    quote,
    typicalMovePct: typical,
    oneWayFeePct: fee,
    sizeUsdc: share.toFixed(),
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
  // #530: phần chia của một coin dưới cỡ lệnh tối thiểu của market SoDEX → bỏ coin đó (không dồn phần sang coin khác).
  // Chỉ sự kiện nhiều coin (một coin giữ đúng hành vi cũ). Không biết lot / min của market thì cũng bỏ (không mở lệnh).
  if (first.eventCoins > 1) {
    const mi = info.get(market);
    const rules =
      mi?.stepSize != null && mi.minQuantity != null && mi.minNotional != null
        ? { stepSize: mi.stepSize, minQuantity: mi.minQuantity, minNotional: mi.minNotional }
        : null;
    if (rules === null || !meetsMinOrder(plan.entryPrice, share, rules))
      return fail(SignalReason.belowMinSize, {
        ...costDetail,
        sizeUsdc: share.toFixed(),
        eventCoins: first.eventCoins,
        ...(rules === null ? { rulesUnknown: true } : {}),
      });
  }

  // Giới hạn của version: chặn thì chỉ theo dõi giả định (shadow), ngoài balance. Số dư so với phần chia của coin này.
  const book = await versionBook(db, v.id, now);
  const blocked = limitBlock({ cfg: { ...cfg, sizeUsdc: share.toFixed() }, ...book });
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
  // #375: lúc đã quyết định mở (qua mọi kiểm). Cùng đồng hồ với `openedClock` ngay trước khi ghi lệnh; `opened_at` vẫn là
  // giờ bắt đầu chu kỳ như trước (không đổi logic giao dịch).
  const decidedClock = deps.now();
  const moved = await movedBeforeEntry(db, market, storyStart, plan.entryMid);
  const outside =
    STOCK_MARKET_SET.has(market) &&
    first.candidate.kind === AssetKind.stock &&
    !isUsMarketOpen(now);
  const shadow = blocked !== null;
  const openedClock = deps.now();
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
          decidedClockAt: new Date(decidedClock),
          openedClockAt: new Date(openedClock),
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
                decidedClockAt: decidedClock,
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
                decidedClockAt: decidedClock,
              }),
              ev(first, SignalStage.decide, SignalOutcome.open, {
                storyId,
                tradeId,
                detail: tradeDetail,
                decidedClockAt: decidedClock,
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
