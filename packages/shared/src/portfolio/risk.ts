import { Decimal, dec } from "../money";

// Risk engine (màn Risk Center, DOMAIN.md mục 7.2, DEC-41). Hàm thuần: đầu vào là chuỗi equity snapshot.
// - Daily loss = (equity đầu ngày − equity hiện tại) / equity đầu ngày; ngày tính theo múi giờ người dùng.
// - Drawdown = (đỉnh equity 30 ngày − equity hiện tại) / đỉnh.
// Server chặn: daily loss, max drawdown, per-trade. Chỉ cảnh báo (UI): max leverage, max positions.

export const RISK_ENFORCED = {
  dailyLoss: true,
  maxDrawdown: true,
  perTrade: true,
  maxLeverage: false,
  maxPositions: false,
} as const;

export interface RiskLimitsInput {
  dailyLossPct: string | null;
  maxDrawdownPct: string | null;
}

export interface EquityPoint {
  at: number;
  equity: string;
}

export interface RiskStatus {
  /** % lỗ trong ngày (dương = lỗ); null khi chưa có snapshot đầu ngày. */
  dailyLossPct: string | null;
  dayStartEquity: string | null;
  drawdownPct: string | null;
  peakEquity: string | null;
  peakAt: number | null;
  equity: string | null;
  breaches: ("daily_loss" | "max_drawdown")[];
}

/** 00:00 ngày hiện tại theo múi giờ IANA, tính bằng ms UTC. */
export function startOfDay(now: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(now));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const elapsed = ((get("hour") * 60 + get("minute")) * 60 + get("second")) * 1000 + (now % 1000);
  return now - elapsed;
}

export function evaluateRisk(
  limits: RiskLimitsInput,
  points: readonly EquityPoint[],
  now: number,
  timeZone: string,
): RiskStatus {
  const sorted = [...points].filter((p) => p.at <= now).sort((a, b) => a.at - b.at);
  const last = sorted.at(-1);
  if (last === undefined) {
    return {
      dailyLossPct: null,
      dayStartEquity: null,
      drawdownPct: null,
      peakEquity: null,
      peakAt: null,
      equity: null,
      breaches: [],
    };
  }
  const dayStart = startOfDay(now, timeZone);
  // Equity đầu ngày: snapshot cuối cùng trước 00:00, hoặc snapshot đầu tiên trong ngày.
  const before =
    sorted.filter((p) => p.at <= dayStart).at(-1) ?? sorted.find((p) => p.at >= dayStart);
  const window = sorted.filter((p) => p.at >= now - 30 * 86_400_000);
  const peak = window.reduce((m, p) => (dec(p.equity).gt(m.equity) ? p : m), window[0] ?? last);
  const eq = dec(last.equity);
  const daily =
    before === undefined || !dec(before.equity).gt(0)
      ? null
      : dec(before.equity).sub(eq).div(before.equity).mul(100);
  const dd = dec(peak.equity).gt(0)
    ? Decimal.max(0, dec(peak.equity).sub(eq).div(peak.equity).mul(100))
    : null;
  const breaches: RiskStatus["breaches"] = [];
  if (daily !== null && limits.dailyLossPct !== null && daily.gte(limits.dailyLossPct))
    breaches.push("daily_loss");
  if (dd !== null && limits.maxDrawdownPct !== null && dd.gte(limits.maxDrawdownPct))
    breaches.push("max_drawdown");
  return {
    dailyLossPct: daily?.toDecimalPlaces(4).toString() ?? null,
    dayStartEquity: before?.equity ?? null,
    drawdownPct: dd?.toDecimalPlaces(4).toString() ?? null,
    peakEquity: peak.equity,
    peakAt: peak.at,
    equity: last.equity,
    breaches,
  };
}

/** Per-trade: notional của lệnh không vượt `perTradePct` % equity. */
export function exceedsPerTrade(
  notional: string,
  equity: string,
  perTradePct: string | null,
): boolean {
  if (perTradePct === null || !dec(equity).gt(0)) return false;
  return dec(notional).gt(dec(equity).mul(perTradePct).div(100));
}
