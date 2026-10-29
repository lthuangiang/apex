import type { AccountMetrics, HoldingBucket } from "../analysis/account";
import { feeRateToPercent, DRIFT_BUILDER_FEE_RATE } from "../fees";
import { formatDecimal } from "../format";
import { Decimal, dec, toDecimalString, type DecimalInput } from "../money";

import { RECO_CONFIG as C, RECO_INPUTS_VERSION } from "./config";
import {
  dcaLadder,
  leverageFor,
  maxDrawdown30Pct,
  medianAbsReturnPct,
  minOrderNotional,
  paramsFor,
  type ParamContext,
  type Params,
} from "./params";
import type {
  NotSuggested,
  RecoInput,
  RecoMarket,
  RecoPlan,
  RecoStrategy,
  Suggestion,
} from "./types";

// Engine đề xuất tất định (RECO_ENGINE.md mục 10). Không I/O, không đồng hồ: `now` đi vào qua input.
// Mọi số trong câu lý do lấy từ đầu vào; không bao giờ trả lợi nhuận dự kiến.

const GROUP: Record<RecoStrategy, string> = {
  spot_grid: "grid",
  futures_grid: "grid",
  spot_dca: "dca",
  futures_dca: "dca",
  recurring_buy: "accumulate",
  rebalancing: "portfolio",
  funding_arb: "arb",
};
const ORDER: readonly RecoStrategy[] = [
  "spot_grid",
  "futures_grid",
  "spot_dca",
  "futures_dca",
  "recurring_buy",
  "rebalancing",
  "funding_arb",
];
const fmt = (v: DecimalInput | number, digits = 2, sign = false) =>
  formatDecimal(
    (typeof v === "number" ? new Decimal(v) : dec(v)).toDecimalPlaces(
      digits,
      Decimal.ROUND_HALF_UP,
    ),
    {
      locale: "en-US",
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: sign ? "exceptZero" : "auto",
    },
  ) ?? "";

/** FNV-1a 64-bit, cho id tất định của suggestion. */
function fnv(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < s.length; i += 1) {
    h ^= BigInt(s.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

export function maxDropPct(d: RecoInput["goals"]["maxDrop"]): number {
  return d === "unsure" ? 5 : Number(d);
}

/** fee_rt (%) = 2 × (maker fee + builder fee của DRIFT). Maker fee đo từ fill maker của người dùng, thiếu thì dùng mức cơ bản. */
export function feeRtPct(engine: "spot" | "perps", account: AccountMetrics | null): Decimal {
  const measured = account?.makerFeePct[engine] ?? null;
  const maker = dec(measured ?? C.baseMakerFeePct[engine]);
  return maker.add(feeRateToPercent(DRIFT_BUILDER_FEE_RATE)).mul(2);
}

interface AssetHistory {
  netPnl: Decimal;
  winRate: number | null;
  volumeShare: Decimal;
  closed: number;
}

/** Gộp lịch sử theo tài sản: BTC-USD và vBTC_vUSDC cùng là BTC. */
export function assetOf(market: string): string {
  const base = market.includes("_")
    ? (market.split("_")[0] ?? market)
    : (market.split("-")[0] ?? market);
  return base.replace(/^v(?=[A-Z])/, "");
}

function historyByAsset(account: AccountMetrics | null): Map<string, AssetHistory> {
  const out = new Map<string, AssetHistory>();
  for (const m of account?.byMarket ?? []) {
    const a = assetOf(m.market);
    const cur = out.get(a) ?? {
      netPnl: new Decimal(0),
      winRate: null,
      volumeShare: new Decimal(0),
      closed: 0,
    };
    const wins = m.winRate === null ? null : Number(m.winRate) * m.closed;
    const prevWins = cur.winRate === null ? null : cur.winRate * cur.closed;
    const closed = cur.closed + m.closed;
    out.set(a, {
      netPnl: cur.netPnl.add(m.netPnl),
      volumeShare: cur.volumeShare.add(m.volumeShare),
      closed,
      winRate:
        closed === 0 || (wins === null && prevWins === null)
          ? null
          : ((wins ?? 0) + (prevWins ?? 0)) / closed,
    });
  }
  return out;
}

function minCapital(strategy: RecoStrategy, ctx: ParamContext): Decimal {
  const m = ctx.market;
  const minOrder = minOrderNotional(m);
  switch (strategy) {
    case "spot_grid":
      return minOrder.mul(C.eligibility.gridMinLevels);
    case "futures_grid":
      return minOrder.mul(C.eligibility.gridMinLevels).div(leverageFor(ctx));
    case "spot_dca":
    case "futures_dca": {
      const med = medianAbsReturnPct(m.closes);
      const dd = maxDrawdown30Pct(m.closes);
      if (med === null || dd === null) return new Decimal(Infinity);
      const first = Decimal.max(dec(C.dca.firstMinPct), med);
      let n = 1;
      let off = first;
      while (n < C.dca.maxSafety && off.lt(dd)) {
        off = off.add(first.mul(dec(C.dca.stepMultiplier).pow(n)));
        n += 1;
      }
      const lev = strategy === "futures_dca" ? leverageFor(ctx) : 1;
      // dcaLadder(capital, n) = capital / units → capital = minOrder / lev × units.
      return minOrder.div(lev).div(dcaLadder("1", n));
    }
    case "recurring_buy":
      return minOrder.mul(C.recurring.buys);
    case "rebalancing":
      return minOrder
        .mul(100)
        .div(C.rebalancing.stableMinPct)
        .mul(Math.max(1, ctx.basket?.length ?? 1));
    case "funding_arb":
      return Decimal.max(dec(C.eligibility.fundingArbMinCapital), minOrder.mul(2));
  }
}

interface Candidate {
  strategy: RecoStrategy;
  market: RecoMarket;
  ctx: ParamContext;
  score: number;
  min: Decimal;
}

export function recommend(input: RecoInput, timeZone: string): RecoPlan {
  const { goals, account } = input;
  const capital = dec(goals.capital);
  const d = maxDropPct(goals.maxDrop);
  const isNew = account === null || account.closedPositions < C.newTraderMaxClosed;
  const hist = historyByAsset(isNew ? null : account);
  const chosen = new Set(goals.assets);
  const notes: string[] = [];
  const notSuggested: NotSuggested[] = [];

  if (isNew)
    notes.push(
      `You have fewer than ${String(C.newTraderMaxClosed)} closed positions, so these suggestions don't use your trading history.`,
    );

  // ---- Loại trừ (mục 10.3) ----
  let forceOneX = false;
  if (!isNew) {
    const short = account.pnlByHolding[C.exclusions.shortHoldingBucket];
    if (dec(short.netPnl).lt(0)) {
      notSuggested.push({
        title: "Fast in-and-out trading",
        reason: `Your trades under 15 minutes lost ${fmt(dec(short.netPnl).abs())} after fees.`,
      });
    }
    for (const [asset, h] of [...hist.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (
        !chosen.has(asset) &&
        h.netPnl.lt(0) &&
        h.winRate !== null &&
        h.winRate < C.exclusions.marketLossMaxWinRate
      ) {
        notSuggested.push({
          title: `${asset} strategies`,
          reason: `${asset}: ${fmt(h.netPnl, 2, true)} net with a ${fmt(h.winRate * 100, 0)}% win rate.`,
        });
      }
    }
    const high = account.lossShareByLeverage?.["≥8x"] ?? null;
    if (high !== null && Number(high) > C.exclusions.highLeverageLossShare) {
      forceOneX = true;
      notes.push(
        `Positions at 8× or more caused ${fmt(Number(high) * 100, 0)}% of your losses, so perp bots use 1×.`,
      );
    }
  }

  // ---- Ứng viên (mục 10.2) ----
  const markets = [...input.markets].sort((a, b) => a.market.localeCompare(b.market));
  const spotOf = (asset: string) => markets.find((m) => m.engine === "spot" && m.asset === asset);
  const basket = markets
    .filter((m) => m.engine === "spot" && chosen.has(m.asset))
    .map((m) => ({
      asset: m.asset,
      market: m.market,
      volumeShare: hist.get(m.asset)?.volumeShare.toString() ?? "0",
      sigma30: m.sigma30,
    }));

  const candidates: Candidate[] = [];
  const excludedByDrop = new Set<string>();
  const consider = (
    strategy: RecoStrategy,
    market: RecoMarket,
    extra: Partial<ParamContext> = {},
  ) => {
    const ctx: ParamContext = {
      market,
      capital: goals.capital,
      maxDropPct: d,
      feeRtPct: feeRtPct(market.engine, isNew ? null : account),
      forceOneX,
      accountLeverageCap: input.accountLeverageCap,
      timeZone,
      ...extra,
    };
    const min = minCapital(strategy, ctx);
    if (!min.isFinite() || min.gt(capital)) return;
    const p = paramsFor(strategy, { ...ctx, capital: toDecimalString(capital) });
    if (p === null) return;
    if (
      p.lossAtStopPct !== null &&
      p.lossAtStopPct > d &&
      (strategy === "futures_grid" || strategy === "futures_dca")
    ) {
      excludedByDrop.add(strategy === "futures_grid" ? "Futures Grid" : "Futures DCA");
      return;
    }
    candidates.push({
      strategy,
      market,
      ctx,
      score: score(strategy, market, input, hist, isNew),
      min,
    });
  };

  for (const m of markets) {
    if (!chosen.has(m.asset)) continue;
    const sigmaPct = m.sigma30 === null ? null : m.sigma30 * 100;
    const h = hist.get(m.asset);
    if (m.engine === "spot") {
      if ((m.rangeScore ?? 0) >= C.eligibility.gridMinRangeScore) consider("spot_grid", m);
      if (
        ["automate", "range", "steady"].includes(goals.goal) &&
        sigmaPct !== null &&
        sigmaPct >= C.eligibility.dcaSigmaMinPct &&
        sigmaPct <= C.eligibility.dcaSigmaMaxPct
      )
        consider("spot_dca", m);
      if (
        ["accumulate", "steady"].includes(goals.goal) &&
        (C.eligibility.recurringBuyAssets as readonly string[]).includes(m.asset)
      )
        consider("recurring_buy", m);
    } else {
      if ((m.rangeScore ?? 0) >= C.eligibility.gridMinRangeScore && goals.goal !== "steady")
        consider("futures_grid", m);
      if (
        !isNew &&
        goals.goal === "automate" &&
        account.hasPerpsHistory &&
        h !== undefined &&
        h.netPnl.gt(0) &&
        d >= C.eligibility.futuresDcaMinDropPct
      )
        consider("futures_dca", m);
      const spot = spotOf(m.asset);
      if (
        spot !== undefined &&
        m.fundingAvg7d !== null &&
        dec(m.fundingAvg7d).gte(C.eligibility.fundingArbMinAvg7dPct) &&
        (m.fundingPos21 ?? 0) >= C.eligibility.fundingArbMinPositiveShare21
      )
        consider("funding_arb", m, { spotMarket: spot });
    }
  }
  const firstSpot =
    basket[0] === undefined ? undefined : markets.find((m) => m.market === basket[0]?.market);
  if (
    basket.length >= C.eligibility.rebalancingMinAssets &&
    ["accumulate", "steady"].includes(goals.goal) &&
    firstSpot !== undefined
  ) {
    consider("rebalancing", firstSpot, { basket });
  }
  for (const title of [...excludedByDrop].sort()) {
    notSuggested.push({ title, reason: `Above your ${String(d)}% max drop at any useful size.` });
  }

  // ---- Chọn (mục 10.4) ----
  candidates.sort(
    (a, b) =>
      b.score - a.score ||
      a.min.comparedTo(b.min) ||
      ORDER.indexOf(a.strategy) - ORDER.indexOf(b.strategy) ||
      a.market.market.localeCompare(b.market.market),
  );
  const best = candidates[0];
  if (best === undefined) {
    return {
      best: null,
      addOns: [],
      notSuggested,
      notes,
      capital: toDecimalString(capital),
      empty: "No strategy fits your answers yet. Try a larger capital or a different goal.",
    };
  }
  const addOn = candidates
    .slice(1)
    .find(
      (c) => c.market.market !== best.market.market || GROUP[c.strategy] !== GROUP[best.strategy],
    );

  // ---- Chia vốn ----
  let bestCap = capital;
  let addCap: Decimal | null = null;
  if (addOn !== undefined) {
    let b = capital.mul(C.split.best);
    let a = capital.sub(b);
    if (b.lt(best.min)) {
      b = best.min;
      a = capital.sub(b);
    }
    if (a.lt(addOn.min)) {
      a = addOn.min;
      b = capital.sub(a);
    }
    if (b.gte(best.min) && a.gte(addOn.min)) {
      bestCap = b;
      addCap = a;
    }
  }
  const build = (c: Candidate, cap: Decimal): Suggestion | null => {
    const p: Params | null = paramsFor(c.strategy, {
      ...c.ctx,
      capital: toDecimalString(cap.toDecimalPlaces(2, Decimal.ROUND_DOWN)),
    });
    if (p === null) return null;
    const h = hist.get(c.market.asset);
    const reasons = [...p.reasons];
    if (!isNew && h?.netPnl.gt(0) === true) {
      reasons.unshift(
        `${c.market.asset} was net positive for you (${fmt(h.netPnl, 2, true)}${h.winRate === null ? "" : `, ${fmt(h.winRate * 100, 0)}% win rate`}).`,
      );
    }
    const id = fnv(
      JSON.stringify([RECO_INPUTS_VERSION, c.strategy, c.market.market, p.values, input.now]),
    );
    return {
      id,
      strategy: c.strategy,
      market: c.market.market,
      values: p.values,
      capital: toDecimalString(cap.toDecimalPlaces(2, Decimal.ROUND_DOWN)),
      score: c.score,
      reasons: reasons.slice(0, 3),
      basis: p.basis,
      computedAt: new Date(input.now).toISOString(),
      inputsVersion: RECO_INPUTS_VERSION,
    };
  };
  const bestS = build(best, bestCap);
  const addS = addOn !== undefined && addCap !== null ? build(addOn, addCap) : null;
  return {
    best: bestS,
    addOns: addS === null ? [] : [addS],
    notSuggested,
    notes,
    capital: toDecimalString(capital),
    empty:
      bestS === null
        ? "No strategy fits your answers yet. Try a larger capital or a different goal."
        : null,
  };
}

function score(
  strategy: RecoStrategy,
  m: RecoMarket,
  input: RecoInput,
  hist: Map<string, AssetHistory>,
  isNew: boolean,
): number {
  const goalTable: Partial<Record<RecoStrategy, number>> = C.goalFit[input.goals.goal];
  const goalFit = strategy === "funding_arb" ? C.fundingArbGoalFit : (goalTable[strategy] ?? 0);
  let historyFit = 0;
  const h = hist.get(m.asset);
  if (!isNew && h !== undefined && input.account !== null) {
    if (h.netPnl.gt(0)) historyFit += C.history.netPositive;
    if (GROUP[strategy] === "grid" || GROUP[strategy] === "dca") {
      const buckets: HoldingBucket[] = ["4h–1d", "1–7d"];
      const acc = input.account;
      if (buckets.reduce((s, b) => s.add(acc.pnlByHolding[b].netPnl), new Decimal(0)).gt(0))
        historyFit += C.history.holdingPositive;
    }
    if (h.winRate !== null && h.winRate >= C.history.winRateMin) historyFit += C.history.winRate;
  }
  let marketFit: number;
  const sigmaPct = m.sigma30 === null ? null : m.sigma30 * 100;
  switch (GROUP[strategy]) {
    case "grid":
      marketFit = C.marketFit.max * (m.rangeScore ?? 0);
      break;
    case "dca":
      marketFit =
        sigmaPct !== null &&
        sigmaPct >= C.eligibility.dcaSigmaMinPct &&
        sigmaPct <= C.marketFit.dcaSigmaGoodMaxPct
          ? C.marketFit.max
          : C.marketFit.dcaOutside;
      break;
    case "arb":
      marketFit = C.marketFit.max * (m.fundingPos21 ?? 0);
      break;
    default:
      marketFit = C.marketFit.flat;
  }
  const maker =
    GROUP[strategy] === "grid" || GROUP[strategy] === "dca" || strategy === "rebalancing";
  const takerRatio = input.account?.takerRatio ?? null;
  const costFit =
    maker && takerRatio !== null && Number(takerRatio) >= C.costFit.takerRatioMin
      ? C.costFit.makerHighTaker
      : C.costFit.other;
  // Làm tròn 2 chữ số để so sánh tất định.
  return Math.round((goalFit + historyFit + marketFit + costFit) * 100) / 100;
}

/** "✦ AI parameters" cho một bot cụ thể (màn tạo bot / Retune with AI). */
export function aiParameters(
  strategy: RecoStrategy,
  market: RecoMarket,
  input: Pick<RecoInput, "account" | "accountLeverageCap" | "now"> & {
    capital: string;
    maxDrop: RecoInput["goals"]["maxDrop"];
    markets: readonly RecoMarket[];
  },
  timeZone: string,
): Suggestion | null {
  const account = input.account;
  const isNew = account === null || account.closedPositions < C.newTraderMaxClosed;
  const high = isNew ? null : (account.lossShareByLeverage?.["≥8x"] ?? null);
  const spotMarket = input.markets.find((m) => m.engine === "spot" && m.asset === market.asset);
  if (strategy === "funding_arb" && spotMarket === undefined) return null;
  const ctx: ParamContext = {
    market,
    capital: input.capital,
    maxDropPct: maxDropPct(input.maxDrop),
    feeRtPct: feeRtPct(market.engine, isNew ? null : account),
    forceOneX: high !== null && Number(high) > C.exclusions.highLeverageLossShare,
    accountLeverageCap: input.accountLeverageCap,
    timeZone,
    ...(strategy === "funding_arb" && spotMarket !== undefined ? { spotMarket } : {}),
  };
  const p = paramsFor(strategy, ctx);
  if (p === null) return null;
  return {
    id: fnv(JSON.stringify([RECO_INPUTS_VERSION, strategy, market.market, p.values, input.now])),
    strategy,
    market: market.market,
    values: p.values,
    capital: input.capital,
    score: 0,
    reasons: p.reasons.slice(0, 3),
    basis: p.basis,
    computedAt: new Date(input.now).toISOString(),
    inputsVersion: RECO_INPUTS_VERSION,
  };
}
