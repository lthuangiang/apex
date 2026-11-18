import { createDb, DeadlineExceededError, readOnlyTx } from "@drift/db";
import { dec, type Decimal } from "@drift/shared";
import { loadSodexConfig, RedisRateLimitStore, SodexRestClient } from "@drift/sodex";
import { Redis } from "ioredis";
import { z } from "zod";

import { checkRange, loadEntries, MAX_RANGE_DAYS, ReplayLimitError } from "./load";
import { DEFAULT_GRIDS, defaultRules, evaluate, NO_TICK, toMarkdown } from "./vb-replay";

// CLI replay VB (#235). Chỉ đọc: một `readOnlyTx` (READ ONLY, statement timeout mỗi câu, idle timeout, trần thời gian
// tổng); khoảng tối đa MAX_RANGE_DAYS ngày, trần số event / fill (vượt thì dừng với lỗi rõ). Tick size đọc từ REST công khai
// của SoDEX (chỉ đọc, có cache). Báo cáo markdown ra stdout, log ra stderr. Chạy trên prod (image backtest):
//   docker compose run --rm -T backtest apps/backtest/node_modules/.bin/tsx apps/backtest/src/replay/cli.ts \
//     --from 2026-11-11 --to 2026-11-18 > report.md
// Tuỳ chọn: --chase 2,3,5,8,12  --pullback 1,2,3  --momentum 0.5,0.25,0  (lưới của từng luật).

const QUERY_TIMEOUT_MS = 30_000;
/** Trần thời gian tổng của transaction; quá trần + một câu thì process tự thoát (kết nối đóng, transaction huỷ). */
const DEADLINE_MS = 10 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
/** Lưới: danh sách số cách nhau bằng dấu phẩy, mỗi số qua `item` (không nhận chuỗi rỗng). */
function list(
  name: string,
  v: string | undefined,
  fallback: number[],
  item: z.ZodNumber,
): number[] {
  if (v === undefined) return fallback;
  return v.split(",").map((x) => {
    const r = item.safeParse(x.trim() === "" ? Number.NaN : Number(x.trim()));
    if (!r.success) throw new ReplayLimitError(`--${name}: not a valid value: "${x}"`);
    return r.data;
  });
}
const date = (v: string | undefined, name: string) => {
  if (v === undefined) throw new Error(`--${name} is required (YYYY-MM-DD or ISO time, UTC)`);
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(t)) throw new Error(`--${name}: not a date: ${v}`);
  return new Date(t);
};

const env = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    SODEX_EGRESS_KEY: z.string().default("default"),
  })
  .parse(process.env);

function fail(message: string): never {
  process.stderr.write(`replay: ${message}\n`);
  process.exit(2);
}

let from: Date;
let to: Date;
let grids: typeof DEFAULT_GRIDS;
try {
  from = date(arg("from"), "from");
  to = date(arg("to"), "to");
  checkRange(from, to);
  grids = {
    ...DEFAULT_GRIDS,
    chaseBps: list("chase", arg("chase"), DEFAULT_GRIDS.chaseBps, z.number().int().positive()),
    pullbackTicks: list(
      "pullback",
      arg("pullback"),
      DEFAULT_GRIDS.pullbackTicks,
      z.number().int().positive(),
    ),
    momentumScale: list(
      "momentum",
      arg("momentum"),
      DEFAULT_GRIDS.momentumScale,
      z.number().min(0).max(1),
    ),
  };
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
// Lưới chặn cuối: quá trần + một câu mà vẫn chạy thì thoát hẳn.
setTimeout(
  () => {
    fail(`stopped after ${String(DEADLINE_MS / 60_000)} min (time limit)`);
  },
  DEADLINE_MS + 2 * QUERY_TIMEOUT_MS,
).unref();

const { db, pool } = createDb(env.DATABASE_URL);
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2 });
try {
  const ticks = new Map<string, Decimal>();
  const notes: string[] = [];
  try {
    const rest = new SodexRestClient({
      config: loadSodexConfig(process.env),
      rateLimit: new RedisRateLimitStore(redis),
      egressKey: env.SODEX_EGRESS_KEY,
      priority: "background",
    });
    for (const s of await rest.getPerpsSymbols()) ticks.set(s.name, dec(s.tickSize));
  } catch (error) {
    // Không đọc được tick: các hàng pullback "Not evaluated" (báo cáo ghi rõ), các luật khác vẫn chạy.
    process.stderr.write(`replay: tick sizes unavailable (${String(error)})\n`);
    notes.push(
      `Tick sizes could not be read from SoDEX, so the pullback rows are not evaluated (${NO_TICK}).`,
    );
  }
  const loaded = await readOnlyTx(
    db,
    { statementTimeoutMs: QUERY_TIMEOUT_MS, deadlineMs: DEADLINE_MS },
    (q, checkDeadline) => loadEntries(q, { from, to, ticks, checkDeadline }),
  ).catch((error: unknown) => {
    if (error instanceof ReplayLimitError || error instanceof DeadlineExceededError)
      fail(error.message);
    throw error;
  });
  const report = evaluate(loaded.entries, defaultRules(grids));
  const md = toMarkdown(report, {
    source: "production data (read-only)",
    generatedAt: Date.now(),
    range: { from: from.getTime(), to: to.getTime() },
    notes,
  });
  process.stdout.write(md);
  process.stdout.write(
    [
      "",
      "**Loader:**",
      `- Entry snapshots in range: ${String(loaded.snapshots)} (invalid, skipped: ${String(loaded.invalid)}).`,
      `- Not matched to a closed trade (entry cancelled after 10 s, or still open): ${String(loaded.unmatched)}.`,
      `- 10 s price source: mid_1s ${String(loaded.reach.mid1s)}, 1-minute candle ${String(loaded.reach.candle)}, none ${String(loaded.reach.none)}.`,
      `- Tick sizes read for ${String(ticks.size)} markets. Range limit: ${String(MAX_RANGE_DAYS)} days.`,
      "",
    ].join("\n"),
  );
} finally {
  await pool.end();
  redis.disconnect();
}
