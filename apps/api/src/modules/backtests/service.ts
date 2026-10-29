import { createHash } from "node:crypto";

import { backtestRuns, candles1m, outbox, type Db } from "@drift/db";
import {
  AppError,
  backtestResultSchema,
  backtestWindow,
  dataVersion,
  ErrorCode,
  SODEX_INTERVAL_FOR_PERIOD,
  type BacktestInterval,
  type BacktestView,
  type StartBacktestBody,
} from "@drift/shared";
import { marketsOf, requirementOf, STRATEGIES } from "@drift/strategies";
import { and, desc, eq, inArray, min } from "drizzle-orm";

import { assertStrategyAvailable } from "../bots/service";
import { iso } from "../security/service";

// Backtest (BACKTEST.md mục 11): api xếp job `backtest.run` qua outbox, worker `backtest` chạy. Kết quả cache
// theo (strategy, market, paramsHash, period, dataVersion); trùng khoá thì sao chép kết quả cho user, không chạy lại.

export interface BacktestDeps {
  db: Db;
  now: () => Date;
  volumeMakerEnabled?: boolean;
}

/** JSON có khoá sắp xếp, để cùng config luôn ra cùng hash. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

function parseConfig(strategy: string, config: unknown): Record<string, unknown> {
  const entry = (
    STRATEGIES as Record<
      string,
      {
        schema: {
          safeParse: (v: unknown) => {
            success: boolean;
            data?: unknown;
            error?: { issues: { path: PropertyKey[]; message: string }[] };
          };
        };
      }
    >
  )[strategy];
  const parsed = entry?.schema.safeParse(config);
  if (parsed?.success !== true) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed?.error?.issues ?? [])
      (fieldErrors[issue.path.map(String).join(".") || "_"] ??= []).push(issue.message);
    throw new AppError(ErrorCode.validationFailed, "Invalid bot settings.", { fieldErrors });
  }
  return parsed.data as Record<string, unknown>;
}

function view(r: typeof backtestRuns.$inferSelect): BacktestView {
  const result = r.result === null ? null : backtestResultSchema.safeParse(r.result);
  return {
    id: r.id,
    status: r.status,
    periodDays: r.periodDays,
    interval: (r.dataVersion.split(":")[0] ?? "1h") as BacktestInterval,
    error: r.error,
    result: result?.success === true ? result.data : null,
    createdAt: iso(r.createdAt),
  };
}

export async function startBacktest(
  deps: BacktestDeps,
  userId: string,
  body: StartBacktestBody,
): Promise<BacktestView> {
  assertStrategyAvailable(body.strategy, deps.volumeMakerEnabled);
  const config = parseConfig(body.strategy, body.config);
  const markets = marketsOf(body.strategy, config);
  const market = requirementOf(body.strategy, config).market;
  const { from, to } = backtestWindow(deps.now().getTime(), body.periodDays);
  // Có đủ nến 1 phút của chính DRIFT cho mọi market thì dùng 1m; không thì nến SoDEX theo kỳ (DEC-40).
  const cover = await deps.db
    .select({ market: candles1m.market, first: min(candles1m.ts) })
    .from(candles1m)
    .where(inArray(candles1m.market, markets))
    .groupBy(candles1m.market);
  const has1m = markets.every((m) => {
    const first = cover.find((c) => c.market === m)?.first ?? null;
    return first !== null && first.getTime() <= from;
  });
  const interval: BacktestInterval = has1m ? "1m" : SODEX_INTERVAL_FOR_PERIOD[body.periodDays];
  const version = dataVersion(interval, to);
  const paramsHash = createHash("sha256")
    .update(canonical({ strategy: body.strategy, config }))
    .digest("hex");

  const [cached] = await deps.db
    .select()
    .from(backtestRuns)
    .where(
      and(
        eq(backtestRuns.strategy, body.strategy),
        eq(backtestRuns.market, market),
        eq(backtestRuns.paramsHash, paramsHash),
        eq(backtestRuns.periodDays, body.periodDays),
        eq(backtestRuns.dataVersion, version),
        inArray(backtestRuns.status, ["done", "unavailable"]),
      ),
    )
    .orderBy(desc(backtestRuns.createdAt))
    .limit(1);
  const base = {
    userId,
    strategy: body.strategy,
    market,
    paramsHash,
    config,
    periodDays: body.periodDays,
    dataVersion: version,
  };
  if (cached !== undefined) {
    const [copy] = await deps.db
      .insert(backtestRuns)
      .values({
        ...base,
        status: cached.status,
        result: cached.result,
        error: cached.error,
        finishedAt: deps.now(),
      })
      .returning();
    if (copy === undefined) throw new AppError(ErrorCode.internal, "Could not store backtest.");
    return view(copy);
  }
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(backtestRuns)
      .values({ ...base, status: "queued" })
      .returning();
    if (row === undefined) throw new AppError(ErrorCode.internal, "Could not queue backtest.");
    await tx.insert(outbox).values({ topic: "backtest.run", payload: { runId: row.id } });
    return view(row);
  });
}

export async function getBacktest(
  deps: BacktestDeps,
  userId: string,
  id: string,
): Promise<BacktestView> {
  const [row] = await deps.db
    .select()
    .from(backtestRuns)
    .where(and(eq(backtestRuns.id, id), eq(backtestRuns.userId, userId)))
    .limit(1);
  if (row === undefined) throw new AppError(ErrorCode.notFound, "Backtest not found.");
  return view(row);
}
