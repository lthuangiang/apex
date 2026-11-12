import { Decimal, dec } from "../money";

// AI Desk B+ (DEC-166, DEC-177): thước đo lỗ trên thẻ Mục tiêu. Lỗ cho phép = vốn × maxDrop% của goals
// ("unsure" → 5%, như RECO_ENGINE mục B). Lỗ đã dùng = drawdown của Risk Center tính bằng USDC (đỉnh equity 30 ngày −
// equity hiện tại), âm → 0; thiếu snapshot → null ("Not available"), không hiện 0.

export interface GoalGauge {
  limit: string;
  used: string | null;
}

export function goalGauge(
  goals: { capital: string; maxDrop: "5" | "10" | "20" | "unsure" },
  risk: { peakEquity: string | null; equity: string | null } | null,
): GoalGauge {
  const pct = goals.maxDrop === "unsure" ? "5" : goals.maxDrop;
  const limit = dec(goals.capital).mul(pct).div(100).toDecimalPlaces(2);
  const used =
    risk?.peakEquity == null || risk.equity == null
      ? null
      : Decimal.max(0, dec(risk.peakEquity).sub(risk.equity)).toDecimalPlaces(2).toString();
  return { limit: limit.toString(), used };
}
