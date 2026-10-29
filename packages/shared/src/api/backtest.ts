import { z } from "zod";

import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

import { BOT_STRATEGIES } from "./bots";

// Backtest (BACKTEST.md mục 11, DEC-40). SoDEX chỉ giữ nến 1 phút khoảng 7 ngày, nên mỗi kỳ dùng nến mịn
// nhất còn đủ cho cả kỳ; khi `candles_1m` của DRIFT phủ đủ kỳ thì dùng 1 phút.

export const BACKTEST_PERIODS = [30, 90, 180] as const;
export type BacktestPeriod = (typeof BACKTEST_PERIODS)[number];
export const BACKTEST_INTERVALS = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
} as const;
export type BacktestInterval = keyof typeof BACKTEST_INTERVALS;
/** Nến SoDEX dùng cho từng kỳ khi DRIFT chưa có đủ nến 1 phút (đo trên mainnet ngày 2026-10-28). */
export const SODEX_INTERVAL_FOR_PERIOD: Record<BacktestPeriod, BacktestInterval> = {
  30: "5m",
  90: "15m",
  180: "1h",
};
const DAY = 86_400_000;

/** Kỳ backtest kết thúc ở 00:00 UTC hôm nay (chỉ ngày đã đóng, kết quả ổn định trong ngày). */
export function backtestWindow(
  now: number,
  periodDays: BacktestPeriod,
): { from: number; to: number } {
  const to = now - (now % DAY);
  return { from: to - periodDays * DAY, to };
}

export function dataVersion(interval: BacktestInterval, to: number): string {
  return `${interval}:${new Date(to).toISOString().slice(0, 10)}`;
}

export const startBacktestBodySchema = z.object({
  strategy: z.enum(BOT_STRATEGIES),
  config: z.record(z.string(), z.unknown()),
  periodDays: z.union([z.literal(30), z.literal(90), z.literal(180)]),
});
export type StartBacktestBody = z.infer<typeof startBacktestBodySchema>;

export const backtestMetricSchema = z.object({
  key: z.string(),
  value: z.string().nullable(),
  unit: z.enum(["count", "pct", "price", "quote"]),
});

export const backtestResultSchema = z.object({
  interval: z.enum(["1m", "5m", "15m", "1h"]),
  candles: z.number().int(),
  from: z.number().int(),
  to: z.number().int(),
  capital: decimalStringSchema,
  net: decimalStringSchema,
  netPct: decimalStringSchema,
  fees: decimalStringSchema,
  funding: decimalStringSchema,
  maxDrawdown: decimalStringSchema,
  maxDrawdownPct: decimalStringSchema,
  equity: z.array(z.object({ at: z.number().int(), value: decimalStringSchema })),
  metrics: z.array(backtestMetricSchema),
  halted: z.string().nullable(),
  perps: z.boolean(),
});
export type BacktestResult = z.infer<typeof backtestResultSchema>;

export const backtestViewSchema = z.object({
  id: uuidSchema,
  status: z.enum(["queued", "running", "done", "failed", "unavailable"]),
  periodDays: z.number().int(),
  interval: z.enum(["1m", "5m", "15m", "1h"]),
  /** Lý do khi failed / unavailable (mã ngắn; UI chọn câu chữ). */
  error: z.string().nullable(),
  result: backtestResultSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type BacktestView = z.infer<typeof backtestViewSchema>;
