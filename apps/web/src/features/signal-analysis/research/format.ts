// Định dạng của tab Signal research. Hàm thuần, chỉ hiển thị số API đã tính.

const MINUS = "−";

/** "+0.21%" / "−0.09%" / "0.00%". */
export function pctSigned(v: number, dp = 2): string {
  const r = Number(v.toFixed(dp));
  if (r === 0) return `${(0).toFixed(dp)}%`;
  return `${r > 0 ? "+" : MINUS}${Math.abs(r).toFixed(dp)}%`;
}

/** "0.10%" (không dấu). */
export const pctPlain = (v: number, dp = 2): string => `${v.toFixed(dp)}%`;

/** "+$9.50" / "−$3.01". */
export function usdSigned(v: string): string {
  const n = Number(v);
  const s = Math.abs(n).toFixed(2);
  if (Number(n.toFixed(2)) === 0) return `$${s}`;
  return `${n > 0 ? "+" : MINUS}$${s}`;
}

/** "−$2.51" / "$0.50" theo dấu, không thêm "+". */
export function usdPlain(v: string): string {
  const n = Number(v);
  return `${n < 0 && Number(n.toFixed(2)) !== 0 ? MINUS : ""}$${Math.abs(n).toFixed(2)}`;
}

/** "$1.2M" / "$640K" / "$500". */
export function usdCompact(v: string): string {
  const n = Math.abs(Number(v));
  const s =
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(0)}K`
        : n.toFixed(0);
  return `${Number(v) < 0 ? MINUS : ""}$${s}`;
}

/** Giá giữ đúng số chữ số thập phân API gửi, nhóm hàng nghìn: "3,412.5", "143.60". */
export function priceText(v: string): string {
  const neg = v.startsWith("-");
  const [i = "0", f] = (neg ? v.slice(1) : v).split(".");
  const grouped = Number(i).toLocaleString("en-US");
  return `${neg ? MINUS : ""}${grouped}${f === undefined ? "" : `.${f}`}`;
}

/** "10,024.6" (1 chữ số). */
export function balance(v: string): string {
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

/** "1.5×"→ "3.4". */
export const times = (v: number): string => (Math.round(v * 10) / 10).toString();

/** Độ trễ ngắn: "31 s", "3 min", "1 h 35 min", "2 h". */
export function delay(secs: number): string {
  if (secs < 60) return `${String(secs)} s`;
  if (secs < 3600) return `${String(Math.round(secs / 60))} min`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  if (m === 60) return `${String(h + 1)} h`;
  return m === 0 ? `${String(h)} h` : `${String(h)} h ${String(m)} min`;
}

/** Độ trễ đủ: "3 min 10 s". */
export function delayLong(secs: number): string {
  if (secs < 60) return `${String(secs)} s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s === 0 ? `${String(m)} min` : `${String(m)} min ${String(s)} s`;
}

/** Thời gian giữ: "2 d", "4 h", "2 d 4 h", "1 h 48 min", "35 min". */
export function span(secs: number): string {
  const d = Math.floor(secs / 86_400);
  const h = Math.floor((secs % 86_400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return h > 0 ? `${String(d)} d ${String(h)} h` : `${String(d)} d`;
  if (h > 0) return m > 0 ? `${String(h)} h ${String(m)} min` : `${String(h)} h`;
  return `${String(m)} min`;
}

export const hold = (hours: number): string => span(hours * 3600);

/** Màu chữ theo dấu (+ = tốt). */
export function tone(v: number | null): string {
  if (v === null || v === 0) return "text-ink";
  return v > 0 ? "text-pos" : "text-neg";
}
