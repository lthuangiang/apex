import {
  dec,
  Decimal,
  escapeTelegramHtml,
  formatCostPerMillion,
  ReasonCode,
  Strategy,
} from "@drift/shared";

import messages from "./messages/en.json" with { type: "json" };
import type { StoppedRun } from "./stopped-run";

// Tin `bot_stopped` dừng đúng kế hoạch (#566, mẫu chủ sản phẩm duyệt 2026-11-26):
//   ✅ ETH Market Making stopped: cost limit reached
//
//   Volume   $1.24M
//   Cost     −25.00 USDC ▼ (limit 25.00)
//   CPM      201.61 per $1M (cùng định dạng Trading Agent: `formatCostPerMillion`)
//   Ran      6h 12m
// Bảng nằm trong <pre> để thẳng cột. Thiếu số nào thì bỏ dòng đó, không bao giờ ghi 0 thay số thiếu (quy tắc 1.8).
// Hàm thuần, không I/O.

const PS = messages.plannedStop;
const PS_REASONS: Record<string, string> = PS.reasons;
const REASONS: Record<string, string> = messages.reasons;

const POSITIVE = /^\d+(\.\d+)?$/;

/**
 * Key nhãn lý do, cùng quy tắc với `stopReasonKey` của web (DEC-262) cho các mã dừng đúng kế hoạch: Market Making dùng
 * chung mã với chiến lược khác nên nhãn theo chiến lược và dữ liệu có được; thiếu dữ liệu thì nhãn chung.
 */
export function plannedStopReasonKey(code: string, run: StoppedRun | null): string {
  if (run === null) return code;
  if (run.strategy === Strategy.volumeFarm && code === ReasonCode.maxCycles)
    return "MAX_CYCLES_VOLUME";
  if (run.strategy !== Strategy.volumeMaker) return code;
  if (code === ReasonCode.budgetDone) return "MM_BUDGET_DONE";
  if (code !== ReasonCode.maxCycles) return code;
  if (run.stopDetail === "volume_target") return "MAX_CYCLES_VOLUME";
  if (run.stopDetail === "end_time") return "MAX_CYCLES_END_TIME";
  // Engine xét volume target trước end time; có khối lượng thật thì biết chắc lý do (MAX_CYCLES chỉ có hai nguồn).
  if (run.volume !== null && POSITIVE.test(run.volume)) {
    if (run.volumeTarget !== null && dec(run.volume).gte(run.volumeTarget))
      return "MAX_CYCLES_VOLUME";
    return "MAX_CYCLES_END_TIME";
  }
  return "MAX_CYCLES_MM";
}

export function plannedStopReason(data: Record<string, unknown>, run: StoppedRun | null): string {
  const code = typeof data.reasonCode === "string" ? data.reasonCode : "";
  return PS_REASONS[plannedStopReasonKey(code, run)] ?? REASONS[code] ?? escapeTelegramHtml(code);
}

/** Nhóm hàng nghìn: "1234567.5" → "1,234,567.5". */
function grouped(fixed: string): string {
  const [int = "0", frac] = fixed.split(".");
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? g : `${g}.${frac}`;
}

/** Bỏ số 0 thừa sau dấu chấm: "1.20" → "1.2", "3.00" → "3". */
const trimZeros = (fixed: string) => (fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed);

/** Volume gọn: $1.24M, $310K, $850.5. Làm tròn xuống: không bao giờ ghi cao hơn khối lượng thật. */
export function compactUsd(v: string): string {
  const d = dec(v);
  const units: [number, string][] = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  for (const [n, suffix] of units) {
    if (d.gte(n))
      return `$${trimZeros(d.div(n).toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2))}${suffix}`;
  }
  return `$${trimZeros(d.toDecimalPlaces(2, Decimal.ROUND_DOWN).toFixed(2))}`;
}

/** Tiền có dấu, 2 chữ số, ▲/▼ và đơn vị như `/status` (DEC-187): "+3.10 USDC ▲", "−25.00 USDC ▼", "0.00 USDC". */
export function signedMoney(v: Decimal, unit: string): string {
  const r = v.toDecimalPlaces(2);
  const u = escapeTelegramHtml(unit);
  if (r.isZero()) return `0.00 ${u}`;
  return r.isPositive()
    ? `+${grouped(r.toFixed(2))} ${u} ▲`
    : `−${grouped(r.abs().toFixed(2))} ${u} ▼`;
}

/** "6h 12m"; từ 1 ngày: "2d 3h" (cùng cách ghi Runtime của Trading Agent). */
export function durationText(ms: number): string {
  const minutes = Math.round(Math.max(0, ms) / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  return `${String(hours)}h ${String(mins).padStart(2, "0")}m`;
}

const withLimit = (text: string, limit: string | null) =>
  limit === null ? text : `${text} ${PS.limit.replace("{limit}", dec(limit).toFixed(2))}`;

/** Khối số liệu (đã có dòng trống phía trước); không còn dòng nào thì null. */
export function plannedStopBody(run: StoppedRun | null): string | null {
  if (run === null) return null;
  const L = PS.labels;
  const lines: [string, string][] = [];
  if (run.volume !== null) lines.push([L.volume, compactUsd(run.volume)]);
  if (run.cost !== null)
    lines.push([L.cost, withLimit(signedMoney(dec(run.cost.value).neg(), "USDC"), run.cost.limit)]);
  if (run.pnl !== null)
    lines.push([L.pnl, withLimit(signedMoney(dec(run.pnl.value), run.pnl.unit), run.pnl.limit)]);
  if (run.costPerMillion !== null)
    lines.push([L.cpm, PS.perMillion.replace("{value}", formatCostPerMillion(run.costPerMillion))]);
  if (run.ranMs !== null) lines.push([L.ran, durationText(run.ranMs)]);
  if (lines.length === 0) return null;
  // Cột giá trị cố định theo nhãn dài nhất ("Volume" + 3 dấu cách như mẫu), kể cả khi dòng đó bị bỏ.
  const width = Math.max(...Object.values(L).map((l) => l.length)) + 3;
  return `\n<pre>${lines.map(([l, v]) => `${l.padEnd(width)}${v}`).join("\n")}</pre>`;
}
