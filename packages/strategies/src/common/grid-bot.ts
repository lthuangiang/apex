import { dec, type Decimal, gt, gte, lte, mul, ReasonCode, sum } from "@drift/shared";

import { clOrdId, without } from "../core/ids";
import {
  applyFill,
  applyFunding,
  carryLedger,
  emptyLedger,
  netPnl,
  type Ledger,
} from "../core/ledger";
import { meetsMinimum, roundQty } from "../core/rounding";
import type {
  OrderIntent,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

import { entryReady, waitingCondition, type EntryCondition, type WaitingInfo } from "./entry";
import { gridPrices } from "./grid";
import { isRetiring, retireEnd, retireFill, retireTick, type Retiring } from "./retire";

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
  /** First entry (IMP-01). `triggerPrice` cũ được map thành `cross`. Thiếu là Now. */
  entry?: EntryCondition | undefined;
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
  /**
   * Lệnh đã gửi huỷ lúc dừng (halt / pause vì max loss) mà sàn chưa báo kết thúc. Lệnh huỷ có thể đã khớp trước đó
   * (hoặc là lệnh `unknown` mà SoDEX thật ra đã nhận, quy tắc 1.7): fill của nó vẫn vào sổ cái để lệnh đóng khi Stop
   * tính đúng vị thế. Bỏ khỏi đây khi sàn báo lệnh kết thúc.
   */
  cancelled?: Record<string, { level: number; side: "buy" | "sell"; ended?: boolean }>;
  /** Đã resume nhưng chưa có giá mới: dựng lại lệnh ở tick đầu tiên (DEC-240). */
  resumeOnTick?: boolean;
  /**
   * Lệnh version cũ engine đã huỷ lúc áp version mới, còn chờ SoDEX báo kết thúc (#223). Còn lệnh ở đây thì grid mới chưa
   * dựng (fill muộn của chúng làm đổi vị thế mà bố cục mới dựa vào).
   */
  retiring?: Retiring | undefined;
  /** Khối lượng đặt và đã khớp của lệnh market mở vị thế ban đầu: mọi lần khớp một phần đều vào sổ cái (#255). */
  initQty?: string;
  initFilled?: string;
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

/** Mức giá và khối lượng mỗi mức theo cấu hình; không dựng được (thiếu rules, dưới min size) thì pause. */
function layout(
  c: GridBotConfig,
  s: GridBotState,
  ctx: StepContext,
): { state: GridBotState } | { halted: StepResult<GridBotState> } {
  const rules = ctx.rules[c.market];
  if (rules === undefined)
    return {
      halted: {
        actions: [{ type: "pause", reason: ReasonCode.orderRejected }],
        state: { ...s, phase: "halted" },
      },
    };
  const levels = gridPrices(c.lowerPrice, c.upperPrice, c.gridLevels, c.spacing, rules);
  // Vốn chia đều theo số mức; khối lượng như nhau ở mọi mức (tính theo giá trung bình của grid).
  const avgLevel = sum(levels).div(levels.length);
  const qty = roundQty(dec(c.notional).div(levels.length).div(avgLevel), rules);
  const state: GridBotState = { ...s, levels, qty, phase: "starting" };
  if (!meetsMinimum(levels[0] ?? "0", qty, rules))
    return {
      halted: {
        actions: [
          {
            type: "log",
            decision: "Grid not started",
            why: "Order size per level is below SoDEX minimum after rounding.",
          },
          { type: "pause", reason: ReasonCode.orderRejected },
        ],
        state: { ...state, phase: "halted" },
      },
    };
  return { state };
}

function start(
  c: GridBotConfig,
  s: GridBotState,
  price: string,
  ctx: StepContext,
): StepResult<GridBotState> {
  const laid = layout(c, s, ctx);
  if ("halted" in laid) return laid.halted;
  const { levels, qty } = laid.state;
  let state = laid.state;
  const actions: StrategyAction[] = [];
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
    state = {
      ...state,
      initClOrdID: id,
      initQty: mul(qty, String(initCount)).toString(),
      initFilled: "0",
    };
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

/**
 * Resume sau khi bot tự pause (DEC-240): giữ sổ cái và vị thế, đặt lại lệnh ở các mức chưa có lệnh quanh giá
 * hiện tại (mua phía dưới, bán phía trên), không mua / bán market. Phía cần vị thế (long: bán, short: mua) chỉ đặt trong
 * phần vị thế còn trống, mức gần giá trước. Grid chưa khởi động thì quay về chờ khởi động như mới. Max loss vẫn chạm
 * thì pause lại ngay.
 */
function resumeGrid(
  c: GridBotConfig,
  s0: GridBotState,
  ctx: StepContext,
): StepResult<GridBotState> {
  let s = s0;
  s = { ...s, resumeOnTick: false };
  // Chưa từng khởi động (chưa có mức): chờ khởi động như mới. Đã đặt lệnh khởi tạo thì không đặt lại (clOrdID trùng sẽ bị
  // engine bỏ qua): dựng lệnh từ vị thế thật như bình thường.
  if (s.levels.length === 0) return { actions: [], state: { ...s, phase: "idle" } };
  // Lệnh khởi tạo chưa báo kết thúc (ví dụ khớp trễ sau một lần dừng): khớp sau này vẫn vào sổ cái.
  if (s.initClOrdID !== null) {
    const side = c.direction === "short" ? ("sell" as const) : ("buy" as const);
    s = { ...s, cancelled: { ...s.cancelled, [s.initClOrdID]: { level: -1, side } } };
  }
  s = { ...s, initClOrdID: null };
  const price = s.lastPrice;
  if (price === null) return { actions: [], state: { ...s, phase: "running" } };
  // Max loss (hoặc stop / take profit) vẫn chạm: dừng lại ngay, không đặt lệnh (resume không vượt được max loss).
  const g = guards(c, { ...s, phase: "running" }, price);
  if (g !== null) return g;
  const pos = dec(s.ledger.position);
  const placed = placeAround(c, ctx, s, price, {
    sell: c.direction === "long" ? pos : null,
    buy: c.direction === "short" ? pos.neg() : null,
  });
  return {
    actions: [
      ...placed.actions,
      {
        type: "log",
        decision: "Grid resumed",
        why: `Orders placed again around ${price} from the current position: ${String(placed.actions.length)} placed.`,
      },
    ],
    state: placed.state,
  };
}

/**
 * Đặt lệnh ở các mức chưa có lệnh quanh `price` (mua phía dưới, bán phía trên), mức gần giá trước. `cap[side]`: tổng
 * khối lượng tối đa của lệnh chiều đó (tính cả lệnh đang mở); null = không giới hạn.
 */
function placeAround(
  c: GridBotConfig,
  ctx: StepContext,
  s: GridBotState,
  price: string,
  cap: { buy: Decimal | null; sell: Decimal | null },
): StepResult<GridBotState> {
  const busy = new Set(Object.values(s.open).map((o) => o.level));
  const openQty = (side: "buy" | "sell") =>
    dec(s.qty).mul(Object.values(s.open).filter((o) => o.side === side).length);
  let room = {
    sell: cap.sell === null ? null : cap.sell.sub(openQty("sell")),
    buy: cap.buy === null ? null : cap.buy.sub(openQty("buy")),
  };
  const want = [
    ...s.levels
      .map((p, i) => ({ p, i, side: "sell" as const }))
      .filter((x) => gt(x.p, price))
      .sort((a, b) => dec(a.p).cmp(b.p)),
    ...s.levels
      .map((p, i) => ({ p, i, side: "buy" as const }))
      .filter((x) => dec(x.p).lt(price))
      .sort((a, b) => dec(b.p).cmp(a.p)),
  ].filter((x) => !busy.has(x.i));
  let state: GridBotState = { ...s, phase: "running" };
  const actions: StrategyAction[] = [];
  for (const x of want) {
    const left = room[x.side];
    if (left !== null) {
      if (left.lt(s.qty)) continue;
      room = { ...room, [x.side]: left.sub(s.qty) };
    }
    const r = order(c, ctx, state, x.i, x.side);
    actions.push({ type: "place", order: r.intent });
    state = r.state;
  }
  return { actions, state };
}

/**
 * Grid của version mới khởi động khi sổ cái còn vị thế (vị thế của version cũ, hoặc fill trễ của lệnh version cũ;
 * #223, DEC-320): không chờ First entry, không đặt lệnh market, giữ vị thế và đặt lệnh quanh giá
 * như Resume (DEC-240). Lệnh làm tăng vị thế bị giới hạn để vị thế xấu nhất (vị thế + mọi lệnh cùng chiều khớp) không
 * vượt grid mới khởi động từ phẳng: long / short tối đa khối lượng mỗi mức × số mức theo hướng của grid, không bao giờ
 * mở phía ngược hướng (long: bán chỉ trong phần vị thế đang giữ, như Resume). Max loss / stop / take profit vẫn chạm
 * thì dừng như thường, không đặt lệnh; không bao giờ tự đóng vị thế.
 */
function adoptGrid(
  c: GridBotConfig,
  s: GridBotState,
  price: string,
  ctx: StepContext,
): StepResult<GridBotState> {
  const laid = layout(c, s, ctx);
  if ("halted" in laid) return laid.halted;
  const base: GridBotState = { ...laid.state, phase: "running", lastPrice: price };
  const g = guards(c, base, price);
  if (g !== null) return g;
  const placed = placeAround(c, ctx, base, price, capOf(c, base));
  return {
    actions: [
      ...placed.actions,
      // Câu chữ PM duyệt 2026-11-18 (#223).
      {
        type: "log",
        decision: "Grid started",
        why: `${String(base.levels.length)} levels around ${price}, keeping the open position of ${s.ledger.position}: ${String(placed.actions.length)} orders placed, no market order.`,
      },
    ],
    state: placed.state,
  };
}

/**
 * Áp version mới (#223, DEC-320). Engine huỷ mọi lệnh đang mở; state mới giữ sổ cái (PM chốt B2:
 * phiên tiếp tục) và chờ mọi lệnh version cũ (lệnh đang mở, lệnh đã huỷ lúc dừng chưa kết thúc) được SoDEX báo kết thúc
 * (`retiring`, huỷ lại mỗi 10 s) rồi mới dựng grid mới: còn vị thế thì quanh vị thế (`adoptGrid`), phẳng thì như bot mới
 * (DEC-38). Lệnh market mở vị thế ban đầu chưa kết thúc thì chưa áp (null, như DEC-304): khối lượng của nó chưa biết.
 */
export function applyGridVersion(s: GridBotState): GridBotState | null {
  if (s.initClOrdID !== null) return null;
  const retiring: Retiring = { ...s.retiring };
  for (const [id, o] of Object.entries(s.open))
    retiring[id] = { side: o.side, qty: s.qty, filled: "0", cancelAt: null };
  const ended: NonNullable<GridBotState["cancelled"]> = {};
  for (const [id, o] of Object.entries(s.cancelled ?? {})) {
    if (o.ended === true) ended[id] = o;
    else
      retiring[id] = {
        side: o.side,
        ...(o.level >= 0 ? { qty: s.qty } : {}),
        filled: "0",
        cancelAt: null,
      };
  }
  return {
    ...initialGridBotState(),
    ledger: carryLedger(s.ledger),
    lastPrice: s.lastPrice,
    ...(Object.keys(ended).length > 0 ? { cancelled: ended } : {}),
    ...(Object.keys(retiring).length > 0 ? { retiring } : {}),
  };
}

/**
 * Sau khi lệnh market mở vị thế kết thúc (khớp đủ, hoặc SoDEX báo kết thúc sau khi khớp một phần): đặt phía còn lại
 * (long → bán phía trên, short → mua phía dưới), chỉ trong phần vị thế đã khớp (#255): mức gần giá trước, không bao giờ
 * bán / mua lại nhiều hơn vị thế đang giữ.
 */
function placeDeferred(
  c: GridBotConfig,
  s: GridBotState,
  price: string,
  ctx: StepContext,
): StepResult<GridBotState> {
  let state: GridBotState = { ...s, initClOrdID: null };
  delete state.initQty;
  delete state.initFilled;
  const actions: StrategyAction[] = [];
  const side = c.direction === "short" ? "buy" : "sell";
  const busy = new Set(Object.values(s.open).map((o) => o.level));
  const want = s.levels
    .map((p, i) => ({ p, i }))
    .filter((x) => !busy.has(x.i) && (side === "sell" ? gt(x.p, price) : dec(x.p).lt(price)));
  // Mức gần giá được ưu tiên khi vị thế không đủ cho mọi mức; thứ tự gửi giữ như trước (theo chỉ số mức).
  const nearest = [...want].sort((a, b) =>
    side === "sell" ? dec(a.p).cmp(b.p) : dec(b.p).cmp(a.p),
  );
  let room = capOf(c, state)[side].sub(
    dec(s.qty).mul(Object.values(s.open).filter((o) => o.side === side).length),
  );
  const keep = new Set<number>();
  for (const x of nearest) {
    if (room.lt(s.qty)) break;
    room = room.sub(s.qty);
    keep.add(x.i);
  }
  for (const x of want) {
    if (!keep.has(x.i)) continue;
    const r = order(c, ctx, state, x.i, side);
    actions.push({ type: "place", order: r.intent });
    state = r.state;
  }
  return { actions, state: { ...state, phase: "running" } };
}

/**
 * Tổng khối lượng tối đa của lệnh mỗi chiều (gồm cả lệnh đang mở) theo vị thế hiện tại (#223 B1): lệnh giảm vị thế không
 * bao giờ lớn hơn vị thế (long: bán ≤ vị thế; short: mua ≤ |vị thế|; Spot và Perps), và vị thế xấu nhất khi mọi lệnh
 * tăng vị thế khớp không vượt grid mới khởi động từ phẳng (khối lượng mỗi mức × số mức).
 */
function capOf(c: GridBotConfig, s: GridBotState): { buy: Decimal; sell: Decimal } {
  const pos = dec(s.ledger.position);
  const full = dec(s.qty).mul(s.levels.length);
  const zero = dec("0");
  const buy = c.direction === "short" ? pos.neg() : full.sub(pos);
  const sell = c.direction === "long" ? pos : full.add(pos);
  return { buy: buy.lt(0) ? zero : buy, sell: sell.lt(0) ? zero : sell };
}

/**
 * Sau mỗi fill (#223 B1): lệnh đang mở vượt `capOf` thì huỷ phần vượt, mức xa giá trước. Lệnh huỷ vào `cancelled` (fill
 * muộn vẫn vào sổ cái); mức đó trống tới khi grid đặt lại.
 */
function enforceCap(c: GridBotConfig, s: GridBotState): StepResult<GridBotState> {
  if (s.phase !== "running" || s.levels.length === 0 || !dec(s.qty).gt(0))
    return { actions: [], state: s };
  const cap = capOf(c, s);
  const price = dec(s.lastPrice ?? s.levels[Math.floor(s.levels.length / 2)] ?? "0");
  const away = (level: number) =>
    dec(s.levels[level] ?? "0")
      .sub(price)
      .abs();
  const drop: string[] = [];
  for (const side of ["buy", "sell"] as const) {
    const mine = Object.entries(s.open)
      .filter(([, o]) => o.side === side)
      .sort(([, a], [, b]) => away(b.level).cmp(away(a.level)));
    let total = dec(s.qty).mul(mine.length);
    for (const [id] of mine) {
      if (total.lte(cap[side])) break;
      drop.push(id);
      total = total.sub(s.qty);
    }
  }
  if (drop.length === 0) return { actions: [], state: s };
  const gone = Object.fromEntries(Object.entries(s.open).filter(([id]) => drop.includes(id)));
  return {
    actions: drop.map((id) => ({ type: "cancel" as const, clOrdID: id })),
    state: {
      ...s,
      open: Object.fromEntries(Object.entries(s.open).filter(([id]) => !drop.includes(id))),
      cancelled: { ...s.cancelled, ...gone },
    },
  };
}

/** Kết quả của một bước có fill, rồi giới hạn lại lệnh đang mở (#223 B1). */
function capped(c: GridBotConfig, r: StepResult<GridBotState>): StepResult<GridBotState> {
  const x = enforceCap(c, r.state);
  return x.actions.length === 0 ? r : { actions: [...r.actions, ...x.actions], state: x.state };
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
    state: cancelAll
      ? { ...s, phase: "halted", open: {}, cancelled: { ...s.cancelled, ...s.open } }
      : { ...s, phase: "halted" },
  };
}

/**
 * Lệnh có làm tăng vị thế không: đang long (hoặc phẳng) thì lệnh mua tăng; đang short (hoặc phẳng) thì lệnh bán tăng.
 */
export function increasesPosition(side: "buy" | "sell", position: string): boolean {
  // So với 0 (decimal.js coi +0 là isPositive).
  const p = dec(position);
  return side === "buy" ? p.gte(0) : p.lte(0);
}

function pauseKeepReducing(s: GridBotState, action: StrategyAction): StepResult<GridBotState> {
  const cancel = Object.entries(s.open).filter(([, o]) =>
    increasesPosition(o.side, s.ledger.position),
  );
  const open = Object.fromEntries(
    Object.entries(s.open).filter(([, o]) => !increasesPosition(o.side, s.ledger.position)),
  );
  return {
    actions: [...cancel.map(([id]) => ({ type: "cancel" as const, clOrdID: id })), action],
    state: {
      ...s,
      phase: "halted",
      open,
      cancelled: { ...s.cancelled, ...Object.fromEntries(cancel) },
    },
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
    // Pause vì max loss (DOMAIN.md mục 7.2, DEC-238): huỷ lệnh làm tăng vị thế, giữ lệnh chỉ giảm vị
    // thế để không lỗ thêm khi giá tiếp tục chạy ngược.
    return pauseKeepReducing(s, { type: "pause", reason: ReasonCode.botMaxLoss });
  }
  return null;
}

/**
 * Bước grid. Lệnh version cũ đang chờ kết thúc (#223) đi trước mọi thứ: fill vào sổ cái theo chiều của chính lệnh (rồi
 * giới hạn lại lệnh đang mở), kết thúc thì thôi chờ (không pause), nhịp giá gửi huỷ lại khi quá hạn.
 */
export function stepGridBot(
  c: GridBotConfig,
  s: GridBotState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<GridBotState> {
  if (e.type === "fill") {
    const r = retireFill(s.retiring, e);
    if (r !== null) {
      const state: GridBotState = {
        ...s,
        retiring: r.retiring,
        ledger: r.quantity.gt(0)
          ? applyFill(s.ledger, r.side, e.price, r.quantity, r.fee)
          : s.ledger,
      };
      return capped(c, { actions: [], state });
    }
  }
  if ((e.type === "orderDone" || e.type === "orderReject") && s.retiring?.[e.clOrdID] !== undefined)
    return { actions: [], state: { ...s, retiring: retireEnd(s.retiring, e.clOrdID) } };
  if (e.type === "tick" || e.type === "timer") {
    const t = retireTick(s.retiring, e.at);
    if (t.retiring !== s.retiring) {
      const r = stepGrid(c, { ...s, retiring: t.retiring }, e, ctx);
      return { actions: [...t.actions, ...r.actions], state: r.state };
    }
  }
  return stepGrid(c, s, e, ctx);
}

function stepGrid(
  c: GridBotConfig,
  s: GridBotState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<GridBotState> {
  // Lệnh đã huỷ lúc dừng: sàn báo kết thúc thì bỏ khỏi danh sách (không pause lần nữa); khớp trễ chỉ vào sổ cái, kể cả
  // sau khi đã resume (không đặt lệnh đối ứng, vì mức đó đã được dựng lại).
  const lateId =
    e.type === "fill" || e.type === "orderDone" || e.type === "orderReject" ? e.clOrdID : null;
  const gone = lateId === null || s.open[lateId] !== undefined ? undefined : s.cancelled?.[lateId];
  if (lateId !== null && gone !== undefined) {
    // Lệnh mở vị thế ban đầu đã kết thúc (`ended`) vẫn giữ để nhận fill tới muộn (#255).
    if (e.type !== "fill")
      return gone.ended === true
        ? { actions: [], state: s }
        : { actions: [], state: { ...s, cancelled: without(s.cancelled ?? {}, lateId) } };
    const booked: GridBotState = {
      ...s,
      ledger: applyFill(s.ledger, e.side ?? gone.side, e.price, e.quantity, e.fee),
    };
    // Lệnh mở vị thế ban đầu khớp sau `orderDone` khi grid đang chạy: đặt thêm phía còn lại cho phần vừa khớp (#255).
    if (gone.level === -1 && s.phase === "running" && s.levels.length > 0)
      return capped(c, placeDeferred(c, booked, s.lastPrice ?? e.price, ctx));
    return capped(c, { actions: [], state: booked });
  }
  if (s.phase === "halted") {
    if (e.type === "resumed") {
      // Chưa có giá mới: chờ giá đầu tiên rồi mới dựng lệnh (không đặt theo giá lúc pause).
      const p = e.prices[c.market];
      return p === undefined
        ? { actions: [], state: { ...s, resumeOnTick: true } }
        : resumeGrid(c, { ...s, lastPrice: p }, ctx);
    }
    if (e.type === "tick" && e.market === c.market && s.resumeOnTick === true)
      return resumeGrid(c, { ...s, lastPrice: e.price }, ctx);
    // Lệnh bị từ chối / kết thúc trên sàn trong lúc dừng: bỏ khỏi danh sách để resume đặt lại mức đó.
    if ((e.type === "orderReject" || e.type === "orderDone") && s.open[e.clOrdID] !== undefined)
      return { actions: [], state: { ...s, open: without(s.open, e.clOrdID) } };
    // Lệnh market mở vị thế ban đầu khớp sau khi đã dừng (ví dụ lệnh `unknown` mà SoDEX thật ra đã nhận): vào sổ cái để
    // lệnh đóng khi Stop tính đúng vị thế; không đặt các mức còn lại. Giữ `initClOrdID` để các phần khớp sau cũng được tính.
    if (e.type === "fill" && e.clOrdID === s.initClOrdID) {
      const side = c.direction === "short" ? "sell" : "buy";
      return {
        actions: [],
        state: {
          ...s,
          ledger: applyFill(s.ledger, side, e.price, e.quantity, e.fee),
        },
      };
    }
    // Lệnh khởi tạo kết thúc trên sàn trong lúc dừng: không còn khớp nữa.
    if ((e.type === "orderDone" || e.type === "orderReject") && e.clOrdID === s.initClOrdID)
      return { actions: [], state: { ...s, initClOrdID: null } };
    // Đã dừng: lệnh giảm vị thế còn giữ (pause vì max loss) vẫn có thể khớp; chỉ ghi sổ cái, không đặt lệnh mới.
    const o = e.type === "fill" ? s.open[e.clOrdID] : undefined;
    if (e.type !== "fill" || o === undefined) return { actions: [], state: s };
    return {
      actions: [],
      state: {
        ...s,
        open: without(s.open, e.clOrdID),
        ledger: applyFill(s.ledger, o.side, e.price, e.quantity, e.fee),
      },
    };
  }

  if (e.type === "tick") {
    const prev = s.lastPrice;
    const state = { ...s, lastPrice: e.price };
    if (state.phase === "idle" || state.phase === "waiting_trigger") {
      // Lệnh version cũ chưa kết thúc (#223 B1): chưa dựng grid mới; còn vị thế thì stop / take profit / max loss vẫn canh.
      if (isRetiring(state.retiring))
        return dec(state.ledger.position).isZero()
          ? { actions: [], state }
          : (guards(c, state, e.price) ?? { actions: [], state });
      // Sổ cái còn vị thế (version cũ để lại, #223): grid mới quản lý tiếp vị thế đó ngay, không chờ First entry.
      if (!dec(state.ledger.position).isZero()) return adoptGrid(c, state, e.price, ctx);
      const entry = c.entry ?? { type: "now" };
      if (!entryReady(entry, c.direction, prev, e.price)) {
        return { actions: [], state: { ...state, phase: "waiting_trigger" } };
      }
      // Sổ cái giữ qua lần sửa (B2): max loss đã chạm thì không khởi động, pause lại, không đặt lệnh (DEC-240 (a), #223 N1).
      if (netPnl(state.ledger, e.price).lte(dec(c.maxLoss).neg()))
        return {
          actions: [{ type: "pause", reason: ReasonCode.botMaxLoss }],
          state: { ...state, phase: "halted" },
        };
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

  // Lệnh market mở vị thế ban đầu đã kết thúc trên sàn (IOC hết hạn): không còn khớp nữa. Không có dòng này thì version
  // mới chờ lệnh khởi tạo mãi (#223, `applyGridVersion`); fill trước đó đã đặt phía còn lại.
  if (e.type === "orderDone" && e.clOrdID === s.initClOrdID) {
    // Vẫn nhận fill tới sau `orderDone` (đối soát / trade đến trễ, DEC-303) vào sổ cái (#255).
    const side = c.direction === "short" ? ("sell" as const) : ("buy" as const);
    const state: GridBotState = {
      ...s,
      cancelled: { ...s.cancelled, [e.clOrdID]: { level: -1, side, ended: true } },
    };
    return s.phase === "starting"
      ? placeDeferred(c, state, s.lastPrice ?? "0", ctx)
      : { actions: [], state: { ...state, initClOrdID: null } };
  }

  if (e.type === "orderReject") {
    // Lệnh bị từ chối không có trên sàn: bỏ khỏi danh sách để resume đặt lại mức đó.
    const state = { ...s, open: without(s.open, e.clOrdID) };
    return halt(state, { type: "pause", reason: ReasonCode.orderRejected }, false);
  }

  if (e.type === "fill") {
    if (e.clOrdID === s.initClOrdID) {
      const side = c.direction === "short" ? "sell" : "buy";
      const filled = dec(s.initFilled ?? "0").add(e.quantity);
      const state: GridBotState = {
        ...s,
        ledger: applyFill(s.ledger, side, e.price, e.quantity, e.fee),
        initFilled: filled.toString(),
      };
      // Khớp một phần: chờ phần còn lại hoặc `orderDone` (#255). State cũ không có `initQty`: coi như khớp đủ.
      if (s.initQty !== undefined && filled.lt(s.initQty)) return { actions: [], state };
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
    if (next < 0 || next >= state.levels.length) return capped(c, { actions: [], state });
    const r = order(c, ctx, state, next, o.side === "buy" ? "sell" : "buy");
    state = r.state;
    return capped(c, {
      actions: [
        { type: "place", order: r.intent },
        {
          type: "log",
          decision: `${o.side === "buy" ? "Bought" : "Sold"} at level ${String(o.level + 1)}`,
          why: `Placed ${o.side === "buy" ? "sell" : "buy"} at ${state.levels[next] ?? ""}.`,
        },
      ],
      state,
    });
  }

  if (e.type === "fundingPaid" && e.market === c.market) {
    const state = { ...s, ledger: applyFunding(s.ledger, e.amount) };
    return guards(c, state, s.lastPrice ?? "0") ?? { actions: [], state };
  }

  return { actions: [], state: s };
}

/** Tạo module chiến lược từ một hàm chuyển cấu hình riêng sang cấu hình grid chung. */
/** Thông tin "Waiting for price" cho UI; chỉ khi grid chưa khởi động. */
export function gridWaiting(c: GridBotConfig, s: GridBotState): WaitingInfo | null {
  const entry = c.entry ?? { type: "now" };
  if (entry.type === "now") return null;
  // "within" (Spot Grid chờ giá vào khoảng) hiện như khoảng giá: "Waiting for price · {low}–{high}".
  return s.phase === "idle" || s.phase === "waiting_trigger"
    ? { kind: "entry", condition: waitingCondition(entry) }
    : null;
}

export function gridBotFor<C>(toGrid: (c: C) => GridBotConfig): StrategyModule<C, GridBotState> {
  return {
    initialState: initialGridBotState,
    step: (c, s, e, ctx) => stepGridBot(toGrid(c), s, e, ctx),
    waiting: (c, s) => gridWaiting(toGrid(c), s),
    applyVersion: (_c, s) => applyGridVersion(s),
    awaitsEnd: (s, id) => s.retiring?.[id] !== undefined,
  };
}
