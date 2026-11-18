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
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { addUsage, weightedInput, type NewsClassifier } from "./classifier";
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

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const CONTENT_MAX = 6000;

export interface MarketInfo {
  name: string;
  tickSize: string | null;
  /** `takerFee` (tỷ lệ thô) của market; null = dùng phí mặc định. */
  takerFee: string | null;
}

export interface PipelineConfig {
  claudeDailyInputBudget: number;
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
  markets: () => Promise<MarketInfo[]>;
  now: () => number;
  log: PipelineLog;
  config: PipelineConfig;
  /** Gọi sau khi mở lệnh (để watcher nạp lại ngay). */
  onTradeOpened?: () => void;
}

export interface CycleReport {
  fetched: number;
  stored: number;
  pages: number;
  classified: number;
  claudeCalls: number;
  signals: number;
  opened: number;
  skipped: Record<string, number>;
  claudeTokensToday: number;
  watermarkAt: string | null;
  error?: string;
}

const candidateList = z.array(
  z.object({ symbol: z.string(), market: z.string(), kind: z.enum(["crypto", "stock"]) }),
);

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

/** Mốc dưới của bài được xử lý: lần đầu now − lookback; sau đó watermark − 10 phút, không bao giờ cũ hơn now − 30 phút. */
export function collectFloor(watermarkAt: number | null, now: number, cfg: PipelineConfig): number {
  const capFloor = now - cfg.maxCatchUpMinutes * MIN_MS;
  if (watermarkAt === null) return Math.max(now - cfg.startLookbackMinutes * MIN_MS, capFloor);
  return Math.max(watermarkAt - NEWS_RULES.watermarkOverlapMinutes * MIN_MS, capFloor);
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
    pages: 0,
    classified: 0,
    claudeCalls: 0,
    signals: 0,
    opened: 0,
    skipped,
    claudeTokensToday: 0,
    watermarkAt: null,
  };

  // ── 1. Collect ────────────────────────────────────────────────────────────────────────────────────────────────
  const state = await newsState(db);
  const floor = collectFloor(state.watermarkAt, now, cfg);
  const markets = await deps.markets();
  const universe = new Set(markets.map((m) => m.name));
  const info = new Map(markets.map((m) => [m.name, m]));

  const fetched: SosoNewsItem[] = [];
  let sourceDown: string | null = null;
  for (let page = 1; page <= cfg.sosoMaxPages; page += 1) {
    if ((await sosoRequestsThisMonth(db, now)) >= cfg.sosoMonthlyLimit) {
      sourceDown = "monthly_quota";
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
      sourceDown = e instanceof Error ? e.message : "error";
      break;
    }
  }
  if (sourceDown !== null && fetched.length === 0) {
    await markSource(db, "sosovalue", now, sourceDown);
    deps.log.warn({ error: sourceDown }, "signal research: sosovalue unavailable");
    report.error = sourceDown;
  } else await markSource(db, "sosovalue", now, null);
  report.fetched = fetched.length;

  const known = await knownIds(
    db,
    fetched.map((i) => i.id),
  );
  const fresh = [
    ...new Map(fetched.filter((i) => !known.has(i.id)).map((i) => [i.id, i])).values(),
  ].sort((a, b) => a.release_time - b.release_time);
  const hashes = new Map(
    fresh.map((i) => [i.id, hashOf(normalizedText(i.title ?? null, i.content ?? null))] as const),
  );
  const seenHash = await existingHashes(db, [...hashes.values()]);
  const events: EventInput[] = [];
  let watermark = state.watermarkAt ?? floor;
  const rows: (typeof signalArticles.$inferInsert)[] = [];
  for (const item of fresh) {
    const hash = hashes.get(item.id) ?? "";
    const candidates = candidatesOf(item.matched_currencies, universe);
    const base = {
      id: item.id,
      source: (item.author ?? "").trim() || "unknown",
      url: item.original_link ?? item.source_link ?? null,
      title: item.title ?? null,
      content: stripHtml(item.content ?? "").slice(0, CONTENT_MAX),
      category: item.category ?? null,
      publishedAt: new Date(item.release_time),
      collectedAt: new Date(now),
      matchedCurrencies: item.matched_currencies,
      candidates,
      contentHash: hash,
      ruleVersion: NEWS_RULES.version,
    };
    const ev = (
      stage: SignalStage,
      outcome: SignalOutcome,
      reason?: SignalReason,
      detail?: Record<string, unknown>,
    ) =>
      events.push({
        articleId: item.id,
        stage,
        outcome,
        reason: reason ?? null,
        detail: detail ?? null,
        at: now,
      });
    if (item.release_time <= floor) {
      rows.push({ ...base, status: "backlog" });
      ev(SignalStage.collect, SignalOutcome.drop, SignalReason.backlog);
      skip(SignalReason.backlog);
      continue;
    }
    watermark = Math.max(watermark, item.release_time);
    ev(SignalStage.collect, SignalOutcome.pass, undefined, {
      delaySeconds: Math.round((now - item.release_time) / 1000),
    });
    // ── 2. Normalize ────────────────────────────────────────────────────────────────────────────────────────────
    const dupOf = seenHash.get(hash);
    let reason: SignalReason | null = null;
    if (now - item.release_time > NEWS_RULES.maxArticleAgeHours * HOUR_MS)
      reason = SignalReason.staleNews;
    else if (dupOf !== undefined) reason = SignalReason.duplicate;
    else if (candidates.length === 0) reason = SignalReason.noSodexMarket;
    if (!seenHash.has(hash)) seenHash.set(hash, item.id);
    if (reason !== null) {
      rows.push({
        ...base,
        status: "dropped",
        duplicateOf: reason === SignalReason.duplicate ? (dupOf ?? null) : null,
      });
      ev(SignalStage.normalize, SignalOutcome.drop, reason);
      skip(reason);
      continue;
    }
    rows.push({ ...base, status: "pending" });
    ev(SignalStage.normalize, SignalOutcome.pass, undefined, {
      candidates: candidates.map((c) => c.market),
    });
  }
  await db.transaction(async (tx) => {
    if (rows.length > 0) await tx.insert(signalArticles).values(rows).onConflictDoNothing();
    await recordEvents(tx, events);
    if (sourceDown === null || fetched.length > 0) await saveNewsState(tx, watermark, now);
  });
  report.stored = rows.length;
  report.watermarkAt = new Date(watermark).toISOString();

  // ── 3. Understand (FIFO, tối đa N lần gọi / chu kỳ, trong ngân sách ngày) ─────────────────────────────────────
  const pending = await db
    .select()
    .from(signalArticles)
    .where(
      and(eq(signalArticles.status, "pending"), eq(signalArticles.ruleVersion, NEWS_RULES.version)),
    )
    .orderBy(asc(signalArticles.publishedAt));
  const signals: Signal[] = [];
  let used = await usageToday(db, now);
  let calls = 0;
  for (const a of pending) {
    const age = now - a.publishedAt.getTime();
    const drop = async (reason: SignalReason, classification: Record<string, unknown> | null) => {
      await db.transaction(async (tx) => {
        await tx
          .update(signalArticles)
          .set({
            status: classification === null ? "dropped" : "classified",
            classification,
            classifiedAt: classification === null ? null : new Date(now),
          })
          .where(eq(signalArticles.id, a.id));
        await recordEvents(tx, [
          {
            articleId: a.id,
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
    if (calls >= cfg.claudeMaxCallsPerCycle) continue; // chờ chu kỳ sau (FIFO)
    if (weightedInput(used) >= cfg.claudeDailyInputBudget) {
      await drop(SignalReason.claudeBudget, null);
      await markSource(db, "claude", now, "daily_budget");
      continue;
    }
    const parsed = candidateList.safeParse(a.candidates);
    const candidates: Candidate[] = parsed.success ? parsed.data : [];
    calls += 1;
    const out = await deps.classifier.classify({
      title: a.title,
      content: a.content ?? "",
      source: a.source,
      publishedAt: a.publishedAt.getTime(),
      candidates,
      universe: [...universe].sort(),
    });
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
    const classification = { ...c, model: "claude", ruleVersion: NEWS_RULES.version };
    const candidate = candidates.find((x) => x.market === c.market);
    let reason: SignalReason | null = null;
    if (c.catalyst === "none") reason = SignalReason.notSignalType;
    else if (candidate === undefined || c.relevance === "passing_mention")
      reason = SignalReason.passingMention;
    else if (c.promotional) reason = SignalReason.promotional;
    else if (!catalystRule(c.catalyst).kinds.includes(candidate.kind))
      reason = SignalReason.wrongAssetKind;
    else if (eventTooOld(c.eventDate, a.publishedAt.getTime())) reason = SignalReason.eventTooOld;
    if (reason !== null || candidate === undefined || c.catalyst === "none") {
      await drop(reason ?? SignalReason.notSignalType, classification);
      continue;
    }
    const rule = catalystRule(c.catalyst);
    await db.transaction(async (tx) => {
      await tx
        .update(signalArticles)
        .set({ status: "classified", classification, classifiedAt: new Date(now) })
        .where(eq(signalArticles.id, a.id));
      await recordEvents(tx, [
        {
          articleId: a.id,
          stage: SignalStage.understand,
          outcome: SignalOutcome.pass,
          detail: {
            market: candidate.market,
            catalyst: c.catalyst,
            direction: rule.direction,
            maxHoldHours: rule.maxHoldHours,
          },
          at: now,
        },
      ]);
    });
    signals.push({
      articleId: a.id,
      source: a.source,
      tier: sourceTierOf(a.source, a.category),
      publishedAt: a.publishedAt.getTime(),
      collectedAt: a.collectedAt.getTime(),
      title: a.title,
      candidate,
      catalyst: c.catalyst,
    });
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

  const today = await usageToday(db, now);
  report.claudeTokensToday = today.input + today.cacheWrite + today.cacheRead + today.output;
  deps.log.info(
    {
      fetched: report.fetched,
      stored: report.stored,
      pages: report.pages,
      classified: report.classified,
      claudeCalls: report.claudeCalls,
      signals: report.signals,
      opened: report.opened,
      skipped,
      claudeTokensToday: {
        input: today.input,
        cacheWrite: today.cacheWrite,
        cacheRead: today.cacheRead,
        output: today.output,
        weightedInput: weightedInput(today),
        budget: cfg.claudeDailyInputBudget,
      },
      sosoRequestsToday: today.soso,
      watermarkAt: report.watermarkAt,
    },
    "signal research news cycle",
  );
  return report;
}

async function knownIds(db: Db, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ id: signalArticles.id })
    .from(signalArticles)
    .where(inArray(signalArticles.id, [...new Set(ids)]));
  return new Set(rows.map((r) => r.id));
}

async function existingHashes(db: Db, hashes: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (hashes.length === 0) return out;
  const rows = await db
    .select({ id: signalArticles.id, hash: signalArticles.contentHash })
    .from(signalArticles)
    .where(inArray(signalArticles.contentHash, [...new Set(hashes)]))
    .orderBy(asc(signalArticles.publishedAt));
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

/**
 * Một nhóm tín hiệu cùng story key trong chu kỳ này. Câu chuyện đã có trong 7 ngày → gộp (thêm nguồn, tính lại "later
 * level", gắn later High cho lệnh), không bao giờ mở lại. Câu chuyện mới → khoá mức ở lần quyết định này (mọi nguồn có tới
 * lúc này), rồi kiểm và mở lệnh cho bài đầu tiên.
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
  const sourcesOf = (xs: readonly Signal[]) =>
    xs.map((s) => ({
      name: s.source,
      tier: s.tier,
      articleId: s.articleId,
      at: new Date(s.publishedAt).toISOString(),
    }));
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
    ...extra,
  });

  const [existing] = await db
    .select()
    .from(signalStories)
    .where(
      and(
        eq(signalStories.storyKey, key),
        eq(signalStories.ruleVersion, NEWS_RULES.version),
        gte(signalStories.firstSeenAt, new Date(now - NEWS_RULES.storyWindowDays * 24 * HOUR_MS)),
      ),
    )
    .orderBy(asc(signalStories.firstSeenAt))
    .limit(1);
  if (existing !== undefined) {
    const prev = storySources.safeParse(existing.sources);
    const sources = [...(prev.success ? prev.data : []), ...sourcesOf(group)];
    const later = levelOf(sources);
    await db.transaction(async (tx) => {
      await tx
        .update(signalStories)
        .set({ sources, laterLevel: later, updatedAt: new Date(now) })
        .where(eq(signalStories.id, existing.id));
      if (later === SignalLevel.high && existing.levelAtEntry !== SignalLevel.high)
        await tx
          .update(signalPaperTrades)
          .set({ laterHigh: true, updatedAt: new Date(now) })
          .where(eq(signalPaperTrades.storyId, existing.id));
      await recordEvents(
        tx,
        group.map((s) =>
          ev(s, SignalStage.filter, SignalOutcome.merge, {
            storyId: existing.id,
            reason: SignalReason.sameStory,
            detail: { laterLevel: later },
          }),
        ),
      );
    });
    return { opened: false, skipped: group.map(() => SignalReason.sameStory) };
  }

  const rule = catalystRule(first.catalyst);
  const sources = sourcesOf(group);
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

  // Nguồn đúng giờ.
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
  const costFail = costCheck(plan.tpPct, cost);
  const costDetail = {
    tpPct: plan.tpPct.toFixed(4),
    costPct: cost.totalPct.toFixed(4),
    spreadPct: spread.toFixed(4),
  };
  if (costFail !== null) return fail(costFail, costDetail);

  // ── Decide: mở lệnh giấy ──────────────────────────────────────────────────────────────────────────────────
  const before = await priceBefore(db, market, first.publishedAt);
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
          eventAt: new Date(first.publishedAt),
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
          tpPrice: plan.tpPrice.toFixed(18),
          slPrice: plan.slPrice.toFixed(18),
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
            tpPrice: plan.tpPrice.toFixed(),
            slPrice: plan.slPrice.toFixed(),
            priceSource: quote.source,
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

// Dùng trong test: số bài đang chờ Claude.
export async function pendingCount(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(signalArticles)
    .where(eq(signalArticles.status, "pending"));
  return r?.n ?? 0;
}
