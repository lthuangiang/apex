import { createDb, DeadlineExceededError, readOnlyTx } from "@drift/db";
import {
  builderFeeRateFor,
  dec,
  feeRateToFraction,
  SODEX_BASE_FEE_PCT,
  Strategy,
} from "@drift/shared";
import { z } from "zod";

import { guardIdleKill, IDLE_KILL_MESSAGE, isIdleKill } from "../replay/abort";

import { checkRange, loadStudy, MAX_RANGE_DAYS, StudyLimitError } from "./load";
import { runStudy, toMarkdown } from "./study";

// CLI nghiên cứu bộ chặn ngược xu hướng Volume Builder (#282). Chỉ đọc, cùng mức an toàn với replay DEC-316: một
// `readOnlyTx` (READ ONLY, statement timeout mỗi câu, idle timeout, trần thời gian tổng), khoảng tối đa 14 ngày, trần số
// nến / market; không gọi REST SoDEX, không đặt lệnh, không ghi DB. Mô phỏng chạy SAU khi transaction đóng. Báo cáo
// markdown ra stdout, lỗi ra stderr (mã thoát 2). Chạy trên prod (image backtest):
//   docker compose run --rm -T backtest apps/backtest/node_modules/.bin/tsx apps/backtest/src/vb-counter-trend/cli.ts \
//     --from 2026-11-05 --to 2026-11-19 > vb-counter-trend.md
// Tuỳ chọn: --markets SOL-USD,XRP-USD (thêm market)  --config bots|default (mặc định bots).

const QUERY_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 120_000;
const DEADLINE_MS = 10 * 60_000;
/** Trần cả process (nạp + mô phỏng). */
const PROCESS_LIMIT_MS = 30 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const date = (v: string | undefined, name: string) => {
  if (v === undefined)
    throw new StudyLimitError(`--${name} is required (YYYY-MM-DD or ISO time, UTC)`);
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(t)) throw new StudyLimitError(`--${name}: not a date: ${v}`);
  return new Date(t);
};

function fail(message: string): never {
  process.stderr.write(`vb-counter-trend: ${message}\n`);
  process.exit(2);
}

const env = z.object({ DATABASE_URL: z.string().min(1) }).safeParse(process.env);
if (!env.success) fail("DATABASE_URL is required");

const startedAt = Date.now();
let from: Date;
let to: Date;
let extra: string[];
let configFrom: "bots" | "default";
try {
  from = date(arg("from"), "from");
  to = date(arg("to"), "to");
  checkRange(from, to, startedAt);
  extra = (arg("markets") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  for (const m of extra)
    if (!/^[A-Z0-9]{1,20}-USD$/.test(m))
      throw new StudyLimitError(`--markets: not a perps market: ${m}`);
  const c = arg("config") ?? "bots";
  if (c !== "bots" && c !== "default")
    throw new StudyLimitError("--config must be bots or default");
  configFrom = c;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
setTimeout(() => {
  fail(`stopped after ${String(PROCESS_LIMIT_MS / 60_000)} min (time limit)`);
}, PROCESS_LIMIT_MS).unref();

const { db, pool } = createDb(env.data.DATABASE_URL);
guardIdleKill(
  pool,
  () => {
    fail(IDLE_KILL_MESSAGE);
  },
  (e) => {
    process.stderr.write(`vb-counter-trend: database client error (${String(e)})\n`);
  },
);
try {
  const loaded = await readOnlyTx(
    db,
    {
      statementTimeoutMs: QUERY_TIMEOUT_MS,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      deadlineMs: DEADLINE_MS,
    },
    (q, checkDeadline) =>
      loadStudy(q, { from, to, now: startedAt, extra, configFrom, checkDeadline }),
  ).catch((error: unknown) => {
    if (error instanceof StudyLimitError || error instanceof DeadlineExceededError)
      fail(error.message);
    if (isIdleKill(error)) fail(IDLE_KILL_MESSAGE);
    throw error;
  });
  await pool.end();
  const pct = (v: string) => dec(v).div(100).toString();
  // Phí cơ bản của SoDEX Perps + builder fee mặc định của Volume Builder (DEC-266). Bậc phí riêng của từng tài khoản
  // không đọc (không gọi SoDEX): số phí có thể cao hơn thực tế một chút với tài khoản có bậc phí thấp hơn.
  const fees = {
    spot: { maker: pct(SODEX_BASE_FEE_PCT.spot.maker), taker: pct(SODEX_BASE_FEE_PCT.spot.taker) },
    perps: {
      maker: pct(SODEX_BASE_FEE_PCT.perps.maker),
      taker: pct(SODEX_BASE_FEE_PCT.perps.taker),
    },
    builder: feeRateToFraction(builderFeeRateFor(Strategy.volumeFarm)).toString(),
  };
  const range = { from: from.getTime(), to: to.getTime() };
  const reports = loaded.markets.map((m) => {
    process.stderr.write(`vb-counter-trend: simulating ${m.market}…\n`);
    return runStudy(m, fees, range);
  });
  process.stdout.write(
    toMarkdown(reports, {
      source: "stored candles_1m (read-only)",
      generatedAt: Date.now(),
      range,
      notes: [
        ...loaded.notes,
        `Fees: SoDEX perps base maker ${SODEX_BASE_FEE_PCT.perps.maker}% / taker ${SODEX_BASE_FEE_PCT.perps.taker}% + builder ${dec(fees.builder).mul(100).toFixed()}% per side; market-order slippage 0.05%. No funding (holds are minutes).`,
        `Range limit ${String(MAX_RANGE_DAYS)} days. Candle-only signal (no historical order book, so the book component is neutral, as in the Backtest tab).`,
      ],
    }),
  );
} finally {
  await pool.end().catch(() => undefined);
}
