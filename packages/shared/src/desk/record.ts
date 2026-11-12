import { dec } from "../money";

import { WHATIF_CONFIG, type ConfigPatch } from "./whatif";

// AI Desk B+ M4 (DEC-166): thành tích đề xuất. 7 ngày sau Apply so kết quả sau khi sửa với cấu hình cũ trên cùng các
// ngày; hiện cả lần làm xấu đi. Hàm thuần: worker tính hai con số, hàm ở đây gắn nhãn.

export const RECORD_CONFIG = {
  /** Đo sau chừng này kể từ lúc version AI được áp (DEC-166: "7 ngày sau mỗi Apply"). */
  measureMs: 7 * 86_400_000,
  /** Dòng còn `queued` quá mức này (tin đo bị mất) → trả về `measuring` để scheduler xếp lại. */
  staleQueuedMs: 60 * 60_000,
} as const;

export type RecordVerdict = "helped" | "made_worse" | "no_clear_effect";

/** Nhãn: chênh < 0.50 USDC → No clear effect (DEC-166); sau khi sửa tốt hơn → Helped; còn lại → Made it worse. */
export function verdictOf(after: string, old: string): RecordVerdict {
  const diff = dec(after).sub(dec(old));
  if (diff.abs().lt(WHATIF_CONFIG.noClearEffectUsd)) return "no_clear_effect";
  return diff.gt(0) ? "helped" : "made_worse";
}

/** Tới hạn đo chưa (đủ 7 ngày kể từ lúc áp). */
export function recordDue(appliedAt: number, now: number): boolean {
  return now - appliedAt >= RECORD_CONFIG.measureMs;
}

export interface ConfigChange {
  key: string;
  from: string | null;
  to: string | null;
}

/** Field đã đổi khi Apply (để ghi "leverage 40× → 10×"): giá trị cũ từ cấu hình trước, giá trị mới từ patch. */
export function changesOf(
  baseline: Readonly<Record<string, unknown>>,
  patch: ConfigPatch,
): ConfigChange[] {
  const str = (v: unknown): string | null =>
    typeof v === "string" || typeof v === "number" ? String(v) : null;
  return Object.entries(patch)
    .map(([key, to]) => ({ key, from: str(baseline[key]), to: str(to) }))
    .filter((c) => c.from !== c.to);
}
