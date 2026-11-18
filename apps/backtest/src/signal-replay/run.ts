import { COSTS_V1, inferTick } from "./costs";
import {
  emptyFundingFunnel,
  evaluateFunding,
  fundingCoverage,
  FUNDING_RULES_V1,
  type FundingCoverage,
  type FundingFunnel,
} from "./funding";
import {
  checkRange,
  listPerpMarkets,
  loadCandles,
  loadFunding,
  loadMidAfter,
  loadMmFills,
  loadSpreadHours,
  loadVbRoundTrips,
  loadWallets,
  loadWhaleEvents,
  LIMITS,
  whaleCoverage,
  type Q,
  type WhaleCoverage,
} from "./load";
import {
  inWindow,
  MACRO_CALENDAR_VERSION,
  PAUSE_WINDOW_V1,
  pauseWindows,
  type PauseWindow,
} from "./macro-calendar";
import { Series, TRADE_RULES_V1, type MarketContext } from "./market";
import { filterMm, filterVb, type FilterResult } from "./risk-filter";
import { groupReport, periodStats, type GroupReport, type PeriodStats } from "./stats";
import {
  emptyStructureFunnel,
  evaluateStructure,
  STRUCTURE_RULES_V1,
  type StructureFunnel,
} from "./structure";
import type { SignalTrade, SignalType } from "./types";
import {
  emptyWhaleFunnel,
  evaluateWhales,
  WHALE_RULES_V1,
  type WalletSnapshot,
  type WhaleEvent,
  type WhaleFunnel,
} from "./whales";

// Ghép các bước replay tín hiệu (#274) trong MỘT transaction chỉ đọc: từng market một (nến của market đó trong bộ nhớ,
// xong thì bỏ), rồi D1 trên ledger thật. Trả báo cáo JSON (CLI ghi ra file / stdout).

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Lệnh bị bỏ giữ lại trong danh sách (mỗi nhóm); lý do vẫn được đếm đủ. */
const MAX_SKIPPED_LISTED = 2_000;
const REFERENCE_MARKET = "BTC-USD";

const WHALE_POPULATION =
  "Live leader_events (seen within minutes) only exist for wallets that DeskLabs users copy or follow, and those wallets are added to each daily leaderboard run as extras. The population is user-picked wallets, not the top of the leaderboard, so passing the anti-survivorship rule is nearly automatic one day after someone follows a wallet.";

export type ReplayPart = SignalType | "risk_filter";
export const ALL_PARTS: readonly ReplayPart[] = [
  "whale",
  "funding",
  "price_structure",
  "risk_filter",
];

export interface GroupOut {
  type: SignalType;
  variant: string;
  ruleVersion: string;
  report: GroupReport;
  /** Phân tích phụ theo điểm (chỉ cá voi, mỗi nhóm ≥ 30 lệnh mới có ý nghĩa). */
  byScore?: { band: string; stats: PeriodStats }[];
  trades: SignalTrade[];
  skippedNotListed: number;
}

export interface SignalReplayReport {
  kind: "signal-replay";
  generatedAt: string;
  range: { from: string; to: string };
  source: string;
  rules: Record<string, unknown>;
  coverage: {
    markets: number;
    marketsWithCandles: number;
    whales: (WhaleCoverage & { limit: string }) | null;
    funding: {
      markets: number;
      totalPoints: number;
      medianDays: number | null;
      marketsWith90Days: number;
      perMarket: FundingCoverage[];
    } | null;
    spread: { tradesMeasured: number; tradesDefault: number };
  };
  funnels: {
    whale?: WhaleFunnel;
    funding?: FundingFunnel;
    priceStructure?: StructureFunnel;
  };
  groups: GroupOut[];
  riskFilter: {
    calendarVersion: string;
    calendarVerified: boolean;
    windows: PauseWindow[];
    marketWideNews: string;
    volumeBuilder: FilterResult & { unclosedRoundTrips: number };
    marketMaking: FilterResult;
  } | null;
  limitations: string[];
}

export interface RunOptions {
  from: Date;
  to: Date;
  parts: readonly ReplayPart[];
  checkDeadline: () => void;
  log: (msg: string) => void;
}

const median = (xs: number[]) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
};

export async function runSignalReplay(q: Q, o: RunOptions): Promise<SignalReplayReport> {
  checkRange(o.from, o.to);
  const from = o.from.getTime();
  const to = o.to.getTime();
  const want = (p: ReplayPart) => o.parts.includes(p);
  const windows = pauseWindows(from - DAY, to + DAY);
  const groups = new Map<
    string,
    {
      type: SignalType;
      variant: string;
      version: string;
      trades: SignalTrade[];
      skipped: number;
      skipReasons: Record<string, number>;
    }
  >();
  const add = (list: readonly SignalTrade[]) => {
    for (const t of list) {
      const key = `${t.type}/${t.variant}`;
      let g = groups.get(key);
      if (g === undefined) {
        g = {
          type: t.type,
          variant: t.variant,
          version: t.ruleVersion,
          trades: [],
          skipped: 0,
          skipReasons: {},
        };
        groups.set(key, g);
      }
      if (t.status === "entered") {
        const w = t.entryAt === null ? null : inWindow(windows, t.entryAt);
        if (w !== null) t.flags.push("in_pause_window");
        g.trades.push(t);
      } else {
        g.skipped += 1;
        const reason = (t.skipReason ?? "").split(":")[0] ?? "";
        g.skipReasons[reason] = (g.skipReasons[reason] ?? 0) + 1;
        if (g.skipped <= MAX_SKIPPED_LISTED) g.trades.push(t);
      }
    }
  };

  const markets = await listPerpMarkets(q);
  o.log(`markets: ${String(markets.length)}`);
  const funnels: SignalReplayReport["funnels"] = {};
  const whaleFunnel = emptyWhaleFunnel();
  const fundingFunnel = emptyFundingFunnel();
  const structureFunnel = emptyStructureFunnel();
  let wallets = new Map<string, WalletSnapshot[]>();
  let whaleEvents = new Map<string, WhaleEvent[]>();
  let whaleCov: WhaleCoverage | null = null;
  if (want("whale")) {
    o.checkDeadline();
    whaleCov = await whaleCoverage(q, o.from, o.to);
    wallets = await loadWallets(q, o.to);
    whaleEvents = await loadWhaleEvents(q, o.from, o.to);
    o.log(
      `whale wallets: ${String(wallets.size)}, markets with events: ${String(whaleEvents.size)}`,
    );
  }
  const fundingCov: FundingCoverage[] = [];
  let withCandles = 0;
  const maxHold = Math.max(WHALE_RULES_V1.maxHoldMs, FUNDING_RULES_V1.maxHoldMs);
  const needCandles = want("whale") || want("funding") || want("price_structure");
  const candleFrom = new Date(from - TRADE_RULES_V1.volLookbackMs - 2 * HOUR);
  const candleTo = new Date(to + maxHold + 2 * HOUR);
  // Market tham chiếu để phân biệt market ít giao dịch với lúc máy thu dừng.
  const reference =
    needCandles && markets.includes(REFERENCE_MARKET)
      ? new Series(REFERENCE_MARKET, await loadCandles(q, REFERENCE_MARKET, candleFrom, candleTo))
      : undefined;
  for (const market of markets) {
    o.checkDeadline();
    const fundingPoints = want("funding")
      ? await loadFunding(q, market, new Date(from - FUNDING_RULES_V1.lookbackMs), o.to)
      : [];
    if (want("funding") && fundingPoints.length > 0)
      fundingCov.push(fundingCoverage(market, fundingPoints));
    if (!needCandles) continue;
    const candles =
      reference !== undefined && market === REFERENCE_MARKET
        ? [...reference.candles]
        : await loadCandles(q, market, candleFrom, candleTo);
    if (candles.length === 0) continue;
    withCandles += 1;
    const series =
      market === REFERENCE_MARKET && reference !== undefined
        ? reference
        : new Series(market, candles);
    // Tick suy ra từ 5 000 nến ĐẦU của chuỗi (nạp từ 30 ngày trước `from`, nên nằm trước phần lớn lệnh); tick size gần như
    // cố định nên đây chỉ là để không dùng dữ liệu sau lệnh.
    const tick = inferTick(
      candles.slice(0, 5_000).flatMap((c) => [c.open, c.high, c.low, c.close]),
    );
    const ctx: MarketContext = {
      series,
      hourly: series.hourlyCloses(),
      spreadHours: await loadSpreadHours(
        q,
        market,
        new Date(from - COSTS_V1.spreadLookbackMs),
        new Date(to + maxHold),
      ),
      tick,
      ...(reference === undefined ? {} : { reference }),
    };
    const events = whaleEvents.get(market);
    if (want("whale") && events !== undefined) {
      const seen = events
        .filter((e) => e.seenAt - e.at <= WHALE_RULES_V1.maxDelayMs)
        .map((e) => e.seenAt);
      const midAfter = await loadMidAfter(q, market, seen);
      add(evaluateWhales(events, wallets, { ...ctx, midAfter }, whaleFunnel, from));
    }
    if (want("funding") && fundingPoints.length > 0)
      add(evaluateFunding(market, fundingPoints, { from, to }, ctx, fundingFunnel));
    if (want("price_structure")) add(evaluateStructure(ctx, { from, to }, structureFunnel));
  }
  if (want("whale")) funnels.whale = whaleFunnel;
  if (want("funding")) funnels.funding = fundingFunnel;
  if (want("price_structure")) funnels.priceStructure = structureFunnel;

  const out: GroupOut[] = [];
  let measured = 0;
  let defaulted = 0;
  for (const g of groups.values()) {
    const report = groupReport(g.trades);
    report.skipped = g.skipped;
    report.skipReasons = g.skipReasons;
    const entered = g.trades.filter((t) => t.status === "entered");
    for (const t of entered)
      if (t.flags.includes("spread_default")) defaulted += 1;
      else measured += 1;
    const group: GroupOut = {
      type: g.type,
      variant: g.variant,
      ruleVersion: g.version,
      report,
      trades: g.trades,
      skippedNotListed: Math.max(0, g.skipped - MAX_SKIPPED_LISTED),
    };
    if (g.type === "whale")
      group.byScore = [
        { band: "score < 0.5", stats: periodStats(entered.filter((t) => (t.score ?? 0) < 0.5)) },
        { band: "score ≥ 0.5", stats: periodStats(entered.filter((t) => (t.score ?? 0) >= 0.5)) },
      ];
    out.push(group);
  }

  let riskFilter: SignalReplayReport["riskFilter"] = null;
  if (want("risk_filter")) {
    o.checkDeadline();
    const vb = await loadVbRoundTrips(q, o.from, o.to);
    o.checkDeadline();
    const mm = await loadMmFills(q, o.from, o.to);
    const inRange = pauseWindows(from, to);
    riskFilter = {
      calendarVersion: MACRO_CALENDAR_VERSION,
      calendarVerified: inRange.every((w) => w.verified),
      windows: inRange,
      marketWideNews:
        "Not available: no market-wide news table yet (the #271 collector will add it); only scheduled macro windows are used.",
      volumeBuilder: { ...filterVb(vb.trades, inRange), unclosedRoundTrips: vb.unclosed },
      marketMaking: filterMm(mm, inRange),
    };
  }

  const days = fundingCov.map((c) => c.days);
  const limitations: string[] = [
    "Prices are SoDEX 1-minute candles (close / high / low), not bid / ask; a candle that touches both TP and SL counts as SL.",
    `Costs: SoDEX base taker fee ${COSTS_V1.takerBpPerLeg.toString()} bp per leg (no per-market fee, no REST call), builder fee ${COSTS_V1.builderBpPerLeg.toString()} bp per leg, plus one spread; spread from mm_market_hourly with a tick size inferred from the candle price grid (conservative: an inferred tick can only be a multiple of the real one), otherwise a default (3 bp BTC / ETH, 10 bp others) flagged spread_default.`,
    "Random baseline = expected result of a random direction at the same moment with the in-sample Long / Short mix, TP, SL and max hold. It tests direction, not timing (a random-time baseline is follow-up work). A group that is all long or all short cannot beat it by construction (flagged).",
    "Likely ranges are a day-block bootstrap (trades clustered by entry day, UTC); the independent normal range is kept as normalCiLow / normalCiHigh. 'Trades needed' uses the clustered standard error.",
    "Gate uses the out-of-sample third; 'both periods' are the in-sample 2/3 and the out-of-sample 1/3 by entry time. Max drawdown is reported but not gated: the acceptable drawdown threshold is pending a decision.",
    "A hold with a candle gap over 30 min anywhere in it is skipped whatever the outcome; a gap where BTC-USD kept trading is counted separately as an illiquid market, a gap BTC-USD shares is collector downtime. Tick size is inferred from the first 5,000 loaded candles (before most trades).",
  ];
  if (whaleCov !== null)
    limitations.push(
      `Whales: ${WHALE_POPULATION} Data exists only since tracking began; events seen more than 5 min after the whale's fill (backfill when tracking starts, or collector downtime) are not tradeable and are only counted. Wallet quality and 'usual size' come from the last leaderboard run that finished before the event.`,
    );
  if (want("funding"))
    limitations.push(
      "Funding: SoDEX has no funding history API; funding_rates only exists since DeskLabs started recording it. Signals with less than 90 days of history are flagged funding_history_short; ≥ 100 prior periods are required.",
    );
  if (riskFilter !== null)
    limitations.push(
      `Risk filter: the macro calendar is hand-written (${MACRO_CALENDAR_VERSION}) and NOT verified against the Fed / BLS sources. Market Making is replayed per fill with a 5-minute markout and only removes position-increasing fills; it does not re-simulate the bot after a skipped fill. Market Making's starting position is the sum of all earlier fills, so liquidations or reconciliation adjustments outside fills can mislabel opening fills. Volume Builder removes whole round trips whose first entry ORDER was placed in a window; round trips that never fully closed are counted, not replayed. Do not use D1 results before the calendar dates are checked.`,
    );

  return {
    kind: "signal-replay",
    generatedAt: new Date().toISOString(),
    range: { from: o.from.toISOString(), to: o.to.toISOString() },
    source: "database (read-only)",
    rules: {
      trade: TRADE_RULES_V1,
      costs: COSTS_V1,
      whale: WHALE_RULES_V1,
      funding: FUNDING_RULES_V1,
      priceStructure: STRUCTURE_RULES_V1,
      pauseWindow: PAUSE_WINDOW_V1,
      limits: LIMITS,
    },
    coverage: {
      markets: markets.length,
      marketsWithCandles: withCandles,
      whales:
        whaleCov === null
          ? null
          : {
              ...whaleCov,
              limit:
                whaleCov.firstRankingFinishedAt === null
                  ? `No finished leaderboard run: no whale event can pass the anti-survivorship rule. ${WHALE_POPULATION}`
                  : `Whale events start ${new Date(whaleCov.firstEventSeenAt ?? 0).toISOString()}; the first leaderboard run finished ${new Date(whaleCov.firstRankingFinishedAt).toISOString()}. Nothing before tracking began is available. ${WHALE_POPULATION}`,
            },
      funding: want("funding")
        ? {
            markets: fundingCov.length,
            totalPoints: fundingCov.reduce((s, c) => s + c.points, 0),
            medianDays: median(days),
            marketsWith90Days: days.filter((d) => d >= 90).length,
            perMarket: fundingCov,
          }
        : null,
      spread: { tradesMeasured: measured, tradesDefault: defaulted },
    },
    funnels,
    groups: out,
    riskFilter,
    limitations,
  };
}
