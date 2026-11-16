/**
 * Phân loại lệnh bị SoDEX từ chối.
 *
 * Thiếu margin: SoDEX trả `code -1` kèm câu lỗi "insufficient margin" (thấy trên mainnet 2026-11-15, bot Market
 * Making bị từ chối 21 438 lần trong 15 giờ). Chỉ nhận khi có **cả** mã -1 **và** câu lỗi khớp (không phân biệt
 * hoa thường, khoảng trắng thừa): mã -1 dùng chung cho nhiều lỗi khác ("position not found", "reduce only…").
 * Post-only bị từ chối (mã `PostOnly`, không có câu lỗi) không bao giờ khớp.
 */
export function isInsufficientMarginReject(
  code: string | number,
  message: string | null | undefined,
): boolean {
  if (String(code).trim() !== "-1") return false;
  if (message === null || message === undefined) return false;
  return /\binsufficient\s+margin\b/i.test(message);
}
