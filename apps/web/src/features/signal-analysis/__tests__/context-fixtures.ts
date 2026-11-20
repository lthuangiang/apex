import { researchSignalContextSchema, type ResearchSignalContext } from "@drift/shared";

// Snapshot bước 4 · Context giả (#343), theo đúng schema API #349 (parse qua zod). Giờ ở UTC; ở Asia/Ho_Chi_Minh
// (UTC+7) 02:41Z = 09:41 như mockup redesign-context-card.html.

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

const BASE: ResearchSignalContext = {
  decidedAt: "2026-11-19T03:20:14.000Z",
  source: "live",
  contextVersion: "context-v1",
  market: "ETH-USD",
  side: "long",
  h1: {
    status: "yes",
    walletsChecked: 12,
    walletSetVersion: null,
    walletSetSize: null,
    assetOnHyperliquid: true,
    agreeingWallets: 2,
    opposingWallets: 0,
    agreeing: null,
    opposing: null,
    agreeingUsdc: "1400000",
    firstAt: "2026-11-19T02:41:00.000Z",
    windowMinutes: 60,
  },
  h2: {
    status: "yes",
    fundingRate: "-0.0001",
    fundingTime: "2026-11-19T03:00:00.000Z",
    intervalHours: 8,
    percentile: 8,
    samples: 90,
    payer: "short",
    thresholdPercentile: 20,
    lookbackDays: 30,
  },
  h3: { status: "no", movedPct: 0.2, typicalMovePct: 0.6, thresholdPct: 0.6 },
  exploratory: { volumeVs24h: 1.8, rangeBreakout: "none" },
};

/** Ghép một snapshot, parse qua schema để fixture không lệch API. */
export function context(p: DeepPartial<ResearchSignalContext> = {}): ResearchSignalContext {
  return researchSignalContextSchema.parse({
    ...BASE,
    ...p,
    h1: { ...BASE.h1, ...p.h1 },
    h2: { ...BASE.h2, ...p.h2 },
    h3: { ...BASE.h3, ...p.h3 },
    exploratory: { ...BASE.exploratory, ...p.exploratory },
  });
}

/** ETH Long: cá voi cùng chiều, funding ngược đám đông, giá chưa chạy (2 of 3 yes). */
export const CTX_ETH = context();

/** "No signal" (mockup trace-no-signal): cả ba No; Short SOL. */
export const CTX_NONE = context({
  market: "SOL-USD",
  side: "short",
  decidedAt: "2026-11-19T02:58:06.000Z",
  h1: {
    status: "no",
    agreeingWallets: 0,
    opposingWallets: 0,
    agreeingUsdc: null,
    firstAt: null,
  },
  h2: {
    status: "no",
    fundingRate: "0.0001",
    percentile: 48,
    payer: "long",
    thresholdPercentile: 80,
  },
  h3: { status: "no", movedPct: -0.1, typicalMovePct: 0.8, thresholdPct: 0.8 },
  exploratory: { volumeVs24h: null, rangeBreakout: null },
});

/** Cá voi ngược chiều + giá đã chạy sớm (H3 Yes, cảnh báo). */
export const CTX_AGAINST_LATE = context({
  h1: {
    status: "against",
    agreeingWallets: 0,
    opposingWallets: 1,
    agreeingUsdc: null,
    firstAt: null,
  },
  h2: { status: "no", percentile: 56, payer: "long", fundingRate: "0.0001" },
  h3: { status: "yes", movedPct: 1.1, typicalMovePct: 0.8, thresholdPct: 0.8 },
  exploratory: { rangeBreakout: "up" },
});

const H1_NA = { agreeingWallets: 0, opposingWallets: 0, agreeingUsdc: null, firstAt: null };

/** Tài sản không có trên Hyperliquid (META). */
export const CTX_NA_ASSET = context({
  market: "META-USD",
  h1: { ...H1_NA, status: "na", assetOnHyperliquid: false, walletsChecked: 0 },
  h2: {
    status: "na",
    percentile: null,
    fundingRate: null,
    fundingTime: null,
    payer: null,
    samples: 4,
  },
  h3: { status: "na", movedPct: null, typicalMovePct: null, thresholdPct: null },
});

/** Có trên Hyperliquid nhưng 0 ví theo dõi có dữ liệu. */
export const CTX_NA_WALLETS = context({
  h1: { ...H1_NA, status: "na", assetOnHyperliquid: true, walletsChecked: 0 },
});

/** Snapshot dựng lại sau (#354): H1 luôn `na`. */
export const CTX_BACKFILLED = context({
  source: "backfilled",
  h1: { ...H1_NA, status: "na", assetOnHyperliquid: true, walletsChecked: null },
});

/**
 * context-v2 (#353): cùng snapshot ETH nhưng H1 trên tập ví nghiên cứu version 3 (top 30 của leaderboard). Fixture gốc ở
 * trên là context-v1 (ví được follow) để giữ câu chữ cũ cho snapshot đã lưu.
 */
export const CTX_V2 = context({
  contextVersion: "context-v2",
  h1: { walletSetVersion: 3, walletSetSize: 30 },
});
