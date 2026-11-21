import { markAbandonedIdempotencyKeys, type Db } from "@drift/db";
import { newTraceId } from "@drift/sodex";
import { z } from "zod";

// #319 (DEC-TBD-idempotency-abandoned): dòng `idempotency_keys` đang chạy quá N phút (process api chết giữa handler) chuyển
// sang `failed_unknown` với `error_code = ABANDONED`. Request lặp lại cùng key nhận 409 `reason: "unknown"`, không chạy lại;
// key không bị xoá (quy tắc 1.7). Chạy ở mọi bản jobs: UPDATE có điều kiện nên không cần lease, mỗi dòng chỉ một bản ghi.

/** Mặc định 10 phút: dài hơn nhiều so với mọi handler của api (lâu nhất là gọi reco / signer / SoDEX, vài chục giây). */
export const IDEMPOTENCY_ABANDONED_DEFAULT_MIN = 10;
export const IDEMPOTENCY_ABANDONED_INTERVAL_MS = 60_000;

/** `IDEMPOTENCY_ABANDONED_AFTER_MIN`: số phút nguyên 5–1440 (dưới 5 phút dễ đánh dấu nhầm request còn đang chạy). */
export const idempotencyAbandonedEnvSchema = z.coerce
  .number()
  .int()
  .min(5)
  .max(1440)
  .default(IDEMPOTENCY_ABANDONED_DEFAULT_MIN);

export interface AbandonedLog {
  warn(data: Record<string, unknown>, msg: string): void;
}

/** Một lượt; trả số dòng vừa đánh dấu. Mỗi dòng một log `warn` có `traceId` (không log key hay user đầy đủ). */
export async function markAbandonedIdempotencyKeysOnce(
  deps: { db: Db; now: () => Date; afterMin: number },
  log: AbandonedLog,
): Promise<number> {
  const rows = await markAbandonedIdempotencyKeys(deps.db, deps.now(), deps.afterMin * 60_000);
  for (const row of rows)
    log.warn(
      {
        traceId: newTraceId(),
        idempotencyRowId: row.id,
        userTail: row.userId.slice(-4),
        startedAt: row.createdAt.toISOString(),
        afterMin: deps.afterMin,
      },
      "idempotency key stuck in progress marked failed_unknown (ABANDONED)",
    );
  return rows.length;
}
