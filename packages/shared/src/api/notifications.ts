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
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_GROUPS = {
  botErrors: ["bot_paused", "bot_stopped", "unknown_order"],
  risk: ["risk_alert"],
  keyFee: ["key_fee"],
  fills: ["fill"],
  daily: ["daily_summary"],
} as const satisfies Record<string, readonly NotificationType[]>;
export type NotificationGroup = keyof typeof NOTIFICATION_GROUPS;
export const ALWAYS_ON_GROUPS: readonly NotificationGroup[] = ["botErrors"];
export const NOTIFICATION_CHANNELS = ["in_app", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Mặc định khi người dùng chưa chỉnh. */
export const NOTIFICATION_DEFAULTS: Record<
  NotificationGroup,
  Record<NotificationChannel, boolean>
> = {
  botErrors: { in_app: true, email: true },
  risk: { in_app: true, email: true },
  keyFee: { in_app: true, email: true },
  fills: { in_app: false, email: false },
  daily: { in_app: false, email: false },
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
      group: z.enum(["botErrors", "risk", "keyFee", "fills", "daily"]),
      alwaysOn: z.boolean(),
      in_app: z.boolean(),
      email: z.boolean(),
    }),
  ),
});
export const notificationSettingsBodySchema = z.object({
  group: z.enum(["botErrors", "risk", "keyFee", "fills", "daily"]),
  channel: z.enum(NOTIFICATION_CHANNELS),
  enabled: z.boolean(),
});
