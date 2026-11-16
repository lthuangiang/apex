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
/**
 * Cần ít nhất chừng này lệnh "Position cut" thật (có fill, có giá tham chiếu) trong kỳ thì mới dùng trượt giá và cỡ lệnh
 * cắt đo được; ít hơn → chỉ phí taker và cỡ cắt = R × order size (DEC-289, DEC-TBD-market-hours-calibrated).
 */
export const MARKET_HOURS_MIN_CUTS = 5;
/** Hệ số C (real ÷ "incl. shock days") của một phạm vi cần ít nhất chừng này ô (giờ × market) có ≥ 3 bot-hour. */
export const MARKET_HOURS_CALIBRATION_MIN_HOURS = 3;
/** Cửa sổ đo R, số fill một bot-hour và C (ngày), không theo kỳ 7 / 30 ngày của trang (DEC-TBD-market-hours-calibrated). */
export const MARKET_HOURS_CALIBRATION_DAYS = 14;
/**
 * Mặc định khi chưa có bot Market Making nào có dữ liệu trong 14 ngày (DEC-TBD-market-hours-calibrated):
 * - `positionRatio` R = vị thế lớn nhất ÷ order size ≈ 2 (khoảng 1.2–3.5×);
 * - `fillsPerBotHour` F = 80 order size một bot-hour (đo 2026-11-16 trên DB local: BTC 72, ETH 89), để phần cắt luôn có;
 * - `calibration` C = 1.0;
 * - `date` = ngày hiện trong câu nguồn "default calibration from {date}".
 */
export const MARKET_HOURS_CALIBRATION_DEFAULTS = {
  positionRatio: "2",
  fillsPerBotHour: "80",
  calibration: "1",
  date: "2026-11-15",
} as const;
/** Nguồn của R, phần cắt và C: bot của market này → mọi market gộp lại → hằng số mặc định. */
export const MARKET_HOURS_CALIBRATION_SOURCES = ["market", "pooled", "default"] as const;
export type MarketHoursCalibrationSource = (typeof MARKET_HOURS_CALIBRATION_SOURCES)[number];

const calibrationScopeSchema = z.object({
  source: z.enum(MARKET_HOURS_CALIBRATION_SOURCES),
  /** Bot-hour (14 ngày) của bot Market Making tiền thật đã dùng; 0 khi `default`. */
  botHours: z.number().int().nonnegative(),
  /**
   * Bot-hour (14 ngày) của bot Market Making tiền thật trên chính market này, kể cả khi chưa đủ dữ liệu để dùng. `pooled`
   * với số này > 0 = "Not enough bot data on this market"; = 0 = "No bots on this market".
   */
  marketBotHours: z.number().int().nonnegative(),
  /** Các market đã gộp khi `pooled` (theo tên); rỗng ở nguồn khác. */
  markets: z.array(z.string()),
});
export type MarketHoursCalibrationScope = z.infer<typeof calibrationScopeSchema>;

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
    /**
     * "Est. CPM · typical day": chi phí ước tính / $1M của mô hình Market Making (DEC-228) từ dao động trung vị của giờ
     * đó; null khi thiếu nến hoặc mô hình.
     */
    estCostPerMillion: decimalStringSchema.nullable(),
    /**
     * "Est. CPM · incl. shock days": trung bình cộng qua các ngày của chi phí mô hình từ dao động của chính ngày đó, cộng
     * một lần cắt vị thế vào ngày có biến động 15 phút ≥ 15 bp (`shockDayCostPerMillion`); null khi thiếu nến / mô hình.
     */
    estShockCostPerMillion: decimalStringSchema.nullable(),
    /**
     * "Est. CPM · calibrated" = "incl. shock days" × `estimate.calibration` (`calibratedCostPerMillion`); null chỉ khi
     * "incl. shock days" null (thiếu nến / mô hình).
     */
    estCalibratedCostPerMillion: decimalStringSchema.nullable(),
    /** Số ngày tính được và số ngày "sốc" (biến động 15 phút lớn nhất ≥ 15 bp) của giờ đó; null khi không có ngày nào. */
    estDays: z.number().int().nonnegative().nullable(),
    shockDays: z.number().int().nonnegative().nullable(),
    /** Range 1 phút lớn nhất trong kỳ (bp) của nến bắt đầu trong giờ đó, và mốc bắt đầu của nến; null khi thiếu nến. */
    maxRangeBp: decimalStringSchema.nullable(),
    maxRangeAt: isoDateTimeSchema.nullable(),
    /**
     * Biến động 15 phút lớn nhất trong kỳ (bp) = (close cao nhất − close thấp nhất) ÷ close thấp nhất × 10 000 trong cửa
     * sổ 15 phút bắt đầu trong giờ đó, và mốc bắt đầu cửa sổ; null khi thiếu nến.
     */
    maxMove15Bp: decimalStringSchema.nullable(),
    maxMove15At: isoDateTimeSchema.nullable(),
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
    /** Ngưỡng ngày "sốc" (bp) = VM_CUT.bp của Market Making. */
    shockBp: z.number().int().positive(),
    /** Phí taker perps của market (bps). */
    cutTakerBp: decimalStringSchema,
    /** Trượt giá trung bình đo từ lệnh cắt thật (bps); null khi chưa đủ `MARKET_HOURS_MIN_CUTS` lệnh cắt. */
    cutSlippageBp: decimalStringSchema.nullable(),
    /** Chi phí một lần cắt (bps) = taker + trượt giá (null → chỉ taker). */
    cutCostBp: decimalStringSchema,
    /** Số lệnh cắt thật (có fill) của market trong kỳ, và notional trung bình một lệnh (null khi chưa đủ). */
    cuts: z.number().int().nonnegative(),
    cutNotional: decimalStringSchema.nullable(),
    /**
     * R dùng cho cỡ một lần cắt = R × order size (DEC-TBD-market-hours-calibrated): đủ `MARKET_HOURS_MIN_CUTS` lệnh cắt
     * thật → trung bình (notional lệnh cắt ÷ order size của bot) (`cuts`); không thì trung vị qua bot Market Making của
     * (vị thế lớn nhất ÷ order size) trong 14 ngày theo `cutScope`; không có bot nào →
     * `MARKET_HOURS_CALIBRATION_DEFAULTS.positionRatio`.
     */
    positionRatio: decimalStringSchema,
    positionRatioSource: z.enum(["cuts", ...MARKET_HOURS_CALIBRATION_SOURCES]),
    /**
     * Volume một bot-hour tính theo đơn vị order size (Σ volume ÷ order size ÷ Σ bot-hour, 14 ngày) theo `cutScope`;
     * không có bot nào → `MARKET_HOURS_CALIBRATION_DEFAULTS.fillsPerBotHour`. Null chỉ ở dữ liệu cũ (không tính phần cắt).
     */
    fillsPerBotHour: decimalStringSchema.nullable(),
    /** Cỡ một lần cắt ÷ volume một bot-hour = R ÷ `fillsPerBotHour`; null = không tính phần cắt. */
    cutShare: decimalStringSchema.nullable(),
    /** Phạm vi bot dùng cho R (khi không từ lệnh cắt) và `fillsPerBotHour`. */
    cutScope: calibrationScopeSchema,
    /**
     * C: trung vị qua các ô (giờ địa phương × market) có ≥ 3 bot-hour Market Making trong 14 ngày của (CPM thật ÷ "incl.
     * shock days"), theo `calibrationScope`; không đủ ô ở mọi phạm vi → `MARKET_HOURS_CALIBRATION_DEFAULTS.calibration`.
     * Không bao giờ null.
     */
    calibration: decimalStringSchema,
    calibrationScope: calibrationScopeSchema,
    /** Số ô đã dùng cho C (0 khi mặc định). */
    calibrationHours: z.number().int().nonnegative(),
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

/** Biến động trong một cửa sổ (bp) = (cao nhất − thấp nhất) ÷ thấp nhất × 10 000; giá không hợp lệ → null. */
export function moveBp(highest: string, lowest: string): Decimal | null {
  const h = dec(highest);
  const l = dec(lowest);
  if (!l.gt(0) || h.lt(l)) return null;
  return h.sub(l).div(l).mul(10_000);
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

/**
 * Một fill của lệnh "Position cut" (market IOC reduce-only): `ref` = giá tham chiếu trước lúc cắt (null khi thiếu);
 * `orderSize` = order size (USDC) trong cấu hình đang chạy của bot (null khi không đọc được).
 */
export interface CutFill {
  orderId: string;
  side: "buy" | "sell";
  price: string;
  size: string;
  ref: string | null;
  orderSize: string | null;
}

/**
 * Số đo lệnh cắt thật của một market trong kỳ (DEC-289):
 * - `cuts` = số lệnh cắt có fill;
 * - `slippageBps` = trượt giá trung bình theo notional trên các fill có giá tham chiếu, dương = bất lợi (mua cao hơn /
 *   bán thấp hơn giá tham chiếu): Σ chiều × (giá khớp − ref) ÷ ref × notional ÷ Σ notional × 10 000;
 * - `notional` = notional trung bình của một lệnh cắt;
 * - `sizeRatio` = trung bình qua các lệnh cắt có order size của (notional lệnh cắt ÷ order size của bot)
 *   (DEC-TBD-market-hours-calibrated); null khi không lệnh nào có order size.
 * Dưới `MARKET_HOURS_MIN_CUTS` lệnh có giá tham chiếu → `slippageBps`, `notional`, `sizeRatio` là null (chỉ phí taker;
 * cỡ cắt theo R).
 */
export function cutStats(fills: readonly CutFill[]): {
  cuts: number;
  slippageBps: Decimal | null;
  notional: Decimal | null;
  sizeRatio: Decimal | null;
} {
  const orders = new Set<string>();
  const priced = new Set<string>();
  // Notional và order size của từng lệnh cắt (một lệnh có thể khớp nhiều fill).
  const perOrder = new Map<string, { notional: Decimal; orderSize: Decimal | null }>();
  let total = new Decimal(0);
  let weighted = new Decimal(0);
  let pricedNotional = new Decimal(0);
  for (const f of fills) {
    orders.add(f.orderId);
    const p = dec(f.price);
    const n = p.mul(dec(f.size));
    total = total.add(n);
    const o = perOrder.get(f.orderId);
    const size = f.orderSize === null ? null : dec(f.orderSize);
    perOrder.set(f.orderId, {
      notional: (o?.notional ?? new Decimal(0)).add(n),
      orderSize: o?.orderSize ?? (size?.gt(0) === true ? size : null),
    });
    if (f.ref === null || !dec(f.ref).gt(0)) continue;
    const ref = dec(f.ref);
    const slip = (f.side === "buy" ? p.sub(ref) : ref.sub(p)).div(ref);
    weighted = weighted.add(slip.mul(n));
    pricedNotional = pricedNotional.add(n);
    priced.add(f.orderId);
  }
  const enough = priced.size >= MARKET_HOURS_MIN_CUTS && pricedNotional.gt(0);
  const ratios = [...perOrder.values()].flatMap((o) =>
    o.orderSize === null ? [] : [o.notional.div(o.orderSize)],
  );
  return {
    cuts: orders.size,
    slippageBps: enough ? weighted.div(pricedNotional).mul(10_000) : null,
    notional: enough ? total.div(orders.size) : null,
    sizeRatio:
      enough && ratios.length > 0
        ? ratios.reduce((a, b) => a.add(b), new Decimal(0)).div(ratios.length)
        : null,
  };
}

/**
 * Một bot Market Making tiền thật trong 14 ngày (DEC-TBD-market-hours-calibrated): market, số bot-hour (giờ có ≥ 1 lệnh
 * tạo), Σ notional fill, vị thế lớn nhất (max |Σ size có dấu theo filled_at| × giá fill, USDC) và order size (USDC)
 * của cấu hình đang chạy. null khi không có fill / không đọc được cấu hình.
 */
export interface MmBotWindow {
  market: string;
  botHours: number;
  volume: string | null;
  maxPosition: string | null;
  orderSize: string | null;
}

/**
 * R và số fill một bot-hour của một nhóm bot (DEC-TBD-market-hours-calibrated). Chỉ bot có order size > 0:
 * - `ratio` = trung vị (vị thế lớn nhất ÷ order size) qua các bot có vị thế lớn nhất > 0;
 * - `fillsPerBotHour` = Σ (volume ÷ order size) ÷ Σ bot-hour qua các bot có bot-hour > 0 (volume một bot-hour theo đơn vị
 *   order size, nên dùng được cho mọi market và mọi order size); null khi không có volume;
 * - `botHours` = Σ bot-hour của các bot đã dùng; `markets` = market của các bot đó (theo tên).
 */
export function positionStats(bots: readonly MmBotWindow[]): {
  ratio: Decimal | null;
  fillsPerBotHour: Decimal | null;
  botHours: number;
  markets: string[];
} {
  const ratios: Decimal[] = [];
  let units = new Decimal(0);
  let hours = 0;
  const markets = new Set<string>();
  for (const b of bots) {
    const size = b.orderSize === null ? null : dec(b.orderSize);
    if (size === null || !size.gt(0) || b.botHours <= 0) continue;
    const pos = b.maxPosition === null ? null : dec(b.maxPosition);
    if (pos?.gt(0) === true) ratios.push(pos.div(size));
    hours += b.botHours;
    markets.add(b.market);
    if (b.volume !== null) units = units.add(dec(b.volume).div(size));
  }
  return {
    ratio: quantile(ratios, 0.5),
    fillsPerBotHour: hours === 0 || !units.gt(0) ? null : units.div(hours),
    botHours: hours,
    markets: [...markets].sort(),
  };
}

/**
 * Cỡ một lần cắt cho "incl. shock days" (DEC-TBD-market-hours-calibrated), một số cho mọi giờ của market:
 * - R: đủ lệnh cắt thật (`cutRatio` khác null) → `cutRatio` (`cuts`); không thì R của bot market này (`market`), không
 *   có thì R của mọi market gộp lại (`pooled`), không có nữa thì `MARKET_HOURS_CALIBRATION_DEFAULTS.positionRatio`
 *   (`default`);
 * - `fillsPerBotHour` theo cùng thứ tự market → pooled → `MARKET_HOURS_CALIBRATION_DEFAULTS.fillsPerBotHour`;
 * - `cutShare` = R ÷ `fillsPerBotHour` (= R × order size ÷ volume một bot-hour), luôn có.
 * `scope` = phạm vi bot của R / `fillsPerBotHour` (market → pooled → default); `marketBotHours` = bot-hour của mọi bot
 * Market Making trên market này (kể cả bot không đọc được order size).
 */
export function cutSizing(
  bots: readonly MmBotWindow[],
  market: string,
  cutRatio: Decimal | null,
): {
  ratio: Decimal;
  ratioSource: "cuts" | MarketHoursCalibrationSource;
  fillsPerBotHour: Decimal;
  cutShare: Decimal;
  scope: MarketHoursCalibrationScope;
} {
  const mine = bots.filter((b) => b.market === market);
  const marketBotHours = mine.reduce((s, b) => s + Math.max(0, b.botHours), 0);
  const own = positionStats(mine);
  const all = positionStats(bots);
  const scope: MarketHoursCalibrationScope =
    own.ratio !== null && own.fillsPerBotHour !== null
      ? { source: "market", botHours: own.botHours, marketBotHours, markets: [] }
      : all.ratio !== null && all.fillsPerBotHour !== null
        ? { source: "pooled", botHours: all.botHours, marketBotHours, markets: all.markets }
        : { source: "default", botHours: 0, marketBotHours, markets: [] };
  const stats = scope.source === "market" ? own : scope.source === "pooled" ? all : null;
  const ratio =
    cutRatio ?? stats?.ratio ?? new Decimal(MARKET_HOURS_CALIBRATION_DEFAULTS.positionRatio);
  const fills =
    stats?.fillsPerBotHour ?? new Decimal(MARKET_HOURS_CALIBRATION_DEFAULTS.fillsPerBotHour);
  return {
    ratio,
    ratioSource: cutRatio !== null ? "cuts" : scope.source,
    fillsPerBotHour: fills,
    cutShare: ratio.div(fills),
    scope,
  };
}

/**
 * C (DEC-TBD-market-hours-calibrated): ô của market này đủ `MARKET_HOURS_CALIBRATION_MIN_HOURS` → trung vị của chúng
 * (`market`); không thì gộp ô của mọi market (`pooled`, `pooled()` chỉ được gọi khi cần vì phải tải nến của từng
 * market); không đủ nữa → `MARKET_HOURS_CALIBRATION_DEFAULTS.calibration` (`default`). Không bao giờ null.
 * `own.botHours` = bot-hour của mọi bot Market Making trên market này (`marketBotHours` của scope).
 */
export async function calibrationOf(
  own: { pairs: readonly { real: Decimal; est: Decimal }[]; botHours: number },
  pooled: () => Promise<{
    pairs: readonly { real: Decimal; est: Decimal }[];
    botHours: number;
    markets: string[];
  }>,
): Promise<{ factor: Decimal; hours: number; scope: MarketHoursCalibrationScope }> {
  const mine = calibrationRatio(own.pairs);
  if (mine !== null)
    return {
      factor: mine,
      hours: usablePairs(own.pairs),
      scope: {
        source: "market",
        botHours: own.botHours,
        marketBotHours: own.botHours,
        markets: [],
      },
    };
  const p = await pooled();
  const all = calibrationRatio(p.pairs);
  if (all !== null)
    return {
      factor: all,
      hours: usablePairs(p.pairs),
      scope: {
        source: "pooled",
        botHours: p.botHours,
        marketBotHours: own.botHours,
        markets: p.markets,
      },
    };
  return {
    factor: new Decimal(MARKET_HOURS_CALIBRATION_DEFAULTS.calibration),
    hours: 0,
    scope: { source: "default", botHours: 0, marketBotHours: own.botHours, markets: [] },
  };
}

const usablePairs = (pairs: readonly { est: Decimal }[]): number =>
  pairs.filter((x) => x.est.gt(0)).length;

/**
 * Hiệu chỉnh (DEC-289): trung vị qua các ô của (chi phí thật ÷ ước tính), chỉ ô có ước tính > 0.
 * Dưới `MARKET_HOURS_CALIBRATION_MIN_HOURS` ô → null (phạm vi đó không đủ dữ liệu).
 */
export function calibrationRatio(
  pairs: readonly { real: Decimal; est: Decimal }[],
): Decimal | null {
  const xs = pairs.filter((x) => x.est.gt(0)).map((x) => x.real.div(x.est));
  return xs.length < MARKET_HOURS_CALIBRATION_MIN_HOURS ? null : quantile(xs, 0.5);
}
