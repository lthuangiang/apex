import {
  compareContext,
  contextGroupOf,
  dec,
  H23_SAME_AS_CURRENT,
  h2ThresholdOf,
  NEWS_RULES,
  SIGNAL_CONTEXT_RULES,
  SIGNAL_CONTEXT_VERSION,
  type ContextSource,
  type DayObs,
  type Decimal,
  type FundingPayer,
  type H1Status,
  type H2Status,
  type H3Status,
  type RangeBreakout,
  type ResearchContextFlags,
  type ResearchContextQuestion,
  type ResearchContextSummary,
  type ResearchSignalContext,
} from "@drift/shared";
import { and, count, eq, gte, inArray, sql } from "drizzle-orm";

import type { Db } from "./client";
import type { DbTx } from "./read-only";
import { latestResearchWalletSet } from "./research-wallets";
import { leaderStatsDaily, signalContexts, type signalPaperTrades } from "./schema";
import type { SignalVersionScope } from "./signal-research-versions";

// Đọc ngữ cảnh tín hiệu (#329) cho API: thẻ bước 4 của trace, cờ gọn của feed, khối "Does context help?" của tổng kết.
// Chỉ đọc giá trị đã lưu lúc quyết định (scheduler `captureSignalContext`); không bao giờ tính lại ngữ cảnh ở đây.

type Q = Db | DbTx;
type ContextRow = typeof signalContexts.$inferSelect;
type TradeRow = typeof signalPaperTrades.$inferSelect;

const iso = (d: Date) => d.toISOString();
const num = (d: Decimal | null): number | null =>
  d === null ? null : d.toDecimalPlaces(4).toNumber();
const numOf = (s: string | null): number | null => (s === null ? null : num(dec(s)));
const decOut = (s: string | null): string | null => (s === null ? null : dec(s).toFixed());

const H1: ReadonlySet<string> = new Set(["yes", "no", "against", "na"]);
const H23: ReadonlySet<string> = new Set(["yes", "no", "na"]);
const h1Of = (v: string): H1Status => (H1.has(v) ? (v as H1Status) : "na");
const h2Of = (v: string): H2Status => (H23.has(v) ? (v as H2Status) : "na");
const h3Of = (v: string): H3Status => (H23.has(v) ? (v as H3Status) : "na");
const sideOf = (v: string) => (v === "short" ? ("short" as const) : ("long" as const));
const payerOf = (v: string | null): FundingPayer | null =>
  v === "long" || v === "short" || v === "none" ? v : null;
const breakoutOf = (v: string | null): RangeBreakout | null =>
  v === "up" || v === "down" || v === "none" ? v : null;
const sourceOf = (v: string) => (v === "backfilled" ? ("backfilled" as const) : ("live" as const));

export function contextFlagsOf(r: ContextRow): ResearchContextFlags {
  return {
    source: sourceOf(r.source),
    h1: h1Of(r.h1Status),
    h2: h2Of(r.h2Status),
    h3: h3Of(r.h3Status),
  };
}

/** Ví có thống kê leaderboard Hyperliquid (trang `/traders/[address]` mở được) trong `addresses` (chữ thường). */
export async function walletsWithProfile(
  q: Q,
  addresses: readonly string[],
): Promise<ReadonlySet<string>> {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (list.length === 0) return new Set();
  const rows = await q
    .selectDistinct({ address: sql<string>`lower(${leaderStatsDaily.address})` })
    .from(leaderStatsDaily)
    .where(
      and(
        eq(leaderStatsDaily.source, "hyperliquid"),
        inArray(sql`lower(${leaderStatsDaily.address})`, list),
      ),
    );
  return new Set(rows.map((r) => r.address));
}

/** Địa chỉ ví đã lưu trong snapshot (để tra trang trader trước khi dựng thẻ). */
export const contextWalletAddresses = (r: ContextRow): string[] => [
  ...(r.h1AgreeingAddresses ?? []),
  ...(r.h1OpposingAddresses ?? []),
];

const refsOf = (list: string[] | null, profiles: ReadonlySet<string>) =>
  list === null
    ? null
    : list.map((address) => {
        const a = address.toLowerCase();
        return { address: a, hasProfile: profiles.has(a) };
      });

/** Thẻ bước 4. `profiles` = ví có trang trader (`walletsWithProfile`); thiếu thì mọi ví chỉ hiện địa chỉ. */
export function signalContextOf(
  r: ContextRow,
  profiles: ReadonlySet<string> = new Set(),
): ResearchSignalContext {
  const side = sideOf(r.direction);
  const typical = r.h3TypicalMovePct === null ? null : dec(r.h3TypicalMovePct);
  const pctl = r.h2Percentile === null ? null : Number(r.h2Percentile);
  return {
    decidedAt: iso(r.decidedAt),
    source: sourceOf(r.source),
    contextVersion: r.contextVersion,
    market: r.market,
    side,
    h1: {
      status: h1Of(r.h1Status),
      walletsChecked: r.h1WalletsChecked,
      walletSetVersion: r.h1WalletSetVersion,
      walletSetSize: r.h1WalletSetSize,
      assetOnHyperliquid: r.h1AssetOnHyperliquid,
      agreeingWallets: r.h1AgreeingWallets,
      opposingWallets: r.h1OpposingWallets,
      agreeing: refsOf(r.h1AgreeingAddresses, profiles),
      opposing: refsOf(r.h1OpposingAddresses, profiles),
      agreeingUsdc: decOut(r.h1AgreeingUsdc),
      firstAt: r.h1FirstAt === null ? null : iso(r.h1FirstAt),
      windowMinutes: SIGNAL_CONTEXT_RULES.h1WindowMinutes,
    },
    h2: {
      status: h2Of(r.h2Status),
      fundingRate: decOut(r.h2FundingRate),
      fundingTime: r.h2FundingTime === null ? null : iso(r.h2FundingTime),
      intervalHours: r.h2IntervalHours === null ? null : Number(r.h2IntervalHours),
      percentile: pctl === null ? null : Math.min(100, Math.max(0, pctl)),
      samples: r.h2Samples,
      payer: payerOf(r.h2Payer),
      thresholdPercentile: h2ThresholdOf(side),
      lookbackDays: SIGNAL_CONTEXT_RULES.h2LookbackDays,
    },
    h3: {
      status: h3Of(r.h3Status),
      movedPct: numOf(r.h3MovedPct),
      typicalMovePct: num(typical),
      thresholdPct: typical === null ? null : num(typical.mul(SIGNAL_CONTEXT_RULES.h3Multiple)),
    },
    exploratory: {
      volumeVs24h: numOf(r.volumeVs24h),
      rangeBreakout: breakoutOf(r.rangeBreakout),
    },
  };
}

/** Snapshot theo id bài (một dòng mỗi bài). */
export async function loadSignalContexts(
  q: Q,
  articleIds: readonly string[],
): Promise<Map<string, ContextRow>> {
  const ids = [...new Set(articleIds)];
  if (ids.length === 0) return new Map();
  const rows = await q.select().from(signalContexts).where(inArray(signalContexts.articleId, ids));
  return new Map(rows.map((r) => [r.articleId, r]));
}

const KEYS = ["h1", "h2", "h3"] as const;

/**
 * "Does context help?" của một version: `closed` = lệnh thật đã đóng ĐƯỢC TÍNH của version (cùng tập với cổng chính,
 * classifier đã qua cổng precision). Mỗi lệnh nối snapshot của bài đã mở nó, chỉ khi snapshot đúng nguồn `source` (#344:
 * `live` và `backfilled` không bao giờ trộn); `na` không vào nhóm nào. H1 chỉ tính snapshot của context version hiện tại;
 * H2 / H3 gộp các context version cùng hàm tính (`H23_SAME_AS_CURRENT`, #353 / review #365). Độ phủ đếm mọi snapshot của
 * nguồn đó thuộc version quy tắc hiện tại (từ lúc lưu version; Baseline: mọi lúc), cùng quy tắc gộp.
 */
export async function loadContextSummary(
  q: Q,
  scope: SignalVersionScope | null,
  closed: readonly TradeRow[],
  source: ContextSource = "live",
): Promise<ResearchContextSummary> {
  const ctx = await loadSignalContexts(
    q,
    closed.flatMap((t) => (t.articleId === null ? [] : [t.articleId])),
  );
  const groups = {
    h1: { with: [] as DayObs[], without: [] as DayObs[] },
    h2: { with: [] as DayObs[], without: [] as DayObs[] },
    h3: { with: [] as DayObs[], without: [] as DayObs[] },
  };
  let missing = 0;
  for (const t of closed) {
    const c = t.articleId === null ? undefined : ctx.get(t.articleId);
    if (c?.source !== source || t.resultPct === null) {
      missing += 1;
      continue;
    }
    const obs: DayObs = { v: dec(t.resultPct), at: t.openedAt.getTime() };
    // #353 / review #365: H1 chỉ snapshot của context version hiện tại (context-v1 = ví được follow, không gộp với v2);
    // H2 / H3 gộp các version có cùng hàm tính (`H23_SAME_AS_CURRENT`). Live / Backfilled vẫn tách (điều kiện ở trên).
    const statuses = {
      h1: c.contextVersion === SIGNAL_CONTEXT_VERSION ? h1Of(c.h1Status) : null,
      h2: H23_SAME_AS_CURRENT.includes(c.contextVersion) ? h2Of(c.h2Status) : null,
      h3: H23_SAME_AS_CURRENT.includes(c.contextVersion) ? h3Of(c.h3Status) : null,
    };
    for (const k of KEYS) {
      const st = statuses[k];
      const g = st === null ? null : contextGroupOf(st);
      if (g !== null) groups[k][g].push(obs);
    }
  }
  const questions: ResearchContextQuestion[] = KEYS.map((key) => {
    const c = compareContext(groups[key].with, groups[key].without);
    return {
      key,
      with: { closed: c.withClosed, avgPct: num(c.withMean) },
      without: { closed: c.withoutClosed, avgPct: num(c.withoutMean) },
      diffPct: num(c.diff),
      range:
        c.ciLow === null || c.ciHigh === null
          ? null
          : { lo: num(c.ciLow) ?? 0, hi: num(c.ciHigh) ?? 0 },
      clusters: c.clusters,
      status: c.status,
      needWith: c.needWith,
      needWithout: c.needWithout,
    };
  });

  const since =
    scope === null || scope.isBaseline ? undefined : gte(signalContexts.decidedAt, scope.createdAt);
  const base = and(
    eq(signalContexts.ruleVersion, NEWS_RULES.version),
    inArray(signalContexts.contextVersion, [...H23_SAME_AS_CURRENT]),
    since,
  );
  const cov = await q
    .select({
      source: signalContexts.source,
      version: signalContexts.contextVersion,
      h1: signalContexts.h1Status,
      h2: signalContexts.h2Status,
      h3: signalContexts.h3Status,
      n: count(),
    })
    .from(signalContexts)
    .where(base)
    .groupBy(
      signalContexts.source,
      signalContexts.contextVersion,
      signalContexts.h1Status,
      signalContexts.h2Status,
      signalContexts.h3Status,
    );
  const own = cov.filter((r) => r.source === source);
  const sum = (rows: typeof cov) => rows.reduce((s, r) => s + r.n, 0);
  const set = await latestResearchWalletSet(q);
  return {
    contextVersion: SIGNAL_CONTEXT_VERSION,
    researchWalletsTop: set?.size ?? null,
    source,
    minClosedPerGroup: SIGNAL_CONTEXT_RULES.compareMinClosed,
    questions,
    closedWithoutSnapshot: missing,
    coverage: {
      signals: sum(own),
      // H1 chỉ version hiện tại; tín hiệu, funding, price run gộp các version cùng hàm H2 / H3.
      whale: sum(own.filter((r) => r.version === SIGNAL_CONTEXT_VERSION && r.h1 !== "na")),
      funding: sum(own.filter((r) => r.h2 !== "na")),
      priceRun: sum(own.filter((r) => r.h3 !== "na")),
      backfilled: sum(cov.filter((r) => r.source === "backfilled")),
      openInterest: "notAvailable",
    },
  };
}
