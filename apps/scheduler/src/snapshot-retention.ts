import type { Db } from "@drift/db";
import { SIGNAL_SNAPSHOT_RETENTION_DAYS } from "@drift/shared";
import { sql, type SQL } from "drizzle-orm";

// Retention snapshot của Signal Analysis (#229): sau `SIGNAL_SNAPSHOT_RETENTION_DAYS` ngày bỏ `payload.signal`
// khỏi event Volume Farm (DEC-311) và đặt `orders.context` của Market Making (DEC-312) về null. Không xoá dòng: lịch sử
// Decisions và lệnh giữ nguyên, chỉ phần snapshot lớn bị bỏ.
// Mỗi lô một transaction ngắn: tìm qua index một phần (`bot_events_signal_idx`, `orders_context_created_idx`, migration
// 0044), `FOR UPDATE SKIP LOCKED` để không chờ dòng engine đang giữ, `lock_timeout` / `statement_timeout` để không bao giờ
// giữ khoá lâu. Index một phần nhỏ dần khi dòng được dọn, nên lượt không có gì để dọn gần như không tốn gì.

const DAY_MS = 86_400_000;
/** Số dòng mỗi lô (mỗi transaction). */
export const SNAPSHOT_RETENTION_BATCH = 2_000;
/** Số lô tối đa mỗi bảng mỗi lượt (lượt 10 phút): tối đa 100 000 dòng / bảng / lượt, phần còn lại để lượt sau. */
export const SNAPSHOT_RETENTION_MAX_BATCHES = 50;
const LOCK_TIMEOUT_MS = 2_000;
const STATEMENT_TIMEOUT_MS = 15_000;

export interface SnapshotRetentionOptions {
  batch?: number;
  maxBatches?: number;
}

export interface SnapshotRetentionResult {
  /** Event đã bỏ `payload.signal`. */
  signals: number;
  /** Lệnh đã đặt `context` về null. */
  contexts: number;
}

/** Mốc cắt: dữ liệu đặt / xảy ra trước mốc này thì bỏ snapshot. */
export function snapshotCutoff(now: number): Date {
  return new Date(now - SIGNAL_SNAPSHOT_RETENTION_DAYS * DAY_MS);
}

async function runBatch(db: Db, statement: SQL): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${String(LOCK_TIMEOUT_MS)}`));
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${String(STATEMENT_TIMEOUT_MS)}`));
    const res = await tx.execute(statement);
    return res.rowCount ?? 0;
  });
}

async function drain(db: Db, statement: SQL, batch: number, maxBatches: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i += 1) {
    const n = await runBatch(db, statement);
    total += n;
    if (n < batch) break;
  }
  return total;
}

/** Bỏ snapshot quá hạn, theo lô. Lỗi (kể cả hết `lock_timeout`) ném ra cho lượt sau thử lại; phần đã dọn vẫn giữ. */
export async function stripOldSnapshots(
  db: Db,
  now: number,
  options: SnapshotRetentionOptions = {},
): Promise<SnapshotRetentionResult> {
  const batch = options.batch ?? SNAPSHOT_RETENTION_BATCH;
  const maxBatches = options.maxBatches ?? SNAPSHOT_RETENTION_MAX_BATCHES;
  const cutoff = snapshotCutoff(now).toISOString();
  // Điều kiện phải khớp đúng điều kiện của index một phần thì planner mới dùng index.
  const signals = await drain(
    db,
    sql`WITH picked AS (
          SELECT id FROM bot_events
          WHERE payload ? 'signal' AND occurred_at < ${cutoff}::timestamptz
          ORDER BY occurred_at
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE bot_events e SET payload = e.payload - 'signal'
        FROM picked WHERE e.id = picked.id`,
    batch,
    maxBatches,
  );
  const contexts = await drain(
    db,
    sql`WITH picked AS (
          SELECT id FROM orders
          WHERE context IS NOT NULL AND created_at < ${cutoff}::timestamptz
          ORDER BY created_at
          LIMIT ${batch}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE orders o SET context = NULL
        FROM picked WHERE o.id = picked.id`,
    batch,
    maxBatches,
  );
  return { signals, contexts };
}
