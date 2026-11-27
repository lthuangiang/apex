import { z } from "zod";

// #558: chu kỳ đọc mỗi user của job báo box mới (`REWARDS_WATCH_INTERVAL_MIN`, phút). Biên dưới 1 phút (trước là 5):
// với ~6 weight mỗi lượt và trần riêng `REWARDS_WATCH_MAX_WEIGHT_PER_MIN` (mặc định 120), số user đọc kịp ≈ 20 × số
// phút chu kỳ; vượt thì lượt đọc lùi dần (ngân sách weight), không lỗi (docs/DEPLOY.md mục 2.23).

export const REWARDS_WATCH_INTERVAL_MIN_MIN = 1;
export const REWARDS_WATCH_INTERVAL_MIN_MAX = 60;
export const REWARDS_WATCH_INTERVAL_MIN_DEFAULT = 15;

const schema = z.coerce
  .number()
  .int()
  .min(REWARDS_WATCH_INTERVAL_MIN_MIN)
  .max(REWARDS_WATCH_INTERVAL_MIN_MAX);

export interface RewardsWatchInterval {
  minutes: number;
  /** Biến có đặt nhưng không hợp lệ (người gọi log warn một lần lúc khởi động). Không đặt / trống thì `null`. */
  invalid: { received: string } | null;
}

/** Sai giá trị thì dùng mặc định, không bao giờ làm scheduler dừng (như các biến SIGNAL_*, DEC-322). */
export function parseRewardsWatchInterval(raw: string | undefined): RewardsWatchInterval {
  if (raw === undefined || raw.trim() === "")
    return { minutes: REWARDS_WATCH_INTERVAL_MIN_DEFAULT, invalid: null };
  const r = schema.safeParse(raw.trim());
  if (r.success) return { minutes: r.data, invalid: null };
  // Không phải secret; cắt ngắn để log không bị phình nếu biến bị đặt nhầm một chuỗi dài.
  return { minutes: REWARDS_WATCH_INTERVAL_MIN_DEFAULT, invalid: { received: raw.slice(0, 32) } };
}
