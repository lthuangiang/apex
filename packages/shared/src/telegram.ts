// Tiện ích thuần cho tin Telegram (docs/NOTIFICATIONS.md mục 5, DEC-170).

/**
 * Escape cho `parse_mode: HTML` của Telegram: chỉ cần `&`, `<`, `>`. Dùng cho mọi chuỗi không do DeskLabs viết
 * (tên bot do người dùng đặt, username…), để chúng không thể thành link, thẻ hay lệnh.
 */
export function escapeTelegramHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
