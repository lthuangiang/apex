import { dec } from "../money";

import type { AccountMetrics, HoldingBucket } from "./account";

// "What stands out" (artboard Onboarding 4). Quy tắc tất định trên số đã tính; UI điền số vào câu
// chữ. Ngưỡng chọn theo khuyến nghị (DEC-34), chỉnh ở đây.

export const FINDING_THRESHOLDS = {
  /** Phí ≥ 30% lãi gộp. */
  feeShareOfGross: 0.3,
  /** Lệnh thua giữ lâu hơn ≥ 1.5× lệnh thắng. */
  loserHoldRatio: 1.5,
  /** Đòn bẩy ≥ 8× gây > 50% tổng lỗ (cùng ngưỡng RECO_ENGINE.md mục 10.3). */
  highLeverageLossShare: 0.5,
} as const;

export type Finding =
  | { kind: "costs"; fees: string; gross: string; feeShare: string; takerRatio: string | null }
  | {
      kind: "holding";
      shortClosed: number;
      shortNet: string;
      bestBucket: HoldingBucket;
      bestClosed: number;
      bestNet: string;
    }
  | {
      kind: "exits";
      ratio: string;
      losersMs: number;
      winnersMs: number;
      avgLoss: string | null;
      avgWin: string | null;
    }
  | { kind: "leverage"; lossShare: string; positionShare: string | null };

export function findings(m: AccountMetrics): Finding[] {
  const out: Finding[] = [];
  const gross = dec(m.grossRealizedPnl);
  if (gross.gt(0) && dec(m.fees).div(gross).gte(FINDING_THRESHOLDS.feeShareOfGross)) {
    out.push({
      kind: "costs",
      fees: m.fees,
      gross: m.grossRealizedPnl,
      feeShare: dec(m.fees).div(gross).toString(),
      takerRatio: m.takerRatio,
    });
  }
  const short = m.pnlByHolding["<15m"];
  const longer = (["4h–1d", "1–7d", ">7d"] as const)
    .map((b) => ({ b, v: m.pnlByHolding[b] }))
    .filter((x) => x.v.closed > 0 && dec(x.v.netPnl).gt(0))
    .sort((a, b) => dec(b.v.netPnl).comparedTo(dec(a.v.netPnl)))[0];
  if (short.closed > 0 && dec(short.netPnl).lt(0) && longer !== undefined) {
    out.push({
      kind: "holding",
      shortClosed: short.closed,
      shortNet: short.netPnl,
      bestBucket: longer.b,
      bestClosed: longer.v.closed,
      bestNet: longer.v.netPnl,
    });
  }
  if (m.avgHoldLosersMs !== null && m.avgHoldWinnersMs !== null && m.avgHoldWinnersMs > 0) {
    const ratio = m.avgHoldLosersMs / m.avgHoldWinnersMs;
    if (ratio >= FINDING_THRESHOLDS.loserHoldRatio) {
      out.push({
        kind: "exits",
        ratio: ratio.toFixed(1),
        losersMs: m.avgHoldLosersMs,
        winnersMs: m.avgHoldWinnersMs,
        avgLoss: m.avgLoss,
        avgWin: m.avgWin,
      });
    }
  }
  const high = m.lossShareByLeverage?.["≥8x"];
  if (high !== undefined && dec(high).gt(FINDING_THRESHOLDS.highLeverageLossShare)) {
    out.push({ kind: "leverage", lossShare: high, positionShare: m.highLeveragePositionShare });
  }
  return out;
}
