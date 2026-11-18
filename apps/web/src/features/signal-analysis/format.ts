// Định dạng của Signal Analysis (team, #233). Hàm thuần, chỉ hiển thị số API đã tính (không tính số phân tích ở đây).

const MINUS = "−";

/** "+0.9" / "−0.6" / "0.0" (bp, 1 chữ số). */
export function signed(v: number, dp = 1): string {
  const r = Number(v.toFixed(dp));
  if (r === 0) return (0).toFixed(dp);
  return `${r > 0 ? "+" : MINUS}${Math.abs(r).toFixed(dp)}`;
}

/** "$222" / "−$105" (đô / 1M, làm tròn đơn vị). */
export function usdM(v: string | number): string {
  const n = Math.round(Number(v));
  const abs = Math.abs(n).toLocaleString("en-US");
  return n < 0 ? `${MINUS}$${abs}` : `$${abs}`;
}

/** "1,872 USDC" / "−39 USDC"; `dp` chữ số thập phân. */
export function usdc(v: string | number, dp = 0): string {
  const n = Number(v);
  const s = Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  return `${n < 0 && Number(n.toFixed(dp)) !== 0 ? MINUS : ""}${s} USDC`;
}

/** "+0.26" / "−0.16" (USDC, 2 chữ số). */
export function signedUsd(v: string | number, dp = 2): string {
  return signed(Number(v), dp);
}

/** "8.42M" / "740K" / "312" (USDC volume). */
export function volume(v: string | number): string {
  const n = Number(v);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

export const count = (n: number): string => n.toLocaleString("en-US");

/** "58%" (số nguyên). */
export const pct = (v: number): string => `${String(Math.round(v))}%`;

/** Giá: giữ chữ số có nghĩa, nhóm hàng nghìn. */
export function price(v: string): string {
  const n = Number(v);
  const dp = n >= 1000 ? 1 : n >= 1 ? 4 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: dp });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:MM:SS" theo múi giờ `tz`. */
export function clock(iso: string, tz: string, seconds = true): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    ...(seconds ? { second: "2-digit" } : {}),
    hourCycle: "h23",
    timeZone: tz,
  }).format(new Date(iso));
}

/** "HH:MM:SS.mmm" theo múi giờ `tz`. */
export function clockMs(iso: string, tz: string): string {
  return `${clock(iso, tz)}.${String(new Date(iso).getUTCMilliseconds()).padStart(3, "0")}`;
}

/** "2026-11-18" theo múi giờ `tz`. */
export function day(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: tz,
  }).format(new Date(iso));
}

/** "Nov 18" từ "2026-11-18". */
export function shortDate(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

/** "12:00–16:00" từ giờ bắt đầu và độ dài (giờ). */
export function hourRange(from: number, len: number): string {
  const to = from + len;
  return `${pad(from)}:00–${pad(to)}:00`;
}

/** "1 min 14 s" / "52 s" / "4 min 05 s". */
export function duration(secs: number): string {
  if (secs < 60) return `${String(secs)} s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m)} min ${pad(s)} s`;
}

/** Màu chữ cho số theo hướng có lợi (+ = tốt): xanh / đỏ / trung tính. */
export function favourTone(v: number | null): string {
  if (v === null || Number(v.toFixed(1)) === 0) return "text-ink";
  return v > 0 ? "text-pos" : "text-neg";
}

/** Màu chữ cho chi phí (+ = tốn): đỏ / xanh. */
export function costTone(v: string | number | null): string {
  if (v === null) return "text-ink";
  const n = Number(v);
  if (Math.round(n) === 0) return "text-ink";
  return n > 0 ? "text-neg" : "text-pos";
}
