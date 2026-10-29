import { z } from "zod";

import { MAX_DROP_OPTIONS, RECO_GOALS } from "../reco/types";
import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

// API mục tiêu (onboarding bước 5) và engine đề xuất (bước 6, AI parameters). SCREENS.md mục 8, RECO_ENGINE.md mục 10.

export const RECO_STRATEGIES = [
  "spot_grid",
  "futures_grid",
  "spot_dca",
  "futures_dca",
  "recurring_buy",
  "rebalancing",
  "funding_arb",
] as const;

export const goalsBodySchema = z.object({
  goal: z.enum(RECO_GOALS),
  capital: decimalStringSchema,
  maxDrop: z.enum(MAX_DROP_OPTIONS),
  assets: z.array(z.string().min(1).max(20)).min(1).max(10),
});
export type GoalsBody = z.infer<typeof goalsBodySchema>;
export const goalsViewSchema = goalsBodySchema.extend({ updatedAt: isoDateTimeSchema });
export type GoalsView = z.infer<typeof goalsViewSchema>;

export const suggestionViewSchema = z.object({
  /** Id của dòng `ai_suggestions` (lưu vào `bot_versions.ai_suggestion_id`). */
  id: uuidSchema,
  strategy: z.enum(RECO_STRATEGIES),
  market: z.string(),
  capital: decimalStringSchema,
  values: z.record(z.string(), z.unknown()),
  reasons: z.array(z.string()),
  basis: z.string(),
  computedAt: isoDateTimeSchema,
});
export type SuggestionView = z.infer<typeof suggestionViewSchema>;

export const planViewSchema = z.object({
  best: suggestionViewSchema.nullable(),
  addOns: z.array(suggestionViewSchema),
  notSuggested: z.array(z.object({ title: z.string(), reason: z.string() })),
  notes: z.array(z.string()),
  capital: decimalStringSchema,
  empty: z.string().nullable(),
});
export type PlanView = z.infer<typeof planViewSchema>;

export const aiParamsBodySchema = z.object({
  strategy: z.enum(RECO_STRATEGIES),
  market: z.string().min(1),
  /** Vốn của bot; thiếu thì dùng vốn trong goals. */
  capital: decimalStringSchema.optional(),
  context: z.enum(["create", "retune"]),
});
export type AiParamsBody = z.infer<typeof aiParamsBodySchema>;

/** Danh sách tài sản có thể chọn ở bước 5, kèm ghi chú từ lịch sử. */
export const assetOptionsSchema = z.object({
  items: z.array(
    z.object({
      asset: z.string(),
      netPnl: decimalStringSchema.nullable(),
      hasHistory: z.boolean(),
    }),
  ),
  available: decimalStringSchema.nullable(),
  worstDrawdownPct: decimalStringSchema.nullable(),
});
