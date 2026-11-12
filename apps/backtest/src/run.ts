import { backtestRuns, candles1m, fundingRates, userBuilderFees, type Db } from "@drift/db";
import {
  AppError,
  BACKTEST_INTERVALS,
  backtestWindow,
  dec,
  builderFeeRateFor,
  ErrorCode,
  feeRateToFraction,
  SODEX_BASE_FEE_PCT,
  type BacktestInterval,
  type BacktestPeriod,
  type BacktestResult,
} from "@drift/shared";
import type { SodexRestClient } from "@drift/sodex";
import { backtest, marketsOf, type Candle } from "@drift/strategies";
import { and, asc, eq, gte, lt } from "drizzle-orm";

// Worker backtest (BACKTEST.md mục 11.2): đọc job, nạp nến + funding, chạy `backtest()` của packages/strategies
// (cùng `step` với engine), lưu kết quả. Thiếu dữ liệu cho cả kỳ → `unavailable`, không chạy trên dữ liệu thiếu.

export interface RunDeps {
  db: Db;
  rest: Pick<SodexRestClient, "getKlines" | "getSpotSymbols" | "getPerpsSymbols">;
  now: () => Date;
}

/** Trượt giá của lệnh market trong mô phỏng (BACKTEST.md mục 11.2, chỉnh được). */
export const BACKTEST_SLIPPAGE = "0.0005";
/** Tối thiểu số nến phải có so với số nến kỳ vọng (SoDEX có thể thiếu vài phút). */
const MIN_COVERAGE = 0.95;
const PAGE = 1000;

class Unavailable extends Error {}

/** Builder fee của user cho chiến lược: mức riêng team đặt (DEC-159) hoặc mặc định. */
export async function userBuilderRate(db: Db, userId: string, strategy: string): Promise<number> {
  const [own] = await db
    .select({ rate: userBuilderFees.rate })
    .from(userBuilderFees)
    .where(and(eq(userBuilderFees.userId, userId), eq(userBuilderFees.strategy, strategy)))
    .limit(1);
  return builderFeeRateFor(strategy, own === undefined ? undefined : { [strategy]: own.rate });
}

async function waitOnLimit<T>(read: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i += 1) {
    try {
      return await read();
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== ErrorCode.rateLimited || i >= 20)
        throw error;
      await new Promise((r) => setTimeout(r, Number(error.details.retryAfterMs ?? 500)));
    }
  }
}

export async function loadCandles(
  deps: RunDeps,
  engine: "spot" | "perps",
  market: string,
  interval: BacktestInterval,
  from: number,
  to: number,
): Promise<Candle[]> {
  const step = BACKTEST_INTERVALS[interval];
  if (interval === "1m") {
    const rows = await deps.db
      .select()
      .from(candles1m)
      .where(
        and(
          eq(candles1m.market, market),
          gte(candles1m.ts, new Date(from)),
          lt(candles1m.ts, new Date(to)),
        ),
      )
      .orderBy(asc(candles1m.ts));
    const own = rows.map((r): Candle => ({
      t: r.ts.getTime(),
      o: r.open,
      h: r.high,
      l: r.low,
      c: r.close,
      v: r.volume,
    }));
    if (covers(own, from, to, step)) return own;
    // `candles_1m` của DRIFT có khoảng trống (marketdata dừng): bù bằng nến 1 phút SoDEX còn giữ (DEC-102).
    const merged = new Map(own.map((k) => [k.t, k]));
    for (const k of await sodexCandles(deps, engine, market, interval, from, to))
      merged.set(k.t, k);
    return [...merged.values()].sort((a, b) => a.t - b.t);
  }
  return sodexCandles(deps, engine, market, interval, from, to);
}

/** Đủ nến cho kỳ: ≥ 95% số nến kỳ vọng và nến đầu không trễ quá 60 bước. */
function covers(candles: readonly Candle[], from: number, to: number, step: number): boolean {
  return (
    candles.length >= ((to - from) / step) * MIN_COVERAGE &&
    (candles[0]?.t ?? Infinity) <= from + step * 60
  );
}

async function sodexCandles(
  deps: RunDeps,
  engine: "spot" | "perps",
  market: string,
  interval: BacktestInterval,
  from: number,
  to: number,
): Promise<Candle[]> {
  const step = BACKTEST_INTERVALS[interval];
  const out = new Map<number, Candle>();
  for (let start = from; start < to; start += step * PAGE) {
    const end = Math.min(to, start + step * PAGE) - 1;
    const page = await waitOnLimit(() =>
      deps.rest.getKlines(engine, market, {
        interval,
        startTime: start,
        endTime: end,
        limit: PAGE,
      }),
    );
    for (const k of page)
      if (k.t >= from && k.t < to) out.set(k.t, { t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v });
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

export async function runJob(deps: RunDeps, runId: string): Promise<void> {
  const [run] = await deps.db
    .select()
    .from(backtestRuns)
    .where(eq(backtestRuns.id, runId))
    .limit(1);
  if (run === undefined || run.status === "done" || run.status === "unavailable") return;
  await deps.db.update(backtestRuns).set({ status: "running" }).where(eq(backtestRuns.id, runId));
  const interval = (run.dataVersion.split(":")[0] ?? "1h") as BacktestInterval;
  const { from, to } = backtestWindow(
    Date.parse(`${run.dataVersion.split(":")[1] ?? ""}T00:00:00Z`),
    run.periodDays as BacktestPeriod,
  );
  const step = BACKTEST_INTERVALS[interval];
  try {
    const config = run.config as Record<string, unknown>;
    const [spot, perps] = await Promise.all([
      waitOnLimit(() => deps.rest.getSpotSymbols()),
      waitOnLimit(() => deps.rest.getPerpsSymbols()),
    ]);
    const markets: Parameters<typeof backtest>[2]["markets"] = {};
    const funding: Parameters<typeof backtest>[2]["funding"] = {};
    for (const m of marketsOf(run.strategy, config)) {
      const sym = spot.find((x) => x.name === m) ?? perps.find((x) => x.name === m);
      if (sym === undefined) throw new Unavailable("market_unknown");
      const engine = spot.some((x) => x.name === m) ? "spot" : "perps";
      const candles = await loadCandles(deps, engine, m, interval, from, to);
      if (!covers(candles, from, to, step)) throw new Unavailable("history_short");
      markets[m] = {
        engine,
        candles,
        rules: {
          tickSize: sym.tickSize,
          stepSize: sym.stepSize,
          minQuantity: sym.minQuantity,
          minNotional: sym.minNotional,
          ...(sym.makerFee === undefined ? {} : { makerFee: sym.makerFee }),
          ...(sym.takerFee === undefined ? {} : { takerFee: sym.takerFee }),
        },
      };
      if (engine === "perps") {
        const rows = await deps.db
          .select()
          .from(fundingRates)
          .where(
            and(
              eq(fundingRates.market, m),
              gte(fundingRates.fundingTime, new Date(from)),
              lt(fundingRates.fundingTime, new Date(to)),
            ),
          )
          .orderBy(asc(fundingRates.fundingTime));
        // SoDEX không có lịch sử funding thị trường; chỉ có phần marketdata đã ghi. Thiếu thì không chạy (DEC-40).
        if ((rows[0]?.fundingTime.getTime() ?? Infinity) > from + 86_400_000)
          throw new Unavailable("funding_short");
        funding[m] = rows.map((r) => ({ at: r.fundingTime.getTime(), rate: r.rate }));
      }
    }
    const pctToFraction = (v: string) => dec(v).div(100).toString();
    const r = backtest(run.strategy, config, {
      markets,
      funding,
      fees: {
        spot: {
          maker: pctToFraction(SODEX_BASE_FEE_PCT.spot.maker),
          taker: pctToFraction(SODEX_BASE_FEE_PCT.spot.taker),
        },
        perps: {
          maker: pctToFraction(SODEX_BASE_FEE_PCT.perps.maker),
          taker: pctToFraction(SODEX_BASE_FEE_PCT.perps.taker),
        },
        builder: feeRateToFraction(
          await userBuilderRate(deps.db, run.userId, run.strategy),
        ).toString(),
      },
      slippage: BACKTEST_SLIPPAGE,
      intervalMs: step,
    });
    const result: BacktestResult = {
      interval,
      candles: r.candles,
      from: r.from,
      to: r.to,
      capital: r.capital,
      net: r.net,
      netPct: r.netPct,
      fees: r.fees,
      funding: r.funding,
      maxDrawdown: r.maxDrawdown,
      maxDrawdownPct: r.maxDrawdownPct,
      equity: r.equity,
      metrics: r.metrics,
      halted: r.halted,
      perps: Object.values(markets).some((m) => m.engine === "perps"),
    };
    await deps.db
      .update(backtestRuns)
      .set({ status: "done", result, error: null, finishedAt: deps.now() })
      .where(eq(backtestRuns.id, runId));
  } catch (error) {
    if (error instanceof Unavailable) {
      await deps.db
        .update(backtestRuns)
        .set({ status: "unavailable", error: error.message, finishedAt: deps.now() })
        .where(eq(backtestRuns.id, runId));
      return;
    }
    await deps.db
      .update(backtestRuns)
      .set({ status: "failed", error: "internal", finishedAt: deps.now() })
      .where(eq(backtestRuns.id, runId));
    throw error;
  }
}
