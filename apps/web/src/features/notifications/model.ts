import { groupOf, type NotificationGroup, type NotificationType } from "@drift/shared";

// Logic thuần cho panel chuông và toast (docs/NOTIFICATIONS.md mục 7, artboard NT-InApp).

export interface NotificationItem {
  id: string;
  type: NotificationType;
  data: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}

/** Nhóm có toast và thuộc tab "Needs you" (mục 7): Bot problems và Risk. */
export const ALERT_GROUPS: readonly NotificationGroup[] = ["botErrors", "risk"];

export function isAlert(n: Pick<NotificationItem, "type">): boolean {
  return ALERT_GROUPS.includes(groupOf(n.type));
}

/** "Needs you": botErrors và risk chưa đọc. */
export function needsYou(items: readonly NotificationItem[]): NotificationItem[] {
  return items.filter((n) => n.readAt === null && isAlert(n));
}

/** Ngày lịch (YYYY-MM-DD) của một thời điểm theo múi giờ của người dùng. */
export function dayKey(at: Date, timeZone: string): string {
  // en-CA cho dạng 2026-11-12.
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  }).format(at);
}

/** Tách Today / Earlier theo ngày lịch ở múi giờ của người dùng, giữ nguyên thứ tự. */
export function splitByDay(
  items: readonly NotificationItem[],
  now: Date,
  timeZone: string,
): { today: NotificationItem[]; earlier: NotificationItem[] } {
  const todayKey = dayKey(now, timeZone);
  const today: NotificationItem[] = [];
  const earlier: NotificationItem[] = [];
  for (const n of items) {
    (dayKey(new Date(n.createdAt), timeZone) === todayKey ? today : earlier).push(n);
  }
  return { today, earlier };
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/**
 * Màn hình mở khi bấm một dòng (mục 5 và 7): Trading Agent, Risk Center, Settings hoặc AI Desk.
 * Bot tiền giả (DEC-105) chỉ xem được trong AI Desk.
 */
export function targetOf(n: Pick<NotificationItem, "type" | "data">, aiDesk: boolean): string {
  const botId = str(n.data.botId);
  switch (n.type) {
    case "bot_paused":
    case "bot_stopped":
    case "unknown_order":
    case "fill":
      if (n.data.paper === true) return aiDesk ? "/desk" : "/";
      return botId === null ? "/agent" : `/agent/${encodeURIComponent(botId)}`;
    case "risk_alert":
      return "/risk";
    case "key_fee":
      return "/settings";
    case "daily_summary":
      return aiDesk ? "/desk" : "/";
    case "leader_big_move":
      // Copy Trading chỉ có khi bật AI Desk (DEC-163).
      return aiDesk ? "/following" : "/";
  }
}

/** Nhãn hành động cuối dòng ("Review →", "Open →", "See AI Desk →" trong artboard). */
export function actionOf(
  n: Pick<NotificationItem, "type">,
  aiDesk: boolean,
): "review" | "open" | "seeDesk" {
  if (n.type === "bot_paused" || n.type === "bot_stopped" || n.type === "risk_alert")
    return "review";
  if (n.type === "daily_summary" && aiDesk) return "seeDesk";
  return "open";
}

/**
 * Toast: những thông báo cảnh báo chưa đọc, chưa từng thấy trong tab này. Lần tải đầu chỉ ghi nhận
 * (không bật toast cho tin cũ). Trả về danh sách mới (mới nhất trước) và tập id đã thấy cập nhật.
 */
export function newAlerts(
  seen: ReadonlySet<string> | null,
  items: readonly NotificationItem[],
): { fresh: NotificationItem[]; seen: Set<string> } {
  const next = new Set(seen ?? []);
  for (const n of items) next.add(n.id);
  if (seen === null) return { fresh: [], seen: next };
  const fresh = items.filter((n) => !seen.has(n.id) && n.readAt === null && isAlert(n));
  return { fresh, seen: next };
}

/** Một toast tại một thời điểm: tin mới gộp với tin đang hiện (mới nhất trước, không trùng). */
export function mergeToast(
  current: readonly NotificationItem[],
  fresh: readonly NotificationItem[],
): NotificationItem[] {
  const ids = new Set(fresh.map((n) => n.id));
  return [...fresh, ...current.filter((n) => !ids.has(n.id))];
}

/** Số hiển thị trên chuông: tối đa "9+". */
export function badgeText(unread: number): string | null {
  if (unread <= 0) return null;
  return unread > 9 ? "9+" : String(unread);
}
