import { z } from "zod";

// #594 (DEC-404 mục 2): chu kỳ đọc mỗi user của job cảnh báo SoDEX Wealth (`WEALTH_WATCH_INTERVAL_MIN`, phút). Mặc định
// 10, cấu hình được 5–60. Mỗi lượt một user tốn 20 (fund-details) + 20 (recurring-buys, chỉ khi user có plan) + 20 × plan
// ACTIVE weight trên trần Wealth chung; job chỉ lấy khi trần còn trên 50%, hết thì dời lượt (docs/DEPLOY.md mục 2.25).

export const WEALTH_WATCH_INTERVAL_MIN_MIN = 5;
export const WEALTH_WATCH_INTERVAL_MIN_MAX = 60;
export const WEALTH_WATCH_INTERVAL_MIN_DEFAULT = 10;

const schema = z.coerce
  .number()
  .int()
  .min(WEALTH_WATCH_INTERVAL_MIN_MIN)
  .max(WEALTH_WATCH_INTERVAL_MIN_MAX);

export interface WealthWatchInterval {
  minutes: number;
  /** Biến có đặt nhưng không hợp lệ (người gọi log warn một lần lúc khởi động). Không đặt / trống thì `null`. */
  invalid: { received: string } | null;
}

/** Sai giá trị thì dùng mặc định, không bao giờ làm scheduler dừng (như `REWARDS_WATCH_INTERVAL_MIN`). */
export function parseWealthWatchInterval(raw: string | undefined): WealthWatchInterval {
  if (raw === undefined || raw.trim() === "")
    return { minutes: WEALTH_WATCH_INTERVAL_MIN_DEFAULT, invalid: null };
  const r = schema.safeParse(raw.trim());
  if (r.success) return { minutes: r.data, invalid: null };
  // Không phải secret; cắt ngắn để log không bị phình nếu biến bị đặt nhầm một chuỗi dài.
  return { minutes: WEALTH_WATCH_INTERVAL_MIN_DEFAULT, invalid: { received: raw.slice(0, 32) } };
}
