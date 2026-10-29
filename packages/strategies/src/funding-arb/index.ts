import { dec, Decimal, ReasonCode } from "@drift/shared";

import { clOrdId, without } from "../core/ids";
import { applyFill, applyFunding, emptyLedger, netPnl, type Ledger } from "../core/ledger";
import { meetsMinimum, roundQty } from "../core/rounding";
import type {
  OrderIntent,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

import type { FundingArbConfig } from "./schema";

// S7 Funding Arbitrage (STRATEGIES.md, DEC-36):
// chờ funding TB 7 ngày ≥ ngưỡng → mua Spot + short Perp cùng khối lượng (mỗi chân nửa vốn) →
// ghi funding mỗi kỳ → 3 kỳ liên tiếp funding ≤ ngưỡng thoát thì đóng cả hai chân và chờ lại.
// Margin ratio dưới ngưỡng: không chuyển margin giữa engine (chưa xác nhận SoDEX cho phép) mà đóng cả hai
// chân và pause(INSUFFICIENT_BALANCE). Lỗ chạm max loss: đóng cả hai chân và stop.

export const EXIT_PERIODS = 3;

export interface FundingArbState {
  phase: "waiting" | "opening" | "in_position" | "closing" | "halted";
  spot: Ledger;
  perp: Ledger;
  prices: Record<string, string>;
  pending: Record<string, "spot" | "perp">;
  lowPeriods: number;
  cycle: number;
  /** Lý do khi đang đóng hai chân: tiếp tục chờ hay dừng. */
  after: StrategyAction | null;
  /** Một chân lúc mở bị từ chối: chờ chân kia khớp xong rồi đóng nó. */
  rejectedLeg: "spot" | "perp" | null;
}

const initial = (): FundingArbState => ({
  phase: "waiting",
  spot: emptyLedger(),
  perp: emptyLedger(),
  prices: {},
  pending: {},
  lowPeriods: 0,
  cycle: 0,
  after: null,
  rejectedLeg: null,
});

function order(
  c: FundingArbConfig,
  ctx: StepContext,
  leg: "spot" | "perp",
  side: "buy" | "sell",
  qty: string,
  tag: string,
  reduceOnly = false,
): OrderIntent {
  return {
    clOrdID: clOrdId(ctx.botId, ctx.version, tag),
    market: leg === "spot" ? c.spotMarket : c.perpMarket,
    engine: leg === "spot" ? "spot" : "perps",
    side,
    type: "market",
    quantity: qty,
    timeInForce: "IOC",
    reduceOnly,
    tag,
  };
}

export function totalPnl(c: FundingArbConfig, s: FundingArbState): Decimal {
  return netPnl(s.spot, s.prices[c.spotMarket] ?? "0").add(
    netPnl(s.perp, s.prices[c.perpMarket] ?? "0"),
  );
}

function open(
  c: FundingArbConfig,
  s: FundingArbState,
  ctx: StepContext,
): StepResult<FundingArbState> {
  const price = s.prices[c.perpMarket] ?? s.prices[c.spotMarket];
  const spotRules = ctx.rules[c.spotMarket];
  const perpRules = ctx.rules[c.perpMarket];
  if (price === undefined || spotRules === undefined || perpRules === undefined)
    return { actions: [], state: s };
  // Cùng khối lượng tài sản ở hai chân: làm tròn theo lot lớn hơn của hai market.
  const lot = Decimal.max(spotRules.stepSize, perpRules.stepSize).toString();
  const qty = roundQty(dec(c.investment).div(2).div(price), { ...spotRules, stepSize: lot });
  if (!meetsMinimum(price, qty, spotRules) || !meetsMinimum(price, qty, perpRules)) {
    return {
      actions: [{ type: "log", decision: "Not entering", why: "Leg size is below SoDEX minimum." }],
      state: s,
    };
  }
  const cycle = s.cycle + 1;
  const a = order(c, ctx, "spot", "buy", qty, `arb:${String(cycle)}:open:spot`);
  const b = order(c, ctx, "perp", "sell", qty, `arb:${String(cycle)}:open:perp`);
  return {
    actions: [
      { type: "place", order: a },
      { type: "place", order: b },
      { type: "log", decision: "Entered", why: `Funding average above ${c.enterFundingPct}%.` },
    ],
    state: {
      ...s,
      phase: "opening",
      cycle,
      pending: { [a.clOrdID]: "spot", [b.clOrdID]: "perp" },
      lowPeriods: 0,
    },
  };
}

function close(
  c: FundingArbConfig,
  s: FundingArbState,
  ctx: StepContext,
  after: StrategyAction | null,
  why: string,
): StepResult<FundingArbState> {
  const actions: StrategyAction[] = [];
  const pending: FundingArbState["pending"] = {};
  const spotQty = dec(s.spot.position);
  const perpQty = dec(s.perp.position);
  if (spotQty.gt(0)) {
    const o = order(
      c,
      ctx,
      "spot",
      "sell",
      spotQty.toString(),
      `arb:${String(s.cycle)}:close:spot`,
    );
    actions.push({ type: "place", order: o });
    pending[o.clOrdID] = "spot";
  }
  if (perpQty.lt(0)) {
    const o = order(
      c,
      ctx,
      "perp",
      "buy",
      perpQty.abs().toString(),
      `arb:${String(s.cycle)}:close:perp`,
      true,
    );
    actions.push({ type: "place", order: o });
    pending[o.clOrdID] = "perp";
  }
  actions.push({ type: "log", decision: "Closing both legs", why });
  if (actions.length === 1) {
    return {
      actions: after === null ? actions : [...actions, after],
      state: { ...s, phase: after === null ? "waiting" : "halted", pending: {}, after: null },
    };
  }
  return { actions, state: { ...s, phase: "closing", pending, after } };
}

function guards(
  c: FundingArbConfig,
  s: FundingArbState,
  ctx: StepContext,
): StepResult<FundingArbState> | null {
  if (s.phase !== "in_position") return null;
  if (totalPnl(c, s).lte(dec(c.maxLoss).neg())) {
    return close(
      c,
      s,
      ctx,
      { type: "stop", reason: ReasonCode.stopLoss, close: true },
      "Loss reached the bot's max loss.",
    );
  }
  return null;
}

export function stepFundingArb(
  c: FundingArbConfig,
  s: FundingArbState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<FundingArbState> {
  if (s.phase === "halted") return { actions: [], state: s };
  switch (e.type) {
    case "tick": {
      const state = { ...s, prices: { ...s.prices, [e.market]: e.price } };
      return guards(c, state, ctx) ?? { actions: [], state };
    }
    case "fundingRate": {
      if (e.market !== c.perpMarket) return { actions: [], state: s };
      if (s.phase === "waiting") {
        return e.avg7d !== null && dec(e.avg7d).gte(c.enterFundingPct)
          ? open(c, s, ctx)
          : { actions: [], state: s };
      }
      if (s.phase !== "in_position") return { actions: [], state: s };
      const low = dec(e.current).lte(c.exitFundingPct) ? s.lowPeriods + 1 : 0;
      if (low >= EXIT_PERIODS)
        return close(
          c,
          { ...s, lowPeriods: 0 },
          ctx,
          null,
          `Funding at or below ${c.exitFundingPct}% for ${String(EXIT_PERIODS)} periods.`,
        );
      return { actions: [], state: { ...s, lowPeriods: low } };
    }
    case "fundingPaid": {
      if (e.market !== c.perpMarket) return { actions: [], state: s };
      const state = { ...s, perp: applyFunding(s.perp, e.amount) };
      return guards(c, state, ctx) ?? { actions: [], state };
    }
    case "marginRatio": {
      if (s.phase === "in_position" && dec(e.ratio).mul(100).lt(c.minMarginRatioPct)) {
        return close(
          c,
          s,
          ctx,
          { type: "pause", reason: ReasonCode.insufficientBalance },
          "Perp margin ratio fell below the limit.",
        );
      }
      return { actions: [], state: s };
    }
    case "orderReject": {
      const leg = s.pending[e.clOrdID];
      if (leg === undefined) return { actions: [], state: s };
      const pending = without(s.pending, e.clOrdID);
      // Một chân lỗi: đóng chân còn lại rồi pause (STRATEGIES.md S7 bước 2). Chân kia còn đang chờ khớp
      // thì đợi nó khớp xong mới đóng, để không bỏ sót vị thế không được hedge.
      if (Object.keys(pending).length > 0) {
        return {
          actions: [
            {
              type: "log",
              decision: "Leg rejected",
              why: `The ${leg} leg was rejected (${e.code}).`,
            },
          ],
          state: { ...s, pending, rejectedLeg: leg },
        };
      }
      return close(
        c,
        { ...s, pending },
        ctx,
        { type: "pause", reason: ReasonCode.orderRejected },
        `The ${leg} leg was rejected (${e.code}).`,
      );
    }
    case "fill": {
      const leg = s.pending[e.clOrdID];
      if (leg === undefined) return { actions: [], state: s };
      const pending = without(s.pending, e.clOrdID);
      const side =
        s.phase === "closing" ? (leg === "spot" ? "sell" : "buy") : leg === "spot" ? "buy" : "sell";
      let state: FundingArbState = {
        ...s,
        pending,
        [leg]: applyFill(s[leg], side, e.price, e.quantity, e.fee),
      };
      if (Object.keys(pending).length > 0) return { actions: [], state };
      if (state.rejectedLeg !== null) {
        const rejected = state.rejectedLeg;
        return close(
          c,
          { ...state, rejectedLeg: null },
          ctx,
          { type: "pause", reason: ReasonCode.orderRejected },
          `The ${rejected} leg was rejected.`,
        );
      }
      if (state.phase === "closing") {
        const after = state.after;
        state = { ...state, phase: after === null ? "waiting" : "halted", after: null };
        return { actions: after === null ? [] : [after], state };
      }
      state = { ...state, phase: "in_position" };
      // Hai chân lệch khối lượng quá ngưỡng thì cân lại bằng chân perp.
      const gap = dec(state.spot.position).add(state.perp.position);
      if (
        !dec(state.spot.position).isZero() &&
        gap.abs().div(state.spot.position).mul(100).gt(c.maxGapPct)
      ) {
        const o = order(
          c,
          ctx,
          "perp",
          gap.isPositive() ? "sell" : "buy",
          gap.abs().toString(),
          `arb:${String(state.cycle)}:balance`,
        );
        return {
          actions: [{ type: "place", order: o }],
          state: { ...state, phase: "opening", pending: { [o.clOrdID]: "perp" } },
        };
      }
      return guards(c, state, ctx) ?? { actions: [], state };
    }
    case "orderAck":
    case "timer":
      return { actions: [], state: s };
  }
}

export const fundingArb: StrategyModule<FundingArbConfig, FundingArbState> = {
  initialState: initial,
  step: stepFundingArb,
};
