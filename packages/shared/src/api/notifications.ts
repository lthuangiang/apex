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
  // Trader đang follow mở mới / đóng hẳn / đảo chiều / bị thanh lý (mức `positions`, DEC-209).
  "leader_position",
  // Bot copy khớp lệnh mở / bỏ qua tín hiệu (DEC-212).
  "copy_bot_opened",
  "copy_bot_skipped",
  // Trạng thái kênh Telegram (nhóm hệ thống `telegram`, DEC-183).
  "telegram_connected",
  "telegram_moved",
  "telegram_blocked",
  // Báo team qua Telegram (docs/NOTIFICATIONS.md mục 13, DEC-184): chỉ role `team`, chỉ kênh Telegram.
  "team_signup",
  "team_sodex_connected",
  "team_bot_started",
  // Theo dõi MCP (DEC-225): chỉ role `team`, chỉ Telegram, tối đa 1 tin / loại / 30 phút.
  "team_mcp_tool_errors",
  "team_mcp_introspect_failing",
  "team_mcp_daily_limit",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_GROUPS = {
  botErrors: ["bot_paused", "bot_stopped", "unknown_order"],
  risk: ["risk_alert"],
  keyFee: ["key_fee"],
  fills: ["fill"],
  daily: ["daily_summary"],
  copyTrading: ["leader_big_move", "leader_position", "copy_bot_opened", "copy_bot_skipped"],
  telegram: ["telegram_connected", "telegram_moved", "telegram_blocked"],
  teamOps: [
    "team_signup",
    "team_sodex_connected",
    "team_bot_started",
    "team_mcp_tool_errors",
    "team_mcp_introspect_failing",
    "team_mcp_daily_limit",
  ],
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
/** Nhóm chỉ cho role `team` (DEC-184): ẩn khỏi Settings của user thường, kiểm tra lại role mỗi lần gửi. */
export const TEAM_ONLY_GROUPS: readonly NotificationGroup[] = ["teamOps"];
/** Nhóm chỉ có kênh Telegram (DEC-184): không có bản in-app hay email ở v1. */
export const TELEGRAM_ONLY_GROUPS: readonly NotificationGroup[] = ["teamOps"];
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
  teamOps: { in_app: false, email: false, telegram: true },
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
      group: z.enum(["botErrors", "risk", "keyFee", "fills", "daily", "copyTrading", "teamOps"]),
      alwaysOn: z.boolean(),
      in_app: z.boolean(),
      email: z.boolean(),
      /** Cài đặt cho kênh Telegram; chỉ có tác dụng khi đã kết nối (DEC-170). */
      telegram: z.boolean(),
    }),
  ),
});
export const notificationSettingsBodySchema = z.object({
  group: z.enum(["botErrors", "risk", "keyFee", "fills", "daily", "copyTrading", "teamOps"]),
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

// ---------- Báo team qua Telegram (docs/NOTIFICATIONS.md mục 13, DEC-184) ----------

/**
 * Sự kiện api / engine ghi vào outbox `jobs.team_ops` trong cùng transaction với thay đổi trạng thái. jobs fan-out cho
 * từng thành viên team. Vốn do engine tính sẵn lúc phát (jobs chỉ hiển thị).
 */
export const teamOpsEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("team_signup"), userId: uuidSchema }),
  z.object({
    type: z.literal("team_sodex_connected"),
    userId: uuidSchema,
    sodexAccountId: uuidSchema,
  }),
  z.object({
    type: z.literal("team_bot_started"),
    botId: uuidSchema,
    /** Vốn theo cấu hình; null = không tính được (bỏ phần vốn khỏi tin, không ghi 0). */
    capital: z.string().nullable(),
    /** "USDC", hoặc coin base với TWAP. */
    capitalAsset: z.string().nullable(),
  }),
  // Theo dõi MCP (DEC-225), scheduler phát. Không bao giờ chứa token id hay client id.
  z.object({
    type: z.literal("team_mcp_tool_errors"),
    calls: z.number().int(),
    errors: z.number().int(),
    /** Phần trăm làm tròn, dạng chuỗi ("25"). */
    pct: z.string(),
    /** Tool lỗi nhiều nhất trong cửa sổ. */
    tool: z.string().nullable(),
  }),
  z.object({ type: z.literal("team_mcp_introspect_failing"), failures: z.number().int() }),
  z.object({
    type: z.literal("team_mcp_daily_limit"),
    /** User chạm giới hạn ngày; jobs đọc email và che lúc fan-out (tối đa 3 email trong tin). */
    userIds: z.array(uuidSchema).min(1).max(50),
  }),
]);
export type TeamOpsEvent = z.infer<typeof teamOpsEventSchema>;

/** Email che (DEC-184): 2 ký tự đầu + `···@` + tên miền, ví dụ `gi···@gmail.com`. */
export function teamMaskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "···";
  return `${email.slice(0, Math.min(2, at))}···@${email.slice(at + 1)}`;
}

/** Ví che (DEC-184): `0x` + 4 ký tự đầu + `…` + 4 ký tự cuối, ví dụ `0x3e9a…11fd`. Không bao giờ địa chỉ đầy đủ. */
export function teamMaskAddress(address: string): string {
  const hex = address.startsWith("0x") ? address.slice(2) : address;
  if (hex.length < 8) return "0x…";
  return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`;
}
