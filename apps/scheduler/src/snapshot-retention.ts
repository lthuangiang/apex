import type { Db } from "@drift/db";
import { SIGNAL_SNAPSHOT_RETENTION_DAYS } from "@drift/shared";
import { sql, type SQL } from "drizzle-orm";

// Retention snapshot của Signal Analysis (#229): sau `SIGNAL_SNAPSHOT_RETENTION_DAYS` ngày bỏ `payload.signal`
// khỏi event Volume Farm (DEC-311) và đặt `orders.context` của Market Making (DEC-312) về null. Không xoá dòng: lịch sử
// Decisions và lệnh giữ nguyên, chỉ phần snapshot lớn bị bỏ.
// Mỗi lô một transaction ngắn: tìm qua index một phần (`bot_events_signal_idx`, `orders_context_created_idx`),
// `FOR UPDATE SKIP LOCKED` để không chờ dòng engine đang giữ, `lock_timeout` / `statement_timeout` để không bao giờ
// giữ khoá lâu. Index một phần nhỏ dần khi dòng được dọn, nên lượt không có gì để dọn gần như không tốn gì.
// Hai index KHÔNG nằm trong migration (review PR #257): migrator chạy trong transaction nên chỉ tạo được bằng CREATE INDEX
// thường, giữ khoá SHARE (chặn ghi của engine) suốt lúc build. Job tự tạo bằng CREATE INDEX CONCURRENTLY, ngoài
// transaction, một lần; trước mỗi lượt kiểm `pg_index.indisvalid`, index INVALID (build bị huỷ) thì DROP INDEX
// CONCURRENTLY và lượt sau tạo lại. Chỉ dọn dòng khi cả hai index hợp lệ.

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

/**
 * Hai index một phần của job. Điều kiện `WHERE` phải khớp đúng điều kiện trong câu dọn bên dưới thì planner mới dùng
 * index. Không khai báo trong `packages/db/src/schema.ts` (drizzle-kit sẽ sinh CREATE INDEX thường trong migration).
 */
export const SNAPSHOT_INDEXES = [
  {
    name: "bot_events_signal_idx",
    create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "bot_events_signal_idx" ON "bot_events" USING btree ("occurred_at") WHERE "bot_events"."payload" ? 'signal'`,
  },
  {
    name: "orders_context_created_idx",
    create: `CREATE INDEX CONCURRENTLY IF NOT EXISTS "orders_context_created_idx" ON "orders" USING btree ("created_at") WHERE "orders"."context" IS NOT NULL`,
  },
] as const;

export interface SnapshotIndexStatus {
  /** Cả hai index tồn tại và hợp lệ: lượt này được dọn dòng. */
  ready: boolean;
  /** Index vừa tạo trong lượt này. */
  created: string[];
  /** Index INVALID vừa bị bỏ (lượt sau tạo lại). */
  dropped: string[];
}

/** `indisvalid` của các index của job trong schema hiện tại; thiếu index thì không có trong map. */
async function snapshotIndexValidity(db: Db): Promise<Map<string, boolean>> {
  const names = SNAPSHOT_INDEXES.map((i) => i.name);
  const res = await db.execute<{ name: string; valid: boolean }>(sql`
    SELECT c.relname AS name, i.indisvalid AS valid
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
     WHERE c.relnamespace = current_schema()::regnamespace
       AND c.relname IN (${sql.join(
         names.map((n) => sql`${n}`),
         sql`, `,
       )})`);
  return new Map(res.rows.map((r) => [r.name, r.valid]));
}

/**
 * Tạo hai index của job nếu thiếu, bằng CREATE INDEX CONCURRENTLY (ngoài transaction: không chặn ghi, chỉ khoá
 * SHARE UPDATE EXCLUSIVE). Index INVALID (một lần build trước bị huỷ hoặc lỗi) bị DROP INDEX CONCURRENTLY và chỉ được
 * tạo lại ở lượt sau. Lỗi lúc build ném ra; index dở dang để lại là INVALID và được dọn ở lượt sau.
 */
export async function ensureSnapshotIndexes(db: Db): Promise<SnapshotIndexStatus> {
  const validity = await snapshotIndexValidity(db);
  const created: string[] = [];
  const dropped: string[] = [];
  for (const idx of SNAPSHOT_INDEXES) {
    const valid = validity.get(idx.name);
    if (valid === false) {
      await db.execute(sql.raw(`DROP INDEX CONCURRENTLY IF EXISTS "${idx.name}"`));
      dropped.push(idx.name);
    } else if (valid === undefined) {
      await db.execute(sql.raw(idx.create));
      created.push(idx.name);
    }
  }
  if (dropped.length > 0) return { ready: false, created, dropped };
  if (created.length === 0) return { ready: true, created, dropped };
  const after = await snapshotIndexValidity(db);
  const ready = SNAPSHOT_INDEXES.every((i) => after.get(i.name) === true);
  return { ready, created, dropped };
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

/**
 * Bỏ snapshot quá hạn, theo lô; giả định hai index đã hợp lệ (scheduler gọi qua `runSnapshotRetention`). Lỗi (kể
 * cả hết `lock_timeout`) ném ra cho lượt sau thử lại; phần đã dọn vẫn giữ.
 */
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

export interface SnapshotRetentionRun extends SnapshotRetentionResult {
  indexes: SnapshotIndexStatus;
}

/** Một lượt của scheduler: bảo đảm index trước, chỉ dọn khi cả hai index hợp lệ. */
export async function runSnapshotRetention(
  db: Db,
  now: number,
  options: SnapshotRetentionOptions = {},
): Promise<SnapshotRetentionRun> {
  const indexes = await ensureSnapshotIndexes(db);
  if (!indexes.ready) return { indexes, signals: 0, contexts: 0 };
  return { indexes, ...(await stripOldSnapshots(db, now, options)) };
}
