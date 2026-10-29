import { z } from "zod";

import { DECIMAL_STRING_PATTERN } from "./money";

// Schema dùng chung cho API (CODING_STANDARDS C7).

/** Tiền, giá, khối lượng truyền dạng chuỗi thập phân, không dùng number. */
export const decimalStringSchema = z
  .string()
  // abort: zod 4 vẫn chạy refine sau khi regex fail; refine gọi dec() sẽ ném RangeError với "" (form trống).
  .regex(DECIMAL_STRING_PATTERN, { message: "Expected a decimal string", abort: true });

/** Thời gian ISO 8601 UTC, ví dụ `2026-10-26T14:02:09Z`. */
export const isoDateTimeSchema = z.iso.datetime({ offset: false });

export const uuidSchema = z.uuid();

/** Header `Idempotency-Key` bắt buộc với mọi POST/PATCH/DELETE thay đổi trạng thái. */
export const idempotencyKeySchema = z.uuid();
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

export const PAGE_LIMIT_DEFAULT = 50;

export const pageQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(PAGE_LIMIT_DEFAULT),
});

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

/** Tên múi giờ IANA mà runtime hỗ trợ, ví dụ `Asia/Ho_Chi_Minh`. */
export const ianaTimeZoneSchema = z.string().refine(
  (tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  { message: "Expected an IANA time zone" },
);
