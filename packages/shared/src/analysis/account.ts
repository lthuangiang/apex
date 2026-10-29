import { add, dec, Decimal, div, gt, isNegative, mul, sub, sum, type DecimalInput } from "../money";

// Phân tích account cho onboarding bước 4 (SCREENS.md mục 8.1) và đầu vào A của engine đề xuất
// (RECO_ENGINE.md mục 10.1). Hàm thuần, không I/O. Định nghĩa chi tiết: DEC-34.
//   - Chỉ tính PnL đã chốt; không bao giờ tính PnL chưa chốt.
//   - lãi ròng = lãi gộp − phí − funding (funding dương = trả, âm = nhận).
//   - win rate tính trên vị thế đã đóng; vị thế thắng khi PnL ròng (sau phí) > 0.

export const HOLDING_BUCKETS = ["<15m", "15m–4h", "4h–1d", "1–7d", ">7d"] as const;
export type HoldingBucket = (typeof HOLDING_BUCKETS)[number];
export const LEVERAGE_BUCKETS = ["<3x", "3–8x", "≥8x"] as const;
export type LeverageBucket = (typeof LEVERAGE_BUCKETS)[number];
/** Dưới ngưỡng này coi là người mới (RECO_ENGINE.md mục 10.1). */
export const NEW_TRADER_MAX_CLOSED = 30;
export const CURVE_POINTS = 120;

export interface PerpsClosedPosition {
  market: string;
  side: "LONG" | "SHORT";
  entryPrice: string;
  closePrice: string;
  closedSize: string;
  /** Tổng phí giao dịch của vị thế. */
  fees: string;
  leverage: number;
  openedAt: number;
  closedAt: number;
}

export interface PerpsFunding {
  market: string;
  /** Dương = trả, âm = nhận. */
  amount: string;
  at: number;
}

export interface Fill {
  market: string;
  side: "BUY" | "SELL";
  price: string;
  quantity: string;
  /** Phí quy ra quote asset (đã gồm builder fee). */
  feeQuote: string;
  isMaker: boolean | null;
  at: number;
}

export interface AccountAnalysisInput {
  perpsPositions: readonly PerpsClosedPosition[];
  perpsFundings: readonly PerpsFunding[];
  perpsFills: readonly Fill[];
  spotFills: readonly Fill[];
  /** Equity hiện tại (USDC) để quy drawdown ra %; null = không có. */
  equity: string | null;
}

interface ClosedTrade {
  market: string;
  gross: Decimal;
  fees: Decimal;
  net: Decimal;
  holdingMs: number;
  closedAt: number;
  leverage: number | null;
}

export interface MarketMetrics {
  market: string;
  closed: number;
  fees: string;
  netPnl: string;
  winRate: string | null;
  volumeShare: string;
}

export interface AccountMetrics {
  periodStart: number | null;
  periodEnd: number | null;
  closedPositions: number;
  isNewTrader: boolean;
  grossRealizedPnl: string;
  fees: string;
  netFunding: string;
  netPnl: string;
  winRate: string | null;
  maxDrawdown: string;
  maxDrawdownPct: string | null;
  takerRatio: string | null;
  /** Maker fee thực tế (%) = Σ phí / Σ notional của fill maker, theo engine; null khi chưa có fill maker. */
  makerFeePct: { spot: string | null; perps: string | null };
  avgHoldWinnersMs: number | null;
  avgHoldLosersMs: number | null;
  hasPerpsHistory: boolean;
  avgWin: string | null;
  avgLoss: string | null;
  medianLeverage: number | null;
  maxLeverage: number | null;
  /** Khoảng thời gian của drawdown lớn nhất (đỉnh → đáy). */
  drawdownFrom: number | null;
  drawdownTo: number | null;
  /** Đường lãi ròng luỹ kế, tối đa CURVE_POINTS điểm. */
  curve: { at: number; cumulative: string }[];
  byMarket: MarketMetrics[];
  pnlByHolding: Record<HoldingBucket, { netPnl: string; closed: number }>;
  lossShareByLeverage: Record<LeverageBucket, string> | null;
  /** Tỷ lệ vị thế Perps đã đóng có đòn bẩy ≥ 8×. */
  highLeveragePositionShare: string | null;
  /** Lượng bán Spot không ghép được với lệnh mua trong lịch sử (không tính PnL). */
  unmatchedSpotSells: Record<string, string>;
}

export function holdingBucket(ms: number): HoldingBucket {
  const minute = 60_000;
  if (ms < 15 * minute) return "<15m";
  if (ms < 4 * 60 * minute) return "15m–4h";
  if (ms < 24 * 60 * minute) return "4h–1d";
  if (ms < 7 * 24 * 60 * minute) return "1–7d";
  return ">7d";
}

export function leverageBucket(leverage: number): LeverageBucket {
  if (leverage < 3) return "<3x";
  if (leverage < 8) return "3–8x";
  return "≥8x";
}

function perpsTrade(p: PerpsClosedPosition): ClosedTrade {
  const move = sub(p.closePrice, p.entryPrice);
  const gross = mul(p.side === "SHORT" ? move.neg() : move, p.closedSize);
  const fees = dec(p.fees);
  return {
    market: p.market,
    gross,
    fees,
    net: gross.sub(fees),
    holdingMs: Math.max(0, p.closedAt - p.openedAt),
    closedAt: p.closedAt,
    leverage: p.leverage,
  };
}

/**
 * Spot: ghép FIFO theo từng market. Mỗi lệnh bán ghép được là một "vị thế đã đóng"; phí mua phân bổ
 * theo khối lượng. Thời gian giữ = trung bình có trọng số theo khối lượng.
 */
function spotTrades(fills: readonly Fill[]): {
  trades: ClosedTrade[];
  unmatched: Record<string, string>;
} {
  const lots = new Map<
    string,
    { qty: Decimal; price: Decimal; feePerUnit: Decimal; at: number }[]
  >();
  const trades: ClosedTrade[] = [];
  const unmatched: Record<string, string> = {};
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    const queue = lots.get(f.market) ?? [];
    lots.set(f.market, queue);
    const qty = dec(f.quantity);
    if (f.side === "BUY") {
      queue.push({
        qty,
        price: dec(f.price),
        feePerUnit: qty.isZero() ? new Decimal(0) : div(f.feeQuote, qty),
        at: f.at,
      });
      continue;
    }
    let left = qty;
    let gross = new Decimal(0);
    let buyFees = new Decimal(0);
    let weightedHold = new Decimal(0);
    let matched = new Decimal(0);
    while (left.gt(0) && queue.length > 0) {
      const lot = queue[0];
      if (lot === undefined) break;
      const take = Decimal.min(left, lot.qty);
      gross = gross.add(dec(f.price).sub(lot.price).mul(take));
      buyFees = buyFees.add(lot.feePerUnit.mul(take));
      weightedHold = weightedHold.add(take.mul(f.at - lot.at));
      matched = matched.add(take);
      lot.qty = lot.qty.sub(take);
      left = left.sub(take);
      if (lot.qty.isZero()) queue.shift();
    }
    if (left.gt(0)) unmatched[f.market] = add(unmatched[f.market] ?? "0", left).toString();
    if (matched.isZero()) continue;
    const sellFee = mul(f.feeQuote, div(matched, qty));
    const fees = buyFees.add(sellFee);
    trades.push({
      market: f.market,
      gross,
      fees,
      net: gross.sub(fees),
      holdingMs: weightedHold.div(matched).round().toNumber(),
      closedAt: f.at,
      leverage: null,
    });
  }
  return { trades, unmatched };
}

const ratio = (part: DecimalInput, whole: DecimalInput): string | null =>
  dec(whole).isZero() ? null : div(part, whole).toString();

export function analyzeAccount(input: AccountAnalysisInput): AccountMetrics {
  const perps = input.perpsPositions.map(perpsTrade);
  const spot = spotTrades(input.spotFills);
  const closed = [...perps, ...spot.trades].sort((a, b) => a.closedAt - b.closedAt);

  const gross = sum(closed.map((t) => t.gross));
  const fees = sum(closed.map((t) => t.fees));
  const funding = sum(input.perpsFundings.map((f) => f.amount));
  const net = gross.sub(fees).sub(funding);
  const winners = closed.filter((t) => gt(t.net, "0"));
  const losers = closed.filter((t) => !gt(t.net, "0"));

  // Drawdown trên đường lãi ròng đã chốt luỹ kế (theo thời điểm đóng; funding cộng theo thời điểm trả).
  const events = [
    ...closed.map((t) => ({ at: t.closedAt, delta: t.net })),
    ...input.perpsFundings.map((f) => ({ at: f.at, delta: dec(f.amount).neg() })),
  ].sort((a, b) => a.at - b.at);
  let cumulative = new Decimal(0);
  let peak = new Decimal(0);
  let maxDrawdown = new Decimal(0);
  // Đường equity dựng lại: equity(t) = equity hiện tại − (lãi luỹ kế cuối − lãi luỹ kế tại t).
  // Không có lịch sử nạp/rút từ SoDEX nên giả định không có chuyển tiền (DEC-34).
  const finalCumulative = sum(events.map((e) => e.delta));
  const equityNow = input.equity === null ? null : dec(input.equity);
  const equityAt = (c: Decimal) =>
    equityNow === null ? null : equityNow.sub(finalCumulative).add(c);
  let peakEquity = equityAt(new Decimal(0));
  let peakAt: number | null = null;
  let drawdownFrom: number | null = null;
  let drawdownTo: number | null = null;
  const curveAll: { at: number; cumulative: string }[] = [];
  let maxDrawdownPct: Decimal | null = equityNow === null ? null : new Decimal(0);
  for (const e of events) {
    cumulative = cumulative.add(e.delta);
    curveAll.push({ at: e.at, cumulative: cumulative.toString() });
    if (cumulative.gt(peak)) {
      peak = cumulative;
      peakAt = e.at;
    }
    if (peak.sub(cumulative).gt(maxDrawdown)) {
      maxDrawdown = peak.sub(cumulative);
      drawdownFrom = peakAt ?? events[0]?.at ?? e.at;
      drawdownTo = e.at;
    }
    const eq = equityAt(cumulative);
    if (eq !== null && peakEquity !== null && maxDrawdownPct !== null) {
      peakEquity = Decimal.max(peakEquity, eq);
      if (peakEquity.gt(0))
        maxDrawdownPct = Decimal.max(maxDrawdownPct, peakEquity.sub(eq).div(peakEquity));
    }
  }

  const allFills = [...input.perpsFills, ...input.spotFills];
  const notional = (f: Fill) => mul(f.price, f.quantity);
  const totalNotional = sum(allFills.map(notional));
  const known = allFills.filter((f) => f.isMaker !== null);
  const takerNotional = sum(known.filter((f) => f.isMaker === false).map(notional));
  const knownNotional = sum(known.map(notional));
  const makerFeePct = (fills: readonly Fill[]) => {
    const makers = fills.filter((f) => f.isMaker === true);
    const n = sum(makers.map(notional));
    return n.isZero()
      ? null
      : sum(makers.map((f) => f.feeQuote))
          .div(n)
          .mul(100)
          .toString();
  };

  const markets = [
    ...new Set([...closed.map((t) => t.market), ...allFills.map((f) => f.market)]),
  ].sort();
  const byMarket = markets.map((market) => {
    const mt = closed.filter((t) => t.market === market);
    const mFunding = sum(
      input.perpsFundings.filter((f) => f.market === market).map((f) => f.amount),
    );
    const mNet = sum(mt.map((t) => t.net)).sub(mFunding);
    const mVolume = sum(allFills.filter((f) => f.market === market).map(notional));
    return {
      market,
      closed: mt.length,
      fees: sum(mt.map((t) => t.fees)).toString(),
      netPnl: mNet.toString(),
      winRate:
        mt.length === 0
          ? null
          : div(String(mt.filter((t) => gt(t.net, "0")).length), String(mt.length)).toString(),
      volumeShare: ratio(mVolume, totalNotional) ?? "0",
    };
  });

  const pnlByHolding = Object.fromEntries(
    HOLDING_BUCKETS.map((b) => {
      const inBucket = closed.filter((t) => holdingBucket(t.holdingMs) === b);
      return [b, { netPnl: sum(inBucket.map((t) => t.net)).toString(), closed: inBucket.length }];
    }),
  ) as Record<HoldingBucket, { netPnl: string; closed: number }>;

  const perpsLosses = perps.filter((t) => isNegative(t.net));
  const totalLoss = sum(perpsLosses.map((t) => t.net.abs()));
  const lossShareByLeverage = totalLoss.isZero()
    ? null
    : (Object.fromEntries(
        LEVERAGE_BUCKETS.map((b) => [
          b,
          div(
            sum(
              perpsLosses
                .filter((t) => leverageBucket(t.leverage ?? 1) === b)
                .map((t) => t.net.abs()),
            ),
            totalLoss,
          ).toString(),
        ]),
      ) as Record<LeverageBucket, string>);

  const avg = (list: ClosedTrade[]) =>
    list.length === 0 ? null : Math.round(list.reduce((s, t) => s + t.holdingMs, 0) / list.length);
  const step = Math.max(1, Math.ceil(curveAll.length / CURVE_POINTS));
  const curve = curveAll.filter((_, i) => i % step === 0 || i === curveAll.length - 1);
  const leverages = perps.map((t) => t.leverage ?? 1).sort((a, b) => a - b);
  const median = (xs: number[]) => {
    if (xs.length === 0) return null;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 === 1 ? (xs[mid] ?? null) : ((xs[mid - 1] ?? 0) + (xs[mid] ?? 0)) / 2;
  };
  const losing = closed.filter((t) => isNegative(t.net));
  const times = [
    ...closed.map((t) => t.closedAt),
    ...allFills.map((f) => f.at),
    ...input.perpsFundings.map((f) => f.at),
  ];

  return {
    periodStart: times.length === 0 ? null : Math.min(...times),
    periodEnd: times.length === 0 ? null : Math.max(...times),
    closedPositions: closed.length,
    isNewTrader: closed.length < NEW_TRADER_MAX_CLOSED,
    grossRealizedPnl: gross.toString(),
    fees: fees.toString(),
    netFunding: funding.toString(),
    netPnl: net.toString(),
    winRate:
      closed.length === 0 ? null : div(String(winners.length), String(closed.length)).toString(),
    maxDrawdown: maxDrawdown.toString(),
    maxDrawdownPct: maxDrawdownPct === null ? null : maxDrawdownPct.toString(),
    takerRatio: ratio(takerNotional, knownNotional),
    makerFeePct: { spot: makerFeePct(input.spotFills), perps: makerFeePct(input.perpsFills) },
    avgHoldWinnersMs: avg(winners),
    avgHoldLosersMs: avg(losers),
    hasPerpsHistory: input.perpsPositions.length > 0 || input.perpsFills.length > 0,
    avgWin:
      winners.length === 0
        ? null
        : sum(winners.map((t) => t.net))
            .div(winners.length)
            .toString(),
    avgLoss:
      losing.length === 0
        ? null
        : sum(losing.map((t) => t.net))
            .div(losing.length)
            .toString(),
    medianLeverage: median(leverages),
    maxLeverage: leverages.at(-1) ?? null,
    drawdownFrom: maxDrawdown.isZero() ? null : drawdownFrom,
    drawdownTo: maxDrawdown.isZero() ? null : drawdownTo,
    curve,
    byMarket,
    pnlByHolding,
    lossShareByLeverage,
    highLeveragePositionShare:
      perps.length === 0
        ? null
        : div(
            String(perps.filter((t) => (t.leverage ?? 1) >= 8).length),
            String(perps.length),
          ).toString(),
    unmatchedSpotSells: spot.unmatched,
  };
}
