import type { RejectSplit } from "@drift/shared";

/**
 * Giải thích số lệnh bị từ chối theo loại (BD-05): post-only sẽ khớp ngay và chặn tự khớp là bình thường; giới hạn rủi
 * ro của DeskLabs chặn (không tới SoDEX) ghi riêng; phần còn lại là lý do khác. Không có lệnh bị từ chối → null (giữ câu
 * phụ cũ).
 */
export function rejectBreakdown(
  t: (key: "postOnly" | "selfTrade" | "riskLimit" | "other", values: { n: number }) => string,
  total: number,
  split: RejectSplit,
): string | null {
  if (total <= 0) return null;
  const other = Math.max(0, total - split.postOnly - split.selfTrade - split.riskLimit);
  const parts: string[] = [];
  if (split.postOnly > 0) parts.push(t("postOnly", { n: split.postOnly }));
  if (split.selfTrade > 0) parts.push(t("selfTrade", { n: split.selfTrade }));
  if (split.riskLimit > 0) parts.push(t("riskLimit", { n: split.riskLimit }));
  if (other > 0) parts.push(t("other", { n: other }));
  return parts.join(" · ");
}
