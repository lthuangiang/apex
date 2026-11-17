import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { sodexCallsOk, sodexCallsProblem } from "./schema";

// Ghi batch cho SoDEX Debugger (DEC-TBD-sodex-debugger). Pool riêng một kết nối, timeout ngắn: DB chậm hay treo chỉ làm
// debugger mất bản ghi, không bao giờ giữ kết nối của pool chính mà engine / api dùng.

export type SodexCallInsert = typeof sodexCallsOk.$inferInsert & {
  /** Lỗi hoặc chậm → bảng giữ 14 ngày. */
  problem: boolean;
};

/** Giới hạn tham số của Postgres là 65535; 36 cột × 1000 dòng còn dư. */
const ROWS_PER_STATEMENT = 1000;

export interface SodexCallSinkHandle {
  write(rows: SodexCallInsert[]): Promise<void>;
  close(): Promise<void>;
}

export function createSodexCallSink(
  databaseUrl: string,
  options: { statementTimeoutMs?: number } = {},
): SodexCallSinkHandle {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 5_000,
    statement_timeout: options.statementTimeoutMs ?? 10_000,
  });
  pool.on("error", () => undefined);
  const db = drizzle(pool);

  /** Lời gọi có clOrdID mà chưa biết bot (tin WS, lệnh gửi ngoài ngữ cảnh bot): tra `orders` theo account + clOrdID. */
  async function fillBots(rows: SodexCallInsert[]): Promise<void> {
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
    const found = await db.execute<{ account: string; cl: string; bot: string }>(sql`
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
  async function fillAddresses(rows: SodexCallInsert[]): Promise<void> {
    const ids = [
      ...new Set(
        rows.flatMap((r) => (r.accountAddress == null && r.accountId != null ? [r.accountId] : [])),
      ),
    ];
    if (ids.length === 0) return;
    const found = await db.execute<{ id: string; address: string }>(sql`
      SELECT id, lower(address) AS address FROM sodex_accounts WHERE id = ANY(${sql.param(ids)}::uuid[])`);
    const byId = new Map(found.rows.map((x) => [x.id, x.address]));
    for (const r of rows) {
      if (r.accountAddress == null && r.accountId != null) {
        r.accountAddress = byId.get(r.accountId) ?? null;
      }
    }
  }

  return {
    async write(rows) {
      if (rows.length === 0) return;
      await Promise.all([fillBots(rows), fillAddresses(rows)]);
      const ok: (typeof sodexCallsOk.$inferInsert)[] = [];
      const problem: (typeof sodexCallsProblem.$inferInsert)[] = [];
      for (const { problem: isProblem, ...row } of rows) (isProblem ? problem : ok).push(row);
      for (const [table, list] of [
        [sodexCallsOk, ok],
        [sodexCallsProblem, problem],
      ] as const) {
        for (let i = 0; i < list.length; i += ROWS_PER_STATEMENT) {
          await db
            .insert(table)
            .values(list.slice(i, i + ROWS_PER_STATEMENT))
            .onConflictDoNothing();
        }
      }
    },
    close: () => pool.end(),
  };
}
