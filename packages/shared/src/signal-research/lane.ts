import { z } from "zod";

import { NEWS_CYCLE } from "./rules";

// Cấu hình đang chạy của lane tin tức (#394). Chu kỳ chỉnh bằng env của scheduler (`SIGNAL_NEWS_CYCLE_MINUTES`), nên api
// không tự đọc env (có thể lệch giá trị scheduler thật sự dùng): scheduler ghi bản chụp vào Redis `sr:lane` mỗi lần tới
// nhịp, api chỉ đọc. Scheduler ngừng ghi (tắt lane, mất lease) thì key tự hết hạn → api trả null ("Not available").
// Hàm ở đây thuần, không I/O.

export const SR_LANE_KEY = "sr:lane";
/** TTL của key: 3 chu kỳ dài nhất (15 phút). */
export const SR_LANE_TTL_MS = 3 * NEWS_CYCLE.maxMinutes * 60_000;

export const cycleMinutesSchema = z
  .number()
  .int()
  .min(NEWS_CYCLE.minMinutes)
  .max(NEWS_CYCLE.maxMinutes);

export const srLaneSnapshotSchema = z.object({
  /** Chu kỳ (phút) scheduler đang dùng cho `setInterval`. */
  cycleMinutes: cycleMinutesSchema,
  /** Trần request SoSoValue mỗi tháng scheduler đang dùng (`SIGNAL_SOSO_MONTHLY_LIMIT`). */
  sosoMonthlyLimit: z.number().int().positive(),
  updatedAt: z.iso.datetime(),
});
export type SrLaneSnapshot = z.infer<typeof srLaneSnapshotSchema>;

/** Giá trị Redis → bản chụp; thiếu, JSON hỏng hoặc sai dạng → null (không bao giờ đoán chu kỳ). */
export function parseSrLane(raw: string | null | undefined): SrLaneSnapshot | null {
  if (raw == null) return null;
  try {
    const p = srLaneSnapshotSchema.safeParse(JSON.parse(raw));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}
