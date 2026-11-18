import { sql } from "drizzle-orm";

import type { Db } from "./client";

/** Transaction của drizzle (tham số của callback `db.transaction`). */
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface ReadOnlyTxOptions {
  /** Trần cho từng câu SQL (ms). */
  statementTimeoutMs: number;
  /**
   * Tuỳ chọn, chỉ dành cho công cụ chạy một lần (CLI): Postgres cắt PHIÊN (FATAL 25P03) nếu client ngồi im quá chừng này
   * (ms) giữa hai câu. Khi phiên bị cắt, node-pg phát sự kiện `error` trên client đang giữ transaction; không ai nghe thì
   * process sập, nên nơi gọi phải gắn handler (xem `guardIdleKill` của replay). Không truyền thì không đặt (server API dùng
   * pool chung, không dùng tuỳ chọn này).
   */
  idleTimeoutMs?: number;
  /**
   * Trần tổng thời gian (ms) tính từ lúc mở transaction. Trần này là HỢP TÁC: chỉ có tác dụng khi callback tự gọi
   * `checkDeadline()` giữa các câu (quá trần thì ném `DeadlineExceededError` và transaction rollback); không gì ngắt
   * callback giữa chừng. Một câu đang chạy vẫn bị `statementTimeoutMs` chặn, nên nếu callback gọi `checkDeadline()` trước
   * mỗi câu thì tổng thời gian ≤ trần + `statementTimeoutMs` + phần tính trong bộ nhớ giữa các câu.
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
 * ghi lỗi SQLSTATE 25006), rồi `statement_timeout` cục bộ cho transaction; `idle_in_transaction_session_timeout` chỉ khi
 * truyền `idleTimeoutMs`.
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
    if (opts.idleTimeoutMs !== undefined)
      await q.execute(
        sql.raw(`SET LOCAL idle_in_transaction_session_timeout = ${ms(opts.idleTimeoutMs)}`),
      );
    const { deadlineMs } = opts;
    const check = () => {
      if (deadlineMs !== undefined && Date.now() - started > deadlineMs)
        throw new DeadlineExceededError(deadlineMs);
    };
    return fn(q, check);
  });
}
