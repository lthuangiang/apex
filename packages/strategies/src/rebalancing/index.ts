import { add, dec, Decimal, mul, ReasonCode, sub } from "@drift/shared";

import { clOrdId, without } from "../core/ids";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";
import { nextRun } from "../recurring-buy/schedule";

import type { RebalancingConfig } from "./schema";

// S6 Rebalancing (STRATEGIES.md, DEC-36): lúc start mua từng tài sản tới tỷ trọng mục tiêu; `timer`
// mỗi 5 phút tính lại tỷ trọng theo giá quote. Lệnh limit IOC tại giá hiện tại; mỗi lần giao dịch không
// quá maxTradePct giá trị danh mục. Khi dừng, tài sản giữ nguyên.

export const REBALANCE_CHECK_MS = 5 * 60_000;

export interface RebalancingState {
  phase: "waiting_prices" | "running" | "halted";
  prices: Record<string, string>;
  holdings: Record<string, string>;
  cash: string;
  fees: string;
  pending: Record<string, { asset: string; side: "buy" | "sell" }>;
  rebalances: number;
  lastRebalanceAt: number | null;
  round: number;
}

const initial = (c: RebalancingConfig): RebalancingState => ({
  phase: "waiting_prices",
  prices: {},
  holdings: Object.fromEntries(
    c.assets.filter((a) => a.asset !== c.quoteAsset).map((a) => [a.asset, "0"]),
  ),
  cash: c.investment,
  fees: "0",
  pending: {},
  rebalances: 0,
  lastRebalanceAt: null,
  round: 0,
});

const tradables = (c: RebalancingConfig) =>
  c.assets.filter((a) => a.asset !== c.quoteAsset && a.market !== undefined);

export function portfolioValue(c: RebalancingConfig, s: RebalancingState): Decimal {
  let total = dec(s.cash);
  for (const a of tradables(c))
    total = total.add(mul(s.holdings[a.asset] ?? "0", s.prices[a.market ?? ""] ?? "0"));
  return total;
}

/** Tỷ trọng hiện tại (%) của từng tài sản, gồm quote. */
export function currentWeights(c: RebalancingConfig, s: RebalancingState): Record<string, Decimal> {
  const total = portfolioValue(c, s);
  const out: Record<string, Decimal> = {};
  for (const a of c.assets) {
    const value =
      a.asset === c.quoteAsset
        ? dec(s.cash)
        : mul(s.holdings[a.asset] ?? "0", s.prices[a.market ?? ""] ?? "0");
    out[a.asset] = total.isZero() ? new Decimal(0) : value.div(total).mul(100);
  }
  return out;
}

function rebalance(
  c: RebalancingConfig,
  s: RebalancingState,
  ctx: StepContext,
  at: number,
  why: string,
): StepResult<RebalancingState> {
  const total = portfolioValue(c, s);
  const diffs = tradables(c).map((a) => {
    const price = s.prices[a.market ?? ""] ?? "0";
    const target = total.mul(a.weightPct).div(100);
    const current = mul(s.holdings[a.asset] ?? "0", price);
    return { a, price, diff: target.sub(current) };
  });
  const gross = diffs.reduce((acc, d) => acc.add(d.diff.abs()), new Decimal(0));
  const cap = total.mul(c.maxTradePct).div(100);
  const scale = gross.isZero() ? new Decimal(0) : Decimal.min(1, cap.div(gross));
  const round = s.round + 1;
  const actions: StrategyAction[] = [];
  const pending: RebalancingState["pending"] = {};
  // Bán trước để có quote cho lệnh mua.
  for (const d of [...diffs].sort((x, y) => x.diff.comparedTo(y.diff))) {
    const rules = ctx.rules[d.a.market ?? ""];
    if (rules === undefined || d.diff.isZero()) continue;
    const side = d.diff.isNegative() ? "sell" : "buy";
    const price = roundPrice(d.price, rules);
    const qty = roundQty(d.diff.abs().mul(scale).div(price), rules);
    if (!meetsMinimum(price, qty, rules)) continue;
    const id = clOrdId(ctx.botId, ctx.version, `rebal:${String(round)}:${d.a.asset}`);
    pending[id] = { asset: d.a.asset, side };
    actions.push({
      type: "place",
      order: {
        clOrdID: id,
        market: d.a.market ?? "",
        engine: "spot",
        side,
        type: "limit",
        price,
        quantity: qty,
        timeInForce: "IOC",
        reduceOnly: false,
        tag: `rebal:${d.a.asset}`,
      },
    });
  }
  if (actions.length === 0) return { actions: [], state: s };
  actions.push({ type: "log", decision: round === 1 ? "Initial allocation" : "Rebalanced", why });
  return {
    actions,
    state: {
      ...s,
      pending,
      round,
      rebalances: s.rebalances + (round === 1 ? 0 : 1),
      lastRebalanceAt: at,
    },
  };
}

function guards(c: RebalancingConfig, s: RebalancingState): StepResult<RebalancingState> | null {
  if (s.phase !== "running") return null;
  const total = portfolioValue(c, s);
  if (c.stopBelow !== undefined && total.lt(c.stopBelow)) {
    return {
      actions: [{ type: "stop", reason: ReasonCode.stopLoss, close: false }],
      state: { ...s, phase: "halted" },
    };
  }
  if (
    c.takeProfitPct !== undefined &&
    total.gte(dec(c.investment).mul(dec("1").add(dec(c.takeProfitPct).div(100))))
  ) {
    return {
      actions: [{ type: "stop", reason: ReasonCode.takeProfit, close: false }],
      state: { ...s, phase: "halted" },
    };
  }
  return null;
}

/** Lần rebalance theo lịch kế tiếp sau `last` (DEC-67: 00:00 giờ người dùng; config cũ: mỗi N giờ, DEC-36). */
export function nextScheduled(c: RebalancingConfig, last: number): number {
  if (c.schedule === undefined) return last + c.scheduleHours * 3_600_000;
  return nextRun({ frequency: c.schedule, time: "00:00", timeZone: c.timeZone ?? "UTC" }, last);
}

export function stepRebalancing(
  c: RebalancingConfig,
  s: RebalancingState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<RebalancingState> {
  if (s.phase === "halted") return { actions: [], state: s };
  if (e.type === "tick") {
    const state = { ...s, prices: { ...s.prices, [e.market]: e.price } };
    if (
      state.phase === "waiting_prices" &&
      tradables(c).every((a) => state.prices[a.market ?? ""] !== undefined)
    ) {
      const started = rebalance(
        c,
        { ...state, phase: "running" },
        ctx,
        e.at,
        "Bought each asset up to its target weight.",
      );
      return { actions: started.actions, state: { ...started.state, phase: "running" } };
    }
    return guards(c, state) ?? { actions: [], state };
  }
  if (e.type === "timer" && s.phase === "running" && Object.keys(s.pending).length === 0) {
    const weights = currentWeights(c, s);
    const drift = c.assets.reduce(
      (m, a) => Decimal.max(m, (weights[a.asset] ?? new Decimal(0)).sub(a.weightPct).abs()),
      new Decimal(0),
    );
    const due =
      c.rebalanceWhen === "threshold"
        ? c.thresholdPct !== undefined && drift.gt(c.thresholdPct)
        : s.lastRebalanceAt === null || e.at >= nextScheduled(c, s.lastRebalanceAt);
    if (!due) return { actions: [], state: s };
    return rebalance(
      c,
      s,
      ctx,
      e.at,
      c.rebalanceWhen === "threshold"
        ? `Largest drift ${drift.toDecimalPlaces(2).toString()}%.`
        : "Scheduled rebalance.",
    );
  }
  if (e.type === "orderReject" && s.pending[e.clOrdID] !== undefined) {
    return {
      actions: [{ type: "pause", reason: ReasonCode.orderRejected }],
      state: { ...s, phase: "halted" },
    };
  }
  if (e.type === "fill") {
    const p = s.pending[e.clOrdID];
    if (p === undefined) return { actions: [], state: s };
    const pending = without(s.pending, e.clOrdID);
    const value = mul(e.price, e.quantity);
    const state: RebalancingState = {
      ...s,
      pending,
      holdings: {
        ...s.holdings,
        [p.asset]: (p.side === "buy" ? add : sub)(
          s.holdings[p.asset] ?? "0",
          e.quantity,
        ).toString(),
      },
      cash: (p.side === "buy" ? dec(s.cash).sub(value) : dec(s.cash).add(value))
        .sub(e.fee)
        .toString(),
      fees: add(s.fees, e.fee).toString(),
    };
    return guards(c, state) ?? { actions: [], state };
  }
  return { actions: [], state: s };
}

export const rebalancing: StrategyModule<RebalancingConfig, RebalancingState> = {
  initialState: initial,
  step: stepRebalancing,
};
