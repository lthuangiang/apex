import { sql } from "drizzle-orm";

import type { Db } from "./client";

/** Transaction của drizzle (tham số của callback `db.transaction`). */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ReadOnlyTxOptions {
  /** Trần cho từng câu SQL (ms). */
  statementTimeoutMs: number;
  /** Postgres cắt transaction nếu client ngồi im quá chừng này (ms) giữa hai câu. Mặc định = `statementTimeoutMs`. */
  idleTimeoutMs?: number;
  /**
   * Trần tổng thời gian (ms) tính từ lúc mở transaction. Callback gọi `checkDeadline()` giữa các câu; quá trần thì ném
   * `DeadlineExceededError` và transaction rollback. Một câu đang chạy vẫn bị `statementTimeoutMs` chặn, nên tổng thời
   * gian ≤ trần + `statementTimeoutMs`.
   */
  deadlineMs?: number;
}

export class DeadlineExceededError extends Error {
  constructor(ms: number) {
    super(`read-only transaction exceeded its ${String(Math.round(ms / 1000))} s time limit`);
    this.name = "DeadlineExceededError";
  }
}

/**
 * Transaction chỉ đọc cho báo cáo / công cụ chạy trên dữ liệu thật: `SET TRANSACTION READ ONLY` là câu đầu tiên (mọi câu
 * ghi lỗi SQLSTATE 25006), rồi `statement_timeout` và `idle_in_transaction_session_timeout` cục bộ cho transaction.
 */
export async function readOnlyTx<T>(
  db: Db,
  opts: ReadOnlyTxOptions,
  fn: (q: DbTx, checkDeadline: () => void) => Promise<T>,
): Promise<T> {
  const ms = (v: number) => String(Math.max(1, Math.floor(v)));
  return db.transaction(async (q) => {
    const started = Date.now();
    await q.execute(sql`SET TRANSACTION READ ONLY`);
    await q.execute(sql.raw(`SET LOCAL statement_timeout = ${ms(opts.statementTimeoutMs)}`));
    await q.execute(
      sql.raw(
        `SET LOCAL idle_in_transaction_session_timeout = ${ms(opts.idleTimeoutMs ?? opts.statementTimeoutMs)}`,
      ),
    );
    const { deadlineMs } = opts;
    const check = () => {
      if (deadlineMs !== undefined && Date.now() - started > deadlineMs)
        throw new DeadlineExceededError(deadlineMs);
    };
    return fn(q, check);
  });
}
