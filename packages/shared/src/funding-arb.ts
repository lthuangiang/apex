import { DRIFT_BUILDER_FEE_RATE, roundTripFeePct } from "./fees";
import { Decimal, dec, type DecimalInput } from "./money";

// Chọn tài sản cho Funding Arbitrage (DEC-160). SoDEX trả funding mỗi giờ, nên ngưỡng cố định "0.005% mỗi kỳ"
// không market nào đạt. Thay bằng câu hỏi thực tế: theo funding trung bình 7 ngày đã trả, mất bao nhiêu giờ để thu
// đủ phí khứ hồi của lượt arb, và funding có dương đều không. Chỉ dùng số đã xảy ra; không dự báo lợi nhuận.

export const ARB_FIT = {
  /** Thu đủ phí khứ hồi maker trong ngần này giờ (theo funding trung bình 7 ngày). */
  maxBreakEvenHours: 72,
  /** Tỷ lệ kỳ funding dương tối thiểu trong 21 kỳ gần nhất. */
  minPositiveShare21: 0.9,
} as const;

/**
 * Phí khứ hồi (%) của một lượt arb, tính trên notional mỗi chân: vào + ra Spot và vào + ra Perps bằng lệnh maker,
 * kèm builder fee (Perps cả hai chiều, Spot chiều bán). Funding chỉ trả trên chân Perps có cùng notional, nên đây
 * cũng là mức funding cộng dồn (%) cần thu để hoà phí.
 */
export function arbRoundTripFeePct(input: {
  spotMakerPct?: DecimalInput | null | undefined;
  perpMakerPct?: DecimalInput | null | undefined;
  builderRate?: number | undefined;
}): Decimal {
  const builderRate = input.builderRate ?? DRIFT_BUILDER_FEE_RATE;
  return roundTripFeePct({ engine: "spot", makerPct: input.spotMakerPct, builderRate }).add(
    roundTripFeePct({ engine: "perps", makerPct: input.perpMakerPct, builderRate }),
  );
}

/** Số giờ funding (theo `avgPct` % mỗi kỳ) để thu đủ `feePct`; null khi funding trung bình ≤ 0. */
export function arbBreakEvenHours(
  avgPct: DecimalInput,
  intervalHours: number,
  feePct: DecimalInput,
): number | null {
  const avg = dec(avgPct);
  if (!avg.gt(0)) return null;
  return dec(feePct).div(avg).mul(intervalHours).toNumber();
}

export interface ArbFit {
  breakEvenHours: number | null;
  positiveShare21: number | null;
  /** Đạt cả hai điều kiện của `ARB_FIT`. Thiếu dữ liệu thì không đạt. */
  eligible: boolean;
}

export function arbFit(input: {
  /** Funding trung bình 7 ngày, % mỗi kỳ; null khi chưa có dữ liệu. */
  avg7dPct: DecimalInput | null;
  /** Tỷ lệ kỳ dương trong 21 kỳ gần nhất; null khi chưa đủ 21 kỳ. */
  positiveShare21: number | null;
  intervalHours: number;
  feePct: DecimalInput;
}): ArbFit {
  const breakEvenHours =
    input.avg7dPct === null
      ? null
      : arbBreakEvenHours(input.avg7dPct, input.intervalHours, input.feePct);
  return {
    breakEvenHours,
    positiveShare21: input.positiveShare21,
    eligible:
      breakEvenHours !== null &&
      breakEvenHours <= ARB_FIT.maxBreakEvenHours &&
      input.positiveShare21 !== null &&
      input.positiveShare21 >= ARB_FIT.minPositiveShare21,
  };
}

/**
 * Ngưỡng vào lệnh mặc định (% mỗi kỳ, 4 chữ số, làm tròn lên): mức funding đủ thu lại phí khứ hồi trong
 * `ARB_FIT.maxBreakEvenHours`. Ví dụ phí 0.124%, kỳ 1 giờ → 0.0018%.
 */
export function arbEnterPct(feePct: DecimalInput, intervalHours: number): string {
  const periods = ARB_FIT.maxBreakEvenHours / intervalHours;
  return dec(feePct).div(periods).toDecimalPlaces(4, Decimal.ROUND_UP).toString();
}
