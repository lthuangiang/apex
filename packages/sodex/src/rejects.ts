/**
 * Phân loại lệnh bị SoDEX từ chối.
 *
 * Thiếu margin: SoDEX trả `code -1` kèm câu lỗi "insufficient margin" (thấy trên mainnet 2026-11-15, bot Market
 * Making bị từ chối 21 438 lần trong 15 giờ). Chỉ nhận khi có **cả** mã -1 **và** câu lỗi khớp (không phân biệt
 * hoa thường, khoảng trắng thừa): mã -1 dùng chung cho nhiều lỗi khác ("position not found", "reduce only…").
 * Post-only bị từ chối (mã `PostOnly`, không có câu lỗi) không bao giờ khớp.
 */
/**
 * #497: SoDEX từ chối lệnh reduce-only vì account KHÔNG có vị thế ở market đó ("position not found: 2", mã -1 dùng chung).
 * Đây là bằng chứng sổ cái của bot sai (bot tưởng có vị thế để đóng): engine đọc lại vị thế ngay, chiến lược không bao giờ
 * chuyển sang lệnh đóng không reduce-only vì lý do này (lệnh đó sẽ MỞ vị thế thật).
 */
export function isPositionNotFoundReject(message: string | null | undefined): boolean {
  if (message === null || message === undefined) return false;
  return /\bposition\s+not\s+found\b/i.test(message);
}

export function isInsufficientMarginReject(
  code: string | number,
  message: string | null | undefined,
): boolean {
  if (String(code).trim() !== "-1") return false;
  if (message === null || message === undefined) return false;
  return /\binsufficient\s+margin\b/i.test(message);
}
