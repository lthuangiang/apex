import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

/**
 * Điều kiện SQL "bot dùng được cho mô hình chi phí Market Making" (DEC-228, DEC-396): cấu hình của version đang chạy
 * (`bots.active_version_id`) có `quoteLevel` là số 0. Cùng quy tắc với `isMmModelBotConfig` (@drift/shared) mà fit
 * hằng ngày ở scheduler dùng: so sánh jsonb nên chuỗi "0", thiếu `quoteLevel` (config cũ theo `distanceBp`), mức khác 0
 * hay bot không có version đều không khớp. Lọc trong SQL (không lọc sau) để giới hạn số dòng không cắt mất bot mức 0.
 *
 * `config` là cột / biểu thức `bot_versions.config` của version đang chạy trong truy vấn gọi tới.
 */
export const mmModelBotSql = (config: SQLWrapper): SQL =>
  sql`(${config} -> 'quoteLevel') = '0'::jsonb`;
