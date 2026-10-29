import { dec, Decimal, gte, lte, ReasonCode } from "@drift/shared";

import { clOrdId, without } from "../core/ids";
import { applyFill, applyFunding, emptyLedger, netPnl, type Ledger } from "../core/ledger";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  OrderIntent,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

// Lõi DCA dùng chung cho S3 Spot DCA và S4 Futures DCA (STRATEGIES.md).
// Mỗi chu kỳ: base order (market) → các safety order limit theo khoảng cách d₁·(1+m+…+m^(k−1)) và
// khối lượng safety·v^(k−1) → lệnh take profit tại giá TB·(1 ± TP%), đặt lại sau mỗi safety khớp.

export interface DcaBotConfig {
  market: string;
  engine: "spot" | "perps";
  direction: "long" | "short";
  /** Giá trị danh nghĩa (quote) của base order và safety order đầu tiên. */
  baseNotional: string;
  safetyNotional: string;
  maxSafetyOrders: number;
  firstStepPct: string;
  stepMultiplier: string;
  sizeMultiplier: string;
  takeProfitPct: string;
  stopLossPct?: string | undefined;
  maxCycles?: number | undefined;
  maxLoss?: string | undefined;
  /** Chỉ bắt đầu chu kỳ khi giá ≤ mức này (long) / ≥ (short). */
  startLevel?: string | undefined;
}

export interface DcaBotState {
  phase: "idle" | "waiting_base" | "in_cycle" | "halted";
  cycle: number;
  completedCycles: number;
  ledger: Ledger;
  baseClOrdID: string | null;
  tpClOrdID: string | null;
  /** clOrdID → chỉ số safety. */
  safeties: Record<string, number>;
  safetiesFilled: number;
  lastPrice: string | null;
  tpAttempt: number;
}

export const initialDcaState = (): DcaBotState => ({
  phase: "idle",
  cycle: 0,
  completedCycles: 0,
  ledger: emptyLedger(),
  baseClOrdID: null,
  tpClOrdID: null,
  safeties: {},
  safetiesFilled: 0,
  lastPrice: null,
  tpAttempt: 0,
});

/** % khoảng cách luỹ kế tới safety thứ k (1-based). */
export function safetyOffsetPct(
  c: Pick<DcaBotConfig, "firstStepPct" | "stepMultiplier">,
  k: number,
): Decimal {
  let total = new Decimal(0);
  for (let i = 0; i < k; i += 1) total = total.add(dec(c.stepMultiplier).pow(i));
  return dec(c.firstStepPct).mul(total);
}

const entrySide = (c: DcaBotConfig) => (c.direction === "long" ? "buy" : "sell");
const exitSide = (c: DcaBotConfig) => (c.direction === "long" ? "sell" : "buy");

function intent(
  c: DcaBotConfig,
  ctx: StepContext,
  tag: string,
  side: "buy" | "sell",
  qty: string,
  price?: string,
  reduceOnly = false,
): OrderIntent {
  return {
    clOrdID: clOrdId(ctx.botId, ctx.version, tag),
    market: c.market,
    engine: c.engine,
    side,
    type: price === undefined ? "market" : "limit",
    ...(price === undefined ? {} : { price }),
    quantity: qty,
    timeInForce: price === undefined ? "IOC" : "GTC",
    reduceOnly,
    tag,
  };
}

function startCycle(
  c: DcaBotConfig,
  s: DcaBotState,
  price: string,
  ctx: StepContext,
): StepResult<DcaBotState> {
  const rules = ctx.rules[c.market];
  const cycle = s.cycle + 1;
  const qty = rules === undefined ? "0" : roundQty(dec(c.baseNotional).div(price), rules);
  if (rules === undefined || !meetsMinimum(price, qty, rules)) {
    return {
      actions: [
        {
          type: "log",
          decision: "Cycle not started",
          why: "Base order is below SoDEX minimum after rounding.",
        },
        { type: "pause", reason: ReasonCode.orderRejected },
      ],
      state: { ...s, phase: "halted" },
    };
  }
  const base = intent(c, ctx, `dca:${String(cycle)}:base`, entrySide(c), qty);
  return {
    actions: [
      { type: "place", order: base },
      {
        type: "log",
        decision: `Cycle ${String(cycle)} started`,
        why: `Base order at about ${price}.`,
      },
    ],
    state: {
      ...s,
      phase: "waiting_base",
      cycle,
      baseClOrdID: base.clOrdID,
      safeties: {},
      safetiesFilled: 0,
      tpClOrdID: null,
      tpAttempt: 0,
    },
  };
}

function placeSafeties(
  c: DcaBotConfig,
  s: DcaBotState,
  basePrice: string,
  ctx: StepContext,
): StepResult<DcaBotState> {
  const rules = ctx.rules[c.market];
  const actions: StrategyAction[] = [];
  const safeties: Record<string, number> = {};
  if (rules === undefined) return { actions, state: s };
  for (let k = 1; k <= c.maxSafetyOrders; k += 1) {
    const off = safetyOffsetPct(c, k).div(100);
    const raw =
      c.direction === "long"
        ? dec(basePrice).mul(dec("1").sub(off))
        : dec(basePrice).mul(dec("1").add(off));
    if (raw.lte(0)) break;
    const price = roundPrice(raw, rules);
    const qty = roundQty(
      dec(c.safetyNotional)
        .mul(dec(c.sizeMultiplier).pow(k - 1))
        .div(price),
      rules,
    );
    if (!meetsMinimum(price, qty, rules)) continue;
    const o = intent(c, ctx, `dca:${String(s.cycle)}:so${String(k)}`, entrySide(c), qty, price);
    actions.push({ type: "place", order: o });
    safeties[o.clOrdID] = k;
  }
  return { actions, state: { ...s, safeties } };
}

function placeTakeProfit(
  c: DcaBotConfig,
  s: DcaBotState,
  ctx: StepContext,
): StepResult<DcaBotState> {
  const rules = ctx.rules[c.market];
  if (rules === undefined) return { actions: [], state: s };
  const avg = dec(s.ledger.avgCost);
  const tp = dec(c.takeProfitPct).div(100);
  const price = roundPrice(
    c.direction === "long" ? avg.mul(dec("1").add(tp)) : avg.mul(dec("1").sub(tp)),
    rules,
  );
  const qty = dec(s.ledger.position).abs().toString();
  const actions: StrategyAction[] =
    s.tpClOrdID === null ? [] : [{ type: "cancel", clOrdID: s.tpClOrdID }];
  const o = intent(
    c,
    ctx,
    `dca:${String(s.cycle)}:tp:${String(s.tpAttempt)}`,
    exitSide(c),
    qty,
    price,
    c.engine === "perps",
  );
  actions.push({ type: "place", order: o });
  return { actions, state: { ...s, tpClOrdID: o.clOrdID, tpAttempt: s.tpAttempt + 1 } };
}

function cancelCycle(s: DcaBotState): StrategyAction[] {
  return [...Object.keys(s.safeties), ...(s.tpClOrdID === null ? [] : [s.tpClOrdID])].map((id) => ({
    type: "cancel",
    clOrdID: id,
  }));
}

function guards(c: DcaBotConfig, s: DcaBotState, price: string): StepResult<DcaBotState> | null {
  const pos = dec(s.ledger.position);
  if (c.stopLossPct !== undefined && !pos.isZero()) {
    const move = dec(price).sub(s.ledger.avgCost).div(s.ledger.avgCost).mul(100);
    const adverse = c.direction === "long" ? move.neg() : move;
    if (adverse.gte(c.stopLossPct)) {
      return {
        actions: [...cancelCycle(s), { type: "stop", reason: ReasonCode.stopLoss, close: true }],
        state: { ...s, phase: "halted", safeties: {}, tpClOrdID: null },
      };
    }
  }
  if (c.maxLoss !== undefined && netPnl(s.ledger, price).lte(dec(c.maxLoss).neg())) {
    return {
      actions: [{ type: "pause", reason: ReasonCode.botMaxLoss }],
      state: { ...s, phase: "halted" },
    };
  }
  return null;
}

export function stepDcaBot(
  c: DcaBotConfig,
  s: DcaBotState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<DcaBotState> {
  if (s.phase === "halted") return { actions: [], state: s };
  if (e.type === "orderReject") {
    return {
      actions: [{ type: "pause", reason: ReasonCode.orderRejected }],
      state: { ...s, phase: "halted" },
    };
  }
  if (e.type === "fundingPaid" && e.market === c.market) {
    const state = { ...s, ledger: applyFunding(s.ledger, e.amount) };
    return guards(c, state, s.lastPrice ?? "0") ?? { actions: [], state };
  }
  if (e.type === "tick") {
    const state = { ...s, lastPrice: e.price };
    if (state.phase === "idle") {
      const ready =
        c.startLevel === undefined ||
        (c.direction === "long" ? lte(e.price, c.startLevel) : gte(e.price, c.startLevel));
      return ready ? startCycle(c, state, e.price, ctx) : { actions: [], state };
    }
    return guards(c, state, e.price) ?? { actions: [], state };
  }
  if (e.type !== "fill") return { actions: [], state: s };

  if (e.clOrdID === s.baseClOrdID) {
    let state: DcaBotState = {
      ...s,
      phase: "in_cycle",
      baseClOrdID: null,
      ledger: applyFill(s.ledger, entrySide(c), e.price, e.quantity, e.fee),
    };
    const safeties = placeSafeties(c, state, e.price, ctx);
    state = safeties.state;
    const tp = placeTakeProfit(c, state, ctx);
    return { actions: [...safeties.actions, ...tp.actions], state: tp.state };
  }
  const k = s.safeties[e.clOrdID];
  if (k !== undefined) {
    const safeties = without(s.safeties, e.clOrdID);
    const state: DcaBotState = {
      ...s,
      safeties,
      safetiesFilled: s.safetiesFilled + 1,
      ledger: applyFill(s.ledger, entrySide(c), e.price, e.quantity, e.fee),
    };
    const g = guards(c, state, e.price);
    if (g !== null) return g;
    const tp = placeTakeProfit(c, state, ctx);
    return {
      actions: [
        ...tp.actions,
        {
          type: "log",
          decision: `Safety order ${String(k)} filled`,
          why: `New average ${state.ledger.avgCost}.`,
        },
      ],
      state: tp.state,
    };
  }
  if (e.clOrdID === s.tpClOrdID) {
    const ledger = applyFill(s.ledger, exitSide(c), e.price, e.quantity, e.fee);
    const completed = s.completedCycles + 1;
    const cancels: StrategyAction[] = Object.keys(s.safeties).map((id) => ({
      type: "cancel",
      clOrdID: id,
    }));
    const state: DcaBotState = {
      ...s,
      ledger,
      completedCycles: completed,
      tpClOrdID: null,
      safeties: {},
      phase: "idle",
    };
    const log: StrategyAction = {
      type: "log",
      decision: `Cycle ${String(s.cycle)} took profit`,
      why: `Sold at ${e.price}.`,
    };
    if (c.maxCycles !== undefined && completed >= c.maxCycles) {
      return {
        actions: [...cancels, log, { type: "stop", reason: ReasonCode.maxCycles, close: false }],
        state: { ...state, phase: "halted" },
      };
    }
    // Chu kỳ mới bắt đầu ở tick kế tiếp (phase idle).
    return { actions: [...cancels, log], state };
  }
  return { actions: [], state: s };
}

export function dcaBotFor<C>(toDca: (c: C) => DcaBotConfig): StrategyModule<C, DcaBotState> {
  return { initialState: initialDcaState, step: (c, s, e, ctx) => stepDcaBot(toDca(c), s, e, ctx) };
}
