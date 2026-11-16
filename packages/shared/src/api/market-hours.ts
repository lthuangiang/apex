import { z } from "zod";

import { swingBps } from "../mm-markout";
import { dec, Decimal } from "../money";
import { decimalStringSchema, isoDateTimeSchema } from "../schemas";

// Market hours (docs/mockups/market-hours, DEC-283): ba khối theo giờ trong ngày, theo múi giờ của người
// xem. Khối 1 = biến động từ nến 1 phút; khối 2 = chi phí làm market đo từ giao dịch công khai (mm_market_hourly);
// khối 3 = fill thật của bot Market Making / Volume Builder tiền thật. Số quá khứ, không dự báo; thiếu → null.

/** Tên múi giờ IANA mà runtime biết (Intl), hoặc "UTC". Sai → lỗi chuẩn C6 (validation). */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  // Chỉ ký tự của tên IANA; runtime phải biết múi giờ đó (DateTimeFormat ném RangeError nếu không). Không dùng
  // Intl.supportedValuesOf: nó chỉ liệt kê tên chuẩn của ICU (vd "Asia/Calcutta"), loại nhầm "Asia/Kolkata".
  .regex(/^[A-Za-z][A-Za-z0-9_+\-/]*$/, "Unknown time zone")
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone");

export const MARKET_HOURS_STRATEGIES = ["both", "volume_maker", "volume_farm"] as const;

export const marketHoursQuerySchema = z.object({
  market: z.string().min(1).max(40).optional(),
  days: z.coerce
    .number()
    .int()
    .refine((d) => d === 7 || d === 30, "days must be 7 or 30")
    .default(30),
  strategy: z.enum(MARKET_HOURS_STRATEGIES).default("both"),
  tz: timeZoneSchema.default("UTC"),
});
export type MarketHoursQuery = z.infer<typeof marketHoursQuerySchema>;

/** Ô dưới mức này (bot × giờ) là "Thin sample". */
export const MARKET_HOURS_THIN_BOT_HOURS = 3;
/** Một giờ là "nóng" trong một ngày khi trung vị range 1 phút của giờ đó > HOT × trung vị của cả ngày. */
export const MARKET_HOURS_HOT_RATIO = 2;
/** Thiếu giá tham chiếu cho hơn chừng này phần volume của ô thì Cost per $1M là "Not available". */
export const MARKET_HOURS_MAX_MISSING_PRICE = 0.2;

const hourSchema = z.object({
  hour: z.number().int().min(0).max(23),
  volatility: z.object({
    medianBp: decimalStringSchema.nullable(),
    p90Bp: decimalStringSchema.nullable(),
    /** Trung vị qua các ngày của (trung vị giờ ÷ trung vị ngày). */
    ratio: decimalStringSchema.nullable(),
    /** % số ngày có dữ liệu mà giờ đó "nóng"; null khi không có ngày nào. */
    hotPct: z.number().nullable(),
    /** Trung vị range 1 phút theo bước 5 phút (12 ô); null khi thiếu. */
    fiveMin: z.array(decimalStringSchema.nullable()).length(12),
    /** Trung vị qua các ngày của dao động 1 phút (độ lệch chuẩn % đổi giá đóng, bps) của giờ đó; null khi thiếu nến. */
    swingBp: decimalStringSchema.nullable(),
    /** Chi phí ước tính / $1M của mô hình Market Making (DEC-228) cho giờ đó; null khi thiếu nến hoặc mô hình. */
    estCostPerMillion: decimalStringSchema.nullable(),
  }),
  cost: z.object({
    /** Markout 30 s phía maker (bp, dương = có lợi cho maker), trung vị qua các giờ trong kỳ. */
    markoutBp: decimalStringSchema.nullable(),
    spreadTicks: z.number().nullable(),
  }),
  bots: z.object({
    costPerMillion: decimalStringSchema.nullable(),
    volume: decimalStringSchema.nullable(),
    fees: decimalStringSchema.nullable(),
    botHours: z.number().int().nonnegative(),
    thin: z.boolean(),
  }),
});
export type MarketHoursHour = z.infer<typeof hourSchema>;

export const marketHoursViewSchema = z.object({
  market: z.string().nullable(),
  markets: z.array(z.string()),
  days: z.number().int(),
  strategy: z.enum(MARKET_HOURS_STRATEGIES),
  tz: z.string(),
  hours: z.array(hourSchema),
  /** Heatmap ngày × giờ: mỗi ngày (theo múi giờ người xem) 24 ô (trung vị range giờ ÷ trung vị ngày). */
  heatmap: z.array(
    z.object({
      date: z.string(),
      cells: z
        .array(
          z.object({
            ratio: decimalStringSchema.nullable(),
            medianBp: decimalStringSchema.nullable(),
          }),
        )
        .length(24),
    }),
  ),
  candlesSince: isoDateTimeSchema.nullable(),
  markoutSince: isoDateTimeSchema.nullable(),
  /** Số ngày (theo múi giờ người xem) trong kỳ có dữ liệu khối 2. */
  markoutDays: z.number().int().nonnegative(),
  fillsSince: isoDateTimeSchema.nullable(),
  /**
   * Đầu vào chung của dòng "Estimated cost per $1M (model)". `unavailable` khác null thì cả dòng là n/a:
   * `no_candles` = market không có nến trong kỳ (không tính được bước giá); `no_market_info` = không đọc được tick size
   * của market từ SoDEX.
   */
  estimate: z.object({
    feesBp: decimalStringSchema,
    stepBp: decimalStringSchema.nullable(),
    modelVersion: z.number().int().nonnegative(),
    unavailable: z.enum(["no_candles", "no_market_info"]).nullable(),
  }),
});
export type MarketHoursView = z.infer<typeof marketHoursViewSchema>;
export type MarketHoursEstimate = MarketHoursView["estimate"];

/** Trung vị qua các ngày của dao động 1 phút (`swingBps`) của từng nhóm giá đóng (một nhóm = một giờ của một ngày). */
export function medianSwingBps(groups: readonly (readonly string[])[]): Decimal | null {
  const xs = groups.map((g) => swingBps(g)).filter((x): x is Decimal => x !== null);
  return quantile(xs, 0.5);
}

/** Range 1 phút (bp) = (cao − thấp) ÷ ((cao + thấp) / 2) × 10 000; giá không hợp lệ → null. */
export function minuteRangeBp(high: string, low: string): Decimal | null {
  const h = dec(high);
  const l = dec(low);
  const mid = h.add(l).div(2);
  if (!mid.gt(0) || h.lt(l)) return null;
  return h.sub(l).div(mid).mul(10_000);
}

/** Phân vị q (0..1) theo nội suy tuyến tính (như percentile_cont của Postgres); rỗng → null. */
export function quantile(xs: readonly Decimal[], q: number): Decimal | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a.cmp(b));
  // Vị trí tính bằng decimal: (n − 1) × q bằng float cho 2.7 → phần lẻ 0.7000000000000002.
  const pos = new Decimal(s.length - 1).mul(q);
  const lo = pos.floor().toNumber();
  const hi = pos.ceil().toNumber();
  const a = s[lo] ?? new Decimal(0);
  const b = s[hi] ?? a;
  return a.add(b.sub(a).mul(pos.sub(lo)));
}

/** Một fill cho Cost per $1M: giá tham chiếu = close của nến 1 phút chứa thời điểm fill + 60 s (null khi thiếu). */
export interface CostFill {
  side: "buy" | "sell";
  price: string;
  size: string;
  fee: string;
  ref: string | null;
}

/**
 * Cost per $1M của một nhóm fill (DevOps chốt): (Σ phí − Σ price PnL) ÷ Σ volume × 1e6, với price PnL của fill = chiều ×
 * (giá tham chiếu − giá khớp) × size (cùng quy ước dấu với `avgMarkout`: mua có lợi khi giá lên). Là ước tính markout,
 * không phải lãi lỗ đã chốt. Thiếu giá tham chiếu cho hơn 20% volume, hoặc không có volume → cost null.
 */
export function fillCostPerMillion(fills: readonly CostFill[]): {
  costPerMillion: Decimal | null;
  volume: Decimal;
  fees: Decimal;
} {
  let volume = new Decimal(0);
  let fees = new Decimal(0);
  let priced = new Decimal(0);
  let pnl = new Decimal(0);
  let pricedFees = new Decimal(0);
  for (const f of fills) {
    const p = dec(f.price);
    const n = p.mul(dec(f.size));
    volume = volume.add(n);
    fees = fees.add(dec(f.fee));
    if (f.ref === null) continue;
    const move = dec(f.ref).sub(p).mul(dec(f.size));
    pnl = pnl.add(f.side === "buy" ? move : move.neg());
    priced = priced.add(n);
    pricedFees = pricedFees.add(dec(f.fee));
  }
  return {
    costPerMillion: costPerMillionOfSums({ volume, priced, pricedFees, pnl }),
    volume,
    fees,
  };
}

/** Tổng của một nhóm fill cho Cost per $1M (SQL có thể cộng sẵn, rồi gọi `costPerMillionOfSums`). */
export interface CostSums {
  /** Σ giá × size của mọi fill. */
  volume: Decimal;
  /** Σ giá × size của fill có giá tham chiếu. */
  priced: Decimal;
  /** Σ phí của fill có giá tham chiếu. */
  pricedFees: Decimal;
  /** Σ price PnL (chiều × (giá tham chiếu − giá khớp) × size) của fill có giá tham chiếu. */
  pnl: Decimal;
}

/** Cùng công thức `fillCostPerMillion`, từ các tổng (trang Bot Monitor cộng trong SQL, không kéo từng fill về). */
export function costPerMillionOfSums(s: CostSums): Decimal | null {
  const missing = s.volume.isZero() ? new Decimal(1) : s.volume.sub(s.priced).div(s.volume);
  return s.priced.gt(0) && missing.lte(MARKET_HOURS_MAX_MISSING_PRICE)
    ? s.pricedFees.sub(s.pnl).div(s.priced).mul(1_000_000)
    : null;
}
