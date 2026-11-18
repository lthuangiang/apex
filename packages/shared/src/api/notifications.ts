import { z } from "zod";

import { feeRateToPercent, formatVolumeUsd } from "../fees";
import { decimalStringSchema, isoDateTimeSchema, uuidSchema } from "../schemas";

// Thông báo (SCREENS.md mục 8.5 › Notifications, DEC-41). Nhóm "bot errors" luôn bật (không tắt được).

export const NOTIFICATION_TYPES = [
  "bot_paused",
  "bot_stopped",
  "unknown_order",
  "risk_alert",
  "key_fee",
  // Builder fee theo bậc volume đổi (DEC-258, DEC-261): scheduler phát, tối đa 1 tin / user × chiến lược / ngày.
  "fee_tier_changed",
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
  // Bất biến tiền thật trên prod (DEC-274): scheduler phát, chỉ role `team`, chỉ Telegram.
  "team_invariant",
  // Sự cố tiền thật và sức khoẻ engine (#241, DEC-313): chỉ role `team`, chỉ Telegram, có mức độ
  // và chặn lặp theo loại; mỗi ngày một tin tổng hợp.
  "team_incident",
  "team_incident_digest",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_GROUPS = {
  botErrors: ["bot_paused", "bot_stopped", "unknown_order"],
  risk: ["risk_alert"],
  keyFee: ["key_fee", "fee_tier_changed"],
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
    "team_invariant",
    "team_incident",
    "team_incident_digest",
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

/**
 * `data` của `fee_tier_changed` (DEC-261). Mức là phần mười bp. `volume`: volume tiền thật 30 ngày (USD,
 * chuỗi thập phân chưa làm tròn) lúc tính; null = không có số (tin chỉ ghi mức mới / cũ). `droppedBelow`: khi mức tăng
 * lại, ngưỡng của bậc user vừa rơi khỏi (USD); null khi mức giảm hoặc không xác định được.
 */
export const feeTierChangedDataSchema = z.object({
  strategy: z.string(),
  rate: z.number().int().nonnegative(),
  previousRate: z.number().int().nonnegative(),
  volume: decimalStringSchema.nullable(),
  droppedBelow: decimalStringSchema.nullable(),
});
export type FeeTierChangedData = z.infer<typeof feeTierChangedDataSchema>;

/**
 * Chọn câu cho `fee_tier_changed` (email, Telegram, in-app dùng chung; câu chữ nằm ở file i18n của từng app). Mức dạng
 * phần trăm ("0.002%"); volume / ngưỡng là số đô làm tròn xuống ("199,999"), app tự ghép đơn vị. Thiếu volume, hoặc mức
 * tăng mà không biết ngưỡng → chỉ câu mức mới / cũ (quy tắc 1.8). Payload sai dạng → null.
 */
export function feeTierChangeText(data: unknown): {
  title: "lowered" | "back";
  body: "lowered" | "raised" | "rates";
  vars: { rate: string; previous: string; volume: string | null; min: string | null };
} | null {
  const p = feeTierChangedDataSchema.safeParse(data);
  if (!p.success) return null;
  const { rate, previousRate, volume, droppedBelow } = p.data;
  const lowered = rate < previousRate;
  const pct = (r: number) => `${feeRateToPercent(r).toString()}%`;
  const vars = {
    rate: pct(rate),
    previous: pct(previousRate),
    volume: volume === null ? null : formatVolumeUsd(volume),
    min: droppedBelow === null ? null : formatVolumeUsd(droppedBelow),
  };
  const body =
    vars.volume === null ? "rates" : lowered ? "lowered" : vars.min === null ? "rates" : "raised";
  return { title: lowered ? "lowered" : "back", body, vars };
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

// ---------- Sự cố tiền thật cho team (#241, DEC-313) ----------

/**
 * Loại sự cố. `critical` = tiền thật đang có rủi ro (engine phát theo bot); `info` = hết sự cố (vị thế khớp lại);
 * `warning` = sức khoẻ engine / SoDEX (scheduler phát).
 */
export const TEAM_INCIDENT_SEVERITY = {
  position_mismatch: "critical",
  close_failed: "critical",
  unknown_gave_up: "critical",
  late_fill: "critical",
  paused_errors: "critical",
  /** Volume Farm nhận fill muộn của lệnh nó đã thôi theo dõi vào vị thế (#239, DEC-317). */
  late_fill_adopted: "critical",
  /** Lệnh chỉ giảm (stop / thoát / đóng) khớp quá vị thế bot theo dõi: đã đóng một vị thế bot không theo dõi (#239 05:31). */
  closing_fill_beyond: "critical",
  /** Bot chờ SoDEX xác nhận huỷ quá 10 phút: lệnh có thể còn nằm trên sổ. */
  cancel_unconfirmed: "critical",
  position_matched: "info",
  /** Engine sửa sổ cái Volume Farm từ fill bị bỏ qua của chính lệnh bot (chi tiết: clOrdID, khối lượng). */
  ledger_repaired: "info",
  /** Quét lệnh mồ côi của Volume Farm đã huỷ một lệnh bot không còn theo dõi (lần huỷ trước bị mất). */
  orphan_cancelled: "warning",
  /** Volume Farm không đọc được vị thế để kiểm tra sổ cái quá 5 phút nên không giao dịch (DEC-317 sửa đổi, #253). */
  repair_waiting: "warning",
  shard_lost: "warning",
  tick_slow: "warning",
  reads_skipped: "warning",
  ws_closes: "warning",
  sodex_errors: "warning",
} as const satisfies Record<string, "critical" | "warning" | "info">;
export type TeamIncidentKind = keyof typeof TEAM_INCIDENT_SEVERITY;
export type TeamIncidentSeverity = (typeof TEAM_INCIDENT_SEVERITY)[TeamIncidentKind];
export const TEAM_INCIDENT_KINDS = Object.keys(TEAM_INCIDENT_SEVERITY) as [
  TeamIncidentKind,
  ...TeamIncidentKind[],
];
export const TEAM_INCIDENT_DETAIL_MAX = 200;

/** Ngưỡng và chặn lặp (#241). Thời gian tính bằng ms. */
export const TEAM_INCIDENT_RULES = {
  /** critical: tối đa 1 tin / (loại, bot, market) / 10 phút (trừ lệch vị thế / khớp lại: không chặn lặp). */
  botThrottleMs: 10 * 60_000,
  /** warning: tối đa 1 tin / loại / 30 phút (như DEC-225). */
  typeThrottleMs: 30 * 60_000,
  /** Shard bị mất: ≥ 1 lần trong 5 phút. */
  shardLostWindowMs: 5 * 60_000,
  shardLostMin: 1,
  /** Vòng engine chậm (`tick slow`): ≥ 3 lần trong 10 phút. */
  tickSlowWindowMs: 10 * 60_000,
  tickSlowMin: 3,
  /** Đọc nền bị phần dự trữ chặn (DEC-310): một phút bất kỳ trong 5 phút qua ≥ 100 lời gọi. */
  readsSkippedWindowMs: 5 * 60_000,
  readsSkippedPerMinute: 100,
  /** WS user stream đóng: > 10 lần / giờ ở một account. */
  wsClosesWindowMs: 60 * 60_000,
  wsClosesPerHour: 10,
  /** SoDEX lỗi / timeout: trong 10 phút ≥ 100 lời gọi REST và ≥ 10% timeout / network / unreadable / HTTP 5xx. */
  sodexWindowMs: 10 * 60_000,
  sodexMinCalls: 100,
  sodexMinPct: 10,
  /** Bộ đếm cho tin tổng hợp: theo giờ, giữ 3 ngày; tin gửi mỗi ngày từ 01:00 UTC (08:00 giờ Việt Nam). */
  countTtlMs: 3 * 24 * 60 * 60_000,
  digestHourUtc: 1,
  digestClaimMs: 36 * 60 * 60_000,
} as const;

/**
 * Loại không bao giờ bị chặn lặp: lệch vị thế / khớp lại. Engine chỉ phát mỗi lần chuyển trạng thái một lần, và một lần
 * "matched" bị ẩn sau "mismatch" (hay ngược lại) sẽ làm team hiểu sai trạng thái hiện tại.
 */
export const TEAM_INCIDENT_UNTHROTTLED: readonly TeamIncidentKind[] = [
  "position_mismatch",
  "position_matched",
];

/** Khoá chặn lặp (SET NX PX) của một sự cố; null = không chặn lặp. */
export function teamIncidentThrottle(e: {
  kind: TeamIncidentKind;
  botId?: string | undefined;
  market?: string | undefined;
}): { key: string; ms: number } | null {
  if (TEAM_INCIDENT_UNTHROTTLED.includes(e.kind)) return null;
  return TEAM_INCIDENT_SEVERITY[e.kind] === "warning"
    ? { key: `team:incident:${e.kind}`, ms: TEAM_INCIDENT_RULES.typeThrottleMs }
    : {
        key: `team:incident:${e.kind}:${e.botId ?? "-"}:${e.market ?? "-"}`,
        ms: TEAM_INCIDENT_RULES.botThrottleMs,
      };
}

/** Bộ đếm theo giờ của tin tổng hợp (jobs tăng, scheduler đọc). `hour` = floor(ms / 3 600 000). */
export const teamIncidentCountKey = (hour: number, kind: TeamIncidentKind) =>
  `team:incident_count:${String(hour)}:${kind}`;

/** Bộ đếm theo phút của tín hiệu sức khoẻ engine (engine tăng, không chờ; scheduler đọc). */
export const ENGINE_HEALTH_SIGNALS = ["shard_lost", "tick_slow", "reads_skipped"] as const;
export type EngineHealthSignal = (typeof ENGINE_HEALTH_SIGNALS)[number];
export const engineHealthKey = (signal: EngineHealthSignal, minute: number) =>
  `team:engine_health:${signal}:${String(minute)}`;
/** Giữ bộ đếm sức khoẻ engine 2 giờ. */
export const ENGINE_HEALTH_TTL_MS = 2 * 60 * 60_000;

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
    type: z.literal("team_invariant"),
    invariant: z.enum(["P1", "P2", "P3", "P4", "P5", "P7"]),
    /** `failing`: sai ở 2 lần kiểm tra liền nhau; `resolved`: đúng trở lại. */
    status: z.enum(["failing", "resolved"]),
    botId: uuidSchema,
    /** Số liệu ngắn đã format, tiếng Anh (không ví, không key); rỗng với `resolved`. */
    detail: z.string().max(200),
  }),
  // Sự cố tiền thật / sức khoẻ engine (#241). Engine ghi các loại theo bot trong CÙNG transaction với sự kiện; scheduler
  // ghi các loại sức khoẻ. Không bao giờ email, ví đầy đủ, key; account chỉ ở dạng đã che.
  z.object({
    type: z.literal("team_incident"),
    kind: z.enum(TEAM_INCIDENT_KINDS),
    /** Bot của sự cố (loại theo bot); không có với loại sức khoẻ engine. */
    botId: uuidSchema.optional(),
    market: z.string().max(40).optional(),
    /** Số liệu ngắn đã format, tiếng Anh (không email / ví đầy đủ / key). */
    detail: z.string().max(TEAM_INCIDENT_DETAIL_MAX),
  }),
  z.object({
    type: z.literal("team_incident_digest"),
    /** Số sự cố trong 24 giờ qua theo loại (kể cả lần bị chặn lặp); loại không có thì không có khoá. */
    counts: z.record(z.string(), z.number().int().nonnegative()),
  }),
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
