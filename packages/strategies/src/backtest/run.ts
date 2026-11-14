import { dec, Decimal, mul, ReasonCode } from "@drift/shared";

import type {
  MarketRules,
  OrderIntent,
  StepContext,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

// Backtest (BACKTEST.md mục 11.2): chạy đúng `step` của chiến lược trên nến quá khứ, thay sàn bằng mô hình
// khớp lệnh bảo thủ:
// - limit chỉ khớp khi giá đi XUYÊN qua mức đặt (low < giá mua, high > giá bán), khớp ở giá đặt, phí maker;
// - lệnh đặt trong một nến không được khớp trong chính nến đó (không có vòng mua-bán trong một nến);
// - market khớp ở giá open của nến kế tiếp ± trượt giá, phí taker; IOC chỉ khớp ngay nếu giá hiện tại cho phép;
// - đường giá trong nến: nến tăng O→L→H→C, nến giảm O→H→L→C (giá chạm phía bất lợi trước);
// - builder fee 0.01% (DEC-46): Perps hai chiều, Spot chỉ chiều bán (SODEX.md mục 5.3), đã cộng vào phí của fill.

export interface Candle {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  /** Khối lượng (base); chỉ chiến lược đọc nến (Volume Farming) cần. */
  v?: string;
}

export interface FundingPoint {
  at: number;
  /** Tỷ lệ thô của SoDEX (0.0001 = 0.01% mỗi kỳ). */
  rate: string;
}

export interface FeeSchedule {
  spot: { maker: string; taker: string };
  perps: { maker: string; taker: string };
  /** Tỷ lệ thô, ví dụ "0.0005". */
  builder: string;
}

export interface BacktestInput<C, S> {
  module: StrategyModule<C, S>;
  config: C;
  markets: Record<
    string,
    { engine: "spot" | "perps"; candles: readonly Candle[]; rules: MarketRules }
  >;
  funding: Record<string, readonly FundingPoint[]>;
  fees: FeeSchedule;
  /** Trượt giá của lệnh market, tỷ lệ thô (mặc định 0.0005 = 0.05%). */
  slippage: string;
  intervalMs: number;
  /** Vốn ban đầu (quote) để tính equity. */
  capital: string;
  /** Số điểm tối đa của đường equity trả về. */
  equityPoints?: number;
  /** Ghi lại mọi event đưa cho chiến lược (test so với engine); tắt mặc định cho nhanh. */
  recordEvents?: boolean;
  /**
   * Gửi kèm `timer` chừng này nến gần nhất của market (tính cả nến vừa đóng), như engine gửi cho Volume Farming.
   * Không có sổ lệnh lịch sử nên `book` là null (tín hiệu chạy chế độ chỉ-nến).
   */
  snapshotCandles?: number;
}

export interface BacktestFill {
  at: number;
  market: string;
  clOrdID: string;
  tag: string;
  side: "buy" | "sell";
  price: string;
  quantity: string;
  fee: string;
  maker: boolean;
}

export interface BacktestOutput<S> {
  candles: number;
  from: number;
  to: number;
  capital: string;
  equityEnd: string;
  net: string;
  netPct: string;
  fees: string;
  /** Funding đã trả (dương) hoặc nhận (âm). */
  funding: string;
  maxDrawdown: string;
  maxDrawdownPct: string;
  equity: { at: number; value: string }[];
  fills: BacktestFill[];
  /** Mọi hành động chiến lược trả về, theo thứ tự (để so với engine thật). */
  actions: StrategyAction[];
  /** Event đã đưa cho chiến lược, theo thứ tự. */
  events: StrategyEvent[];
  halted: Extract<StrategyAction, { type: "pause" | "stop" }> | null;
  state: S;
  /** Vị thế cuối theo market (base, có dấu). */
  positions: Record<string, string>;
  fundingEvents: { at: number; market: string; amount: string; position: string }[];
}

interface Open {
  order: OrderIntent;
  placedAt: number;
  /** Giá đặt dạng số, chỉ dùng để so sánh nhanh; tiền vẫn tính bằng Decimal. */
  px: number;
}

function pathOf(c: Candle): string[] {
  return dec(c.c).gte(c.o) ? [c.o, c.l, c.h, c.c] : [c.o, c.h, c.l, c.c];
}

export function runBacktest<C, S>(input: BacktestInput<C, S>): BacktestOutput<S> {
  const { module: mod, config } = input;
  const marketNames = Object.keys(input.markets).sort();
  const rules = Object.fromEntries(marketNames.map((m) => [m, input.markets[m]?.rules])) as Record<
    string,
    MarketRules
  >;
  const first = input.markets[marketNames[0] ?? ""];
  const anyEngine = first?.engine ?? "spot";
  // Như engine (DEC-112): nửa phí khứ hồi maker; Spot chỉ chịu builder fee ở chiều bán.
  const ctx: StepContext = {
    botId: "backtest",
    version: 1,
    rules,
    feeRate: dec(first?.rules.makerFee ?? input.fees[anyEngine].maker)
      .add(dec(input.fees.builder).mul(anyEngine === "perps" ? 1 : "0.5"))
      .toString(),
    takerFeeRate: dec(first?.rules.takerFee ?? input.fees[anyEngine].taker)
      .add(dec(input.fees.builder).mul(anyEngine === "perps" ? 1 : "0.5"))
      .toString(),
  };

  // Gom nến theo thời điểm; chỉ dùng các mốc mà mọi market đều có nến (thị trường đồng bộ).
  const byTime = new Map<number, Map<string, Candle>>();
  for (const m of marketNames) {
    for (const c of input.markets[m]?.candles ?? []) {
      const row = byTime.get(c.t) ?? new Map<string, Candle>();
      row.set(m, c);
      byTime.set(c.t, row);
    }
  }
  const times = [...byTime.entries()]
    .filter(([, row]) => row.size === marketNames.length)
    .map(([t]) => t)
    .sort((a, b) => a - b);

  const engineOf = (m: string) => input.markets[m]?.engine ?? "spot";
  const open = new Map<string, Open>();
  const pendingMarket: OrderIntent[] = [];
  /** Stop loss gốc trên sàn (DEC-118): kích hoạt khi giá chạm `price`, khớp market cả vị thế. */
  const stops = new Map<string, { order: OrderIntent; price: Decimal }>();
  const fills: BacktestFill[] = [];
  const actions: StrategyAction[] = [];
  const events: StrategyEvent[] = [];
  const fundingEvents: BacktestOutput<S>["fundingEvents"] = [];
  const pos = new Map<string, Decimal>();
  const last = new Map<string, string>();
  let cash = new Decimal(0);
  let feesTotal = new Decimal(0);
  let fundingTotal = new Decimal(0);
  let state = mod.initialState(config);
  const run: { halted: BacktestOutput<S>["halted"] } = { halted: null };
  // Đọc qua hàm để TypeScript không thu hẹp `run.halted` qua các lời gọi `feed`.
  const running = () => run.halted === null;

  const feeOf = (o: OrderIntent, price: string, maker: boolean) => {
    const e = engineOf(o.market);
    // Phí của market trên `/symbols` nếu có (một số market Spot miễn phí), không thì bảng cơ bản (DEC-112).
    const r = input.markets[o.market]?.rules;
    const base =
      (maker ? r?.makerFee : r?.takerFee) ?? (maker ? input.fees[e].maker : input.fees[e].taker);
    const builder = e === "perps" || o.side === "sell" ? input.fees.builder : "0";
    return mul(mul(price, o.quantity), dec(base).add(builder));
  };
  const fill = (o: OrderIntent, price: string, maker: boolean, at: number): StrategyEvent => {
    const fee = feeOf(o, price, maker);
    const notional = mul(price, o.quantity);
    cash = o.side === "buy" ? cash.sub(notional).sub(fee) : cash.add(notional).sub(fee);
    feesTotal = feesTotal.add(fee);
    const signed = o.side === "buy" ? dec(o.quantity) : dec(o.quantity).neg();
    pos.set(o.market, (pos.get(o.market) ?? new Decimal(0)).add(signed));
    fills.push({
      at,
      market: o.market,
      clOrdID: o.clOrdID,
      tag: o.tag,
      side: o.side,
      price,
      quantity: o.quantity,
      fee: fee.toString(),
      maker,
    });
    return {
      type: "fill",
      at,
      clOrdID: o.clOrdID,
      price,
      quantity: o.quantity,
      fee: fee.toString(),
    };
  };
  const slipped = (o: OrderIntent, price: string) =>
    dec(price)
      .mul(o.side === "buy" ? dec("1").add(input.slippage) : dec("1").sub(input.slippage))
      .toString();

  const apply = (list: readonly StrategyAction[], at: number): StrategyEvent[] => {
    const out: StrategyEvent[] = [];
    for (const a of list) {
      if (a.type === "modifyStop") {
        const x = stops.get(a.clOrdID);
        if (x === undefined)
          out.push({ type: "orderReject", at, clOrdID: a.clOrdID, code: "STOP_NOT_FOUND" });
        else x.price = dec(a.stopPrice);
        continue;
      }
      if (a.type === "cancel") {
        open.delete(a.clOrdID);
        stops.delete(a.clOrdID);
        const i = pendingMarket.findIndex((o) => o.clOrdID === a.clOrdID);
        if (i >= 0) pendingMarket.splice(i, 1);
        // Khớp engine: huỷ thành công → `orderDone` (DEC-100, Volume Maker dọn lệnh cancelling).
        out.push({ type: "orderDone", at, clOrdID: a.clOrdID });
        continue;
      }
      if (a.type !== "place") continue;
      const o = a.order;
      const price = last.get(o.market) ?? null;
      if (o.stop !== undefined) {
        out.push({ type: "orderAck", at, clOrdID: o.clOrdID });
        stops.set(o.clOrdID, { order: o, price: dec(o.stop.price) });
        continue;
      }
      if (o.type === "market") {
        out.push({ type: "orderAck", at, clOrdID: o.clOrdID });
        pendingMarket.push(o);
        continue;
      }
      const crossesNow =
        price !== null &&
        o.price !== undefined &&
        (o.side === "buy" ? dec(price).lte(o.price) : dec(price).gte(o.price));
      if (o.timeInForce === "GTX" && crossesNow) {
        out.push({ type: "orderReject", at, clOrdID: o.clOrdID, code: "POST_ONLY_WOULD_TRADE" });
        continue;
      }
      out.push({ type: "orderAck", at, clOrdID: o.clOrdID });
      if (o.timeInForce === "IOC") {
        if (crossesNow) out.push(fill(o, o.price ?? price, false, at));
        // Khớp engine (DEC-229): IOC kết thúc ngay, khớp hay không đều báo `orderDone`.
        out.push({ type: "orderDone", at, clOrdID: o.clOrdID });
        continue;
      }
      if (crossesNow) {
        // Limit GTC đặt xuyên giá hiện tại: khớp như taker ở giá đặt.
        out.push(fill(o, o.price ?? price, false, at));
        continue;
      }
      open.set(o.clOrdID, { order: o, placedAt: at, px: Number(o.price) });
    }
    return out;
  };

  const feed = (initial: StrategyEvent[]) => {
    const queue = [...initial];
    while (queue.length > 0 && run.halted === null) {
      const event = queue.shift();
      if (event === undefined) break;
      if (input.recordEvents === true) events.push(event);
      const result = mod.step(config, state, event, ctx);
      state = result.state;
      actions.push(...result.actions);
      queue.push(...apply(result.actions, event.at));
      const stop = result.actions.find(
        (a): a is Extract<StrategyAction, { type: "pause" | "stop" }> =>
          a.type === "pause" || a.type === "stop",
      );
      if (stop !== undefined) run.halted = stop;
    }
  };

  const equityAt = () => {
    let e = dec(input.capital).add(cash);
    for (const [m, q] of pos) e = e.add(q.mul(last.get(m) ?? "0"));
    return e;
  };
  const curve: { at: number; value: Decimal }[] = [];
  let peak = dec(input.capital);
  let maxDd = new Decimal(0);
  let maxDdPct = new Decimal(0);
  const fundingIdx = new Map<string, number>();
  const candleIdx = new Map<string, number>();
  const fundingWindow = new Map<string, FundingPoint[]>();

  for (const t of times) {
    if (run.halted !== null) break;
    const row = byTime.get(t);
    if (row === undefined) continue;
    // 1. Lệnh market chờ: khớp ở open của nến này ± trượt giá.
    const due = pendingMarket.splice(0, pendingMarket.length);
    const marketFills: StrategyEvent[] = [];
    for (const o of due) {
      const c = row.get(o.market);
      if (c === undefined) continue;
      marketFills.push(fill(o, slipped(o, c.o), false, t), {
        type: "orderDone",
        at: t,
        clOrdID: o.clOrdID,
      });
    }
    if (marketFills.length > 0) feed(marketFills);
    // 2. Đi theo đường giá trong nến, từng market.
    for (const m of marketNames) {
      const c = row.get(m);
      if (c === undefined) continue;
      const path = pathOf(c);
      for (let i = 0; i < path.length && running(); i += 1) {
        const p = path[i] ?? c.c;
        const prev = i === 0 ? null : (path[i - 1] ?? null);
        last.set(m, p);
        const hit: StrategyEvent[] = [];
        const stopHits: StrategyEvent[] = [];
        if (prev !== null && stops.size > 0) {
          const lo = Decimal.min(prev, p);
          const hi = Decimal.max(prev, p);
          for (const [id, x] of [...stops]) {
            if (x.order.market !== m) continue;
            const q = pos.get(m) ?? new Decimal(0);
            const closes = x.order.side === "sell" ? q.gt(0) : q.lt(0);
            if (!closes) {
              // Không còn vị thế để giảm: SoDEX không khớp gì, lệnh hết hiệu lực.
              stops.delete(id);
              continue;
            }
            const hitNow = x.order.side === "sell" ? lo.lte(x.price) : hi.gte(x.price);
            if (!hitNow) continue;
            stops.delete(id);
            const o = { ...x.order, quantity: q.abs().toString() };
            stopHits.push(fill(o, slipped(o, x.price.toString()), false, t));
          }
        }
        if (prev !== null && open.size > 0) {
          const a = Number(prev);
          const b = Number(p);
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          const crossed: Open[] = [];
          for (const x of open.values()) {
            if (x.order.market !== m || x.placedAt >= t) continue;
            if (x.order.side === "buy" ? lo < x.px : hi > x.px) crossed.push(x);
          }
          // Đi xuống: mua cao trước; đi lên: bán thấp trước.
          if (crossed.length > 1) crossed.sort((x, y) => (b < a ? y.px - x.px : x.px - y.px));
          for (const x of crossed) {
            open.delete(x.order.clOrdID);
            hit.push(fill(x.order, x.order.price ?? p, true, t));
          }
        }
        feed([...stopHits, { type: "tick", at: t, market: m, price: p }, ...hit]);
      }
    }
    // 3. Funding của các kỳ chốt trong nến này (Perps): trả = vị thế × giá × rate (dương = trả).
    for (const m of marketNames) {
      if (engineOf(m) !== "perps") continue;
      const list = input.funding[m] ?? [];
      let i = fundingIdx.get(m) ?? 0;
      while (i < list.length && (list[i]?.at ?? Infinity) <= t + input.intervalMs) {
        const f = list[i];
        i += 1;
        if (f === undefined || f.at <= t - input.intervalMs) continue;
        const q = pos.get(m) ?? new Decimal(0);
        const amount = q.mul(last.get(m) ?? "0").mul(f.rate);
        const window = [...(fundingWindow.get(m) ?? []), f].filter(
          (x) => x.at > f.at - 7 * 86_400_000,
        );
        fundingWindow.set(m, window);
        const avg = window.reduce((s, x) => s.add(x.rate), new Decimal(0)).div(window.length);
        const evs: StrategyEvent[] = [
          {
            type: "fundingRate",
            at: f.at,
            market: m,
            current: dec(f.rate).mul(100).toString(),
            avg7d: avg.mul(100).toString(),
          },
        ];
        if (!q.isZero()) {
          cash = cash.sub(amount);
          fundingTotal = fundingTotal.add(amount);
          fundingEvents.push({
            at: f.at,
            market: m,
            amount: amount.toString(),
            position: q.toString(),
          });
          evs.push({ type: "fundingPaid", at: f.at, market: m, amount: amount.toString() });
        }
        feed(evs);
      }
      fundingIdx.set(m, i);
    }
    // 4. Timer mỗi nến (Recurring Buy, Rebalancing, TWAP dùng đồng hồ; Volume Farming cần thêm nến).
    const at = t + input.intervalMs - 1;
    const snap = input.snapshotCandles;
    const m0 = marketNames[0];
    if (snap === undefined || m0 === undefined) feed([{ type: "timer", at }]);
    else {
      const list = input.markets[m0]?.candles ?? [];
      const idx = candleIdx.get(m0) ?? 0;
      let i = idx;
      while (i < list.length && (list[i]?.t ?? Infinity) <= t) i += 1;
      candleIdx.set(m0, i);
      const window = list.slice(Math.max(0, i - snap), i).map((k) => ({
        t: k.t,
        o: k.o,
        h: k.h,
        l: k.l,
        c: k.c,
        v: k.v ?? "0",
      }));
      feed([{ type: "timer", at, market: { market: m0, candles: window, book: null } }]);
    }
    const eq = equityAt();
    curve.push({ at: t + input.intervalMs, value: eq });
    peak = Decimal.max(peak, eq);
    const dd = peak.sub(eq);
    if (dd.gt(maxDd)) maxDd = dd;
    if (peak.gt(0)) maxDdPct = Decimal.max(maxDdPct, dd.div(peak).mul(100));
  }

  // Dừng có đóng vị thế: đóng ở giá cuối ± trượt giá, phí taker.
  if (run.halted?.type === "stop" && run.halted.close) {
    for (const [m, q] of pos) {
      if (q.isZero()) continue;
      const price = last.get(m);
      if (price === undefined) continue;
      const o: OrderIntent = {
        clOrdID: `backtest-close-${m}`,
        market: m,
        engine: engineOf(m),
        side: q.gt(0) ? "sell" : "buy",
        type: "market",
        quantity: q.abs().toString(),
        timeInForce: "IOC",
        reduceOnly: true,
        tag: "close",
      };
      fill(o, slipped(o, price), false, times.at(-1) ?? 0);
    }
    const eq = equityAt();
    curve.push({ at: (times.at(-1) ?? 0) + input.intervalMs, value: eq });
  }

  const end = equityAt();
  const net = end.sub(input.capital);
  const points = input.equityPoints ?? 200;
  const step = Math.max(1, Math.ceil(curve.length / points));
  const sampled = curve.filter((_, i) => i % step === 0 || i === curve.length - 1);
  return {
    candles: times.length,
    from: times[0] ?? 0,
    to: (times.at(-1) ?? 0) + input.intervalMs,
    capital: input.capital,
    equityEnd: end.toString(),
    net: net.toString(),
    netPct: dec(input.capital).isZero() ? "0" : net.div(input.capital).mul(100).toString(),
    fees: feesTotal.toString(),
    funding: fundingTotal.toString(),
    maxDrawdown: maxDd.toString(),
    maxDrawdownPct: maxDdPct.toString(),
    equity: sampled.map((p) => ({ at: p.at, value: p.value.toString() })),
    fills,
    actions,
    events,
    halted: run.halted,
    state,
    positions: Object.fromEntries([...pos.entries()].map(([m, q]) => [m, q.toString()])),
    fundingEvents,
  };
}

export const STOP_REASONS_WITH_LOSS: readonly string[] = [
  ReasonCode.stopLoss,
  ReasonCode.botMaxLoss,
];
