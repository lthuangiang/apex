import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import { sodexCallsOk, sodexCallsProblem } from "./schema";

// Ghi batch cho SoDEX Debugger (DEC-309, sửa theo review PR #217 B1 / M2).
//
// PgBouncer (transaction mode) từ chối tham số khởi động `statement_timeout`, nên timeout đặt bằng
// `SET LOCAL statement_timeout` trong MỖI transaction (BEGIN … COMMIT), cách duy nhất hợp lệ ở transaction mode.
//
// Ngân sách kết nối PgBouncer: mỗi process có đúng MỘT kết nối client cho debugger (pool max 1). Ở transaction mode
// PgBouncer chỉ giữ một kết nối server trong lúc transaction chạy: bình thường vài ms mỗi giây; tối đa
// `SINK_STATEMENT_TIMEOUT_MS` (3 s) khi DB chậm, và sau một lần ghi lỗi recorder nghỉ dần tới 60 s. Với ~10 process
// (engine, api, marketdata, scheduler, jobs, reco, backtest…) trường hợp xấu nhất là ~10 kết nối server × ≤ 3 s, chỉ
// khi DB đã chậm, rồi giảm nhanh nhờ backoff; bình thường < 1 kết nối server tính trung bình.
//
// Dòng hỏng (dữ liệu Postgres từ chối): chia đôi batch tới khi chỉ còn bỏ đúng dòng đó (đếm và trả về), không làm mất
// dòng khác. Bảng ok và bảng problem ghi riêng: dòng lỗi hỏng không bao giờ làm mất dòng thành công.

export type SodexCallInsert = typeof sodexCallsOk.$inferInsert & {
  /** Lỗi hoặc chậm → bảng giữ 14 ngày. */
  problem: boolean;
};

/** Giới hạn tham số của Postgres là 65535; 36 cột × 1000 dòng còn dư. */
const ROWS_PER_STATEMENT = 1000;
export const SINK_STATEMENT_TIMEOUT_MS = 3_000;

export interface SodexCallSinkHandle {
  /** Trả số dòng bị bỏ vì Postgres từ chối dữ liệu. Lỗi kết nối / timeout thì ném. */
  write(rows: SodexCallInsert[]): Promise<{ dropped: number }>;
  close(): Promise<void>;
}

type Tx = NodePgDatabase;

/** Lỗi do dữ liệu của dòng (class 22 data exception, 23 integrity): chia đôi batch để tìm dòng hỏng. */
function isDataError(error: unknown): boolean {
  let e: unknown = error;
  for (let i = 0; i < 3 && e !== null && typeof e === "object"; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code.startsWith("22") || code.startsWith("23");
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function createSodexCallSink(
  databaseUrl: string,
  options: { statementTimeoutMs?: number } = {},
): SodexCallSinkHandle {
  const timeoutMs = options.statementTimeoutMs ?? SINK_STATEMENT_TIMEOUT_MS;
  // Không gửi tham số khởi động nào ngoài mặc định (PgBouncer transaction mode).
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
  pool.on("error", () => undefined);

  /** Một transaction ngắn có statement timeout cục bộ. */
  async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL statement_timeout = ${String(Math.floor(timeoutMs))}`);
      const result = await fn(drizzle(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Lời gọi có clOrdID mà chưa biết bot (tin WS, lệnh gửi ngoài ngữ cảnh bot): tra `orders` theo account + clOrdID. */
  async function fillBots(tx: Tx, rows: SodexCallInsert[]): Promise<void> {
    const accounts: string[] = [];
    const clOrdIds: string[] = [];
    for (const r of rows) {
      if (r.botId != null || r.accountId == null) continue;
      for (const c of r.clOrdIds ?? []) {
        accounts.push(r.accountId);
        clOrdIds.push(c);
      }
    }
    if (clOrdIds.length === 0) return;
    const found = await tx.execute<{ account: string; cl: string; bot: string }>(sql`
      SELECT o.sodex_account_id AS account, o.cl_ord_id AS cl, o.bot_id AS bot
      FROM orders o
      JOIN unnest(${sql.param(accounts)}::uuid[], ${sql.param(clOrdIds)}::text[]) AS u(a, c)
        ON o.sodex_account_id = u.a AND o.cl_ord_id = u.c`);
    const bots = new Map(found.rows.map((x) => [`${x.account}:${x.cl}`, x.bot]));
    for (const r of rows) {
      if (r.botId != null || r.accountId == null) continue;
      for (const c of r.clOrdIds ?? []) {
        const bot = bots.get(`${r.accountId}:${c}`);
        if (bot !== undefined) {
          r.botId = bot;
          break;
        }
      }
    }
  }

  /** Lệnh đã ký không có địa chỉ trong URL: lấy địa chỉ ví từ account (id trong ngữ cảnh). */
  async function fillAddresses(tx: Tx, rows: SodexCallInsert[]): Promise<void> {
    const ids = [
      ...new Set(
        rows.flatMap((r) => (r.accountAddress == null && r.accountId != null ? [r.accountId] : [])),
      ),
    ];
    if (ids.length === 0) return;
    const found = await tx.execute<{ id: string; address: string }>(sql`
      SELECT id, lower(address) AS address FROM sodex_accounts WHERE id = ANY(${sql.param(ids)}::uuid[])`);
    const byId = new Map(found.rows.map((x) => [x.id, x.address]));
    for (const r of rows) {
      if (r.accountAddress == null && r.accountId != null) {
        r.accountAddress = byId.get(r.accountId) ?? null;
      }
    }
  }

  type Table = typeof sodexCallsOk | typeof sodexCallsProblem;
  type Row = typeof sodexCallsOk.$inferInsert;

  /** Ghi `list`; dòng hỏng bị tách ra bằng chia đôi và bỏ. Trả số dòng bị bỏ. */
  async function insert(table: Table, list: Row[]): Promise<number> {
    if (list.length === 0) return 0;
    try {
      await inTx(async (tx) => {
        for (let i = 0; i < list.length; i += ROWS_PER_STATEMENT) {
          await tx
            .insert(table)
            .values(list.slice(i, i + ROWS_PER_STATEMENT))
            .onConflictDoNothing();
        }
      });
      return 0;
    } catch (error) {
      if (!isDataError(error)) throw error;
      if (list.length === 1) return 1;
      const mid = Math.ceil(list.length / 2);
      return (await insert(table, list.slice(0, mid))) + (await insert(table, list.slice(mid)));
    }
  }

  return {
    async write(rows) {
      if (rows.length === 0) return { dropped: 0 };
      // Tra bot / địa chỉ là phụ: lỗi thì vẫn ghi dòng (thiếu bot), không mất bản ghi.
      await inTx(async (tx) => {
        await fillBots(tx, rows);
        await fillAddresses(tx, rows);
      }).catch((error: unknown) => {
        if (!isDataError(error)) throw error;
      });
      const ok: Row[] = [];
      const problem: Row[] = [];
      for (const { problem: isProblem, ...row } of rows) (isProblem ? problem : ok).push(row);
      const dropped = (await insert(sodexCallsProblem, problem)) + (await insert(sodexCallsOk, ok));
      return { dropped };
    },
    close: () => pool.end(),
  };
}
