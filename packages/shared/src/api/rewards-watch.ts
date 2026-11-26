import { z } from "zod";

import { isoDateTimeSchema } from "../schemas";

import { evmAddressSchema } from "./sodex";

// Báo box mới của SoDEX rewards (#558, DEC-398). Người dùng bật "Tell me about new boxes" lúc ký rewards: web gửi JWT
// một lần tới api, api kiểm ví rồi nhờ signer mã hoá (Vault transit `drift-rewards`); scheduler đọc định kỳ bằng client
// chỉ đọc (allowlist GET) và báo box mới. Server không bao giờ claim / open / merge. Sau công tắc `REWARDS_WATCH_ENABLED`
// (mặc định tắt). PR1 chỉ có schema và hằng; route (PR3), job (PR4), web (PR5) làm sau.

/** JWT dạng `header.payload.signature` (base64url), tối đa 4 KB. Không kiểm chữ ký (DeskLabs không có khoá của SoDEX). */
export const REWARDS_JWT_MAX_LENGTH = 4096;
export const rewardsJwtSchema = z
  .string()
  .max(REWARDS_JWT_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/);

/**
 * `POST /api/v1/rewards/watch` (bắt buộc `Idempotency-Key`): bật báo box mới bằng JWT vừa ký trên trình duyệt. `address`
 * phải là master wallet SoDEX của tài khoản. Không bao giờ log hay trả lại `token`.
 */
export const rewardsWatchEnableBodySchema = z
  .object({ token: rewardsJwtSchema, address: evmAddressSchema })
  .strict();
export type RewardsWatchEnableBody = z.infer<typeof rewardsWatchEnableBodySchema>;

export const REWARDS_WATCH_STATUSES = ["off", "active", "paused"] as const;
export type RewardsWatchStatus = (typeof REWARDS_WATCH_STATUSES)[number];

/** Lý do tạm dừng: `exp` đã tới, SoDEX trả 401, hoặc tài khoản đổi sang ví khác. */
export const REWARDS_WATCH_PAUSE_REASONS = ["expired", "unauthorized", "wallet_changed"] as const;
export type RewardsWatchPauseReason = (typeof REWARDS_WATCH_PAUSE_REASONS)[number];

/**
 * `GET /api/v1/rewards/watch`, cũng là response của `POST`. Công tắc trên web lấy trạng thái từ đây (quy tắc 6).
 * `delayed`: các lượt đọc gần đây bị lùi (SoDEX bận / lỗi liên tiếp).
 */
export const rewardsWatchStateSchema = z.object({
  status: z.enum(REWARDS_WATCH_STATUSES),
  reason: z.enum(REWARDS_WATCH_PAUSE_REASONS).nullable(),
  expiresAt: isoDateTimeSchema.nullable(),
  lastCheckedAt: isoDateTimeSchema.nullable(),
  delayed: z.boolean(),
});
export type RewardsWatchState = z.infer<typeof rewardsWatchStateSchema>;

/** Loại thông báo của nhóm `rewards` (DEC-398), cũng nằm trong `NOTIFICATION_TYPES` / `NOTIFICATION_GROUPS.rewards`. */
export const REWARDS_NOTIFICATION_TYPES = [
  "rewards_claimable",
  "rewards_box_received",
  "rewards_draw_won",
  "rewards_watch_paused",
] as const;
export type RewardsNotificationType = (typeof REWARDS_NOTIFICATION_TYPES)[number];

/**
 * Mặc định kênh của nhóm `rewards` (DEC-398, chủ sản phẩm chốt 2026-11-26): in-app bật; Telegram bật (chỉ gửi khi người
 * dùng đã kết nối Telegram); email tắt (cho phép bật).
 */
export const REWARDS_NOTIFICATION_DEFAULTS = {
  in_app: true,
  email: false,
  telegram: true,
} as const;

/** Toast (DEC-398, đổi DEC-170 mục 6): box nhận được và vé trúng; không toast cho box chờ claim. */
export const REWARDS_TOAST_TYPES: readonly RewardsNotificationType[] = [
  "rewards_box_received",
  "rewards_draw_won",
];

// Dữ liệu `notifications.payload` của nhóm `rewards` (scheduler ghi, web / jobs đọc). Không bao giờ có địa chỉ ví,
// token hay txHash: tin chỉ báo có box mới; chi tiết xem trên trang Rewards.

/** Số box theo cấp, đúng chuỗi cấp SoDEX trả (không có thì `level` null). */
export const rewardsLevelCountSchema = z.object({
  level: z.string().nullable(),
  count: z.number().int().positive(),
});

/** `rewards_claimable`: `lottery/treasures.lifetime.granted` tăng `count`. */
export const rewardsClaimableDataSchema = z.object({ count: z.number().int().positive() });
export type RewardsClaimableData = z.infer<typeof rewardsClaimableDataSchema>;

/** `rewards_box_received`: transfer `direction: in` (không phải `lottery_prize`) mới trong ledger, gộp một lượt. */
export const rewardsBoxReceivedDataSchema = z.object({
  count: z.number().int().positive(),
  levels: z.array(rewardsLevelCountSchema),
});
export type RewardsBoxReceivedData = z.infer<typeof rewardsBoxReceivedDataSchema>;

/**
 * `rewards_draw_won`: transfer `reason: lottery_prize` mới, gộp theo `round`. `boxes` đếm từ ledger; `wins` /
 * `tickets` từ `lottery/draw/entries?round=` (null khi không đọc được hoặc round đã báo). Hai số có thể khác nhau.
 */
export const rewardsDrawWonDataSchema = z.object({
  round: z.number().int().nullable(),
  boxes: z.number().int().positive(),
  wins: z.number().int().nonnegative().nullable(),
  tickets: z.number().int().nonnegative().nullable(),
});
export type RewardsDrawWonData = z.infer<typeof rewardsDrawWonDataSchema>;

/** `rewards_watch_paused`: báo đã tạm dừng (một lần mỗi phiên rewards). */
export const rewardsWatchPausedDataSchema = z.object({
  reason: z.enum(REWARDS_WATCH_PAUSE_REASONS),
});
export type RewardsWatchPausedData = z.infer<typeof rewardsWatchPausedDataSchema>;
