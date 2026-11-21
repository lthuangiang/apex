import { dec, Decimal, gt, gte, lte, mul, ReasonCode, sum } from "@drift/shared";

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

/**
 * Lệnh của một mức (#261, DEC-359). `qty`: khối lượng đặt, thiếu = `qty` của grid (state cũ, và mọi
 * lệnh đặt đủ một mức). `filled`: phần đã khớp, thiếu = 0. Lệnh khớp một phần vẫn nằm trong `open` tới khi khớp hết hoặc
 * kết thúc trên sàn; mỗi lần khớp đều vào sổ cái.
 */
export interface GridOrder {
  level: number;
  side: "buy" | "sell";
  qty?: string;
  filled?: string;
}

/**
 * Lệnh trong `cancelled` (#426, DEC-362). `level`: mức của lệnh; −1 = lệnh market mở vị thế ban đầu; −2 =
 * lệnh version cũ đã kết thúc (không có mức trong grid hiện tại). `countered`: tổng khối lượng đã có lệnh đối ứng; có
 * field này thì fill tới muộn được đặt thêm đối ứng cho phần chưa có (lệnh kết thúc / bị huỷ vì vượt giới hạn khi grid
 * đang chạy, DEC-359); thiếu thì fill muộn chỉ vào sổ cái (lệnh huỷ lúc dừng, lệnh version cũ, lệnh khởi tạo).
 */
export interface EndedOrder extends GridOrder {
  ended?: boolean;
  countered?: string;
}

/** Số lệnh mức / lệnh version cũ đã kết thúc được nhớ để nhận fill tới muộn (#426). Lệnh khởi tạo không tính. */
export const GRID_KEEP_ENDED = 50;
/** Mức giả của lệnh version cũ đã kết thúc trong `cancelled`. */
const OLD_VERSION_LEVEL = -2;

export interface GridBotState {
  phase: GridPhase;
  levels: string[];
  /** Khối lượng mỗi mức (theo lot). */
  qty: string;
  /** clOrdID → lệnh đang mở (mức, chiều, khối lượng đặt và đã khớp). */
  open: Record<string, GridOrder>;
  /** Lần đặt thứ mấy ở mỗi (mức, chiều), để clOrdID không trùng. */
  attempts: Record<string, number>;
  ledger: Ledger;
  lastPrice: string | null;
  outOfRange: boolean;
  initClOrdID: string | null;
  /**
   * Lệnh không còn mở mà fill của nó vẫn phải vào sổ cái: lệnh đã gửi huỷ (halt / pause vì max loss / vượt giới hạn) mà
   * sàn chưa báo kết thúc, và lệnh đã kết thúc (`ended`) vì lịch sử lệnh của SoDEX trễ hơn trade (DEC-303) nên trade có
   * thể tới sau `orderDone` (#426). Lệnh có thể là lệnh `unknown` mà SoDEX thật ra đã nhận (quy tắc 1.7). Lệnh mức và
   * lệnh version cũ đã kết thúc chỉ giữ `GRID_KEEP_ENDED` lệnh gần nhất. Xem `EndedOrder`.
   */
  cancelled?: Record<string, EndedOrder>;
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

/** Khối lượng đặt của lệnh. */
const qtyOf = (s: GridBotState, o: GridOrder): string => o.qty ?? s.qty;
/** Phần chưa khớp của lệnh (không âm). */
const remainingOf = (s: GridBotState, o: GridOrder): Decimal =>
  Decimal.max(0, dec(qtyOf(s, o)).sub(o.filled ?? "0"));
/** Tổng phần chưa khớp của các lệnh đang mở theo chiều (#261: lệnh đã khớp một phần chỉ tính phần còn lại). */
const openQty = (s: GridBotState, side: "buy" | "sell"): Decimal =>
  sum(
    Object.values(s.open)
      .filter((o) => o.side === side)
      .map((o) => remainingOf(s, o)),
  );

/** Đặt lệnh limit ở `level`; `qty` mặc định là khối lượng mỗi mức (lệnh đối ứng của phần khớp một phần thì nhỏ hơn). */
function order(
  c: GridBotConfig,
  ctx: StepContext,
  s: GridBotState,
  level: number,
  side: "buy" | "sell",
  qty: string = s.qty,
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
    quantity: qty,
    timeInForce: "GTC",
    reduceOnly: false,
    tag: `grid:${key}`,
  };
  return {
    intent,
    state: {
      ...s,
      // Lệnh đủ một mức giữ dạng cũ `{ level, side }`; chỉ lệnh nhỏ hơn mới ghi `qty`.
      open: { ...s.open, [id]: qty === s.qty ? { level, side } : { level, side, qty } },
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
  let room = {
    sell: cap.sell === null ? null : cap.sell.sub(openQty(s, "sell")),
    buy: cap.buy === null ? null : cap.buy.sub(openQty(s, "buy")),
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
    retiring[id] = { side: o.side, qty: qtyOf(s, o), filled: o.filled ?? "0", cancelAt: null };
  const ended: NonNullable<GridBotState["cancelled"]> = {};
  for (const [id, o] of Object.entries(s.cancelled ?? {})) {
    if (o.ended === true) {
      // Sang version mới: fill muộn của lệnh cũ chỉ vào sổ cái (mức và khối lượng của grid đã khác), giữ khối lượng đặt.
      const rest: EndedOrder = { ...o };
      delete rest.countered;
      ended[id] = o.level >= 0 ? { ...rest, qty: qtyOf(s, o) } : rest;
    } else
      retiring[id] = {
        side: o.side,
        ...(o.level >= 0 ? { qty: qtyOf(s, o) } : {}),
        filled: o.level >= 0 ? (o.filled ?? "0") : "0",
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
  let room = capOf(c, state)[side].sub(openQty(s, side));
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
function enforceCap(c: GridBotConfig, s: GridBotState, ctx: StepContext): StepResult<GridBotState> {
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
    let total = openQty(s, side);
    for (const [id, o] of mine) {
      if (total.lte(cap[side])) break;
      drop.push(id);
      total = total.sub(remainingOf(s, o));
    }
  }
  if (drop.length === 0) return { actions: [], state: s };
  const gone = Object.fromEntries(Object.entries(s.open).filter(([id]) => drop.includes(id)));
  let state: GridBotState = {
    ...s,
    open: Object.fromEntries(Object.entries(s.open).filter(([id]) => !drop.includes(id))),
    cancelled: { ...s.cancelled, ...gone },
  };
  const actions: StrategyAction[] = drop.map((id) => ({ type: "cancel" as const, clOrdID: id }));
  // Lệnh bị huỷ đã khớp một phần: đối ứng cho phần đã khớp nếu đủ min size (#261). Nhớ phần đã có đối ứng để fill tới
  // trước khi huỷ xong chỉ được đối ứng phần thêm (#426).
  for (const [id, o] of Object.entries(gone)) {
    const x = counterRest(c, ctx, state, o, "0");
    actions.push(...x.result.actions);
    state = {
      ...x.result.state,
      cancelled: { ...x.result.state.cancelled, [id]: { ...o, countered: x.countered } },
    };
  }
  return { actions, state };
}

/**
 * Lệnh đối ứng của một lệnh mức (#261, DEC-359): mua mức i → bán mức i+1, bán mức i → mua mức i−1,
 * khối lượng = phần đã khớp (không bao giờ hơn). Ngoài range thì không đặt.
 */
function counter(
  c: GridBotConfig,
  ctx: StepContext,
  s: GridBotState,
  o: GridOrder,
  qty: string,
): StepResult<GridBotState> {
  const next = o.side === "buy" ? o.level + 1 : o.level - 1;
  if (next < 0 || next >= s.levels.length) return { actions: [], state: s };
  const r = order(c, ctx, s, next, o.side === "buy" ? "sell" : "buy", qty);
  return {
    actions: [
      { type: "place", order: r.intent },
      {
        type: "log",
        decision: `${o.side === "buy" ? "Bought" : "Sold"} at level ${String(o.level + 1)}`,
        why: `Placed ${o.side === "buy" ? "sell" : "buy"} at ${r.state.levels[next] ?? ""}.`,
      },
    ],
    state: r.state,
  };
}

/**
 * Lệnh mức kết thúc khi mới khớp một phần (`orderDone`, huỷ do `enforceCap`): đối ứng cho phần đã khớp nếu đạt min size
 * của SoDEX; dưới min size thì không đặt (vị thế đó để Resume hoặc lệnh đóng xử lý).
 */
function counterRest(
  c: GridBotConfig,
  ctx: StepContext,
  s: GridBotState,
  o: GridOrder,
  countered: string,
): { result: StepResult<GridBotState>; countered: string } {
  const filled = dec(o.filled ?? "0");
  const rest = filled.sub(countered);
  const rules = ctx.rules[c.market];
  const next = o.side === "buy" ? o.level + 1 : o.level - 1;
  const price = s.levels[next];
  const none = { result: { actions: [], state: s }, countered };
  if (!rest.gt(0) || rules === undefined || price === undefined) return none;
  // Phần chưa có đối ứng dưới min size: chưa đặt, cộng dồn với fill muộn sau (DEC-359, #426).
  if (!meetsMinimum(price, rest, rules)) return none;
  return { result: counter(c, ctx, s, o, rest.toString()), countered: filled.toString() };
}

/**
 * Ghi lệnh vào `cancelled` là đã kết thúc (#426): fill tới muộn vẫn vào sổ cái. Chỉ giữ `GRID_KEEP_ENDED` lệnh mức /
 * lệnh version cũ đã kết thúc gần nhất; lệnh khởi tạo (−1) không bị bỏ.
 */
function endOrder(s: GridBotState, id: string, o: EndedOrder): GridBotState {
  // Đã khớp đủ khối lượng đặt: không còn gì để khớp thêm, thôi nhớ.
  const placed = o.level >= 0 ? qtyOf(s, o) : o.qty;
  if (placed !== undefined && dec(o.filled ?? "0").gte(placed))
    return { ...s, cancelled: without(s.cancelled ?? {}, id) };
  const cancelled: Record<string, EndedOrder> = {
    ...without(s.cancelled ?? {}, id),
    [id]: { ...o, ended: true },
  };
  const old = Object.entries(cancelled).filter(([, x]) => x.ended === true && x.level !== -1);
  const drop = new Set(old.slice(0, Math.max(0, old.length - GRID_KEEP_ENDED)).map(([k]) => k));
  return {
    ...s,
    cancelled:
      drop.size === 0
        ? cancelled
        : Object.fromEntries(Object.entries(cancelled).filter(([k]) => !drop.has(k))),
  };
}

/** Kết quả của một bước có fill, rồi giới hạn lại lệnh đang mở (#223 B1). */
function capped(
  c: GridBotConfig,
  ctx: StepContext,
  r: StepResult<GridBotState>,
): StepResult<GridBotState> {
  const x = enforceCap(c, r.state, ctx);
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
      return capped(c, ctx, { actions: [], state });
    }
  }
  const old =
    e.type === "orderDone" || e.type === "orderReject" ? s.retiring?.[e.clOrdID] : undefined;
  if ((e.type === "orderDone" || e.type === "orderReject") && old !== undefined) {
    const state: GridBotState = { ...s, retiring: retireEnd(s.retiring, e.clOrdID) };
    // Lệnh version cũ kết thúc: fill tới muộn của nó vẫn vào sổ cái theo chiều của chính lệnh (#426). Bị từ chối thì
    // không bao giờ khớp.
    return {
      actions: [],
      state:
        e.type === "orderReject"
          ? state
          : endOrder(state, e.clOrdID, {
              level: OLD_VERSION_LEVEL,
              side: old.side,
              ...(old.qty === undefined ? {} : { qty: old.qty }),
              filled: old.filled,
            }),
    };
  }
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
    // Lệnh đã kết thúc (`ended`) vẫn giữ để nhận fill tới muộn (#255 lệnh khởi tạo, #426 lệnh mức). Sàn xác nhận huỷ
    // (`orderDone`) thì nhớ là đã kết thúc thay vì quên, vì trade có thể tới sau (DEC-303); bị từ chối thì không khớp.
    if (e.type !== "fill") {
      if (gone.ended === true) return { actions: [], state: s };
      return {
        actions: [],
        state:
          e.type === "orderDone"
            ? endOrder(s, lateId, gone)
            : { ...s, cancelled: without(s.cancelled ?? {}, lateId) },
      };
    }
    // Biết khối lượng đặt (lệnh mức, lệnh version cũ): chỉ ghi tới đủ khối lượng, fill phát lại không cộng trùng (#426).
    const placed = gone.level >= 0 ? qtyOf(s, gone) : gone.qty;
    const q =
      placed === undefined
        ? dec(e.quantity)
        : Decimal.max(0, Decimal.min(dec(placed).sub(gone.filled ?? "0"), e.quantity));
    if (!q.gt(0)) return { actions: [], state: s };
    const fee = q.lt(e.quantity) ? dec(e.fee).mul(q).div(e.quantity).toString() : e.fee;
    const record: EndedOrder = {
      ...gone,
      filled: dec(gone.filled ?? "0")
        .add(q)
        .toString(),
    };
    const booked: GridBotState = {
      ...s,
      ledger: applyFill(s.ledger, e.side ?? gone.side, e.price, q, fee),
      // Nhớ phần đã khớp: lệnh version cũ (`applyGridVersion`) chỉ chờ phần còn lại (#261), fill phát lại không cộng trùng.
      ...(gone.level === -1 ? {} : { cancelled: { ...s.cancelled, [lateId]: record } }),
    };
    // Lệnh mở vị thế ban đầu khớp sau `orderDone` khi grid đang chạy: đặt thêm phía còn lại cho phần vừa khớp (#255).
    if (gone.level === -1 && s.phase === "running" && s.levels.length > 0)
      return capped(c, ctx, placeDeferred(c, booked, s.lastPrice ?? e.price, ctx));
    // Lệnh mức kết thúc / bị huỷ khi grid đang chạy (DEC-359): phần khớp muộn chưa có đối ứng, đủ min size, được đặt thêm
    // một lệnh đối ứng; tổng đối ứng = tổng đã khớp. "Đang chạy" gồm `starting` (lệnh khởi tạo chưa xong), như lệnh đối
    // ứng thường. Lệnh huỷ lúc dừng, hoặc grid đang dừng: chỉ vào sổ cái, Resume dựng lại theo vị thế.
    if (gone.countered !== undefined && (s.phase === "running" || s.phase === "starting")) {
      const x = counterRest(c, ctx, booked, record, gone.countered);
      return capped(c, ctx, {
        actions: x.result.actions,
        state: {
          ...x.result.state,
          cancelled: {
            ...x.result.state.cancelled,
            [lateId]: { ...record, countered: x.countered },
          },
        },
      });
    }
    return capped(c, ctx, { actions: [], state: booked });
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
    // Lệnh bị từ chối / kết thúc trên sàn trong lúc dừng: bỏ khỏi danh sách để resume đặt lại mức đó. Kết thúc thì vẫn
    // nhớ để fill tới muộn vào sổ cái (#426), không đặt lệnh (đang dừng).
    if (e.type === "orderReject" || e.type === "orderDone") {
      const stopped = s.open[e.clOrdID];
      if (stopped !== undefined) {
        const state: GridBotState = { ...s, open: without(s.open, e.clOrdID) };
        return {
          actions: [],
          state: e.type === "orderDone" ? endOrder(state, e.clOrdID, stopped) : state,
        };
      }
    }
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
    // Đã dừng: lệnh giảm vị thế còn giữ (pause vì max loss) vẫn có thể khớp; chỉ ghi sổ cái, không đặt lệnh mới. Khớp một
    // phần thì lệnh vẫn được theo dõi để các phần khớp sau cũng vào sổ cái (#261).
    const o = e.type === "fill" ? s.open[e.clOrdID] : undefined;
    if (e.type !== "fill" || o === undefined) return { actions: [], state: s };
    return { actions: [], state: bookLevelFill(s, e.clOrdID, o, e).state };
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

  // Lệnh mức kết thúc trên sàn khi đã khớp một phần (#261): thôi theo dõi, đối ứng cho phần đã khớp nếu đủ min size.
  // Lệnh chưa khớp gì giữ cách xử lý cũ.
  if (e.type === "orderDone") {
    const o = s.open[e.clOrdID];
    if (o !== undefined && dec(o.filled ?? "0").gt(0)) {
      const state: GridBotState = { ...s, open: without(s.open, e.clOrdID) };
      const x = counterRest(c, ctx, state, o, "0");
      // Nhớ lệnh đã kết thúc và phần đã có đối ứng: trade tới sau `orderDone` vẫn vào sổ cái (#426).
      return capped(c, ctx, {
        actions: x.result.actions,
        state: endOrder(x.result.state, e.clOrdID, { ...o, countered: x.countered }),
      });
    }
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
    // Mọi lần khớp vào sổ cái; khớp một phần thì lệnh vẫn mở, chưa đặt đối ứng (#261, DEC-359).
    const { state, filled } = bookLevelFill(s, e.clOrdID, o, e);
    const g = guards(c, state, e.price);
    if (g !== null) return g;
    if (state.open[e.clOrdID] !== undefined) return capped(c, ctx, { actions: [], state });
    // Khớp hết: MỘT lệnh đối ứng bằng tổng đã khớp (khớp đủ một lần: đúng khối lượng mỗi mức như trước).
    return capped(c, ctx, counter(c, ctx, state, o, filled));
  }

  if (e.type === "fundingPaid" && e.market === c.market) {
    const state = { ...s, ledger: applyFunding(s.ledger, e.amount) };
    return guards(c, state, s.lastPrice ?? "0") ?? { actions: [], state };
  }

  return { actions: [], state: s };
}

/**
 * Ghi một fill của lệnh mức vào sổ cái (#261). Khớp hết (tổng ≥ khối lượng đặt) thì bỏ khỏi `open`; chưa hết thì giữ, kèm
 * phần đã khớp. `filled`: tổng đã khớp, đúng chuỗi khối lượng đặt khi khớp vừa đủ.
 */
function bookLevelFill(
  s: GridBotState,
  id: string,
  o: GridOrder,
  e: Extract<StrategyEvent, { type: "fill" }>,
): { state: GridBotState; filled: string } {
  const qty = qtyOf(s, o);
  const total = dec(o.filled ?? "0").add(e.quantity);
  const full = total.gte(qty);
  return {
    state: {
      ...s,
      open: full ? without(s.open, id) : { ...s.open, [id]: { ...o, filled: total.toString() } },
      ledger: applyFill(s.ledger, o.side, e.price, e.quantity, e.fee),
    },
    filled: total.eq(qty) ? qty : total.toString(),
  };
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
