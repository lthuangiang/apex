import { formatDecimal, isNegative, isZero } from "@drift/shared";

import { formatDuration, formatRatio } from "@/lib/format";

// Định dạng số cho Copy Trading theo artboard (`+$84,120`, `5h 40m`, `62%`). Thiếu dữ liệu: null, nơi gọi hiện
// "Not enough trades" / "Not available" — không bao giờ 0 (quy tắc 1.8).

const LOCALE = "en-US";

/** "$84,120" / "+$84,120" / "−$9,800". */
export function usd(value: string | null, signed = false, decimals = 0): string | null {
  if (value === null) return null;
  const abs = formatDecimal(value.replace(/^-/, ""), {
    locale: LOCALE,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (abs === null) return null;
  const sign = isNegative(value) && !isZero(value) ? "−" : signed && !isZero(value) ? "+" : "";
  return `${sign}$${abs}`;
}

export const holdText = (ms: number | null): string | null =>
  ms === null ? null : formatDuration(ms);
export const pctText = (ratio: string | null): string | null => formatRatio(ratio);

/** "0x3e9a…11fd". */
export const addr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
/** Ô chữ đầu thẻ: hai ký tự sau 0x. */
export const initials = (a: string): string => a.slice(2, 4).toUpperCase();

/** "34 min ago", "2 hours ago", "yesterday". */
export function ago(iso: string, now = Date.now()): string {
  const diff = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto", style: "short" });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(diff, "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  return rtf.format(Math.round(diff / 86_400), "day");
}

/** Market SoDEX → tên ngắn: "BTC-USD" → "BTC". */
export const base = (market: string): string => market.split(/[-_]/)[0] ?? market;
