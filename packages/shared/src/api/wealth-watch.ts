import { z } from "zod";

import { isoDateTimeSchema } from "../schemas";

// Cảnh báo SoDEX Wealth qua chuông và Telegram (#594, DEC-402 mục 7, DEC-404). Người dùng bật công tắc "Alerts" ở
// Portfolio › My Wealth; scheduler đọc dữ liệu Wealth CÔNG KHAI theo master wallet (không token, không chữ ký) và báo khi
// một yêu cầu nạp / subscribe / redeem / mua định kỳ chuyển sang trạng thái kết thúc, hoặc một kỳ mua định kỳ bị bỏ qua /
// lỗi. Sau công tắc hệ thống `WEALTH_WATCH_ENABLED` (mặc định tắt; role team vẫn dùng được để thử). Server chỉ lưu khoá
// chống trùng (đã băm) + trạng thái đã báo, không lưu vị thế hay số tiền.

/** `GET /api/v1/wealth/watch`, cũng là response của `POST`. Công tắc trên web lấy trạng thái từ đây (quy tắc 6). */
export const WEALTH_WATCH_STATUSES = ["off", "active"] as const;
export const wealthWatchStateSchema = z.object({
  status: z.enum(WEALTH_WATCH_STATUSES),
  lastCheckedAt: isoDateTimeSchema.nullable(),
  /** Các lượt đọc gần đây bị lùi (SoDEX lỗi liên tiếp). */
  delayed: z.boolean(),
});
export type WealthWatchState = z.infer<typeof wealthWatchStateSchema>;

/** Loại thông báo của nhóm `wealth` (cũng nằm trong `NOTIFICATION_TYPES` / `NOTIFICATION_GROUPS.wealth`). */
export const WEALTH_NOTIFICATION_TYPES = [
  "wealth_request_settled",
  "wealth_recurring_issue",
] as const;
export type WealthNotificationType = (typeof WEALTH_NOTIFICATION_TYPES)[number];

// ---------- Phân loại theo tài liệu SoDEX (docs.sodex.com › Wealth API › User Fund History / Recurring Buy Plans) ----------

/** Trạng thái kết thúc của một dòng fund-details (tài liệu: `processing`, `completed`, `cancelled`, `failed`, `rejected`). */
export const WEALTH_FUND_FINAL_STATUSES = ["completed", "failed", "rejected", "cancelled"] as const;
export type WealthFundFinalStatus = (typeof WEALTH_FUND_FINAL_STATUSES)[number];
/** Trạng thái đã biết nhưng chưa kết thúc: không báo, không log. */
export const WEALTH_FUND_OPEN_STATUSES = ["processing"] as const;

/** Loại yêu cầu được báo. Khoá theo `transactionType` trước (có `recurring_buy`), không có thì theo `kind`. */
export const WEALTH_ALERT_WHAT = ["invest", "redeem", "recurring_buy"] as const;
export type WealthAlertWhat = (typeof WEALTH_ALERT_WHAT)[number];
export const WEALTH_KIND_TO_WHAT: Readonly<Record<string, WealthAlertWhat>> = {
  recurring_buy: "recurring_buy",
  subscribe: "invest",
  deposit: "invest",
  redeem: "redeem",
};
/** Loại đã biết theo tài liệu nhưng không báo (airdrop, thanh lý, chuyển share). */
export const WEALTH_KINDS_IGNORED = [
  "airdrop",
  "liquidation",
  "transfer_in",
  "transfer_out",
] as const;

/**
 * Trạng thái kỳ mua định kỳ được báo. **[confirm]** Tài liệu SoDEX không liệt kê giá trị `status` của executions (chỉ ghi
 * "Execution status"); chưa thấy trên dữ liệu thật. So khớp không phân biệt hoa thường. Giá trị khác: không báo, chỉ log
 * (DEC-404 mục 3b). Sửa danh sách sau khi chủ sản phẩm kiểm bằng ví thật (`WEALTH_WATCH_ENABLED` vẫn tắt tới lúc đó).
 */
export const WEALTH_EXECUTION_ALERT_STATUSES = ["skipped", "failed"] as const;
export type WealthExecutionAlertStatus = (typeof WEALTH_EXECUTION_ALERT_STATUSES)[number];
/** Trạng thái kỳ mua không cần báo (đã chạy / đang chờ). Cũng **[confirm]**; chỉ ảnh hưởng việc có log hay không. */
export const WEALTH_EXECUTION_QUIET_STATUSES = [
  "completed",
  "success",
  "succeeded",
  "executed",
  "processing",
  "pending",
  "scheduled",
] as const;
/**
 * `reasonCode` đã biết của kỳ mua → khoá câu chữ. **[confirm]** Tài liệu không liệt kê; danh sách RỖNG cho tới khi thấy
 * giá trị thật. Kỳ mua có `reasonCode` không nằm ở đây: không báo, chỉ log (DEC-404 mục 3b). Không có `reasonCode` thì
 * vẫn báo (không kèm lý do).
 */
export const WEALTH_EXECUTION_REASONS: Readonly<Record<string, string>> = {};

// ---------- Dữ liệu `notifications.payload` (scheduler ghi, web / jobs đọc) ----------
// Không bao giờ có địa chỉ ví hay txHash. Số giữ dạng chuỗi đúng như SoDEX trả (không cộng trừ, không làm tròn).

const amount = z.string().nullable();

/** `wealth_request_settled`: một yêu cầu Wealth chuyển sang trạng thái kết thúc. */
export const wealthRequestSettledDataSchema = z.object({
  fundId: z.string(),
  /** Tên quỹ từ `GET /funds`; null khi không đọc được (hiện `fundId`). */
  fundName: z.string().nullable(),
  what: z.enum(WEALTH_ALERT_WHAT),
  status: z.enum(WEALTH_FUND_FINAL_STATUSES),
  /** Tiền đã trả (`cost`, tài sản của quỹ, USD). */
  cost: amount,
  /** Tiền nhận về từ redeem (`proceeds`). */
  proceeds: amount,
  /** Share nhận (nạp) hoặc share đã gửi (redeem): `shares`, thiếu thì `requestedShares`. */
  shares: amount,
});
export type WealthRequestSettledData = z.infer<typeof wealthRequestSettledDataSchema>;

/** `wealth_recurring_issue`: một kỳ mua định kỳ bị bỏ qua / lỗi. */
export const wealthRecurringIssueDataSchema = z.object({
  fundId: z.string().nullable(),
  fundName: z.string().nullable(),
  status: z.enum(WEALTH_EXECUTION_ALERT_STATUSES),
  /** `reasonCode` đã biết (nằm trong `WEALTH_EXECUTION_REASONS`), không thì null. */
  reasonCode: z.string().nullable(),
  /** `scheduledLocalDate` của SoDEX (ngày lịch theo giờ của quỹ). */
  scheduledDate: z.string(),
  amount,
});
export type WealthRecurringIssueData = z.infer<typeof wealthRecurringIssueDataSchema>;

/**
 * Số tiền / share đúng như SoDEX trả, chỉ trình bày: thêm dấu phẩy hàng nghìn, bỏ số 0 thừa ở phần lẻ nhưng giữ tối thiểu
 * 2 chữ số lẻ. Không làm tròn ("1.234567" giữ nguyên). Chuỗi không phải số thập phân → null (không hiện).
 */
export function formatWealthAmount(raw: string | null): string | null {
  if (raw === null) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw.trim());
  if (m === null) return null;
  const [, sign = "", int = "0", frac = ""] = m;
  const intPart = int.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = frac.replace(/0+$/, "");
  return `${sign}${intPart}.${trimmed.padEnd(2, "0")}`;
}
