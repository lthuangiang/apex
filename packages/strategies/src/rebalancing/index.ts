import { add, dec, Decimal, mul, ReasonCode, RoundMode, sub } from "@drift/shared";

import { clOrdId, without } from "../core/ids";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  BookTop,
  MarketRules,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";
import { nextRun } from "../recurring-buy/schedule";

import type { RebalancingConfig } from "./schema";

// S6 Rebalancing (STRATEGIES.md, DEC-36): lúc start mua từng tài sản tới tỷ trọng mục tiêu; `timer`
// mỗi 5 phút tính lại tỷ trọng theo giá quote. Lệnh limit IOC tại ask (mua) / bid (bán) ± 0,3%; tổng các lệnh của một
// lần rebalance không quá maxTradePct giá trị danh mục. Khi dừng, tài sản giữ nguyên.

export const REBALANCE_CHECK_MS = 5 * 60_000;
/** Lô lệnh chờ quá lâu mà không có `orderDone` (tin mất) thì coi như xong với phần đã khớp (P0.1). */
export const REBAL_PENDING_TIMEOUT_MS = 60_000;
/**
 * Lệnh IOC đặt theo giá ask (mua) / bid (bán) ± biên trượt giá cố định (PM chốt sau bản rà soát strategy; không có field
 * trên form). Sổ lệnh cũ hơn `REBAL_BOOK_MAX_AGE_MS` hoặc thiếu market nào thì chờ, không quay về giá khớp gần nhất.
 */
export const REBAL_SLIPPAGE = "0.003";
export const REBAL_BOOK_MAX_AGE_MS = 180_000;

/** Có sổ lệnh còn mới cho mọi market giao dịch. */
function booksReady(c: RebalancingConfig, s: RebalancingState, at: number): boolean {
  if (s.booksAt == null || at - s.booksAt > REBAL_BOOK_MAX_AGE_MS) return false;
  return tradables(c).every((a) => s.books?.[a.market ?? ""] !== undefined);
}

/** Giá lệnh IOC: mua = ask × (1 + trượt giá) làm tròn xuống, bán = bid × (1 − trượt giá) làm tròn lên. */
function iocPrice(
  s: RebalancingState,
  market: string,
  side: "buy" | "sell",
  rules: MarketRules,
): string | null {
  const b = s.books?.[market];
  if (b === undefined) return null;
  const slip = dec(REBAL_SLIPPAGE);
  return side === "buy"
    ? roundPrice(dec(b.ask).mul(dec("1").add(slip)), rules, RoundMode.down)
    : roundPrice(dec(b.bid).mul(dec("1").sub(slip)), rules, RoundMode.up);
}
const KEEP_RECENT = 20;

export interface RebalOrder {
  asset: string;
  side: "buy" | "sell";
  qty?: string;
  filled?: string;
}

export interface RebalancingState {
  phase: "waiting_prices" | "running" | "halted";
  prices: Record<string, string>;
  holdings: Record<string, string>;
  cash: string;
  fees: string;
  /** Lệnh IOC đang chờ; `qty` / `filled` thiếu ở state cũ (trước P0.1). */
  pending: Record<string, RebalOrder>;
  /** Lệnh đã xong gần đây, để nhận fill tới trễ (P0.1). */
  recent?: Record<string, RebalOrder>;
  /** Lúc đặt lô lệnh đang chờ (ms). */
  pendingSince?: number | null;
  /** Đỉnh sổ lệnh gần nhất của từng market (engine gửi kèm `timer` mỗi 60 s) và lúc nhận. */
  books?: Record<string, BookTop>;
  booksAt?: number | null;
  rebalances: number;
  lastRebalanceAt: number | null;
  round: number;
  /**
   * Initial buy theo giờ (IMP-04): `part` là số phần đã mua, phần kế tiếp tới hạn ở startedAt + part × 1 h.
   * null hoặc thiếu (state cũ) = không mua dần.
   */
  building?: { startedAt: number; part: number } | null;
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
  building: null,
});

export const INITIAL_PART_MS = 3_600_000;

/** Số phần mua dần; null = All now. */
export const initialParts = (c: RebalancingConfig): number | null =>
  c.initialBuy === "over_hours" && c.initialBuyHours !== undefined ? c.initialBuyHours : null;

/**
 * Tiến độ Initial buy cho Trading Agent ("Initial buy: {done} of {total} parts", DEC-222): chỉ khi
 * đang mua dần (`building` còn); All now hoặc đã mua xong thì null. Hàm thuần, chỉ đọc config và state đã lưu.
 */
export function initialBuyProgress(
  c: RebalancingConfig,
  s: Pick<RebalancingState, "building">,
): { done: number; total: number } | null {
  const total = initialParts(c);
  const b = s.building ?? null;
  return total === null || b === null ? null : { done: b.part, total };
}

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
    const price = iocPrice(s, d.a.market ?? "", side, rules);
    if (price === null) continue;
    const qty = roundQty(d.diff.abs().mul(scale).div(price), rules);
    if (!meetsMinimum(price, qty, rules)) continue;
    const id = clOrdId(ctx.botId, ctx.version, `rebal:${String(round)}:${d.a.asset}`);
    pending[id] = { asset: d.a.asset, side, qty, filled: "0" };
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
  // Lần mua đầu bị giới hạn bởi Max trade per rebalance: nói đúng đã mua bao nhiêu phần, phần còn lại ở các lần sau.
  const reason =
    round === 1 && scale.lt(1)
      ? `Bought ${scale.mul(100).toDecimalPlaces(0, Decimal.ROUND_DOWN).toString()}% of the target allocation; the rest follows in the next rebalances.`
      : why;
  actions.push({
    type: "log",
    decision: round === 1 ? "Initial allocation" : "Rebalanced",
    why: reason,
  });
  return {
    actions,
    state: {
      ...s,
      pending,
      pendingSince: at,
      round,
      rebalances: s.rebalances + (round === 1 ? 0 : 1),
      lastRebalanceAt: at,
    },
  };
}

/**
 * Phần thứ `k` (1..N) của Initial buy: chỉ mua, đưa mỗi tài sản tới k/N giá trị mục tiêu, vẫn chịu maxTradePct.
 * clOrdID riêng `rebal:init:<k>:<asset>`; All now giữ nguyên cách sinh clOrdID cũ. Xong phần N thì `round` = 1
 * như sau Initial allocation, nên các lần rebalance sau có clOrdID giống bot All now.
 */
function buildPart(
  c: RebalancingConfig,
  s: RebalancingState,
  ctx: StepContext,
  at: number,
  startedAt: number,
  k: number,
  n: number,
): StepResult<RebalancingState> {
  const total = portfolioValue(c, s);
  const fraction = dec(String(k)).div(n);
  const cap = total.mul(c.maxTradePct).div(100);
  const diffs = tradables(c).map((a) => {
    const price = s.prices[a.market ?? ""] ?? "0";
    const target = total.mul(a.weightPct).div(100).mul(fraction);
    const current = mul(s.holdings[a.asset] ?? "0", price);
    return { a, price, diff: Decimal.max(0, target.sub(current)) };
  });
  const gross = diffs.reduce((acc, d) => acc.add(d.diff), new Decimal(0));
  const scale = gross.isZero() ? new Decimal(0) : Decimal.min(1, cap.div(gross));
  const actions: StrategyAction[] = [];
  const pending: RebalancingState["pending"] = {};
  for (const d of diffs) {
    const rules = ctx.rules[d.a.market ?? ""];
    if (rules === undefined || d.diff.isZero()) continue;
    const price = iocPrice(s, d.a.market ?? "", "buy", rules);
    if (price === null) continue;
    const qty = roundQty(d.diff.mul(scale).div(price), rules);
    if (!meetsMinimum(price, qty, rules)) continue;
    const id = clOrdId(ctx.botId, ctx.version, `rebal:init:${String(k)}:${d.a.asset}`);
    pending[id] = { asset: d.a.asset, side: "buy", qty, filled: "0" };
    actions.push({
      type: "place",
      order: {
        clOrdID: id,
        market: d.a.market ?? "",
        engine: "spot",
        side: "buy",
        type: "limit",
        price,
        quantity: qty,
        timeInForce: "IOC",
        reduceOnly: false,
        tag: `rebal:${d.a.asset}`,
      },
    });
  }
  const done = k >= n;
  actions.push({
    type: "log",
    decision: `Initial buy ${String(k)} of ${String(n)}`,
    why:
      actions.length === 0
        ? "Nothing to buy in this part (below SoDEX minimum order size)."
        : "Bought an equal part of each target weight.",
  });
  return {
    actions,
    state: {
      ...s,
      pending,
      pendingSince: Object.keys(pending).length === 0 ? null : at,
      building: done ? null : { startedAt, part: k },
      ...(done ? { round: 1, lastRebalanceAt: at } : {}),
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

/** Lệnh đã xong (khớp đủ / `orderDone` / quá hạn chờ): bỏ khỏi danh sách chờ, nhớ lại để nhận fill trễ. */
function settle(s: RebalancingState, id: string): RebalancingState {
  const o = s.pending[id];
  if (o === undefined) return s;
  const pending = without(s.pending, id);
  return {
    ...s,
    pending,
    pendingSince: Object.keys(pending).length === 0 ? null : (s.pendingSince ?? null),
    recent: Object.fromEntries(
      [...Object.entries(s.recent ?? {}), [id, o] as const].slice(-KEEP_RECENT),
    ),
  };
}

/** Đủ giá và sổ lệnh của mọi market: mua lần đầu (All now hoặc phần 1 của Over N hours). */
function readyToStart(c: RebalancingConfig, s: RebalancingState, at: number): boolean {
  return (
    s.phase === "waiting_prices" &&
    tradables(c).every((a) => s.prices[a.market ?? ""] !== undefined) &&
    booksReady(c, s, at)
  );
}

function startAllocation(
  c: RebalancingConfig,
  state: RebalancingState,
  ctx: StepContext,
  at: number,
): StepResult<RebalancingState> {
  const parts = initialParts(c);
  if (parts !== null) {
    const first = buildPart(c, { ...state, phase: "running" }, ctx, at, at, 1, parts);
    return { actions: first.actions, state: { ...first.state, phase: "running" } };
  }
  const started = rebalance(
    c,
    { ...state, phase: "running" },
    ctx,
    at,
    "Bought each asset up to its target weight.",
  );
  return { actions: started.actions, state: { ...started.state, phase: "running" } };
}

export function stepRebalancing(
  c: RebalancingConfig,
  s0: RebalancingState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<RebalancingState> {
  if (s0.phase === "halted") return { actions: [], state: s0 };
  // Đỉnh sổ lệnh engine gửi kèm timer: giữ bản mới nhất của từng market (đọc lỗi thì giữ bản cũ).
  const s: RebalancingState =
    e.type === "timer" && e.books !== undefined
      ? {
          ...s0,
          books: {
            ...s0.books,
            ...Object.fromEntries(
              Object.entries(e.books).flatMap(([m, b]) => (b === null ? [] : [[m, b] as const])),
            ),
          },
          booksAt: e.at,
        }
      : s0;
  if (e.type === "tick") {
    const state = { ...s, prices: { ...s.prices, [e.market]: e.price } };
    if (readyToStart(c, state, e.at)) return startAllocation(c, state, ctx, e.at);
    return guards(c, state) ?? { actions: [], state };
  }
  if (e.type === "timer" && readyToStart(c, s, e.at)) return startAllocation(c, s, ctx, e.at);
  if (e.type === "timer" && s.phase === "running" && Object.keys(s.pending).length > 0) {
    // Lệnh chờ không bao giờ có `orderDone`: quá hạn thì coi như xong (state cũ thiếu giờ đặt thì bắt đầu đếm).
    if (s.pendingSince == null) return { actions: [], state: { ...s, pendingSince: e.at } };
    if (e.at - s.pendingSince < REBAL_PENDING_TIMEOUT_MS) return { actions: [], state: s };
    let st = s;
    for (const id of Object.keys(s.pending)) st = settle(st, id);
    return { actions: [], state: st };
  }
  if (e.type === "timer" && s.phase === "running" && Object.keys(s.pending).length === 0) {
    const b = s.building ?? null;
    if (b !== null) {
      // Đang mua dần: chưa rebalance theo ngưỡng hay lịch cho tới khi mua xong phần cuối.
      const parts = initialParts(c) ?? b.part + 1;
      if (e.at < b.startedAt + b.part * INITIAL_PART_MS) return { actions: [], state: s };
      // Phần kế tiếp cần sổ lệnh còn mới; chưa có thì chờ (không đếm phần).
      if (!booksReady(c, s, e.at)) return { actions: [], state: s };
      return buildPart(c, s, ctx, e.at, b.startedAt, b.part + 1, parts);
    }
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
    // Chưa có sổ lệnh còn mới cho mọi market: chờ lần sau, không đặt lệnh theo giá khớp gần nhất.
    if (!booksReady(c, s, e.at)) return { actions: [], state: s };
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
  if (e.type === "orderDone" && s.pending[e.clOrdID] !== undefined)
    return { actions: [], state: settle(s, e.clOrdID) };
  if (e.type === "fill") {
    const live = s.pending[e.clOrdID];
    const p = live ?? s.recent?.[e.clOrdID];
    if (p === undefined) return { actions: [], state: s };
    // Lệnh có ghi khối lượng: chỉ tính tới đủ khối lượng (fill phát lại / khớp trễ không cộng trùng).
    const room = p.qty === undefined ? dec(e.quantity) : dec(p.qty).sub(p.filled ?? "0");
    const q = Decimal.min(room, e.quantity);
    if (!q.gt(0)) return { actions: [], state: s };
    const fee = q.lt(e.quantity) ? dec(e.fee).mul(q).div(e.quantity).toString() : e.fee;
    const value = mul(e.price, q);
    const next: RebalOrder = { ...p, filled: add(p.filled ?? "0", q).toString() };
    let state: RebalancingState = {
      ...s,
      ...(live === undefined
        ? { recent: { ...s.recent, [e.clOrdID]: next } }
        : { pending: { ...s.pending, [e.clOrdID]: next } }),
      holdings: {
        ...s.holdings,
        [p.asset]: (p.side === "buy" ? add : sub)(s.holdings[p.asset] ?? "0", q).toString(),
      },
      cash: (p.side === "buy" ? dec(s.cash).sub(value) : dec(s.cash).add(value))
        .sub(fee)
        .toString(),
      fees: add(s.fees, fee).toString(),
    };
    // Khớp đủ (hoặc lệnh của state cũ không ghi khối lượng): lệnh xong.
    if (live !== undefined && (next.qty === undefined || dec(next.filled ?? "0").gte(next.qty)))
      state = settle(state, e.clOrdID);
    return guards(c, state) ?? { actions: [], state };
  }
  return { actions: [], state: s };
}

export const rebalancing: StrategyModule<RebalancingConfig, RebalancingState> = {
  initialState: initial,
  step: stepRebalancing,
};
