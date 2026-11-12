import { z } from "zod";

import { isoDateTimeSchema, uuidSchema } from "../schemas";

// Thông báo (SCREENS.md mục 8.5 › Notifications, DEC-41). Nhóm "bot errors" luôn bật (không tắt được).

export const NOTIFICATION_TYPES = [
  "bot_paused",
  "bot_stopped",
  "unknown_order",
  "risk_alert",
  "key_fee",
  "fill",
  "daily_summary",
  "leader_big_move",
  // Trạng thái kênh Telegram (DEC-183); `telegram_blocked` thêm ở N3.
  "telegram_connected",
  "telegram_moved",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_GROUPS = {
  botErrors: ["bot_paused", "bot_stopped", "unknown_order"],
  risk: ["risk_alert"],
  keyFee: ["key_fee"],
  fills: ["fill"],
  daily: ["daily_summary"],
  copyTrading: ["leader_big_move"],
  telegram: ["telegram_connected", "telegram_moved"],
} as const satisfies Record<string, readonly NotificationType[]>;
export type NotificationGroup = keyof typeof NOTIFICATION_GROUPS;
/**
 * Nhóm hệ thống (DEC-183): luôn bật, chỉ in-app (không email, không Telegram), ẩn khỏi
 * bảng Settings. Worker gửi Telegram (N3) phải bỏ qua các nhóm này.
 */
export const SYSTEM_GROUPS: readonly NotificationGroup[] = ["telegram"];
export const ALWAYS_ON_GROUPS: readonly NotificationGroup[] = ["botErrors", "telegram"];
/**
 * Nhóm không gửi email (DEC-163 mục 11). Telegram thì được với `copyTrading`, mặc định tắt, người dùng tự bật
 * (DEC-170 thay DEC-163 mục 11 cho Telegram).
 */
export const IN_APP_ONLY_GROUPS: readonly NotificationGroup[] = ["copyTrading", "telegram"];
export const NOTIFICATION_CHANNELS = ["in_app", "email", "telegram"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * Mặc định khi người dùng chưa chỉnh (docs/NOTIFICATIONS.md mục 4). Telegram chỉ gửi khi đã kết nối;
 * `daily` (Morning brief) bật sẵn trên Telegram (DEC-170).
 */
export const NOTIFICATION_DEFAULTS: Record<
  NotificationGroup,
  Record<NotificationChannel, boolean>
> = {
  botErrors: { in_app: true, email: true, telegram: true },
  risk: { in_app: true, email: true, telegram: true },
  keyFee: { in_app: true, email: true, telegram: true },
  fills: { in_app: false, email: false, telegram: false },
  daily: { in_app: false, email: false, telegram: true },
  copyTrading: { in_app: true, email: false, telegram: false },
  telegram: { in_app: true, email: false, telegram: false },
};

export function groupOf(type: NotificationType): NotificationGroup {
  return (
    (Object.keys(NOTIFICATION_GROUPS) as NotificationGroup[]).find((g) =>
      (NOTIFICATION_GROUPS[g] as readonly string[]).includes(type),
    ) ?? "botErrors"
  );
}

export const notificationViewSchema = z.object({
  id: uuidSchema,
  type: z.enum(NOTIFICATION_TYPES),
  data: z.record(z.string(), z.unknown()),
  createdAt: isoDateTimeSchema,
  readAt: isoDateTimeSchema.nullable(),
});
export const notificationListSchema = z.object({
  items: z.array(notificationViewSchema),
  unread: z.number().int(),
});

export const notificationSettingsSchema = z.object({
  groups: z.array(
    z.object({
      group: z.enum(["botErrors", "risk", "keyFee", "fills", "daily", "copyTrading"]),
      alwaysOn: z.boolean(),
      in_app: z.boolean(),
      email: z.boolean(),
      /** Cài đặt cho kênh Telegram; chỉ có tác dụng khi đã kết nối (DEC-170). */
      telegram: z.boolean(),
    }),
  ),
});
export const notificationSettingsBodySchema = z.object({
  group: z.enum(["botErrors", "risk", "keyFee", "fills", "daily", "copyTrading"]),
  channel: z.enum(NOTIFICATION_CHANNELS),
  enabled: z.boolean(),
});

// ---------- Telegram (docs/NOTIFICATIONS.md mục 3 và 9, DEC-170) ----------

/** Token kết nối: 32 byte base64url = 43 ký tự `[A-Za-z0-9_-]` (giới hạn tham số `start`: ≤ 64). */
export const TELEGRAM_LINK_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const TELEGRAM_LINK_TTL_MS = 10 * 60 * 1000;

export const telegramLinkCreatedSchema = z.object({
  /** `https://t.me/<bot>?start=<token>`; token chỉ có trong response này, server chỉ lưu hash. */
  deepLink: z.url(),
  expiresAt: isoDateTimeSchema,
});
export type TelegramLinkCreated = z.infer<typeof telegramLinkCreatedSchema>;

export const TELEGRAM_LINK_STATUSES = ["not_connected", "pending", "active", "blocked"] as const;
export const telegramLinkStatusSchema = z.object({
  status: z.enum(TELEGRAM_LINK_STATUSES),
  /** `@username` trên Telegram; null khi người dùng không đặt username. */
  username: z.string().nullable().optional(),
  connectedAt: isoDateTimeSchema.optional(),
  /** Khi `pending`: token còn hiệu lực tới lúc này. */
  expiresAt: isoDateTimeSchema.optional(),
  /** Khi `blocked`: lúc Telegram báo người dùng đã chặn bot. */
  blockedAt: isoDateTimeSchema.optional(),
});
export type TelegramLinkStatus = z.infer<typeof telegramLinkStatusSchema>;
