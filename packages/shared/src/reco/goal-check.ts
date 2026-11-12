import { Decimal, dec, type DecimalInput } from "../money";

import { RECO_CONFIG } from "./config";

// Goal check của AI Desk (AI_DESK_RECOMMENDED.md mục 3.1): quy mục tiêu "mỗi ngày X USDC" ra % năm để khách tự thấy
// nó cao hay thấp. Chỉ là phép chia, không dự báo, không lãi kép, không ảnh hưởng `recommend()`.

export type GoalBand = "reasonable" | "ambitious" | "unrealistic";

export interface GoalCheck {
  /** % mỗi năm = mỗi ngày × 365 ÷ vốn × 100. */
  annualPct: string;
  band: GoalBand;
  /** Vốn cần để đạt mục tiêu ở từng mức % năm ví dụ (`RECO_CONFIG.goalCheck.examplePcts`). */
  examples: { annualPct: string; capital: string }[];
}

/** null khi thiếu số hoặc số không dương. */
export function goalCheck(daily: DecimalInput, capital: DecimalInput): GoalCheck | null {
  let d: Decimal;
  let c: Decimal;
  try {
    d = dec(daily);
    c = dec(capital);
  } catch {
    return null;
  }
  if (!d.gt(0) || !c.gt(0)) return null;
  const C = RECO_CONFIG.goalCheck;
  const yearly = d.mul(365);
  const pct = yearly.div(c).mul(100);
  const band: GoalBand = pct.lte(C.reasonableMaxPct)
    ? "reasonable"
    : pct.lte(C.ambitiousMaxPct)
      ? "ambitious"
      : "unrealistic";
  return {
    annualPct: pct.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toString(),
    band,
    examples: C.examplePcts.map((p) => ({
      annualPct: p,
      capital: yearly.div(p).mul(100).toDecimalPlaces(2, Decimal.ROUND_UP).toString(),
    })),
  };
}
