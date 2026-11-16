import { dec, type TeamOpsBot } from "@drift/shared";

import { formatDateTime, formatMoney } from "@/lib/format";

// Định dạng của trang Bot Monitor (docs/mockups/ops). Giờ theo múi giờ của trình duyệt (quyết định 6). Thiếu số → null
// để trang hiện "Not available", không bao giờ 0.

/** "$1.21M", "$96.4K", "$612.80" (Decimal, không float). */
export function compactUsd(v: string | null): string | null {
  if (v === null) return null;
  const d = dec(v);
  const abs = d.abs();
  const sign = d.isNeg() ? "−" : "";
  if (abs.gte(1_000_000)) return `${sign}$${abs.div(1_000_000).toFixed(2)}M`;
  if (abs.gte(1_000)) return `${sign}$${abs.div(1_000).toFixed(1)}K`;
  const m = formatMoney(abs.toString());
  return m === null ? null : `${sign}$${m}`;
}

/** "$612.80" */
export function usd(v: string | null): string | null {
  if (v === null) return null;
  const m = formatMoney(v);
  return m === null ? null : m.startsWith("−") ? `−$${m.slice(1)}` : `$${m}`;
}

/** Số với `dp` chữ số thập phân cố định ("71.0", "112"). */
export function fixed(v: string, dp: number): string {
  return dec(v).toFixed(dp);
}

/** Giờ "11:42:10" theo múi giờ trình duyệt; mốc không thuộc hôm nay thì kèm ngày ("Nov 14, 10:05:07"). */
export function clock(iso: string, now: number, timeZone?: string): string {
  const d = new Date(iso);
  const day = (x: Date) =>
    new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeZone }).format(x);
  if (day(d) !== day(new Date(now))) return formatDateTime(iso, timeZone ?? browserZone());
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(d);
}

/** "11:42:10 GMT+7" cho dòng Checked. */
export function clockWithZone(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
    timeZone,
  }).format(new Date(iso));
}

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Khoảng thời gian thô: số phút / giờ / ngày (làm tròn xuống). */
export function span(ms: number): { unit: "min" | "h" | "d"; count: number } {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return { unit: "min", count: min };
  const h = Math.floor(min / 60);
  if (h < 24) return { unit: "h", count: h };
  return { unit: "d", count: Math.floor(h / 24) };
}

/** 8 ký tự cuối của id (chủ bot, bot; quyết định 5). */
export const tail = (id: string) => id.slice(-8);

export type Flag = "warn" | "bad";

/** Ô nào vượt ngưỡng, suy từ lý do của nhãn (không tự đặt ngưỡng ở trang). */
export function flagsOf(r: TeamOpsBot): Partial<Record<string, Flag>> {
  const out: Partial<Record<string, Flag>> = {};
  for (const x of r.reasons) {
    if (x.code === "alert_active") {
      out.alert = "bad";
      if (x.invariant === "P1") out.inv = "bad";
    }
    if (x.code === "rejected_pause") out.rej = "bad";
    if (x.code === "gap_problem") out.gap = "bad";
    if (x.code === "requests_high") out.req = "warn";
    if (x.code === "gap_long") out.gap = "warn";
    if (x.code === "cuts_hour") out.cuts = "warn";
    if (x.code === "untracked") out.untr = "warn";
    if (x.code === "rejects") out.rej ??= "warn";
    if (x.code === "cost_high") out.cost = "warn";
    if (x.code === "stale_candles") out.skips = "warn";
  }
  return out;
}

export const WAIT_KEYS = [
  "counterTrend",
  "spread",
  "sideways",
  "stale",
  "belowMinimum",
  "blockedHour",
] as const;
export type WaitKey = (typeof WAIT_KEYS)[number];

/** Tổng số lần bắt đầu chờ và lý do nhiều nhất (hoà thì lấy lý do đứng trước). */
export function waitsOf(vb: NonNullable<TeamOpsBot["vb"]>): { total: number; top: WaitKey | null } {
  let total = 0;
  let top: WaitKey | null = null;
  for (const k of WAIT_KEYS) {
    total += vb.waits[k];
    if (vb.waits[k] > 0 && (top === null || vb.waits[k] > vb.waits[top])) top = k;
  }
  return { total, top };
}
