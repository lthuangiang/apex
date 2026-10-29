import { dec, Decimal, ReasonCode, Strategy } from "@drift/shared";

import type { MarketRules, StrategyModule } from "../core/types";
import { STRATEGIES } from "../registry";
import { requirementOf } from "../requirements";

import {
  runBacktest,
  type BacktestOutput,
  type Candle,
  type FeeSchedule,
  type FundingPoint,
} from "./run";

export { runBacktest } from "./run";
export type {
  BacktestFill,
  BacktestInput,
  BacktestOutput,
  Candle,
  FeeSchedule,
  FundingPoint,
} from "./run";

// Backtest cấp cao: parse config bằng schema của chiến lược, chạy mô phỏng, tính chỉ số riêng
// (BACKTEST.md mục 11.1). Không có APR hay lợi nhuận kỳ vọng.

export type MetricUnit = "count" | "pct" | "price" | "quote";
export interface Metric {
  key: string;
  value: string | null;
  unit: MetricUnit;
}

export interface BacktestSummary {
  candles: number;
  from: number;
  to: number;
  capital: string;
  net: string;
  netPct: string;
  fees: string;
  funding: string;
  maxDrawdown: string;
  maxDrawdownPct: string;
  equity: { at: number; value: string }[];
  metrics: Metric[];
  halted: string | null;
}

/** Market mà chiến lược cần nến. */
export function marketsOf(strategy: string, c: Record<string, unknown>): string[] {
  switch (strategy) {
    case Strategy.rebalancing:
      return ((c.assets as { market?: string }[] | undefined) ?? []).flatMap((a) =>
        a.market === undefined ? [] : [a.market],
      );
    case Strategy.fundingArb:
      return [String(c.spotMarket), String(c.perpMarket)];
    default:
      return [String(c.market)];
  }
}

const sumNotional = (fills: BacktestOutput<unknown>["fills"]) =>
  fills.reduce((s, f) => s.add(dec(f.price).mul(f.quantity)), new Decimal(0));
const sumQty = (fills: BacktestOutput<unknown>["fills"]) =>
  fills.reduce((s, f) => s.add(f.quantity), new Decimal(0));
const pct = (v: Decimal) => v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toString();

function metricsOf(
  strategy: string,
  c: Record<string, unknown>,
  out: BacktestOutput<unknown>,
  candles: Record<string, readonly Candle[]>,
): Metric[] {
  const fills = out.fills.filter((f) => f.tag !== "close");
  switch (strategy) {
    case Strategy.spotGrid:
    case Strategy.futuresGrid: {
      const list = candles[String(c.market)] ?? [];
      const inside = list.filter(
        (k) => dec(k.c).gte(String(c.lowerPrice)) && dec(k.c).lte(String(c.upperPrice)),
      ).length;
      return [
        {
          key: "fills",
          value: String(fills.filter((f) => f.tag !== "grid:init").length),
          unit: "count",
        },
        {
          key: "timeInRange",
          value: list.length === 0 ? null : pct(new Decimal(inside).div(list.length).mul(100)),
          unit: "pct",
        },
      ];
    }
    case Strategy.spotDca:
    case Strategy.futuresDca: {
      const cycles = fills.filter((f) => /^dca:\d+:tp:/.test(f.tag)).length;
      if (strategy === Strategy.futuresDca) {
        return [
          { key: "completedCycles", value: String(cycles), unit: "count" },
          {
            key: "stopLossHits",
            value: out.halted?.reason === ReasonCode.stopLoss ? "1" : "0",
            unit: "count",
          },
        ];
      }
      const perCycle = new Map<string, Set<string>>();
      for (const f of fills) {
        const m = /^dca:(\d+):so(\d+)/.exec(f.tag);
        if (m === null) continue;
        const set = perCycle.get(m[1] ?? "") ?? new Set<string>();
        set.add(m[2] ?? "");
        perCycle.set(m[1] ?? "", set);
      }
      return [
        { key: "completedCycles", value: String(cycles), unit: "count" },
        {
          key: "maxSafetyUsed",
          value: String(Math.max(0, ...[...perCycle.values()].map((s) => s.size))),
          unit: "count",
        },
      ];
    }
    case Strategy.recurringBuy: {
      const buys = fills.filter((f) => f.tag === "rb:buy");
      const qty = sumQty(buys);
      const cost = sumNotional(buys).add(buys.reduce((s, f) => s.add(f.fee), new Decimal(0)));
      const lastPrice = (candles[String(c.market)] ?? []).at(-1)?.c ?? null;
      return [
        { key: "buysMade", value: String(buys.length), unit: "count" },
        {
          key: "avgBuyPrice",
          value: qty.isZero() ? null : sumNotional(buys).div(qty).toString(),
          unit: "price",
        },
        {
          key: "valueVsCost",
          value:
            cost.isZero() || lastPrice === null
              ? null
              : pct(qty.mul(lastPrice).sub(cost).div(cost).mul(100)),
          unit: "pct",
        },
      ];
    }
    case Strategy.rebalancing: {
      const rounds = new Set(
        fills.map((f) => /^rebal:(\d+):/.exec(f.tag)?.[1]).filter((x) => x !== undefined),
      );
      // Mua và giữ: chia vốn theo tỷ trọng mục tiêu ở giá open đầu tiên, giữ tới cuối.
      const assets = (c.assets as { market?: string; weightPct: string }[] | undefined) ?? [];
      let bhEnd = new Decimal(0);
      let ok = true;
      for (const a of assets) {
        const share = dec(String(c.investment)).mul(a.weightPct).div(100);
        if (a.market === undefined) {
          bhEnd = bhEnd.add(share);
          continue;
        }
        const list = candles[a.market] ?? [];
        const first = list[0];
        const lastC = list.at(-1);
        if (first === undefined || lastC === undefined) {
          ok = false;
          continue;
        }
        bhEnd = bhEnd.add(share.div(first.o).mul(lastC.c));
      }
      const bhNet = bhEnd.sub(String(c.investment));
      return [
        {
          key: "vsBuyAndHold",
          value: ok ? dec(out.net).sub(bhNet).toString() : null,
          unit: "quote",
        },
        { key: "rebalances", value: String(rounds.size), unit: "count" },
      ];
    }
    case Strategy.fundingArb: {
      const spot = candles[String(c.spotMarket)] ?? [];
      const perp = new Map((candles[String(c.perpMarket)] ?? []).map((k) => [k.t, k.c]));
      let gap = new Decimal(0);
      for (const k of spot) {
        const p = perp.get(k.t);
        if (p === undefined || dec(k.c).isZero()) continue;
        gap = Decimal.max(gap, dec(p).sub(k.c).abs().div(k.c).mul(100));
      }
      return [
        { key: "fundingCollected", value: dec(out.funding).neg().toString(), unit: "quote" },
        { key: "periodsInPosition", value: String(out.fundingEvents.length), unit: "count" },
        { key: "maxLegGap", value: pct(gap), unit: "pct" },
      ];
    }
    case Strategy.twap: {
      const list = candles[String(c.market)] ?? [];
      const arrival = list[0]?.o ?? null;
      const slices = fills.filter((f) => f.tag.startsWith("twap:"));
      const qty = sumQty(slices);
      const sign = c.side === "sell" ? -1 : 1;
      const opens = new Map(list.map((k) => [k.t, k.o]));
      let worst: Decimal | null = null;
      for (const f of slices) {
        const ref = opens.get(f.at - (f.at % 1)) ?? arrival;
        if (ref === null) continue;
        const s = dec(f.price).sub(ref).div(ref).mul(100).mul(sign);
        worst = worst === null ? s : Decimal.max(worst, s);
      }
      return [
        {
          key: "avgVsArrival",
          value:
            arrival === null || qty.isZero()
              ? null
              : pct(sumNotional(slices).div(qty).sub(arrival).div(arrival).mul(100).mul(sign)),
          unit: "pct",
        },
        { key: "slicesFilled", value: String(slices.length), unit: "count" },
        { key: "worstSlippage", value: worst === null ? null : pct(worst), unit: "pct" },
      ];
    }
    case Strategy.volumeMaker: {
      const quotes = fills.filter((f) => f.tag.startsWith("vm:") && !f.tag.endsWith(":close"));
      const volume = sumNotional(quotes);
      const maker = sumNotional(quotes.filter((f) => f.maker));
      const cost = dec(out.net).neg();
      const st = out.state as { maxInventory?: string };
      return [
        { key: "volumeMade", value: volume.toString(), unit: "quote" },
        { key: "netCost", value: cost.toString(), unit: "quote" },
        {
          key: "costPerMillion",
          value: volume.isZero()
            ? null
            : cost.div(volume).mul(1_000_000).toDecimalPlaces(2).toString(),
          unit: "quote",
        },
        {
          key: "makerShare",
          value: volume.isZero() ? null : pct(maker.div(volume).mul(100)),
          unit: "pct",
        },
        { key: "maxInventory", value: st.maxInventory ?? null, unit: "quote" },
      ];
    }
    default:
      return [];
  }
}

/** Vốn để tính % kết quả. Recurring Buy và TWAP dùng số tiền thực đã dùng. */
function capitalOf(
  strategy: string,
  c: Record<string, unknown>,
  candles: Record<string, readonly Candle[]>,
): string {
  if (strategy === Strategy.recurringBuy) {
    const per = dec(String(c.amountPerBuy));
    if (c.ends === "after_budget" && typeof c.totalBudget === "string") return c.totalBudget;
    if (c.ends === "after_n_buys" && typeof c.buyCount === "number")
      return per.mul(c.buyCount).toString();
    return per.toString();
  }
  if (strategy === Strategy.twap) {
    const o = (candles[String(c.market)] ?? [])[0]?.o ?? "0";
    return dec(String(c.totalSize)).mul(o).toString();
  }
  return requirementOf(strategy, c).capital;
}

export interface BacktestData {
  markets: Record<
    string,
    { engine: "spot" | "perps"; candles: readonly Candle[]; rules: MarketRules }
  >;
  funding: Record<string, readonly FundingPoint[]>;
  fees: FeeSchedule;
  slippage: string;
  intervalMs: number;
}

export function backtest(
  strategy: string,
  rawConfig: unknown,
  data: BacktestData,
): BacktestSummary & { output: BacktestOutput<unknown> } {
  const entry = (
    STRATEGIES as Record<
      string,
      | { schema: { parse: (v: unknown) => unknown }; module: StrategyModule<unknown, unknown> }
      | undefined
    >
  )[strategy];
  if (entry === undefined) throw new RangeError(`No backtest for ${strategy}`);
  const config = entry.schema.parse(rawConfig) as Record<string, unknown>;
  const candles = Object.fromEntries(Object.entries(data.markets).map(([m, v]) => [m, v.candles]));
  let capital = capitalOf(strategy, config, candles);
  const output = runBacktest({
    module: entry.module,
    config,
    markets: data.markets,
    funding: data.funding,
    fees: data.fees,
    slippage: data.slippage,
    intervalMs: data.intervalMs,
    capital,
  });
  if (strategy === Strategy.recurringBuy) {
    // % kết quả của Recurring Buy tính trên số tiền đã thực sự mua.
    const spent = output.fills
      .filter((f) => f.tag === "rb:buy")
      .reduce((s, f) => s.add(dec(f.price).mul(f.quantity)).add(f.fee), new Decimal(0));
    if (spent.gt(0)) capital = spent.toString();
  }
  const net = dec(output.net);
  return {
    candles: output.candles,
    from: output.from,
    to: output.to,
    capital,
    net: output.net,
    netPct: dec(capital).isZero() ? "0" : pct(net.div(capital).mul(100)),
    fees: output.fees,
    funding: output.funding,
    maxDrawdown: output.maxDrawdown,
    maxDrawdownPct: pct(dec(output.maxDrawdownPct)),
    equity: output.equity,
    metrics: metricsOf(strategy, config, output, candles),
    halted: output.halted === null ? null : output.halted.reason,
    output,
  };
}
