import { gte, lte, mul } from "@drift/shared";

import type {
  OrderIntent,
  StepContext,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

// Exchange giả lập cho unit test và backtest (BACKTEST.md): khớp theo giá tick, không có sổ lệnh.
// - limit mua khớp khi giá ≤ giá đặt; limit bán khi giá ≥ giá đặt (khớp ở giá đặt, phí maker).
// - market khớp ngay ở giá hiện tại (phí taker).
// - GTX (post-only) bị từ chối nếu sẽ khớp ngay; IOC không khớp ngay thì huỷ.

export interface SimOptions {
  makerFee: string;
  takerFee: string;
  /** clOrdID sẽ bị từ chối khi đặt (test lỗi lệnh). */
  rejectTags?: (order: OrderIntent) => boolean;
}

export interface SimFill {
  at: number;
  clOrdID: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  fee: string;
  tag: string;
}

export class SimExchange {
  readonly open = new Map<string, OrderIntent>();
  readonly fills: SimFill[] = [];
  readonly rejected: string[] = [];
  /** Giá gần nhất theo từng market. */
  readonly prices = new Map<string, string>();

  constructor(private readonly options: SimOptions) {}

  /** Áp dụng hành động của chiến lược; trả về các event phát sinh ngay. */
  apply(actions: readonly StrategyAction[], at: number): StrategyEvent[] {
    const events: StrategyEvent[] = [];
    for (const a of actions) {
      if (a.type === "cancel") this.open.delete(a.clOrdID);
      if (a.type !== "place") continue;
      const o = a.order;
      if (this.options.rejectTags?.(o) === true) {
        this.rejected.push(o.clOrdID);
        events.push({ type: "orderReject", at, clOrdID: o.clOrdID, code: "SIM_REJECT" });
        continue;
      }
      const price = this.prices.get(o.market) ?? null;
      if (o.type === "market") {
        if (price === null) {
          events.push({ type: "orderReject", at, clOrdID: o.clOrdID, code: "NO_PRICE" });
          continue;
        }
        events.push(
          { type: "orderAck", at, clOrdID: o.clOrdID },
          this.#fill(o, price, this.options.takerFee, at),
        );
        continue;
      }
      const crosses = price !== null && this.#crosses(o, price);
      if (o.timeInForce === "GTX" && crosses) {
        this.rejected.push(o.clOrdID);
        events.push({ type: "orderReject", at, clOrdID: o.clOrdID, code: "POST_ONLY_WOULD_TRADE" });
        continue;
      }
      events.push({ type: "orderAck", at, clOrdID: o.clOrdID });
      if (crosses) {
        // `crosses` chỉ đúng khi đã có giá; lệnh limit luôn có giá đặt.
        events.push(this.#fill(o, o.price ?? "0", this.options.takerFee, at));
      } else if (o.timeInForce !== "IOC") {
        this.open.set(o.clOrdID, o);
      }
    }
    return events;
  }

  /** Giá mới của một market: khớp các lệnh limit của market đó bị cắt qua. */
  tick(market: string, price: string, at: number): StrategyEvent[] {
    this.prices.set(market, price);
    const events: StrategyEvent[] = [];
    for (const o of [...this.open.values()]) {
      if (o.market === market && this.#crosses(o, price)) {
        this.open.delete(o.clOrdID);
        events.push(this.#fill(o, o.price ?? price, this.options.makerFee, at));
      }
    }
    return events;
  }

  #crosses(o: OrderIntent, price: string): boolean {
    if (o.price === undefined) return true;
    return o.side === "buy" ? lte(price, o.price) : gte(price, o.price);
  }

  #fill(o: OrderIntent, price: string, rate: string, at: number): StrategyEvent {
    const fee = mul(mul(price, o.quantity), rate).toString();
    this.fills.push({
      at,
      clOrdID: o.clOrdID,
      side: o.side,
      price,
      quantity: o.quantity,
      fee,
      tag: o.tag,
    });
    return { type: "fill", at, clOrdID: o.clOrdID, price, quantity: o.quantity, fee };
  }
}

export interface RunResult<S> {
  state: S;
  actions: StrategyAction[];
  exchange: SimExchange;
  /** Hành động cuối cùng là pause/stop (nếu có). */
  halted: Extract<StrategyAction, { type: "pause" | "stop" }> | null;
}

/**
 * Chạy chiến lược trên chuỗi tick: mỗi tick → khớp lệnh → đưa event cho `step` → áp dụng action.
 * Dừng khi chiến lược pause/stop. Dùng chung cho test và backtest để cùng một chuỗi hành động.
 */
export function runSim<C, S>(
  mod: StrategyModule<C, S>,
  config: C,
  ctx: StepContext,
  ticks: readonly { at: number; price: string; market: string }[],
  options: SimOptions,
  extra: (at: number) => StrategyEvent[] = () => [],
): RunResult<S> {
  const exchange = new SimExchange(options);
  let state = mod.initialState(config);
  const all: StrategyAction[] = [];
  // Giữ trong object để TypeScript không thu hẹp kiểu qua closure.
  const run: { halted: RunResult<S>["halted"] } = { halted: null };
  const feed = (events: StrategyEvent[]) => {
    const queue = [...events];
    while (queue.length > 0 && run.halted === null) {
      const event = queue.shift();
      if (event === undefined) break;
      const result = mod.step(config, state, event, ctx);
      state = result.state;
      all.push(...result.actions);
      const stop = result.actions.find(
        (a): a is Extract<StrategyAction, { type: "pause" | "stop" }> =>
          a.type === "pause" || a.type === "stop",
      );
      queue.push(
        ...exchange.apply(
          result.actions.filter((a) => a.type === "place" || a.type === "cancel"),
          event.at,
        ),
      );
      if (stop !== undefined) run.halted = stop;
    }
  };
  for (const t of ticks) {
    if (run.halted !== null) break;
    const fills = exchange.tick(t.market, t.price, t.at);
    feed([{ type: "tick", at: t.at, market: t.market, price: t.price }, ...fills, ...extra(t.at)]);
  }
  return { state, actions: all, exchange, halted: run.halted };
}
