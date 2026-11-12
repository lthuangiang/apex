import { z } from "zod";

import { decimalStringSchema } from "./schemas";

// Tín hiệu ví leader cho Copy Trade (DEC-161). `marketdata` (leader) đọc ví leader rồi publish qua NATS core;
// engine nghe và chuyển cho các bot copy đúng ví đó. Market luôn là symbol Perps của SoDEX.

export const LeaderSource = { sodex: "sodex", hyperliquid: "hyperliquid" } as const;
export type LeaderSource = (typeof LeaderSource)[keyof typeof LeaderSource];

/** Subject NATS: `leader.<source>.<address>.<kind>`; địa chỉ viết thường. */
export function leaderSubject(
  source: LeaderSource,
  address: string,
  kind: "fill" | "position",
): string {
  return `leader.${source}.${address.toLowerCase()}.${kind}`;
}

export const leaderFillMessageSchema = z.object({
  source: z.enum(["sodex", "hyperliquid"]),
  address: z.string(),
  market: z.string(),
  side: z.enum(["buy", "sell"]),
  price: decimalStringSchema,
  quantity: decimalStringSchema,
  /** Vị thế của leader trên market sau fill (có dấu, âm là short). */
  positionAfter: decimalStringSchema,
  /** Lúc leader khớp (ms). */
  at: z.number().int(),
  /**
   * Hạn mức notional (USD) cho lệnh mở / tăng của từng bot copy, theo `botId` (DEC-163 mục 9: tổng ≤ 50% độ sâu sổ
   * SoDEX). Có map mà thiếu bot → hạn mức 0 (bot vừa start sau lúc phân bổ: bỏ qua lần mở này cho an toàn).
   */
  allowances: z.record(z.string(), decimalStringSchema).optional(),
  /** `min_hold`: trader không còn đạt minHoldFilter (mục 5), mọi hạn mức là 0. */
  allowanceReason: z.enum(["liquidity", "min_hold"]).optional(),
});
export type LeaderFillMessage = z.infer<typeof leaderFillMessageSchema>;

export const leaderPositionMessageSchema = z.object({
  source: z.enum(["sodex", "hyperliquid"]),
  address: z.string(),
  /** Vị thế có dấu theo market; market không có trong map là 0. */
  positions: z.record(z.string(), decimalStringSchema),
  at: z.number().int(),
});
export type LeaderPositionMessage = z.infer<typeof leaderPositionMessageSchema>;
