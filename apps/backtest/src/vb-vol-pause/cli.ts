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

import { MOVE_MINUTES, STRONG_FACTOR, TYPICAL_WINDOW } from "./balance";
import { liveTrades, loadLiveVbFills, type LiveVbFill } from "./live";
import {
  FILL_MODELS,
  MEDIAN_WINDOW,
  PART2_RULE,
  pauseMarkdown,
  runPauseStudy,
  type LimitFill,
} from "./study";

// CLI nghiên cứu "tạm dừng khi biến động vọt lên" của Volume Builder (#363, việc 1). Chỉ đọc, cùng mức an toàn với công cụ
// #282 (DEC-316): một `readOnlyTx` (READ ONLY, statement timeout, idle timeout, trần thời gian tổng), tối đa 14 ngày; không
// gọi SoDEX, không đặt lệnh, không ghi DB; mô phỏng chạy sau khi transaction đóng. Markdown ra stdout. Ví dụ:
//   pnpm --filter @drift/backtest exec tsx src/vb-vol-pause/cli.ts --from 2026-11-07 --to 2026-11-21 > vb-vol-pause.md
// Tuỳ chọn: --markets SOL-USD (thêm market), --config bots|default (mặc định bots), --fill-models through,touch (mặc định
// through: mô hình khớp limit cũ; thêm touch để đặt Δ của hai mô hình cạnh nhau).
// Báo cáo có thêm dòng hiệu chỉnh: baseline backtest so với cost thật của bot Volume Builder tiền thật cùng market, cùng kỳ
// (đọc `fills` / `orders`, công thức tab Volume Builder của Signal Analysis; xem `live.ts`).

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
let fills: LimitFill[];
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
  const fm = (arg("fill-models") ?? "through").split(",").map((x) => x.trim());
  fills = FILL_MODELS.filter((x) => fm.includes(x));
  if (fills.length === 0 || fills.length !== fm.length)
    throw new StudyLimitError("--fill-models takes through, touch or through,touch");
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
    async (q, checkDeadline) => {
      const study = await loadStudy(q, {
        from,
        to,
        now: startedAt,
        extra,
        configFrom,
        checkDeadline,
      });
      const live = new Map<string, LiveVbFill[]>();
      for (const m of study.markets) {
        checkDeadline();
        live.set(m.market, await loadLiveVbFills(q, { market: m.market, from, to }));
      }
      return { ...study, live };
    },
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
  const reports = loaded.markets.flatMap((m) =>
    fills.map((fill) => ({
      ...runPauseStudy(
        m,
        fees,
        range,
        (what) => {
          process.stderr.write(`vb-vol-pause: ${what}\n`);
        },
        fill,
      ),
      live: liveTrades(loaded.live.get(m.market) ?? []),
    })),
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
        "Calibration: live cost uses the Volume Builder tab formula of the team Signal Analysis page (closed trades of live volume_farm bots on the market, both-leg volume, result = price P&L − all fill fees, real fees from fills). Fees / $1M + price part / $1M = cost / $1M. The backtest decides on candles and its fill model is pessimistic, so when the gap is large only Δ cost vs baseline should be read.",
        "Possible causes of a gap (defaults are NOT changed by this tool): (1) assumed 0.05% slippage on every market order (stop loss and taker legs), i.e. 500 USDC / $1M on that leg; (2) maker / taker mix: a backtest limit order only fills when price trades through it, so it fills maker less often than live, which falls back to taker; (3) fills on 1-minute candles: no queue, no intra-minute path, exits at candle prices; (4) fee rate: base SoDEX rates here vs the real rate on each fill; (5) live bots may have run on fewer days, other sizes or other configs than the backtest config. Compare the fees and price-part columns: a fee gap points at (2) or (4), a price-part gap at (1) or (3). An easy step closer to live would be to set the slippage to the live taker slippage and the fee rate to the live average, but that is a separate decision.",
        "Fill models: through (default) fills a limit only when price trades through it; touch fills it as soon as price touches it. Run with --fill-models through,touch to put both side by side; the model closer to live in the calibration line is more trustworthy. Δ of a rule can be inflated when the rule avoids exactly the adverse fills a model exaggerates.",
        `Part 2: a trade is in a strong move when, at its entry decision, price moved more than ${String(STRONG_FACTOR)} × the median of the same ${String(MOVE_MINUTES)}-minute move over the ${String(TYPICAL_WINDOW)} closed candles before (closed candles only); otherwise calm. Balance = entries forced to balance long / short volume (snapshot flag), signal = the rest. "With rule" uses k ${String(PART2_RULE.k)} · m ${String(PART2_RULE.m)} from part 1. Mean intervals: block bootstrap by UTC day.`,
        `Range limit ${String(MAX_RANGE_DAYS)} days per run.`,
      ],
    }),
  );
} finally {
  await pool.end().catch(() => undefined);
}
