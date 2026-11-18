import { z } from "zod";

import { Decimal } from "../money";
import { decimalStringSchema, uuidSchema } from "../schemas";

import { timeZoneSchema } from "./market-hours";

// AI Desk › "How your bots performed" (#234, thiết kế #232, DEC-TBD-ai-desk-performance): chỉ bot tiền thật của chính
// người dùng, chỉ Market Making + Volume Builder. API chỉ trả số đã tổng hợp: không bao giờ có thành phần tín hiệu,
// snapshot báo giá, kết quả giả định đi ngược chiều hay dữ liệu người khác.
// - Tổng và từng bot: công thức kỳ của Platform Stats (sổ cái giá vốn bình quân, `periodNetPnl`), chi phí / $1M =
//   max(0, −net) ÷ volume × 1M (giống trang bot). Phí tách SoDEX = fee − builder fee, DeskLabs = builder fee. Phần giá
//   = chi phí − phí (âm khi giá có lợi; khi đó chi phí = max(0, phí + phần giá)).
// - Theo giờ: phí + markout 1 phút mỗi fill (cùng cách khối 3 của Market hours), thiếu giá > 20% → n/a.

export const DESK_PERFORMANCE_PERIODS = ["7d", "30d"] as const;
export const deskPerformanceQuerySchema = z.object({
  period: z.enum(DESK_PERFORMANCE_PERIODS).default("7d"),
  tz: timeZoneSchema.default("UTC"),
});
export type DeskPerformanceQuery = z.infer<typeof deskPerformanceQuerySchema>;

/** Số fill tối thiểu để hiện chi phí (cả card, từng bot, từng giờ). */
export const PERFORMANCE_MIN_FILLS = 30;
/** Khung giờ rẻ / đắt nhất: số giờ liền nhau, giờ nào cũng đủ `PERFORMANCE_MIN_FILLS`. */
export const PERFORMANCE_WINDOW_HOURS = 3;
/** Gợi ý (VB): mỗi nhóm ≥ 30 lượt; nhóm tệ hơn ≥ 1,5× chi phí / $1M và ≥ 20% số lượt của bot. */
export const IDEA_MIN_TRADES = 30;
export const IDEA_COST_RATIO = 1.5;
export const IDEA_MIN_SHARE = 0.2;
/** Max spread đề xuất = mức hiện tại − 2 bp, không dưới 2 bp. */
export const IDEA_SPREAD_STEP_BPS = 2;
export const IDEA_SPREAD_FLOOR_BPS = 2;

const usd = decimalStringSchema;

/** Chi phí của một tập fill trong kỳ; mọi số `perMillion` null khi chưa có volume hoặc thiếu giá. */
export const performanceCostSchema = z.object({
  volume: usd,
  fills: z.number().int(),
  /** Tổng chi phí (USDC) = max(0, phí + phần giá); null khi thiếu giá. */
  cost: usd.nullable(),
  sodexFee: usd,
  builderFee: usd,
  /** Phần giá (USDC); âm = giá có lợi. null khi thiếu giá. */
  priceMove: usd.nullable(),
  perMillion: z.object({
    cost: usd.nullable(),
    sodexFee: usd.nullable(),
    builderFee: usd.nullable(),
    priceMove: usd.nullable(),
  }),
});
export type PerformanceCost = z.infer<typeof performanceCostSchema>;

export const performanceHourSchema = z.object({
  /** Giờ địa phương 0–23 theo `tz`. */
  hour: z.number().int().min(0).max(23),
  fills: z.number().int(),
  /** Phí / $1M; null khi không có fill. */
  feesPerMillion: usd.nullable(),
  /** Markout 1 phút / $1M; null khi thiếu giá. */
  pricePerMillion: usd.nullable(),
  costPerMillion: usd.nullable(),
  /** Dưới `PERFORMANCE_MIN_FILLS` fill: vẽ mờ, không chọn làm giờ rẻ / đắt nhất. */
  thin: z.boolean(),
});

export const performanceWindowSchema = z.object({
  /** Giờ bắt đầu (địa phương); khung dài `PERFORMANCE_WINDOW_HOURS`, có thể qua nửa đêm. */
  from: z.number().int().min(0).max(23),
  costPerMillion: usd,
  fills: z.number().int(),
});
export type PerformanceWindow = z.infer<typeof performanceWindowSchema>;

export const PERFORMANCE_EXIT_REASONS = [
  "holdTime",
  "maxHold",
  "stopLoss",
  "takeProfit",
  "earlyProfit",
  "exchangeStop",
  "trailing",
  "other",
] as const;

export const performanceBotSchema = z.object({
  id: uuidSchema,
  name: z.string(),
  strategy: z.enum(["volume_maker", "volume_farm"]),
  market: z.string(),
  current: performanceCostSchema,
  /** Kỳ trước; null khi bot không giao dịch kỳ trước. */
  previous: performanceCostSchema.nullable(),
});

export const performanceIdeaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sidewaysOnly"),
    botId: uuidSchema,
    botName: z.string(),
    trades: z.number().int(),
    /** Chi phí / $1M của lượt vào khi thị trường không đi ngang. */
    worseCostPerMillion: usd,
    betterCostPerMillion: usd,
    /** Tỉ lệ (0–1) số lượt thuộc nhóm tệ hơn. */
    worseShare: z.number(),
  }),
  z.object({
    kind: z.literal("maxSpread"),
    botId: uuidSchema,
    botName: z.string(),
    trades: z.number().int(),
    fromBps: usd,
    toBps: usd,
    worseCostPerMillion: usd,
    betterCostPerMillion: usd,
    worseShare: z.number(),
  }),
]);
export type PerformanceIdea = z.infer<typeof performanceIdeaSchema>;

export const deskPerformanceSchema = z.object({
  period: z.enum(DESK_PERFORMANCE_PERIODS),
  tz: z.string(),
  /** `noBots`: chưa có bot tiền thật MM / VB; `notEnough`: < 30 fill trong kỳ; `ready`: đủ số. */
  state: z.enum(["noBots", "notEnough", "ready"]),
  current: performanceCostSchema,
  /** Kỳ trước cùng độ dài; null khi không giao dịch kỳ trước. */
  previous: performanceCostSchema.nullable(),
  hours: z.array(performanceHourSchema),
  cheapest: performanceWindowSchema.nullable(),
  dearest: performanceWindowSchema.nullable(),
  /** Volume Builder: lượt đóng trong kỳ theo lý do; null khi không có lượt VB nào. */
  exits: z
    .object({
      bots: z.number().int(),
      trades: z.number().int(),
      items: z.array(
        z.object({
          reason: z.enum(PERFORMANCE_EXIT_REASONS),
          trades: z.number().int(),
          share: z.number(),
          /** Lãi / lỗ bình quân mỗi lượt sau phí (USDC). */
          avgNet: usd,
        }),
      ),
    })
    .nullable(),
  bots: z.array(performanceBotSchema),
  ideas: z.array(performanceIdeaSchema),
});
export type DeskPerformance = z.infer<typeof deskPerformanceSchema>;

/** Tổng của một tập fill để tính `PerformanceCost`. */
export interface CostTotals {
  volume: Decimal;
  fills: number;
  fees: Decimal;
  builderFee: Decimal;
  /** Net PnL trong kỳ (`periodNetPnl`); null khi thiếu giá. */
  net: Decimal | null;
}

const per = (v: Decimal, volume: Decimal) =>
  volume.isZero() ? null : v.div(volume).mul(1_000_000).toDecimalPlaces(2).toString();

/**
 * Chi phí trong kỳ: phần giá = −net − phí (net đã trừ phí); chi phí = max(0, phí + phần giá) = max(0, −net) (giống
 * `netCostPerMillion` của trang bot). Thiếu giá → chi phí và phần giá null, phí vẫn có.
 */
export function performanceCost(t: CostTotals): PerformanceCost {
  const sodex = t.fees.sub(t.builderFee);
  const price = t.net === null ? null : t.net.neg().sub(t.fees);
  const cost = t.net === null ? null : Decimal.max(0, t.net.neg());
  return {
    volume: t.volume.toDecimalPlaces(2).toString(),
    fills: t.fills,
    cost: cost === null ? null : cost.toDecimalPlaces(4).toString(),
    sodexFee: sodex.toDecimalPlaces(4).toString(),
    builderFee: t.builderFee.toDecimalPlaces(4).toString(),
    priceMove: price === null ? null : price.toDecimalPlaces(4).toString(),
    perMillion: {
      cost: cost === null ? null : per(cost, t.volume),
      sodexFee: per(sodex, t.volume),
      builderFee: per(t.builderFee, t.volume),
      priceMove: price === null ? null : per(price, t.volume),
    },
  };
}

/**
 * Khung `PERFORMANCE_WINDOW_HOURS` giờ liền nhau (qua nửa đêm được) có chi phí / $1M thấp nhất và cao nhất. Chỉ xét
 * khung mà giờ nào cũng có ≥ `PERFORMANCE_MIN_FILLS` fill và có giá. Chi phí của khung tính từ tổng (`sums`), không
 * lấy trung bình các giờ. Không có khung nào → null; chỉ một khung → chỉ có `cheapest`.
 */
export function costWindows(
  sums: readonly ({ fills: number; costUsd: Decimal; priced: Decimal } | null)[],
): { cheapest: PerformanceWindow | null; dearest: PerformanceWindow | null } {
  const n = sums.length;
  const windows: PerformanceWindow[] = [];
  for (let from = 0; from < n; from++) {
    let cost = new Decimal(0);
    let priced = new Decimal(0);
    let fills = 0;
    let ok = true;
    for (let k = 0; k < PERFORMANCE_WINDOW_HOURS; k++) {
      const s = sums[(from + k) % n] ?? null;
      if (s === null || s.fills < PERFORMANCE_MIN_FILLS || s.priced.isZero()) {
        ok = false;
        break;
      }
      cost = cost.add(s.costUsd);
      priced = priced.add(s.priced);
      fills += s.fills;
    }
    if (ok)
      windows.push({
        from,
        costPerMillion: cost.div(priced).mul(1_000_000).toDecimalPlaces(2).toString(),
        fills,
      });
  }
  if (windows.length === 0) return { cheapest: null, dearest: null };
  const sorted = [...windows].sort((a, b) => new Decimal(a.costPerMillion).cmp(b.costPerMillion));
  const cheapest = sorted[0] ?? null;
  const dearest = sorted.at(-1) ?? null;
  return {
    cheapest,
    dearest: dearest === null || dearest === cheapest ? null : dearest,
  };
}

/** Chi phí / $1M của một nhóm lượt VB (net sau phí, volume): max(0, −Σnet) ÷ Σvolume × 1M. */
export function groupCostPerMillion(net: number, volume: number): number | null {
  return volume > 0 ? (Math.max(0, -net) / volume) * 1_000_000 : null;
}

/**
 * So hai nhóm lượt cho một gợi ý: cần mỗi nhóm ≥ `IDEA_MIN_TRADES`, nhóm tệ hơn ≥ `IDEA_COST_RATIO` × chi phí của
 * nhóm kia và ≥ `IDEA_MIN_SHARE` tổng lượt của bot. Trả về số để hiện, hoặc null.
 */
export function compareGroups(
  worse: { trades: number; net: number; volume: number },
  better: { trades: number; net: number; volume: number },
  botTrades: number,
): { worseCost: number; betterCost: number; worseShare: number } | null {
  if (worse.trades < IDEA_MIN_TRADES || better.trades < IDEA_MIN_TRADES || botTrades === 0)
    return null;
  const w = groupCostPerMillion(worse.net, worse.volume);
  const b = groupCostPerMillion(better.net, better.volume);
  if (w === null || b === null) return null;
  const share = worse.trades / botTrades;
  if (share < IDEA_MIN_SHARE) return null;
  if (b === 0 ? w <= 0 : w < b * IDEA_COST_RATIO) return null;
  return { worseCost: w, betterCost: b, worseShare: share };
}
