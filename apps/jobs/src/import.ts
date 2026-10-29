import {
  accountAnalyses,
  fundingPayments,
  historyPositions,
  historyTrades,
  imports,
  sodexAccounts,
  type Db,
} from "@drift/db";
import { analyzeAccount, AppError, ErrorCode, mul, type Fill } from "@drift/shared";
import type { Engine, SodexRestClient, UserTrade } from "@drift/sodex";
import { and, asc, eq, gte } from "drizzle-orm";
import { getAddress, type Address } from "viem";

// Onboarding bước 3–4: import lịch sử (chỉ đọc SoDEX) rồi phân tích (DEC-34).
// - Lùi tối đa IMPORT_LOOKBACK_DAYS; phân trang bằng endTime giảm dần.
// - Mỗi phần (spot fills, perps fills, positions, fundings) có progress và coverage riêng; phần nào
//   lỗi thì ghi là lỗi, không lấp chỗ trống (SCREENS.md mục 8.1).
// - Đọc được retry (C10); upsert theo id của SoDEX nên chạy lại không tạo bản trùng.

export const IMPORT_LOOKBACK_DAYS = 365;
const DAY = 86_400_000;

export const ImportSection = {
  spotFills: "spotFills",
  perpsFills: "perpsFills",
  positions: "positions",
  fundings: "fundings",
} as const;
export type ImportSection = (typeof ImportSection)[keyof typeof ImportSection];

export interface SectionCoverage {
  status: "done" | "failed";
  count: number;
  from: number | null;
  to: number | null;
  /** Dừng vì chạm giới hạn lùi, có thể còn dữ liệu cũ hơn. */
  truncated: boolean;
}

export interface ImportDeps {
  db: Db;
  rest: Pick<
    SodexRestClient,
    "getTrades" | "getPositionsHistory" | "getFundings" | "getPerpsAccountValue"
  >;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

/** Đọc lại tối đa 3 lần với backoff có jitter; hết hạn mức thì chờ đúng retryAfterMs (C10). */
async function readWithRetry<T>(deps: ImportDeps, read: () => Promise<T>): Promise<T> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= 3) throw error;
      const retryAfter =
        error instanceof AppError && error.code === ErrorCode.rateLimited
          ? Number(error.details.retryAfterMs ?? 1000)
          : 0;
      await sleep(Math.max(retryAfter, 500 * 2 ** attempt + Math.floor(Math.random() * 250)));
    }
  }
}

/** Phân trang lùi theo thời gian: lấy trang, rồi endTime = (cũ nhất − 1). */
async function paginate<T>(
  deps: ImportDeps,
  limit: number,
  since: number,
  until: number,
  page: (endTime: number) => Promise<T[]>,
  at: (item: T) => number,
  onPage: (items: T[]) => Promise<void>,
): Promise<{ count: number; from: number | null; to: number | null; truncated: boolean }> {
  let endTime = until;
  let count = 0;
  let from: number | null = null;
  let to: number | null = null;
  for (;;) {
    const items = await readWithRetry(deps, () => page(endTime));
    const inRange = items.filter((item) => at(item) >= since);
    if (inRange.length > 0) {
      await onPage(inRange);
      count += inRange.length;
      const times = inRange.map(at);
      from = Math.min(from ?? Infinity, ...times);
      to = Math.max(to ?? -Infinity, ...times);
    }
    const oldest = items.length === 0 ? null : Math.min(...items.map(at));
    if (items.length < limit || oldest === null) return { count, from, to, truncated: false };
    if (oldest < since) return { count, from, to, truncated: true };
    endTime = oldest - 1;
  }
}

/** Phí quy ra quote: phí tính bằng base asset thì nhân giá khớp. */
function feeInQuote(trade: UserTrade): string {
  const fee = trade.fee ?? "0";
  const base = trade.symbol.split(/[_-]/)[0];
  return trade.feeCoin !== undefined && trade.feeCoin === base
    ? mul(fee, trade.price).toString()
    : fee;
}

export async function runImport(deps: ImportDeps, importId: string): Promise<void> {
  const { db } = deps;
  const [row] = await db
    .select({ imp: imports, account: sodexAccounts })
    .from(imports)
    .innerJoin(sodexAccounts, eq(sodexAccounts.id, imports.sodexAccountId))
    .where(eq(imports.id, importId))
    .limit(1);
  if (row === undefined) return;
  // Consumer idempotent: message trùng của import đã xong thì bỏ qua (C10).
  if (row.imp.status === "done" || row.imp.status === "failed") return;
  const account = row.account;
  const address: Address = getAddress(account.address);
  const accountID = account.sodexAccountId;
  const now = deps.now().getTime();
  const since = now - IMPORT_LOOKBACK_DAYS * DAY;

  await db
    .update(imports)
    .set({ status: "running", startedAt: deps.now(), progress: {} })
    .where(eq(imports.id, importId));
  const coverage: Partial<Record<ImportSection, SectionCoverage>> = {};
  const progress = async (
    section: ImportSection,
    value: SectionCoverage | { status: "running"; count: number },
  ) => {
    const current = await db
      .select({ progress: imports.progress })
      .from(imports)
      .where(eq(imports.id, importId));
    const merged = {
      ...(current[0]?.progress as Record<string, unknown> | undefined),
      [section]: value,
    };
    await db.update(imports).set({ progress: merged }).where(eq(imports.id, importId));
  };

  const section = async (
    name: ImportSection,
    run: () => Promise<Omit<SectionCoverage, "status">>,
  ) => {
    await progress(name, { status: "running", count: 0 });
    try {
      const result = await run();
      coverage[name] = { status: "done", ...result };
    } catch {
      coverage[name] = { status: "failed", count: 0, from: null, to: null, truncated: false };
    }
    await progress(
      name,
      coverage[name] ?? { status: "failed", count: 0, from: null, to: null, truncated: false },
    );
  };

  const trades = (engine: Engine) => async () =>
    paginate(
      deps,
      1000,
      since,
      now,
      (endTime) => deps.rest.getTrades(engine, address, { accountID, endTime, limit: 1000 }),
      (t) => t.time,
      async (items) => {
        await db
          .insert(historyTrades)
          .values(
            items.map((t) => ({
              sodexAccountId: account.id,
              engine,
              tradeId: t.tradeID,
              orderId: t.orderID,
              clOrdId: t.clOrdID,
              market: t.symbol,
              side: t.side,
              price: t.price,
              quantity: t.quantity,
              fee: feeInQuote(t),
              builderFee: t.builderFee ?? null,
              feeCoin: t.feeCoin ?? null,
              isMaker: t.isMaker ?? null,
              tradedAt: new Date(t.time),
            })),
          )
          .onConflictDoNothing();
      },
    );

  await section(ImportSection.spotFills, trades("spot"));
  await section(ImportSection.perpsFills, trades("perps"));
  await section(ImportSection.positions, () =>
    paginate(
      deps,
      500,
      since,
      now,
      (endTime) => deps.rest.getPositionsHistory(address, { accountID, endTime, limit: 500 }),
      (p) => p.updatedAt,
      async (items) => {
        const closed = items.filter((p) => !p.active);
        if (closed.length === 0) return;
        await db
          .insert(historyPositions)
          .values(
            closed.map((p) => ({
              sodexAccountId: account.id,
              positionId: p.id,
              market: p.symbol,
              side: p.positionSide,
              avgEntryPrice: p.avgEntryPrice,
              avgClosePrice: p.avgClosePrice,
              closedSize: p.cumClosedSize,
              tradingFee: p.cumTradingFee,
              realizedPnl: p.realizedPnL,
              leverage: p.leverage,
              openedAt: new Date(p.createdAt),
              closedAt: new Date(p.updatedAt),
            })),
          )
          .onConflictDoNothing();
      },
    ),
  );
  await section(ImportSection.fundings, () =>
    paginate(
      deps,
      1000,
      since,
      now,
      (endTime) => deps.rest.getFundings(address, { accountID, endTime, limit: 1000 }),
      (f) => f.timestamp,
      async (items) => {
        await db
          .insert(fundingPayments)
          .values(
            items.map((f) => ({
              sodexAccountId: account.id,
              positionId: f.positionID,
              market: f.symbol,
              amount: f.fundingFee,
              paidAt: new Date(f.timestamp),
            })),
          )
          .onConflictDoNothing();
      },
    ),
  );

  let equity: string | null = null;
  try {
    equity = await readWithRetry(deps, () => deps.rest.getPerpsAccountValue(address));
  } catch {
    equity = null;
  }

  await analyze(deps, account.id, importId, since, equity);
  const failed = Object.values(coverage).some((c) => c.status === "failed");
  await db
    .update(imports)
    .set({
      status: failed ? "failed" : "done",
      coverage,
      finishedAt: deps.now(),
      error: failed ? "section_failed" : null,
    })
    .where(eq(imports.id, importId));
}

/** Phân tích trên dữ liệu đã lưu trong khoảng lookback. */
export async function analyze(
  deps: ImportDeps,
  sodexAccountId: string,
  importId: string,
  since: number,
  equity: string | null,
) {
  const { db } = deps;
  const sinceDate = new Date(since);
  const [trades, positions, fundings] = await Promise.all([
    db
      .select()
      .from(historyTrades)
      .where(
        and(
          eq(historyTrades.sodexAccountId, sodexAccountId),
          gte(historyTrades.tradedAt, sinceDate),
        ),
      )
      .orderBy(asc(historyTrades.tradedAt)),
    db
      .select()
      .from(historyPositions)
      .where(
        and(
          eq(historyPositions.sodexAccountId, sodexAccountId),
          gte(historyPositions.closedAt, sinceDate),
        ),
      ),
    db
      .select()
      .from(fundingPayments)
      .where(
        and(
          eq(fundingPayments.sodexAccountId, sodexAccountId),
          gte(fundingPayments.paidAt, sinceDate),
        ),
      ),
  ]);
  const fill = (t: typeof historyTrades.$inferSelect): Fill => ({
    market: t.market,
    side: t.side,
    price: t.price,
    quantity: t.quantity,
    feeQuote: t.fee ?? "0",
    isMaker: t.isMaker,
    at: t.tradedAt.getTime(),
  });
  const metrics = analyzeAccount({
    perpsPositions: positions.map((p) => ({
      market: p.market,
      side: p.side === "SHORT" ? "SHORT" : "LONG",
      entryPrice: p.avgEntryPrice,
      closePrice: p.avgClosePrice,
      closedSize: p.closedSize,
      fees: p.tradingFee,
      leverage: p.leverage,
      openedAt: p.openedAt.getTime(),
      closedAt: p.closedAt.getTime(),
    })),
    perpsFundings: fundings.map((f) => ({
      market: f.market,
      amount: f.amount,
      at: f.paidAt.getTime(),
    })),
    perpsFills: trades.filter((t) => t.engine === "perps").map(fill),
    spotFills: trades.filter((t) => t.engine === "spot").map(fill),
    equity,
  });
  await db.insert(accountAnalyses).values({
    sodexAccountId,
    importId,
    periodStart: metrics.periodStart === null ? null : new Date(metrics.periodStart),
    periodEnd: metrics.periodEnd === null ? null : new Date(metrics.periodEnd),
    metrics,
    computedAt: deps.now(),
  });
}
