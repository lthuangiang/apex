import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(
  databaseUrl: string,
  /** Chờ một kết nối rảnh tối đa chừng này (ms) rồi lỗi; thiếu = chờ không giới hạn (mặc định của pg). */
  options: { connectionTimeoutMillis?: number } = {},
): { db: Db; pool: pg.Pool } {
  // PgBouncer chạy transaction mode: không dùng prepared statement có tên.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10, ...options });
  // Kết nối rảnh bị Postgres/PgBouncer cắt (restart, failover) không được làm sập process: pool tự bỏ
  // client hỏng, query kế tiếp mở kết nối mới; lỗi của query đang chạy vẫn trả về nơi gọi.
  pool.on("error", () => undefined);
  return { db: drizzle(pool, { schema }), pool };
}
