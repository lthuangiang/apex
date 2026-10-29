import { dec, Decimal, ReasonCode, RoundMode } from "@drift/shared";

import { clOrdId } from "../core/ids";
import { applyFill, emptyLedger, type Ledger } from "../core/ledger";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  OrderIntent,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

import type { VolumeMakerConfig } from "./schema";

// S9 Volume Maker (VOLUME_MAKER.md mục 17.2–17.3): báo giá hai phía bằng lệnh post-only (GTX) quanh giá hiện tại,
// làm mới mỗi `refreshSeconds` (qua `timer`), tồn kho gần 0.
// - Chỉ maker: không có lệnh taker, trừ lệnh đóng reduce-only khi dừng (phí của nó vẫn tính vào ngân sách).
// - Trần chi phí = phí + lỗ đã chốt + lỗ chưa chốt trên tồn kho: 80% cảnh báo, 100% dừng (BUDGET_DONE).
// - Tồn kho > 50% max: phía làm tăng tồn kho lùi xa gấp đôi; ≥ 100%: chỉ báo giá phía giảm tồn kho.
// - Lỗ chưa chốt trên tồn kho ≥ `inventoryLossStop` → dừng (STOP_LOSS), đóng reduce-only nếu chọn.
// - Đạt khối lượng mục tiêu hoặc hết thời gian chạy → dừng (MAX_CYCLES, DEC-43).
// Chống self-trade giữa các bot của cùng account nằm ở engine (cần thấy mọi lệnh mở của account).

export interface VolumeMakerState {
  phase: "running" | "halted";
  mid: string | null;
  lastRefresh: number | null;
  cycle: number;
  bid: string | null;
  ask: string | null;
  ledger: Ledger;
  volume: string;
  makerVolume: string;
  maxInventory: string;
  warned: boolean;
  selfTradeBlocked: number;
}

const initial = (): VolumeMakerState => ({
  phase: "running",
  mid: null,
  lastRefresh: null,
  cycle: 0,
  bid: null,
  ask: null,
  ledger: emptyLedger(),
  volume: "0",
  makerVolume: "0",
  maxInventory: "0",
  warned: false,
  selfTradeBlocked: 0,
});

const BP = new Decimal("0.0001");

/** Chi phí đã dùng: phí + lỗ đã chốt + lỗ chưa chốt (lãi không bù vào). */
export function costUsed(s: VolumeMakerState): Decimal {
  const l = s.ledger;
  const unrealized =
    s.mid === null ? new Decimal(0) : dec(l.position).mul(dec(s.mid).sub(l.avgCost));
  return dec(l.fees)
    .add(Decimal.max(0, dec(l.realized).neg()))
    .add(Decimal.max(0, unrealized.neg()));
}

/** Chi phí trên mỗi 1 triệu USD khối lượng; null khi chưa có khối lượng. */
export function costPerMillion(s: VolumeMakerState): string | null {
  return dec(s.volume).isZero()
    ? null
    : costUsed(s).div(s.volume).mul(1_000_000).toDecimalPlaces(2).toString();
}

function order(
  c: VolumeMakerConfig,
  ctx: StepContext,
  side: "buy" | "sell",
  price: string,
  qty: string,
  tag: string,
  reduceOnly = false,
  market = false,
): OrderIntent {
  return {
    clOrdID: clOrdId(ctx.botId, ctx.version, tag),
    market: c.market,
    engine: "perps",
    side,
    type: market ? "market" : "limit",
    ...(market ? {} : { price }),
    quantity: qty,
    timeInForce: market ? "IOC" : "GTX",
    reduceOnly,
    tag,
  };
}

function cancelQuotes(s: VolumeMakerState): StrategyAction[] {
  return [s.bid, s.ask].flatMap((id) =>
    id === null ? [] : [{ type: "cancel" as const, clOrdID: id }],
  );
}

function halt(
  c: VolumeMakerConfig,
  s: VolumeMakerState,
  ctx: StepContext,
  reason: ReasonCode,
  why: string,
): StepResult<VolumeMakerState> {
  const pos = dec(s.ledger.position);
  const close = c.onStop === "close_inventory" && !pos.isZero();
  const rules = ctx.rules[c.market];
  const actions: StrategyAction[] = [
    ...cancelQuotes(s),
    { type: "log", decision: "Volume Maker stopped", why },
  ];
  if (close && rules !== undefined) {
    // Lệnh taker duy nhất được phép: đóng tồn kho reduce-only (VOLUME_MAKER.md 17.3.2).
    actions.push({
      type: "place",
      order: order(
        c,
        ctx,
        pos.gt(0) ? "sell" : "buy",
        "0",
        roundQty(pos.abs(), rules),
        `vm:${String(s.cycle)}:close`,
        true,
        true,
      ),
    });
  }
  actions.push({ type: "stop", reason, close: false });
  return { actions, state: { ...s, phase: "halted", bid: null, ask: null } };
}

function refresh(
  c: VolumeMakerConfig,
  s: VolumeMakerState,
  ctx: StepContext,
  at: number,
): StepResult<VolumeMakerState> {
  const rules = ctx.rules[c.market];
  if (rules === undefined || s.mid === null) return { actions: [], state: s };
  const mid = dec(s.mid);
  const cycle = s.cycle + 1;
  const inv = dec(s.ledger.position).mul(mid);
  const used = inv.abs().div(c.maxInventory);
  const long = inv.gt(0);
  const d = BP.mul(c.distanceBp);
  // Phía làm tăng tồn kho: lùi xa gấp đôi khi > 50%, bỏ hẳn khi ≥ 100%.
  const far = (increasing: boolean) => (increasing && used.gt("0.5") ? d.mul(2) : d);
  const allowBid = !(long && used.gte(1));
  const allowAsk = !(!long && !inv.isZero() && used.gte(1));
  const bidPrice = roundPrice(
    mid.mul(new Decimal(1).sub(far(long || inv.isZero()))),
    rules,
    RoundMode.down,
  );
  const askPrice = roundPrice(
    mid.mul(new Decimal(1).add(far(!long || inv.isZero()))),
    rules,
    RoundMode.up,
  );
  // Ít nhất một tick cách mid (mục 17 S9: "at least one tick").
  const bidOk = dec(bidPrice).lt(mid) && dec(askPrice).gt(mid);
  const qty = roundQty(dec(c.orderSize).div(mid), rules);
  const actions: StrategyAction[] = [...cancelQuotes(s)];
  let bid: string | null = null;
  let ask: string | null = null;
  if (bidOk && meetsMinimum(bidPrice, qty, rules)) {
    if (allowBid) {
      const o = order(c, ctx, "buy", bidPrice, qty, `vm:${String(cycle)}:bid`);
      actions.push({ type: "place", order: o });
      bid = o.clOrdID;
    }
    if (allowAsk) {
      const o = order(c, ctx, "sell", askPrice, qty, `vm:${String(cycle)}:ask`);
      actions.push({ type: "place", order: o });
      ask = o.clOrdID;
    }
  }
  return { actions, state: { ...s, cycle, bid, ask, lastRefresh: at } };
}

function guards(
  c: VolumeMakerConfig,
  s: VolumeMakerState,
  ctx: StepContext,
  at: number,
): StepResult<VolumeMakerState> | null {
  const used = costUsed(s);
  if (used.gte(c.costBudget))
    return halt(
      c,
      s,
      ctx,
      ReasonCode.budgetDone,
      `Cost ${used.toDecimalPlaces(2).toString()} reached the budget of ${c.costBudget}.`,
    );
  const unrealized =
    s.mid === null ? new Decimal(0) : dec(s.ledger.position).mul(dec(s.mid).sub(s.ledger.avgCost));
  if (unrealized.neg().gte(c.inventoryLossStop))
    return halt(c, s, ctx, ReasonCode.stopLoss, `Inventory loss reached ${c.inventoryLossStop}.`);
  if (dec(s.volume).gte(c.volumeTarget))
    return halt(c, s, ctx, ReasonCode.maxCycles, `Volume target ${c.volumeTarget} reached.`);
  if (c.runUntil !== "target_or_budget" && c.untilAt !== undefined && at >= c.untilAt)
    return halt(c, s, ctx, ReasonCode.maxCycles, "Run time ended.");
  if (!s.warned && used.gte(dec(c.costBudget).mul("0.8"))) {
    return {
      actions: [
        { type: "flag", needsAttention: true },
        {
          type: "log",
          decision: "Cost at 80% of budget",
          why: `${used.toDecimalPlaces(2).toString()} of ${c.costBudget} used.`,
        },
      ],
      state: { ...s, warned: true },
    };
  }
  return null;
}

export function stepVolumeMaker(
  c: VolumeMakerConfig,
  s: VolumeMakerState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<VolumeMakerState> {
  if (s.phase === "halted") return { actions: [], state: s };
  switch (e.type) {
    case "tick": {
      if (e.market !== c.market) return { actions: [], state: s };
      const state = { ...s, mid: e.price };
      const g = guards(c, state, ctx, e.at);
      if (g !== null) return g;
      // Báo giá đầu tiên ngay khi có giá.
      return state.lastRefresh === null ? refresh(c, state, ctx, e.at) : { actions: [], state };
    }
    case "timer": {
      const g = guards(c, s, ctx, e.at);
      if (g !== null) return g;
      if (s.lastRefresh !== null && e.at - s.lastRefresh < c.refreshSeconds * 1000)
        return { actions: [], state: s };
      return refresh(c, s, ctx, e.at);
    }
    case "fill": {
      const side = e.clOrdID === s.bid ? "buy" : e.clOrdID === s.ask ? "sell" : null;
      if (side === null) return { actions: [], state: s };
      const ledger = applyFill(s.ledger, side, e.price, e.quantity, e.fee);
      const notional = dec(e.price).mul(e.quantity);
      const mid = s.mid ?? e.price;
      const inv = dec(ledger.position).mul(mid).abs();
      const state: VolumeMakerState = {
        ...s,
        ledger,
        volume: dec(s.volume).add(notional).toString(),
        makerVolume: dec(s.makerVolume).add(notional).toString(),
        maxInventory: Decimal.max(s.maxInventory, inv).toString(),
        ...(side === "buy" ? { bid: null } : { ask: null }),
      };
      return guards(c, state, ctx, e.at) ?? { actions: [], state };
    }
    case "orderReject": {
      if (e.clOrdID !== s.bid && e.clOrdID !== s.ask) return { actions: [], state: s };
      const blocked = e.code === "SELF_TRADE_BLOCKED";
      const state = {
        ...s,
        ...(e.clOrdID === s.bid ? { bid: null } : { ask: null }),
        selfTradeBlocked: s.selfTradeBlocked + (blocked ? 1 : 0),
      };
      return {
        actions: blocked
          ? [
              {
                type: "log",
                decision: "Quote skipped",
                why: "It would have traded with your own order (SELF_TRADE_BLOCKED).",
              },
            ]
          : [],
        state,
      };
    }
    case "orderAck":
    case "fundingPaid":
    case "fundingRate":
    case "marginRatio":
      return { actions: [], state: s };
  }
}

export const volumeMaker: StrategyModule<VolumeMakerConfig, VolumeMakerState> = {
  initialState: initial,
  step: stepVolumeMaker,
};
