import { groupOf, ReasonCode, type NotificationGroup, type NotificationType } from "@drift/shared";

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

/**
 * Bot kết thúc đúng kế hoạch, không phải sự cố (DEC-180). Backend vẫn xếp vào `botErrors`
 * nên email/Telegram không đổi; chỉ in-app bỏ chúng khỏi Needs you và toast.
 */
export const PLANNED_STOP_REASONS: readonly ReasonCode[] = [
  ReasonCode.budgetDone,
  ReasonCode.maxCycles,
  ReasonCode.takeProfit,
];

/**
 * Sự cố thật cần người dùng xem (DEC-180): thuộc Bot problems hoặc Risk, không phải bot
 * tiền ảo (`data.paper`, DEC-105), và không phải bot dừng đúng kế hoạch.
 */
export function isIncident(n: Pick<NotificationItem, "type" | "data">): boolean {
  if (!ALERT_GROUPS.includes(groupOf(n.type))) return false;
  if (n.data.paper === true) return false;
  const reason = n.data.reasonCode;
  return !(
    typeof reason === "string" && (PLANNED_STOP_REASONS as readonly string[]).includes(reason)
  );
}

/** Tin thuộc Bot problems / Risk nhưng không phải sự cố: chỉ hiện ở All, với icon trung tính (không đỏ). */
export function isQuiet(n: Pick<NotificationItem, "type" | "data">): boolean {
  return ALERT_GROUPS.includes(groupOf(n.type)) && !isIncident(n);
}

/** "Needs you": sự cố thật chưa đọc. */
export function needsYou(items: readonly NotificationItem[]): NotificationItem[] {
  return items.filter((n) => n.readAt === null && isIncident(n));
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
    case "telegram_connected":
    case "telegram_moved":
    case "telegram_blocked":
      return "/settings?tab=notifications";
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
 * Toast: những sự cố thật chưa đọc, chưa từng thấy trong tab này. Lần tải đầu chỉ ghi nhận
 * (không bật toast cho tin cũ). Trả về danh sách mới (mới nhất trước) và tập id đã thấy cập nhật.
 */
export function newAlerts(
  seen: ReadonlySet<string> | null,
  items: readonly NotificationItem[],
): { fresh: NotificationItem[]; seen: Set<string> } {
  const next = new Set(seen ?? []);
  for (const n of items) next.add(n.id);
  if (seen === null) return { fresh: [], seen: next };
  const fresh = items.filter((n) => !seen.has(n.id) && n.readAt === null && isIncident(n));
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
