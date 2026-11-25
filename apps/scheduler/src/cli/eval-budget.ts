import { dec, NEWS_CLASSIFIER, type Decimal } from "@drift/shared";

import type { ClaudeUsage } from "../signal-research/classifier";

// Phần thuần của `classifier-eval` (#530): chi phí theo `NEWS_CLASSIFIER.pricing` và quyết định dừng theo `--max-usd`.
// Tách riêng để test không gọi Claude (file CLI chạy ngay khi import).

type Pricing = typeof NEWS_CLASSIFIER.pricing;

/** Chi phí USD của usage đã cộng dồn, theo bảng giá (ghi / đọc cache tính theo bội số của giá đầu vào). */
export function usageUsd(usage: ClaudeUsage, p: Pricing = NEWS_CLASSIFIER.pricing): Decimal {
  const perM = (n: number, price: string) => dec(String(n)).times(price).div(1_000_000);
  return perM(usage.input, p.inputPerM)
    .plus(perM(usage.cacheWrite, p.inputPerM).times(p.cacheWriteMultiple))
    .plus(perM(usage.cacheRead, p.inputPerM).times(p.cacheReadMultiple))
    .plus(perM(usage.output, p.outputPerM));
}

/**
 * `--max-usd <n>`: thiếu → null (không giới hạn); số dương hữu hạn → giới hạn; giá trị khác (0, âm, chữ) → lỗi, để lệnh
 * dừng trước mọi lời gọi thay vì chạy không có trần.
 */
export function parseMaxUsd(
  raw: string | null,
): { ok: true; value: Decimal | null } | { ok: false } {
  if (raw === null) return { ok: true, value: null };
  if (!/^\d+(\.\d+)?$/.test(raw.trim())) return { ok: false };
  const v = dec(raw.trim());
  return v.gt(0) ? { ok: true, value: v } : { ok: false };
}

/** Kiểm sau mỗi lần gọi: chi phí cộng dồn VƯỢT trần thì dừng, không gọi tiếp. Đúng bằng trần vẫn chạy tiếp. */
export function overBudget(spentUsd: Decimal, maxUsd: Decimal | null): boolean {
  return maxUsd !== null && spentUsd.gt(maxUsd);
}
