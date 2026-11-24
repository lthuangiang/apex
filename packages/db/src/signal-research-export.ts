import {
  claudeCostUsd,
  dec,
  NEWS_RULES,
  SOURCE_HEALTH,
  SR_EXPORT_PERIOD_HOURS,
  SR_EXPORT_ROW_LIMITS,
  SR_EXPORT_SCHEMA_VERSION,
  type SignalSourceKey,
  type SrExport,
  type SrExportPeriod,
} from "@drift/shared";
import { and, asc, count, desc, gte, inArray, isNull, or, sql } from "drizzle-orm";

import type { Db } from "./client";
import type { DbTx } from "./read-only";
import {
  newsSignalDeliveries,
  newsSignals,
  newsSignalTrades,
  signalBotVersions,
  signalClassifierVersions,
  signalContexts,
  signalPaperTrades,
  signalResearchUsage,
  signalSourceHealth,
} from "./schema";
import { sourceStatus } from "./signal-research";
import { loadSignalResearchArticlesExport } from "./signal-research-articles";

// File "Export data" của Signal Research (#489; hợp đồng `srExportSchema` trong packages/shared). Chỉ đọc; nơi gọi bọc trong
// transaction chỉ đọc. Chỉ chọn những cột được phép xuất: KHÔNG đọc email, user id (`created_by`, `owner_user_id` chỉ dùng
// để tách team / riêng, không xuất), địa chỉ ví H1, id bot / tài khoản mainnet, nội dung / URL bài (trừ `excerpt` ngắn đã
// chuẩn hoá của bài không có tiêu đề, #509), `last_error` của nguồn
// (chuỗi lỗi thô có thể chứa URL / tham số). Mainnet chỉ có số gộp (DEC-361). Thiếu số → null, không bao giờ 0.

type Q = Db | DbTx;

const iso = (d: Date) => d.toISOString();
const isoOrNull = (d: Date | null) => (d === null ? null : iso(d));
/** numeric(38,18) → chuỗi thập phân gọn ("1.500000" → "1.5"). */
const decOrNull = (s: string | null) => (s === null ? null : dec(s).toFixed());
const decOut = (s: string) => dec(s).toFixed();
const KNOWN_SOURCES = new Set<string>(Object.keys(SOURCE_HEALTH));

function section(rows: number, total: number, limit: number) {
  const omitted = Math.max(0, total - rows);
  return { rows, total, omitted, truncated: omitted > 0, limit };
}

export interface SignalResearchExportInput {
  period: SrExportPeriod;
  now: Date;
  /** Chu kỳ scheduler (Redis `sr:lane`) cho trạng thái nguồn; null = chu kỳ mặc định. */
  cycleMinutes: number | null;
}

export async function loadSignalResearchExport(
  q: Q,
  input: SignalResearchExportInput,
  check: () => void = () => undefined,
): Promise<SrExport> {
  const { now, period } = input;
  const since = new Date(now.getTime() - SR_EXPORT_PERIOD_HOURS[period] * 3_600_000);

  const [reader] = await q
    .select({ v: signalClassifierVersions.promptVersion })
    .from(signalClassifierVersions)
    .orderBy(desc(signalClassifierVersions.startedAt))
    .limit(1);
  check();

  // ── Bài ──
  const arts = await loadSignalResearchArticlesExport(
    q,
    since,
    SR_EXPORT_ROW_LIMITS.articles,
    check,
  );
  const tradeIds = arts.rows.flatMap((r) =>
    r.article.tradeId === null ? [] : [r.article.tradeId],
  );
  const levels = new Map<string, string>();
  for (let i = 0; i < tradeIds.length; i += 1000) {
    const chunk = tradeIds.slice(i, i + 1000);
    for (const t of await q
      .select({ id: signalPaperTrades.id, level: signalPaperTrades.levelAtEntry })
      .from(signalPaperTrades)
      .where(inArray(signalPaperTrades.id, chunk)))
      levels.set(t.id, t.level);
    check();
  }
  const articles: SrExport["articles"] = arts.rows.map(({ article: a, ...x }) => ({
    id: a.id,
    publishedAt: a.publishedAt,
    collectedAt: a.collectedAt,
    claudeDoneAt: isoOrNull(x.claudeDoneAt),
    source: a.source,
    tier: a.tier,
    title: a.title,
    excerpt: x.excerpt,
    tagged: a.tagged,
    candidates: a.candidates,
    market: a.asset,
    stage: a.stage,
    outcome: a.outcome,
    reason: a.reason,
    reasonLimit: a.reasonLimit,
    mergeReason: a.mergeReason,
    rulesVersion: a.rulesVersion,
    readerVersion: a.readerVersion,
    sentToClaude: a.sentToClaude,
    claudeCalls: a.claude?.calls ?? null,
    claudeCostUsd: a.claude?.costUsd ?? null,
    catalyst: x.catalyst,
    relevance: x.relevance,
    promotional: x.promotional,
    level: a.tradeId === null ? null : (levels.get(a.tradeId) ?? null),
    side: a.side,
    paperTradeId: a.tradeId,
  }));

  // ── Bối cảnh (H1 chỉ số đếm, không địa chỉ ví) ──
  const ctxWhere = gte(signalContexts.decidedAt, since);
  const [ctxCount] = await q.select({ n: count() }).from(signalContexts).where(ctxWhere);
  const ctxRows = await q
    .select({
      articleId: signalContexts.articleId,
      market: signalContexts.market,
      direction: signalContexts.direction,
      decidedAt: signalContexts.decidedAt,
      source: signalContexts.source,
      contextVersion: signalContexts.contextVersion,
      ruleVersion: signalContexts.ruleVersion,
      h1Status: signalContexts.h1Status,
      h1WalletsChecked: signalContexts.h1WalletsChecked,
      h1AssetOnHyperliquid: signalContexts.h1AssetOnHyperliquid,
      h1WalletSetVersion: signalContexts.h1WalletSetVersion,
      h1WalletSetSize: signalContexts.h1WalletSetSize,
      h1AgreeingWallets: signalContexts.h1AgreeingWallets,
      h1OpposingWallets: signalContexts.h1OpposingWallets,
      h1AgreeingUsdc: signalContexts.h1AgreeingUsdc,
      h1FirstAt: signalContexts.h1FirstAt,
      h2Status: signalContexts.h2Status,
      h2FundingRate: signalContexts.h2FundingRate,
      h2FundingTime: signalContexts.h2FundingTime,
      h2Percentile: signalContexts.h2Percentile,
      h2Samples: signalContexts.h2Samples,
      h2Payer: signalContexts.h2Payer,
      h2IntervalHours: signalContexts.h2IntervalHours,
      h3Status: signalContexts.h3Status,
      h3MovedPct: signalContexts.h3MovedPct,
      h3TypicalMovePct: signalContexts.h3TypicalMovePct,
      volumeVs24h: signalContexts.volumeVs24h,
      rangeBreakout: signalContexts.rangeBreakout,
      marketVersion: signalContexts.marketVersion,
      marketBtcChange24hPct: signalContexts.marketBtcChange24hPct,
      marketBtcTrend: signalContexts.marketBtcTrend,
      marketVol4hPct: signalContexts.marketVol4hPct,
      marketVolPercentile: signalContexts.marketVolPercentile,
      marketVolatility: signalContexts.marketVolatility,
    })
    .from(signalContexts)
    .where(ctxWhere)
    .orderBy(desc(signalContexts.decidedAt), desc(signalContexts.articleId))
    .limit(SR_EXPORT_ROW_LIMITS.context);
  check();
  const context: SrExport["context"] = ctxRows.map((c) => ({
    articleId: c.articleId,
    market: c.market,
    direction: c.direction,
    decidedAt: iso(c.decidedAt),
    source: c.source,
    contextVersion: c.contextVersion,
    ruleVersion: c.ruleVersion,
    h1: {
      status: c.h1Status,
      walletsChecked: c.h1WalletsChecked,
      assetOnHyperliquid: c.h1AssetOnHyperliquid,
      walletSetVersion: c.h1WalletSetVersion,
      walletSetSize: c.h1WalletSetSize,
      agreeingWallets: c.h1AgreeingWallets,
      opposingWallets: c.h1OpposingWallets,
      agreeingUsdc: decOrNull(c.h1AgreeingUsdc),
      firstAt: isoOrNull(c.h1FirstAt),
    },
    h2: {
      status: c.h2Status,
      fundingRate: decOrNull(c.h2FundingRate),
      fundingTime: isoOrNull(c.h2FundingTime),
      percentile: decOrNull(c.h2Percentile),
      samples: c.h2Samples,
      payer: c.h2Payer,
      intervalHours: decOrNull(c.h2IntervalHours),
    },
    h3: {
      status: c.h3Status,
      movedPct: decOrNull(c.h3MovedPct),
      typicalMovePct: decOrNull(c.h3TypicalMovePct),
    },
    volumeVs24h: decOrNull(c.volumeVs24h),
    rangeBreakout: c.rangeBreakout,
    marketState: {
      version: c.marketVersion,
      btcChange24hPct: decOrNull(c.marketBtcChange24hPct),
      btcTrend: c.marketBtcTrend,
      vol4hPct: decOrNull(c.marketVol4hPct),
      volPercentile: decOrNull(c.marketVolPercentile),
      volatility: c.marketVolatility,
    },
  }));

  // ── Version: team đầy đủ, riêng chỉ số đếm ──
  const versionRows = await q
    .select({
      id: signalBotVersions.id,
      number: signalBotVersions.number,
      name: signalBotVersions.name,
      status: signalBotVersions.status,
      isBaseline: signalBotVersions.isBaseline,
      config: signalBotVersions.config,
      hypothesis: signalBotVersions.hypothesis,
      statusChangedAt: signalBotVersions.statusChangedAt,
      createdAt: signalBotVersions.createdAt,
      experimentFinishedAt: signalBotVersions.experimentFinishedAt,
      experimentResult: signalBotVersions.experimentResult,
      private: sql<boolean>`${signalBotVersions.ownerUserId} is not null`,
    })
    .from(signalBotVersions)
    .orderBy(asc(signalBotVersions.number));
  check();
  const teamVersions = versionRows.filter((v) => !v.private);
  const privateByStatus = new Map<string, number>();
  for (const v of versionRows)
    if (v.private) privateByStatus.set(v.status, (privateByStatus.get(v.status) ?? 0) + 1);
  const numberOf = new Map(teamVersions.map((v) => [v.id, v.number]));

  // ── Lệnh giấy: version của team (và lệnh trước version); My versions chỉ số đếm ──
  const teamTrade = or(
    isNull(signalPaperTrades.versionId),
    sql`not exists (select 1 from ${signalBotVersions} v where v.id = ${signalPaperTrades.versionId} and v.owner_user_id is not null)`,
  );
  const opened = gte(signalPaperTrades.openedAt, since);
  const [tradeCount] = await q
    .select({
      team: sql<number>`count(*) filter (where ${teamTrade})::int`,
      all: sql<number>`count(*)::int`,
    })
    .from(signalPaperTrades)
    .where(opened);
  const tradeRows = await q
    .select({
      id: signalPaperTrades.id,
      versionId: signalPaperTrades.versionId,
      label: signalPaperTrades.label,
      articleId: signalPaperTrades.articleId,
      market: signalPaperTrades.market,
      direction: signalPaperTrades.direction,
      level: signalPaperTrades.levelAtEntry,
      catalyst: signalPaperTrades.catalyst,
      status: signalPaperTrades.status,
      openedAt: signalPaperTrades.openedAt,
      sizeUsdc: signalPaperTrades.sizeUsdc,
      entryPrice: signalPaperTrades.entryPrice,
      tpPrice: signalPaperTrades.tpPrice,
      slPrice: signalPaperTrades.slPrice,
      exitedAt: signalPaperTrades.exitedAt,
      exitPrice: signalPaperTrades.exitPrice,
      exitReason: signalPaperTrades.exitReason,
      resultUsdc: signalPaperTrades.resultUsdc,
      resultPct: signalPaperTrades.resultPct,
    })
    .from(signalPaperTrades)
    .where(and(opened, teamTrade))
    .orderBy(desc(signalPaperTrades.openedAt), desc(signalPaperTrades.id))
    .limit(SR_EXPORT_ROW_LIMITS.paperTrades);
  check();
  const teamTrades = tradeCount?.team ?? 0;
  const paperItems: SrExport["paperTrades"]["items"] = tradeRows.map((t) => ({
    id: t.id,
    version: t.versionId === null ? null : (numberOf.get(t.versionId) ?? null),
    label: t.label,
    articleId: t.articleId,
    market: t.market,
    side: t.direction,
    level: t.level,
    catalyst: t.catalyst,
    status: t.status,
    openedAt: iso(t.openedAt),
    sizeUsdc: decOut(t.sizeUsdc),
    entryPrice: decOut(t.entryPrice),
    tpPrice: decOut(t.tpPrice),
    slPrice: decOut(t.slPrice),
    exitedAt: isoOrNull(t.exitedAt),
    exitPrice: decOrNull(t.exitPrice),
    exitReason: t.exitReason,
    resultUsdc: decOrNull(t.resultUsdc),
    resultPct: decOrNull(t.resultPct),
  }));

  // ── Mainnet: chỉ số gộp, không dòng theo bot / người (DEC-361) ──
  const decided = gte(newsSignals.decidedAt, since);
  const byLevel = await q
    .select({ key: newsSignals.level, n: count() })
    .from(newsSignals)
    .where(decided)
    .groupBy(newsSignals.level)
    .orderBy(asc(newsSignals.level));
  const byKind = await q
    .select({ key: newsSignals.kind, n: count() })
    .from(newsSignals)
    .where(decided)
    .groupBy(newsSignals.kind)
    .orderBy(asc(newsSignals.kind));
  const byOutcome = await q
    .select({
      outcome: newsSignalDeliveries.outcome,
      reason: newsSignalDeliveries.reason,
      n: count(),
    })
    .from(newsSignalDeliveries)
    .where(gte(newsSignalDeliveries.createdAt, since))
    .groupBy(newsSignalDeliveries.outcome, newsSignalDeliveries.reason)
    .orderBy(asc(newsSignalDeliveries.outcome), asc(newsSignalDeliveries.reason));
  const tradesOpened = gte(newsSignalTrades.openedAt, since);
  const byStatus = await q
    .select({ key: newsSignalTrades.status, n: count() })
    .from(newsSignalTrades)
    .where(tradesOpened)
    .groupBy(newsSignalTrades.status)
    .orderBy(asc(newsSignalTrades.status));
  const byCloseReason = await q
    .select({ key: newsSignalTrades.closeReason, n: count() })
    .from(newsSignalTrades)
    .where(and(tradesOpened, sql`${newsSignalTrades.status} = 'closed'`))
    .groupBy(newsSignalTrades.closeReason)
    .orderBy(asc(newsSignalTrades.closeReason));
  check();
  const sumN = (xs: readonly { n: number }[]) => xs.reduce((a, x) => a + x.n, 0);

  // ── Chi phí theo ngày UTC (ngày của mốc đầu kỳ trở đi) ──
  const usage = await q
    .select()
    .from(signalResearchUsage)
    .where(gte(signalResearchUsage.day, since.toISOString().slice(0, 10)))
    .orderBy(asc(signalResearchUsage.day));
  const health = await q
    .select({
      source: signalSourceHealth.source,
      lastOkAt: signalSourceHealth.lastOkAt,
      lastErrorAt: signalSourceHealth.lastErrorAt,
      lastError: signalSourceHealth.lastError,
      lastCycleAt: signalSourceHealth.lastCycleAt,
      watermarkAt: signalSourceHealth.watermarkAt,
    })
    .from(signalSourceHealth)
    .orderBy(asc(signalSourceHealth.source));
  check();

  const artSection = section(articles.length, arts.total, SR_EXPORT_ROW_LIMITS.articles);
  const ctxSection = section(context.length, ctxCount?.n ?? 0, SR_EXPORT_ROW_LIMITS.context);
  const tradeSection = section(paperItems.length, teamTrades, SR_EXPORT_ROW_LIMITS.paperTrades);
  return {
    meta: {
      schemaVersion: SR_EXPORT_SCHEMA_VERSION,
      period,
      from: iso(since),
      to: iso(now),
      exportedAt: iso(now),
      rulesVersion: NEWS_RULES.version,
      readerVersion: reader?.v ?? null,
      articlesVersion: arts.scope?.number ?? null,
      truncated: artSection.truncated || ctxSection.truncated || tradeSection.truncated,
      sections: { articles: artSection, context: ctxSection, paperTrades: tradeSection },
    },
    articles,
    context,
    versions: {
      team: teamVersions.map((v) => ({
        number: v.number,
        name: v.name,
        status: v.status,
        isBaseline: v.isBaseline,
        config: v.config,
        hypothesis: v.hypothesis,
        statusChangedAt: iso(v.statusChangedAt),
        createdAt: iso(v.createdAt),
        experimentFinishedAt: isoOrNull(v.experimentFinishedAt),
        experimentResult: v.experimentResult ?? null,
      })),
      private: {
        total: versionRows.length - teamVersions.length,
        byStatus: [...privateByStatus.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, n]) => ({ key, n })),
      },
    },
    paperTrades: {
      items: paperItems,
      privateVersionTrades: (tradeCount?.all ?? 0) - teamTrades,
    },
    mainnet: {
      signals: { total: sumN(byLevel), byLevel, byKind },
      deliveries: { total: sumN(byOutcome), byOutcome },
      trades: { total: sumN(byStatus), byStatus, byCloseReason },
    },
    costs: {
      days: usage.map((u) => ({
        day: u.day,
        sosoRequests: u.sosoRequests,
        claudeCalls: u.claudeCalls,
        claudeInputTokens: u.claudeInputTokens,
        claudeCacheWriteTokens: u.claudeCacheWriteTokens,
        claudeCacheReadTokens: u.claudeCacheReadTokens,
        claudeOutputTokens: u.claudeOutputTokens,
        claudeCostUsd: claudeCostUsd({
          input: u.claudeInputTokens,
          cacheWrite: u.claudeCacheWriteTokens,
          cacheRead: u.claudeCacheReadTokens,
          output: u.claudeOutputTokens,
        })
          .toDecimalPlaces(6)
          .toFixed(),
      })),
    },
    sources: health.map((h) => ({
      source: h.source,
      // Trạng thái tính như ô nguồn của trang; `last_error` chỉ dùng để phân loại, không xuất.
      status: KNOWN_SOURCES.has(h.source)
        ? sourceStatus(
            h.source as SignalSourceKey,
            h.lastOkAt,
            h.lastErrorAt,
            now.getTime(),
            h.lastError,
            input.cycleMinutes,
          )
        : null,
      lastOkAt: isoOrNull(h.lastOkAt),
      lastErrorAt: isoOrNull(h.lastErrorAt),
      lastCycleAt: isoOrNull(h.lastCycleAt),
      watermarkAt: isoOrNull(h.watermarkAt),
    })),
  };
}
