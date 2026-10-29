import { z } from "zod";

import { HOLDING_BUCKETS, LEVERAGE_BUCKETS } from "../analysis/account";
import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

// Onboarding bước 3 (import) và bước 4 (account analysis) (SCREENS.md mục 8.1, DEC-34).

export const IMPORT_SECTIONS = ["spotFills", "perpsFills", "positions", "fundings"] as const;

const sectionSchema = z.object({
  status: z.enum(["running", "done", "failed"]),
  count: z.number().int().nonnegative(),
  from: z.number().int().nullable().optional(),
  to: z.number().int().nullable().optional(),
  truncated: z.boolean().optional(),
});

export const importViewSchema = z.object({
  id: uuidSchema,
  status: z.enum(["queued", "running", "done", "failed"]),
  progress: z.partialRecord(z.enum(IMPORT_SECTIONS), sectionSchema),
  coverage: z.partialRecord(z.enum(IMPORT_SECTIONS), sectionSchema).nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type ImportView = z.infer<typeof importViewSchema>;
export const latestImportSchema = z.object({ import: importViewSchema.nullable() });

const ratio = decimalStringSchema.nullable();
export const accountMetricsSchema = z.object({
  periodStart: z.number().int().nullable(),
  periodEnd: z.number().int().nullable(),
  closedPositions: z.number().int().nonnegative(),
  isNewTrader: z.boolean(),
  grossRealizedPnl: decimalStringSchema,
  fees: decimalStringSchema,
  netFunding: decimalStringSchema,
  netPnl: decimalStringSchema,
  winRate: ratio,
  maxDrawdown: decimalStringSchema,
  maxDrawdownPct: ratio,
  takerRatio: ratio,
  /** Phân tích lưu trước P8 không có trường này. */
  makerFeePct: z.object({ spot: ratio, perps: ratio }).default({ spot: null, perps: null }),
  avgHoldWinnersMs: z.number().int().nullable(),
  avgHoldLosersMs: z.number().int().nullable(),
  hasPerpsHistory: z.boolean(),
  avgWin: ratio,
  avgLoss: ratio,
  medianLeverage: z.number().nullable(),
  maxLeverage: z.number().nullable(),
  drawdownFrom: z.number().int().nullable(),
  drawdownTo: z.number().int().nullable(),
  curve: z.array(z.object({ at: z.number().int(), cumulative: decimalStringSchema })),
  byMarket: z.array(
    z.object({
      market: z.string(),
      closed: z.number().int(),
      fees: decimalStringSchema,
      netPnl: decimalStringSchema,
      winRate: ratio,
      volumeShare: decimalStringSchema,
    }),
  ),
  pnlByHolding: z.record(
    z.enum(HOLDING_BUCKETS),
    z.object({ netPnl: decimalStringSchema, closed: z.number().int() }),
  ),
  highLeveragePositionShare: ratio,
  lossShareByLeverage: z.record(z.enum(LEVERAGE_BUCKETS), decimalStringSchema).nullable(),
  unmatchedSpotSells: z.record(z.string(), decimalStringSchema),
});

export const analysisViewSchema = z.object({
  analysis: z
    .object({ id: uuidSchema, computedAt: isoDateTimeSchema, metrics: accountMetricsSchema })
    .nullable(),
});
export type AnalysisView = z.infer<typeof analysisViewSchema>;
