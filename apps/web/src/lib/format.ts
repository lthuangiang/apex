import { formatDecimal, formatPercent, mul } from "@drift/shared";

/** `0x8f3e…c21a` */
export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** Ngày dạng "Apr 26, 2027" từ timestamp ms. */
export function formatDate(ms: number | string, timeZone = "Asia/Ho_Chi_Minh"): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone,
  }).format(new Date(Number(ms)));
}

/** "Oct 26, 14:02:11" từ ISO string hoặc timestamp ms. */
export function formatDateTime(value: number | string, timeZone = "Asia/Ho_Chi_Minh"): string {
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(d);
}

/** maxFeeRate (phần mười bp) → "0.01%" và "1 bp". */
export function feeLabels(rate: number): { pct: string; bp: string } {
  const pct = `${(rate / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
  return { pct, bp: `${String(rate / 10)} bp` };
}

const LOCALE = "en-US";

export function formatInteger(value: number): string {
  return new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 }).format(value);
}

/** Tiền USDC 2 chữ số; `signed` hiện dấu + / − (mục 9.4). */
export function formatMoney(value: string | null, signed = false): string | null {
  if (value === null) return null;
  const out = formatDecimal(value, {
    locale: LOCALE,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: signed ? "exceptZero" : "auto",
  });
  return out?.replace("-", "−") ?? null;
}

/** Tỷ lệ thô (0.46) → "46%". */
export function formatRatio(value: string | null, digits = 0): string | null {
  if (value === null) return null;
  return formatPercent(mul(value, "100"), { locale: LOCALE, maximumFractionDigits: digits });
}

/** Khoảng thời gian dạng "11h 02m" / "3d 4h". */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  return `${String(hours)}h ${String(mins).padStart(2, "0")}m`;
}

/** Số chữ số thập phân của một bước (tick / lot): "0.01" → 2, "1" → 0, "0.0001" → 4. */
export function stepDecimals(step: string): number {
  const [, frac = ""] = step.replace(/0+$/, "").split(".");
  return frac.length;
}

/** Ngưỡng dưới của số lượng tài sản: nhỏ hơn thì hiện "< 0.0001" (giá trị đầy đủ ở tooltip). */
export const TINY = "0.0001";

/**
 * Số có dấu phân cách hàng nghìn, `digits` chữ số thập phân (giá theo tick, khối lượng theo lot).
 * `digits` null = giữ đủ chữ số nhưng tối đa 8. Trả `{ text, full }`: `full` là giá trị gốc cho tooltip
 * khi bị làm tròn hoặc hiện dạng "< 0.0001" (UI_REVIEW E1.5).
 */
export function formatAmount(
  value: string | null,
  digits: number | null = null,
): { text: string; full: string | null } | null {
  if (value === null) return null;
  const abs = value.replace(/^-/, "");
  if (Number(abs) !== 0 && Number(abs) < Number(TINY) && (digits === null || digits >= 4)) {
    return { text: `< ${TINY}`, full: value };
  }
  const max = digits ?? 8;
  const text =
    formatDecimal(value, {
      locale: LOCALE,
      minimumFractionDigits: digits ?? 0,
      maximumFractionDigits: max,
    })?.replace("-", "−") ?? value;
  const [, frac = ""] = abs.split(".");
  return { text, full: frac.replace(/0+$/, "").length > max ? value : null };
}
