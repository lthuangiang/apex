import { dec, gt, gte, lte, mul, ReasonCode, sum } from "@drift/shared";

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

import { gridPrices } from "./grid";

/** Cấu hình chung của bot grid (Spot và Futures). */
export interface GridBotConfig {
  market: string;
  engine: "spot" | "perps";
  direction: "neutral" | "long" | "short";
  lowerPrice: string;
  upperPrice: string;
  gridLevels: number;
  spacing: "arithmetic" | "geometric";
  /** Giá trị danh nghĩa phân bổ cho grid (Spot: investment; Perps: margin × leverage). */
  notional: string;
  /** Mốc để đo % take profit (Spot: investment; Perps: margin). */
  capital: string;
  triggerPrice?: string | undefined;
  stopBelow?: string | undefined;
  stopAbove?: string | undefined;
  takeProfitPct?: string | undefined;
  maxLoss: string;
  closeOnStop: boolean;
}

// Lõi grid dùng chung cho S1 Spot Grid và S2 Futures Grid (STRATEGIES.md, DEC-36).
// - Long (Spot luôn là long): mua market đủ cho mọi lệnh bán phía trên giá, rồi đặt bán phía trên.
// - Short: bán market đủ cho mọi lệnh mua phía dưới giá, rồi đặt mua phía dưới.
// - Neutral: không mở vị thế ban đầu.
// Mua mức i khớp → bán mức i+1; bán mức i khớp → mua mức i−1. Giá ra ngoài range: vẫn running,
// bật `needs_attention`.

export type GridPhase = "idle" | "waiting_trigger" | "starting" | "running" | "halted";

export interface GridBotState {
  phase: GridPhase;
  levels: string[];
  /** Khối lượng mỗi mức (theo lot). */
  qty: string;
  /** clOrdID → { level, side } của lệnh đang mở. */
  open: Record<string, { level: number; side: "buy" | "sell" }>;
  /** Lần đặt thứ mấy ở mỗi (mức, chiều), để clOrdID không trùng. */
  attempts: Record<string, number>;
  ledger: Ledger;
  lastPrice: string | null;
  outOfRange: boolean;
  initClOrdID: string | null;
}

export const initialGridBotState = (): GridBotState => ({
  phase: "idle",
  levels: [],
  qty: "0",
  open: {},
  attempts: {},
  ledger: emptyLedger(),
  lastPrice: null,
  outOfRange: false,
  initClOrdID: null,
});

function order(
  c: GridBotConfig,
  ctx: StepContext,
  s: GridBotState,
  level: number,
  side: "buy" | "sell",
): { intent: OrderIntent; state: GridBotState } {
  const key = `${String(level)}:${side}`;
  const attempt = s.attempts[key] ?? 0;
  const id = clOrdId(ctx.botId, ctx.version, `grid:${key}`, attempt);
  const intent: OrderIntent = {
    clOrdID: id,
    market: c.market,
    engine: c.engine,
    side,
    type: "limit",
    price: s.levels[level] ?? "0",
    quantity: s.qty,
    timeInForce: "GTC",
    reduceOnly: false,
    tag: `grid:${key}`,
  };
  return {
    intent,
    state: {
      ...s,
      open: { ...s.open, [id]: { level, side } },
      attempts: { ...s.attempts, [key]: attempt + 1 },
    },
  };
}

function start(
  c: GridBotConfig,
  s: GridBotState,
  price: string,
  ctx: StepContext,
): StepResult<GridBotState> {
  const rules = ctx.rules[c.market];
  if (rules === undefined)
    return {
      actions: [{ type: "pause", reason: ReasonCode.orderRejected }],
      state: { ...s, phase: "halted" },
    };
  const levels = gridPrices(c.lowerPrice, c.upperPrice, c.gridLevels, c.spacing, rules);
  // Vốn chia đều theo số mức; khối lượng như nhau ở mọi mức (tính theo giá trung bình của grid).
  const avgLevel = sum(levels).div(levels.length);
  const qty = roundQty(dec(c.notional).div(levels.length).div(avgLevel), rules);
  let state: GridBotState = { ...s, levels, qty, phase: "starting" };
  const actions: StrategyAction[] = [];
  if (!meetsMinimum(levels[0] ?? "0", qty, rules)) {
    actions.push({
      type: "log",
      decision: "Grid not started",
      why: "Order size per level is below SoDEX minimum after rounding.",
    });
    actions.push({ type: "pause", reason: ReasonCode.orderRejected });
    return { actions, state: { ...state, phase: "halted" } };
  }
  const above = levels.map((p, i) => ({ p, i })).filter((x) => gt(x.p, price));
  const below = levels.map((p, i) => ({ p, i })).filter((x) => dec(x.p).lt(price));
  // Vị thế ban đầu: long mua đủ cho các lệnh bán phía trên; short bán đủ cho các lệnh mua phía dưới.
  const initSide = c.direction === "long" ? "buy" : c.direction === "short" ? "sell" : null;
  const initCount = initSide === "buy" ? above.length : initSide === "sell" ? below.length : 0;
  if (initSide !== null && initCount > 0) {
    const id = clOrdId(ctx.botId, ctx.version, "grid:init", 0);
    actions.push({
      type: "place",
      order: {
        clOrdID: id,
        market: c.market,
        engine: c.engine,
        side: initSide,
        type: "market",
        quantity: mul(qty, String(initCount)).toString(),
        timeInForce: "IOC",
        reduceOnly: false,
        tag: "grid:init",
      },
    });
    state = { ...state, initClOrdID: id };
  }
  // Phía không cần vị thế ban đầu đặt ngay; phía còn lại đặt sau khi lệnh market khớp.
  const now =
    initSide === "buy"
      ? below.map((x) => ({ ...x, side: "buy" as const }))
      : initSide === "sell"
        ? above.map((x) => ({ ...x, side: "sell" as const }))
        : [
            ...below.map((x) => ({ ...x, side: "buy" as const })),
            ...above.map((x) => ({ ...x, side: "sell" as const })),
          ];
  for (const x of now) {
    const r = order(c, ctx, state, x.i, x.side);
    actions.push({ type: "place", order: r.intent });
    state = r.state;
  }
  actions.push({
    type: "log",
    decision: "Grid started",
    why: `${String(levels.length)} levels, ${String(below.length)} buys and ${String(above.length)} sells at ${price}.`,
  });
  return {
    actions,
    state: { ...state, phase: state.initClOrdID !== null ? "starting" : "running" },
  };
}

/** Sau khi lệnh market mở vị thế khớp: đặt phía còn lại (long → bán phía trên, short → mua phía dưới). */
function placeDeferred(
  c: GridBotConfig,
  s: GridBotState,
  price: string,
  ctx: StepContext,
): StepResult<GridBotState> {
  let state = s;
  const actions: StrategyAction[] = [];
  const side = c.direction === "short" ? "buy" : "sell";
  s.levels.forEach((p, i) => {
    if (side === "sell" ? gt(p, price) : dec(p).lt(price)) {
      const r = order(c, ctx, state, i, side);
      actions.push({ type: "place", order: r.intent });
      state = r.state;
    }
  });
  return { actions, state: { ...state, phase: "running" } };
}

function halt(
  s: GridBotState,
  action: StrategyAction,
  cancelAll: boolean,
): StepResult<GridBotState> {
  const cancels: StrategyAction[] = cancelAll
    ? Object.keys(s.open).map((id) => ({ type: "cancel", clOrdID: id }))
    : [];
  return {
    actions: [...cancels, action],
    state: { ...s, phase: "halted", open: cancelAll ? {} : s.open },
  };
}

/** Kiểm tra stop / take profit / max loss sau mỗi giá mới hoặc fill. */
function guards(c: GridBotConfig, s: GridBotState, price: string): StepResult<GridBotState> | null {
  if (
    (c.stopBelow !== undefined && lte(price, c.stopBelow)) ||
    (c.stopAbove !== undefined && gte(price, c.stopAbove))
  ) {
    return halt(s, { type: "stop", reason: ReasonCode.stopLoss, close: c.closeOnStop }, true);
  }
  const pnl = netPnl(s.ledger, price);
  if (c.takeProfitPct !== undefined && pnl.gte(dec(c.capital).mul(c.takeProfitPct).div(100))) {
    return halt(s, { type: "stop", reason: ReasonCode.takeProfit, close: c.closeOnStop }, true);
  }
  if (pnl.lte(dec(c.maxLoss).neg())) {
    // pause giữ lệnh đang mở (DOMAIN.md mục 7.2).
    return halt(s, { type: "pause", reason: ReasonCode.botMaxLoss }, false);
  }
  return null;
}

export function stepGridBot(
  c: GridBotConfig,
  s: GridBotState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<GridBotState> {
  if (s.phase === "halted") return { actions: [], state: s };

  if (e.type === "tick") {
    const prev = s.lastPrice;
    const state = { ...s, lastPrice: e.price };
    if (state.phase === "idle" || state.phase === "waiting_trigger") {
      if (c.triggerPrice !== undefined) {
        const crossed =
          prev !== null &&
          dec(prev).sub(c.triggerPrice).mul(dec(e.price).sub(c.triggerPrice)).lte(0);
        if (!crossed) return { actions: [], state: { ...state, phase: "waiting_trigger" } };
      }
      return start(c, state, e.price, ctx);
    }
    const g = guards(c, state, e.price);
    if (g !== null) return g;
    const out = dec(e.price).lt(c.lowerPrice) || dec(e.price).gt(c.upperPrice);
    if (out !== state.outOfRange) {
      return {
        actions: [
          { type: "flag", needsAttention: out },
          {
            type: "log",
            decision: out ? "Price left the grid range" : "Price back in range",
            why: `Last price ${e.price}.`,
          },
        ],
        state: { ...state, outOfRange: out },
      };
    }
    return { actions: [], state };
  }

  if (e.type === "orderReject") {
    return halt(s, { type: "pause", reason: ReasonCode.orderRejected }, false);
  }

  if (e.type === "fill") {
    if (e.clOrdID === s.initClOrdID) {
      const side = c.direction === "short" ? "sell" : "buy";
      const state = {
        ...s,
        ledger: applyFill(s.ledger, side, e.price, e.quantity, e.fee),
        initClOrdID: null,
      };
      return placeDeferred(c, state, s.lastPrice ?? e.price, ctx);
    }
    const o = s.open[e.clOrdID];
    if (o === undefined) return { actions: [], state: s };
    const open = without(s.open, e.clOrdID);
    let state: GridBotState = {
      ...s,
      open,
      ledger: applyFill(s.ledger, o.side, e.price, e.quantity, e.fee),
    };
    const g = guards(c, state, e.price);
    if (g !== null) return g;
    const next = o.side === "buy" ? o.level + 1 : o.level - 1;
    if (next < 0 || next >= state.levels.length) return { actions: [], state };
    const r = order(c, ctx, state, next, o.side === "buy" ? "sell" : "buy");
    state = r.state;
    return {
      actions: [
        { type: "place", order: r.intent },
        {
          type: "log",
          decision: `${o.side === "buy" ? "Bought" : "Sold"} at level ${String(o.level + 1)}`,
          why: `Placed ${o.side === "buy" ? "sell" : "buy"} at ${state.levels[next] ?? ""}.`,
        },
      ],
      state,
    };
  }

  if (e.type === "fundingPaid" && e.market === c.market) {
    const state = { ...s, ledger: applyFunding(s.ledger, e.amount) };
    return guards(c, state, s.lastPrice ?? "0") ?? { actions: [], state };
  }

  return { actions: [], state: s };
}

/** Tạo module chiến lược từ một hàm chuyển cấu hình riêng sang cấu hình grid chung. */
export function gridBotFor<C>(toGrid: (c: C) => GridBotConfig): StrategyModule<C, GridBotState> {
  return {
    initialState: initialGridBotState,
    step: (c, s, e, ctx) => stepGridBot(toGrid(c), s, e, ctx),
  };
}
