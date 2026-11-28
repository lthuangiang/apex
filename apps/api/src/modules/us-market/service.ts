import { sodexAccounts, type Db } from "@drift/db";
import {
  AppError,
  bookStatusOf,
  ErrorCode,
  marketDepthOf,
  tickerVolumeOf,
  US_MARKET_ANTHROPIC,
  US_MARKET_CACHE_MS,
  WEALTH_ACTIVITY_LIMIT,
  WEALTH_BUSY_REASON,
  type UsMarketEngine,
  type UsMarketRow,
  type UsMarketsResponse,
  type WealthFund,
  type WealthFundRow,
  type WealthMeInclude,
  type WealthMeResponse,
} from "@drift/shared";
import {
  SymbolStatus,
  TtlCache,
  type PerpsSymbol,
  type SodexRestClient,
  type SpotSymbol,
  type Ticker,
  type WealthReadClient,
  type WealthReadResult,
} from "@drift/sodex";
import { and, desc, eq } from "drizzle-orm";

// US Market + SoDEX Wealth phía api (#589, DEC-402 mục 1–4). Chỉ đọc: sổ lệnh / ticker / symbol qua REST SoDEX, quỹ và
// vị thế Wealth qua `WealthReadClient` (allowlist GET). Không lưu gì vào DB. Cache trong bộ nhớ của tiến trình api:
// mỗi chu kỳ một lần đọc cho mỗi market (không theo số người xem), vị thế Wealth theo địa chỉ. Log không bao giờ có
// địa chỉ ví: chỉ phần và lý do lỗi.

export type UsMarketRest = Pick<
  SodexRestClient,
  "getOrderbook" | "getTickers" | "getSpotSymbols" | "getPerpsSymbols"
>;
export type WealthReader = Pick<
  WealthReadClient,
  | "getFunds"
  | "getTradingStatus"
  | "getPositions"
  | "getPnl"
  | "getInFlight"
  | "getFundDetails"
  | "getRecurringBuys"
  | "getPnlHistory"
>;

export interface UsMarketLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface UsMarketDeps {
  db: Db;
  now: () => Date;
  rest: UsMarketRest;
  wealth: WealthReader;
  log: UsMarketLog;
  /** Ghi đè TTL (test). */
  cacheMs?: number;
  wealthCacheMs?: number;
}

/**
 * Cache vị thế Wealth theo địa chỉ (DEC-402: ngắn, không lưu). 90 s (#592: 60–120 s): trần riêng 400 weight / phút, mỗi
 * lượt mặc định 4 lời gọi × 20, nên cache ngắn hơn sẽ ăn hết ngân sách khi vài người cùng mở.
 */
export const WEALTH_ME_CACHE_MS = 90_000;
/** Số địa chỉ tối đa giữ trong mỗi cache (phần chính, mua định kỳ, PnL history); vượt thì bỏ mục cũ nhất. */
const WEALTH_ME_CACHE_MAX = 2000;
/** Không có `retryAfterMs` từ bucket thì báo chờ chừng này. */
const WEALTH_BUSY_DEFAULT_RETRY_MS = 30_000;

type Settled<T> = { ok: true; value: T } | { ok: false };

type WealthOk = Extract<WealthMeResponse, { status: "ok" }>;
type WealthBase = Omit<WealthOk, "status" | "recurringBuys" | "pnlHistory">;
type WealthRecurring = NonNullable<WealthOk["recurringBuys"]>;
type WealthHistory = NonNullable<WealthOk["pnlHistory"]>;

/** Cache theo địa chỉ, gộp lời gọi đang chạy; lỗi (kể cả busy) không cache. Vượt `max` mục thì bỏ mục cũ nhất. */
function addressCache<T>(ttlMs: number, max: number, now: () => number) {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  const inflight = new Map<string, Promise<T>>();
  return (key: string, load: () => Promise<T>): Promise<T> => {
    const hit = entries.get(key);
    if (hit !== undefined && hit.expiresAt > now()) return Promise.resolve(hit.value);
    const pending = inflight.get(key);
    if (pending !== undefined) return pending;
    const promise = load()
      .then((value) => {
        entries.delete(key);
        entries.set(key, { value, expiresAt: now() + ttlMs });
        if (entries.size > max) {
          const oldest = entries.keys().next();
          if (oldest.done !== true) entries.delete(oldest.value);
        }
        return value;
      })
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  };
}

function errorCodeOf(error: unknown): string {
  return error instanceof AppError ? error.code : "unknown";
}

export interface UsMarketService {
  markets(): Promise<UsMarketsResponse>;
  /** `include`: phần đọc thêm (#592); mặc định không đọc `recurring-buys` / `pnl-history`. */
  wealthMe(userId: string, include?: readonly WealthMeInclude[]): Promise<WealthMeResponse>;
}

/** Hết ngân sách weight của chính DeskLabs (#592): 429 kèm `retryAfterMs`, không cache. */
function busyError(results: readonly WealthReadResult<unknown>[]): AppError | null {
  const waits = results.flatMap((r) =>
    r.kind !== "ok" && r.reason === "budget"
      ? [r.retryAfterMs ?? WEALTH_BUSY_DEFAULT_RETRY_MS]
      : [],
  );
  if (waits.length === 0) return null;
  return new AppError(ErrorCode.rateLimited, "SoDEX Wealth is busy. Try again shortly.", {
    reason: WEALTH_BUSY_REASON,
    retryAfterMs: Math.max(...waits),
  });
}

export function createUsMarketService(deps: UsMarketDeps): UsMarketService {
  const ttl = deps.cacheMs ?? US_MARKET_CACHE_MS;
  const marketsCache = new TtlCache<UsMarketsResponse>(ttl, () => deps.now().getTime());
  const fundsCache = new TtlCache<WealthReadResult<WealthFund[]>>(ttl, () => deps.now().getTime());
  const meTtl = deps.wealthCacheMs ?? WEALTH_ME_CACHE_MS;
  const clock = () => deps.now().getTime();
  const baseCache = addressCache<WealthBase>(meTtl, WEALTH_ME_CACHE_MAX, clock);
  const recurringCache = addressCache<WealthRecurring>(meTtl, WEALTH_ME_CACHE_MAX, clock);
  const historyCache = addressCache<WealthHistory>(meTtl, WEALTH_ME_CACHE_MAX, clock);

  const funds = () =>
    fundsCache.get("all", async () => {
      const r = await deps.wealth.getFunds();
      if (r.kind !== "ok")
        deps.log.warn({ part: "funds", reason: r.reason }, "wealth: read failed");
      return r;
    });

  async function readRest<T>(part: string, p: Promise<T>): Promise<Settled<T>> {
    try {
      return { ok: true, value: await p };
    } catch (error) {
      deps.log.warn({ part, code: errorCodeOf(error) }, "us market: read failed");
      return { ok: false };
    }
  }

  async function marketRow(
    target: {
      engine: UsMarketEngine;
      symbol: string;
      fundId: string | null;
      fundName: string | null;
    },
    symbols: Settled<(SpotSymbol | PerpsSymbol)[]>,
    tickers: Settled<Ticker[]>,
    nowMs: number,
  ): Promise<UsMarketRow> {
    const info = symbols.ok ? symbols.value.find((s) => s.name === target.symbol) : undefined;
    const ticker = tickers.ok ? tickers.value.find((t) => t.symbol === target.symbol) : undefined;
    const book = await readRest(
      `orderbook:${target.symbol}`,
      deps.rest.getOrderbook(target.engine, target.symbol, 10),
    );
    const { volume24h, lastTradeAt } = tickerVolumeOf(
      { quoteVolume: ticker?.quoteVolume ?? null, closeTime: ticker?.closeTime ?? null },
      nowMs,
    );
    // Trạng thái chỉ khi biết cả symbol (halt) và sổ lệnh; thiếu một trong hai → null ("Not provided").
    const bookStatus =
      info === undefined || !book.ok
        ? null
        : bookStatusOf({
            halted: info.status !== SymbolStatus.trading,
            bids: book.value.bids.length,
            asks: book.value.asks.length,
          });
    return {
      symbol: target.symbol,
      engine: target.engine,
      displayName: info?.displayName ?? null,
      fundId: target.fundId,
      fundName: target.fundName,
      maxLeverage: info !== undefined && "maxLeverage" in info ? info.maxLeverage : null,
      // Ticker trả "0" khi chưa từng khớp: không hiện như một giá.
      lastPrice:
        ticker?.lastPx === undefined || ticker.lastPx === null || /^0(\.0+)?$/.test(ticker.lastPx)
          ? null
          : ticker.lastPx,
      volume24h,
      lastTradeAt,
      bookStatus,
      depth: book.ok ? marketDepthOf(book.value) : null,
    };
  }

  async function fundRow(fund: WealthFund): Promise<WealthFundRow> {
    const ts = await deps.wealth.getTradingStatus(fund.fundId);
    if (ts.kind !== "ok")
      deps.log.warn({ part: "trading-status", reason: ts.reason }, "wealth: read failed");
    return {
      fundId: fund.fundId,
      name: fund.name,
      fundType: fund.fundType,
      fundStatus: fund.fundStatus,
      nav: fund.nav,
      aum: fund.aum,
      asOf: fund.asOf,
      spotSymbol: fund.spot?.symbol ?? null,
      requests:
        ts.kind !== "ok"
          ? null
          : {
              channel: ts.data.channel,
              open: ts.data.channel !== "closed",
              closedReason: ts.data.closedReason,
              nextChannel: ts.data.nextChannel,
              nextChannelAt:
                ts.data.nextChannelAt === null
                  ? null
                  : new Date(ts.data.nextChannelAt * 1000).toISOString(),
            },
    };
  }

  async function loadMarkets(): Promise<UsMarketsResponse> {
    const readAt = deps.now();
    const nowMs = readAt.getTime();
    const [fundList, spotSymbols, perpsSymbols, spotTickers, perpsTickers] = await Promise.all([
      funds(),
      readRest("symbols:spot", deps.rest.getSpotSymbols()),
      readRest("symbols:perps", deps.rest.getPerpsSymbols()),
      readRest("tickers:spot", deps.rest.getTickers("spot")),
      readRest("tickers:perps", deps.rest.getTickers("perps")),
    ]);
    const pick = (engine: UsMarketEngine) =>
      engine === "spot"
        ? { symbols: spotSymbols, tickers: spotTickers }
        : { symbols: perpsSymbols, tickers: perpsTickers };

    const anthropic = await Promise.all(
      US_MARKET_ANTHROPIC.map((m) => {
        const src = pick(m.engine);
        return marketRow({ ...m, fundId: null, fundName: null }, src.symbols, src.tickers, nowMs);
      }),
    );
    if (fundList.kind !== "ok")
      return {
        readAt: readAt.toISOString(),
        anthropic,
        fundTokens: { status: "not_provided" },
        funds: { status: "not_provided" },
      };
    const tokenFunds = fundList.data.filter((f) => f.spot != null);
    const vaultFunds = fundList.data.filter((f) => f.spot == null);
    const [tokens, vaults] = await Promise.all([
      Promise.all(
        tokenFunds.map((f) =>
          marketRow(
            { engine: "spot", symbol: f.spot?.symbol ?? "", fundId: f.fundId, fundName: f.name },
            spotSymbols,
            spotTickers,
            nowMs,
          ),
        ),
      ),
      Promise.all(vaultFunds.map((f) => fundRow(f))),
    ]);
    return {
      readAt: readAt.toISOString(),
      anthropic,
      fundTokens: { status: "ok", items: tokens },
      funds: { status: "ok", items: vaults },
    };
  }

  async function connectedAddress(userId: string): Promise<string | null> {
    const [account] = await deps.db
      .select({ address: sodexAccounts.address })
      .from(sodexAccounts)
      .where(and(eq(sodexAccounts.userId, userId), eq(sodexAccounts.status, "connected")))
      .orderBy(desc(sodexAccounts.createdAt))
      .limit(1);
    return account?.address ?? null;
  }

  function warnFailed(parts: Record<string, WealthReadResult<unknown>>): void {
    const failed = Object.entries(parts)
      .filter(([, r]) => r.kind !== "ok")
      .map(([part, r]) => `${part}:${r.kind === "ok" ? "" : r.reason}`);
    if (failed.length > 0) deps.log.warn({ parts: failed }, "wealth: read failed");
  }

  /** Phần chính: 4 lời gọi Wealth theo địa chỉ (pnl, positions, in-flight, fund-details) + danh sách quỹ dùng chung. */
  async function loadBase(address: string): Promise<WealthBase> {
    const readAt = deps.now();
    const [pnl, positions, inFlight, details, fundList] = await Promise.all([
      deps.wealth.getPnl(address),
      deps.wealth.getPositions(address),
      deps.wealth.getInFlight(address),
      deps.wealth.getFundDetails(address),
      funds(),
    ]);
    warnFailed({ pnl, positions, inFlight, details });
    // Hết ngân sách ở bất kỳ phần nào: trạng thái busy riêng (không hiện "Not provided" cho phần đó).
    const busy = busyError([pnl, positions, inFlight, details]);
    if (busy !== null) throw busy;
    if (pnl.kind !== "ok")
      throw new AppError(ErrorCode.sodexUnavailable, "SoDEX Wealth is not available right now.", {
        reason: pnl.reason,
      });

    const fundById = new Map(
      fundList.kind === "ok" ? fundList.data.map((f) => [f.fundId, f] as const) : [],
    );
    const posById = new Map(
      positions.kind === "ok" ? positions.data.positions.map((p) => [p.fundId, p] as const) : [],
    );
    const nameOf = (fundId: string) =>
      fundById.get(fundId)?.name ?? posById.get(fundId)?.name ?? null;
    const p = pnl.data;
    return {
      readAt: readAt.toISOString(),
      summary: {
        currency: p.currency,
        totalValue: p.totalValue,
        settledValue: p.settledValue,
        totalCost: p.totalCost,
        totalPnl: p.totalPnl,
        totalRealizedPnl: p.totalRealizedPnl,
        totalUnrealizedPnl: p.totalUnrealizedPnl,
        totalPnl24h: p.totalPnl24h,
        inFlightValue: p.inFlightValue,
        complete: p.complete,
      },
      holdings: p.positions.map((row) => {
        const pos = posById.get(row.fundId);
        return {
          fundId: row.fundId,
          name: nameOf(row.fundId),
          fundType: fundById.get(row.fundId)?.fundType ?? null,
          shares: row.shares,
          price: row.price,
          marketValue: row.marketValue,
          avgCost: row.avgCostWithAirdrop ?? pos?.avgCostWithAirdrop ?? pos?.avgCost ?? null,
          unrealizedPnl: row.unrealizedPnl,
          realizedPnl: row.realizedPnl,
          pnl24h: row.pnl24h,
          pendingRedeemShares: pos?.pendingRedeemShares ?? null,
          pendingDepositShares: pos?.pendingDepositShares ?? null,
          priced: row.priced,
        };
      }),
      inFlight:
        inFlight.kind !== "ok"
          ? { status: "not_provided" }
          : {
              status: "ok",
              items: inFlight.data.funds.flatMap((f) =>
                f.inFlight.map((cell) => ({
                  fundId: f.fundId,
                  name: nameOf(f.fundId),
                  kind: cell.kind,
                  stage: cell.stage,
                  direction: cell.direction,
                  unit: cell.unit,
                  amount: cell.amount,
                  count: cell.count,
                })),
              ),
            },
      activity:
        details.kind !== "ok"
          ? { status: "not_provided" }
          : {
              status: "ok",
              items: details.data.entries.slice(0, WEALTH_ACTIVITY_LIMIT).map((e) => ({
                fundId: e.fundId,
                name: nameOf(e.fundId),
                kind: e.kind,
                transactionType: e.transactionType,
                status: e.status,
                at: e.at,
                requestedAt: e.requestedAt,
                shares: e.shares ?? e.requestedShares,
                cost: e.cost,
                proceeds: e.proceeds,
              })),
            },
    };
  }

  /** Tên quỹ cho phần thêm: danh sách quỹ dùng chung (đã cache), không gọi thêm theo địa chỉ. */
  async function fundNames(): Promise<Map<string, string>> {
    const fundList = await funds();
    return new Map(
      fundList.kind === "ok" ? fundList.data.map((f) => [f.fundId, f.name] as const) : [],
    );
  }

  async function loadRecurringBuys(address: string): Promise<WealthRecurring> {
    const [recurring, names] = await Promise.all([
      deps.wealth.getRecurringBuys(address),
      fundNames(),
    ]);
    warnFailed({ recurring });
    const busy = busyError([recurring]);
    if (busy !== null) throw busy;
    if (recurring.kind !== "ok") return { status: "not_provided" };
    return {
      status: "ok",
      items: recurring.data.plans.map((plan) => ({
        planIndex: plan.planIndex,
        fundId: plan.fundId,
        name: plan.fundId === null ? null : (names.get(plan.fundId) ?? null),
        amount: plan.amount,
        planType: plan.planType,
        status: plan.status,
        nextScheduledAt: plan.nextScheduledAt,
        successfulExecutionCount: plan.successfulExecutionCount,
        totalBuyAmount: plan.totalBuyAmount,
        avgCost: plan.avgCost,
      })),
    };
  }

  async function loadPnlHistory(address: string): Promise<WealthHistory> {
    const history = await deps.wealth.getPnlHistory(address, { interval: "1d", range: "1M" });
    warnFailed({ history });
    const busy = busyError([history]);
    if (busy !== null) throw busy;
    if (history.kind !== "ok") return { status: "not_provided" };
    return {
      status: "ok",
      items: history.data.points.map((pt) => ({
        ts: pt.ts,
        pnl: pt.pnl,
        totalValue: pt.totalValue,
      })),
    };
  }

  async function wealthMe(
    userId: string,
    include: readonly WealthMeInclude[] = [],
  ): Promise<WealthMeResponse> {
    const address = await connectedAddress(userId);
    if (address === null) return { status: "not_connected" };
    const key = address.toLowerCase();
    const wantRecurring = include.includes("recurringBuys");
    const wantHistory = include.includes("pnlHistory");
    const [base, recurringBuys, pnlHistory] = await Promise.all([
      baseCache(key, () => loadBase(key)),
      wantRecurring ? recurringCache(key, () => loadRecurringBuys(key)) : undefined,
      wantHistory ? historyCache(key, () => loadPnlHistory(key)) : undefined,
    ]);
    return {
      status: "ok",
      ...base,
      ...(recurringBuys === undefined ? {} : { recurringBuys }),
      ...(pnlHistory === undefined ? {} : { pnlHistory }),
    };
  }

  return {
    markets: () => marketsCache.get("us", loadMarkets),
    wealthMe,
  };
}
