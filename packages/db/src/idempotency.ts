import { IDEMPOTENCY_ABANDONED, IDEMPOTENCY_FAILED_UNKNOWN } from "@drift/shared";
import { and, isNull, lt } from "drizzle-orm";

import type { Db } from "./client";
import { idempotencyKeys } from "./schema";

// #319: process api chết giữa handler thì dòng `idempotency_keys` nằm ở "đang chạy" (`status_code` và `outcome` null) tới
// khi hết hạn 24 h, và client chỉ nhận 409 `in_progress`. Dòng đang chạy quá `olderThanMs` được đánh dấu `failed_unknown`
// với `error_code = ABANDONED`: cùng key sau đó nhận 409 `reason: "unknown"` (đọc lại trạng thái rồi dùng key mới), handler
// KHÔNG chạy lại và key KHÔNG bị xoá hay giải phóng (quy tắc 1.7: có thể tác dụng phụ đã xảy ra). Dòng vẫn hết hạn 24 h như
// mọi dòng khác.

export interface AbandonedIdempotencyKey {
  id: string;
  userId: string;
  createdAt: Date;
}

/**
 * Một lượt: đánh dấu mọi dòng đang chạy tạo trước `now − olderThanMs`. UPDATE có điều kiện (vẫn đang chạy), nên chạy lại
 * hoặc hai bản jobs chạy cùng lúc không đổi kết quả và mỗi dòng chỉ được trả về một lần. Dòng đã xong (`status_code` có
 * giá trị) hay đã `failed_unknown` không bị đụng.
 */
export async function markAbandonedIdempotencyKeys(
  db: Db,
  now: Date,
  olderThanMs: number,
): Promise<AbandonedIdempotencyKey[]> {
  return db
    .update(idempotencyKeys)
    .set({ outcome: IDEMPOTENCY_FAILED_UNKNOWN, errorCode: IDEMPOTENCY_ABANDONED, updatedAt: now })
    .where(
      and(
        isNull(idempotencyKeys.statusCode),
        isNull(idempotencyKeys.outcome),
        lt(idempotencyKeys.createdAt, new Date(now.getTime() - olderThanMs)),
      ),
    )
    .returning({
      id: idempotencyKeys.id,
      userId: idempotencyKeys.userId,
      createdAt: idempotencyKeys.createdAt,
    });
}
