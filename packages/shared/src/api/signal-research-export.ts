import { z } from "zod";

import { isoDateTimeSchema } from "../schemas";

import {
  RESEARCH_ARTICLE_OUTCOMES,
  RESEARCH_DROP_REASONS,
  RESEARCH_MERGE_REASONS,
  RESEARCH_SOURCE_TIERS,
  RESEARCH_STAGES,
} from "./signal-research";

// File "Export data" của Signal Research (#489): một file JSON cho PM phân tích hằng ngày, chỉ role team, chỉ đọc.
// KHÔNG BAO GIỜ chứa email, user id, địa chỉ ví (kể cả ví H1), API key, token, payload đã ký, id bot / tài khoản mainnet.
// Mainnet chỉ có số gộp (DEC-361). Bài báo chỉ có tiêu đề và metadata, không có nội dung / đoạn trích / URL. Số không có
// trong DB là null, không bao giờ 0 (quy tắc 1.8).

export const SR_EXPORT_SCHEMA_VERSION = 1;
export const SR_EXPORT_PERIODS = ["24h", "7d", "30d"] as const;
export type SrExportPeriod = (typeof SR_EXPORT_PERIODS)[number];
/** Số giờ của mỗi kỳ; kỳ tối đa 30 ngày. */
export const SR_EXPORT_PERIOD_HOURS: Record<SrExportPeriod, number> = {
  "24h": 24,
  "7d": 7 * 24,
  "30d": 30 * 24,
};
/**
 * Trần số dòng mỗi phần có danh sách (không làm nặng DB). Vượt trần thì giữ các dòng MỚI NHẤT và ghi rõ trong `meta`
 * (`truncated`, `rows`, `total`, `omitted`), không cắt âm thầm.
 */
export const SR_EXPORT_ROW_LIMITS = { articles: 5000, context: 5000, paperTrades: 5000 } as const;

export const srExportQuerySchema = z.object({
  period: z.enum(SR_EXPORT_PERIODS).default("24h"),
});

/** Tên file: `desklabs-signal-research-<period>-<YYYY-MM-DD UTC>.json`. */
export function srExportFileName(period: SrExportPeriod, at: Date): string {
  return `desklabs-signal-research-${period}-${at.toISOString().slice(0, 10)}.json`;
}

const iso = isoDateTimeSchema;
const int = z.number().int();
const count = z.number().int().nonnegative();
const dec = z.string().regex(/^-?\d+(\.\d+)?$/);

const sectionSchema = z.object({
  /** Số dòng có trong file. */
  rows: count,
  /** Số dòng khớp kỳ trong DB. */
  total: count,
  /** Số dòng bị bỏ vì vượt trần (`total − rows`). */
  omitted: count,
  truncated: z.boolean(),
  limit: count,
});

export const srExportMetaSchema = z.object({
  schemaVersion: z.literal(SR_EXPORT_SCHEMA_VERSION),
  period: z.enum(SR_EXPORT_PERIODS),
  from: iso,
  to: iso,
  exportedAt: iso,
  /** Version Rules đang chạy (`news-v5`). */
  rulesVersion: z.string(),
  /** Prompt Claude (reader) đang chạy, mới nhất trong `signal_classifier_versions`; null khi chưa có. */
  readerVersion: z.string().nullable(),
  /** Bước dừng / kết quả của bài tính theo version Baseline (`number`); null khi không có Baseline. */
  articlesVersion: int.nullable(),
  /** true khi có ít nhất một phần bị cắt vì vượt trần. */
  truncated: z.boolean(),
  sections: z.object({
    articles: sectionSchema,
    context: sectionSchema,
    paperTrades: sectionSchema,
  }),
});

export const srExportArticleSchema = z.object({
  /** Id bài của SoSoValue. */
  id: z.string(),
  publishedAt: iso,
  collectedAt: iso,
  claudeDoneAt: iso.nullable(),
  source: z.string(),
  tier: z.enum(RESEARCH_SOURCE_TIERS).nullable(),
  title: z.string().nullable(),
  tagged: z.array(z.string()),
  candidates: z.array(z.string()),
  market: z.string().nullable(),
  stage: z.enum(RESEARCH_STAGES),
  outcome: z.enum(RESEARCH_ARTICLE_OUTCOMES),
  reason: z.enum(RESEARCH_DROP_REASONS).nullable(),
  reasonLimit: z.number().int().positive().nullable(),
  mergeReason: z.enum(RESEARCH_MERGE_REASONS).nullable(),
  rulesVersion: int,
  readerVersion: z.string().nullable(),
  sentToClaude: z.boolean(),
  claudeCalls: count.nullable(),
  claudeCostUsd: dec.nullable(),
  catalyst: z.string().nullable(),
  relevance: z.string().nullable(),
  promotional: z.boolean().nullable(),
  /** Level lúc vào của lệnh giấy bài này mở (version Baseline); null khi bài không mở lệnh. */
  level: z.string().nullable(),
  side: z.enum(["long", "short"]).nullable(),
  /** Id lệnh giấy (bảng `paperTrades`). */
  paperTradeId: z.uuid().nullable(),
});

/** Bối cảnh đã lưu của một tín hiệu: chỉ số đếm ví H1, không bao giờ địa chỉ ví. */
export const srExportContextSchema = z.object({
  articleId: z.string(),
  market: z.string(),
  direction: z.string(),
  decidedAt: iso,
  source: z.string(),
  contextVersion: z.string(),
  ruleVersion: z.string(),
  h1: z.object({
    status: z.string(),
    walletsChecked: count.nullable(),
    assetOnHyperliquid: z.boolean().nullable(),
    walletSetVersion: int.nullable(),
    walletSetSize: count.nullable(),
    agreeingWallets: count.nullable(),
    opposingWallets: count.nullable(),
    agreeingUsdc: dec.nullable(),
    firstAt: iso.nullable(),
  }),
  h2: z.object({
    status: z.string(),
    fundingRate: dec.nullable(),
    fundingTime: iso.nullable(),
    percentile: dec.nullable(),
    samples: count.nullable(),
    payer: z.string().nullable(),
    intervalHours: dec.nullable(),
  }),
  h3: z.object({
    status: z.string(),
    movedPct: dec.nullable(),
    typicalMovePct: dec.nullable(),
  }),
  volumeVs24h: dec.nullable(),
  rangeBreakout: z.string().nullable(),
  marketState: z.object({
    version: z.string().nullable(),
    btcChange24hPct: dec.nullable(),
    btcTrend: z.string().nullable(),
    vol4hPct: dec.nullable(),
    volPercentile: dec.nullable(),
    volatility: z.string().nullable(),
  }),
});

export const srExportVersionSchema = z.object({
  number: int,
  name: z.string(),
  status: z.string(),
  isBaseline: z.boolean(),
  config: z.unknown(),
  hypothesis: z.string().nullable(),
  statusChangedAt: iso,
  createdAt: iso,
  experimentFinishedAt: iso.nullable(),
  experimentResult: z.unknown().nullable(),
});

export const srExportPaperTradeSchema = z.object({
  id: z.uuid(),
  /** Số version (team); null = lệnh trước khi có version. */
  version: int.nullable(),
  label: z.string(),
  articleId: z.string().nullable(),
  market: z.string(),
  side: z.string(),
  level: z.string(),
  catalyst: z.string(),
  status: z.string(),
  openedAt: iso,
  sizeUsdc: dec,
  entryPrice: dec,
  tpPrice: dec,
  slPrice: dec,
  exitedAt: iso.nullable(),
  exitPrice: dec.nullable(),
  exitReason: z.string().nullable(),
  resultUsdc: dec.nullable(),
  resultPct: dec.nullable(),
});

const keyCount = z.object({ key: z.string().nullable(), n: count });

export const srExportMainnetSchema = z.object({
  signals: z.object({
    total: count,
    byLevel: z.array(keyCount),
    byKind: z.array(keyCount),
  }),
  deliveries: z.object({
    total: count,
    byOutcome: z.array(z.object({ outcome: z.string(), reason: z.string().nullable(), n: count })),
  }),
  trades: z.object({
    total: count,
    byStatus: z.array(keyCount),
    byCloseReason: z.array(keyCount),
  }),
});

export const srExportCostDaySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sosoRequests: count,
  claudeCalls: count,
  claudeInputTokens: count,
  claudeCacheWriteTokens: count,
  claudeCacheReadTokens: count,
  claudeOutputTokens: count,
  claudeCostUsd: dec,
});

export const srExportSourceSchema = z.object({
  source: z.string(),
  status: z.enum(["live", "delayed", "down"]).nullable(),
  lastOkAt: iso.nullable(),
  lastErrorAt: iso.nullable(),
  lastCycleAt: iso.nullable(),
  watermarkAt: iso.nullable(),
});

export const srExportSchema = z.object({
  meta: srExportMetaSchema,
  articles: z.array(srExportArticleSchema),
  context: z.array(srExportContextSchema),
  versions: z.object({
    team: z.array(srExportVersionSchema),
    /** Version riêng của người dùng test (My versions): chỉ số đếm, không kèm chủ. */
    private: z.object({ total: count, byStatus: z.array(keyCount) }),
  }),
  paperTrades: z.object({
    items: z.array(srExportPaperTradeSchema),
    /** Lệnh giấy của My versions trong kỳ: chỉ số đếm. */
    privateVersionTrades: count,
  }),
  mainnet: srExportMainnetSchema,
  costs: z.object({ days: z.array(srExportCostDaySchema) }),
  sources: z.array(srExportSourceSchema),
});
export type SrExport = z.infer<typeof srExportSchema>;
export type SrExportArticle = z.infer<typeof srExportArticleSchema>;
