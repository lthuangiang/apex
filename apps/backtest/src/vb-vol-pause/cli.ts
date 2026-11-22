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
import { checkRange, loadStudy, MAX_RANGE_DAYS, StudyLimitError } from "../vb-counter-trend/load";

import { MEDIAN_WINDOW, pauseMarkdown, runPauseStudy } from "./study";

// CLI nghiên cứu "tạm dừng khi biến động vọt lên" của Volume Builder (#363, việc 1). Chỉ đọc, cùng mức an toàn với công cụ
// #282 (DEC-316): một `readOnlyTx` (READ ONLY, statement timeout, idle timeout, trần thời gian tổng), tối đa 14 ngày; không
// gọi SoDEX, không đặt lệnh, không ghi DB; mô phỏng chạy sau khi transaction đóng. Markdown ra stdout. Ví dụ:
//   pnpm --filter @drift/backtest exec tsx src/vb-vol-pause/cli.ts --from 2026-11-07 --to 2026-11-21 > vb-vol-pause.md
// Tuỳ chọn: --markets SOL-USD (thêm market), --config bots|default (mặc định bots).

const QUERY_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 120_000;
const DEADLINE_MS = 10 * 60_000;
const PROCESS_LIMIT_MS = 60 * 60_000;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const date = (v: string | undefined, name: string) => {
  if (v === undefined) throw new StudyLimitError(`--${name} is required (YYYY-MM-DD, UTC)`);
  const t = Date.parse(v.length === 10 ? `${v}T00:00:00Z` : v);
  if (Number.isNaN(t)) throw new StudyLimitError(`--${name}: not a date: ${v}`);
  return new Date(t);
};
function fail(message: string): never {
  process.stderr.write(`vb-vol-pause: ${message}\n`);
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
    process.stderr.write(`vb-vol-pause: database client error (${String(e)})\n`);
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
  const fees = {
    spot: { maker: pct(SODEX_BASE_FEE_PCT.spot.maker), taker: pct(SODEX_BASE_FEE_PCT.spot.taker) },
    perps: {
      maker: pct(SODEX_BASE_FEE_PCT.perps.maker),
      taker: pct(SODEX_BASE_FEE_PCT.perps.taker),
    },
    builder: feeRateToFraction(builderFeeRateFor(Strategy.volumeFarm)).toString(),
  };
  const range = { from: from.getTime(), to: to.getTime() };
  const reports = loaded.markets.map((m) =>
    runPauseStudy(m, fees, range, (what) => {
      process.stderr.write(`vb-vol-pause: ${what}\n`);
    }),
  );
  process.stdout.write(
    pauseMarkdown(reports, {
      source: "stored candles_1m (read-only)",
      range,
      notes: [
        ...loaded.notes,
        `Rule: a candle spikes when its range (high − low) ÷ open is above k × the median range of the ${String(MEDIAN_WINDOW)} closed 1-minute candles before it. Right after a candle closes, no new entry while any of the last m closed candles spiked (so trading resumes after m calm minutes). Open trades keep their stop loss. Only closed candles are used (no look-ahead).`,
        "The backtest decides once a minute, when a candle closes, so the running candle has just started at decision time; the running-candle part of the rule needs per-second data and is measured separately.",
        "Entries blocked = decision minutes where the bot would have opened a new trade but the rule stopped it (the bot retries the next minute).",
        "Stop-loss hits = trades whose first exit was the native stop loss.",
        "Cost / $1M = −Σ result after fees ÷ Σ volume (both legs) × 1M, as on the team page: positive = cost, negative = profit. Volume / day and result / day divide by the days with ≥ 90% of minutes; trades on other days are left out.",
        "95% intervals: paired block bootstrap by UTC day (2,000 resamples, fixed seed); Δ = cell − baseline on the same resampled days. With few days the intervals are narrower than the truth.",
        `Fees: SoDEX perps base maker ${SODEX_BASE_FEE_PCT.perps.maker}% / taker ${SODEX_BASE_FEE_PCT.perps.taker}% + builder ${dec(fees.builder).mul(100).toFixed()}% per side; market-order slippage 0.05%; no funding. Candle-only signal (no historical order book).`,
        `Range limit ${String(MAX_RANGE_DAYS)} days per run.`,
      ],
    }),
  );
} finally {
  await pool.end().catch(() => undefined);
}
