import { dec, Decimal, ReasonCode, RoundMode } from "@drift/shared";

import { clOrdId } from "../core/ids";
import { applyFill, emptyLedger, type Ledger } from "../core/ledger";
import { meetsMinimum, roundPrice, roundQty } from "../core/rounding";
import type {
  BookTop,
  MarketRules,
  OrderIntent,
  StepContext,
  StepResult,
  StrategyAction,
  StrategyEvent,
  StrategyModule,
} from "../core/types";

import { vmMaxInventory, type VolumeMakerConfig } from "./schema";

// S9 Volume Maker / Market Making (VOLUME_MAKER.md mục 17.2–17.3, DEC-100): báo giá hai phía bằng lệnh post-only
// (GTX) quanh giá hiện tại và chủ động quản lý tồn kho.
// - Mọi lệnh đã gửi được theo dõi tới khi xong (huỷ xác nhận, khớp hết, bị từ chối, hoặc quá hạn): fill của
//   lệnh đã thay / đã huỷ vẫn được tính, tối đa phần chưa khớp của lệnh đó.
// - Đang có vị thế: phía đóng là lệnh GTX + reduce-only, gần mid hơn khi vị thế lớn; phía làm tăng vị thế lùi xa
//   ít nhất gấp đôi khoảng cách, bỏ hẳn khi chạm Max open position. Khối lượng lệnh đóng = vị thế − phần chưa khớp
//   của các lệnh đóng chưa xong. Vị thế dưới mức tối thiểu SoDEX coi như phẳng: báo giá hai phía bình thường.
// - Fill làm đổi vị thế → báo giá lại ở nhịp `timer` kế tiếp, cách lần trước ít nhất 2 s (mục 17.3.5).
// - `positionSync` lệch quá một lot trong ≥ 30 s → lấy vị thế SoDEX làm chuẩn, ghi log và gắn cờ.
// - Trần chi phí = phí + lỗ đã chốt + lỗ chưa chốt trên tồn kho: 80% cảnh báo, 100% dừng (BUDGET_DONE).
// - Lỗ chưa chốt trên tồn kho ≥ `inventoryLossStop` → dừng (STOP_LOSS), đóng reduce-only nếu chọn.
// - Đạt khối lượng mục tiêu hoặc hết thời gian chạy → dừng (MAX_CYCLES, DEC-43).
// Chống self-trade giữa các bot của cùng account nằm ở engine (cần thấy mọi lệnh mở của account).

export interface TrackedOrder {
  side: "buy" | "sell";
  /** close = lệnh giảm vị thế (reduce-only). */
  role: "open" | "close";
  price: string;
  qty: string;
  filled: string;
  status: "live" | "cancelling" | "done";
  /** Thời điểm đổi `status` gần nhất (ms). */
  since: number;
}

export interface VolumeMakerState {
  phase: "running" | "halted";
  mid: string | null;
  lastRefresh: number | null;
  cycle: number;
  /** Mọi lệnh đã gửi theo clOrdID; lệnh `done` được giữ 10 phút để nhận fill tới muộn. */
  orders: Record<string, TrackedOrder>;
  /** Vị thế vừa đổi vì fill: báo giá lại sớm. */
  requoteDue: boolean;
  /** Vị thế SoDEX khác sổ của bot (đang chờ xác nhận lần sau). */
  drift: { size: string; since: number } | null;
  /** Lệnh đóng reduce-only bị từ chối liên tiếp; tới ngưỡng thì gửi lệnh đóng chỉ post-only. */
  closeRejects: number;
  closeReduceOnly: boolean;
  ledger: Ledger;
  volume: string;
  makerVolume: string;
  maxInventory: string;
  warned: boolean;
  selfTradeBlocked: number;
  /** Đỉnh sổ lệnh gần nhất (engine gửi kèm `timer`, DEC-135); thiếu ở state cũ. */
  book?: BookTop | null;
  bookAt?: number | null;
  /** Giá trong cửa sổ xu hướng gần nhất cho Smart quoting (DEC-144, DEC-152). */
  recent?: { t: number; p: string }[];
  /** Điều chỉnh Smart quoting đang áp dụng (để chỉ ghi Decisions khi đổi); null = bình thường. */
  smartNote?: string | null;
  /** Chữ ký hành động Smart quoting đang áp dụng ("bid:pull|ask:15"); ghi Decisions chỉ khi chữ ký đổi (DEC-152). */
  smartSig?: string | null;
  /** Lúc Smart quoting bắt đầu có giá (để khởi động đủ dữ liệu, DEC-152). */
  smartSince?: number | null;
  /** Điều chỉnh đang được giữ của từng phía, tới `until` (DEC-152). */
  smartHold?: Partial<Record<"buy" | "sell", SmartSide & { until: number }>> | null;
}

/** Điều chỉnh Smart quoting của một phía: lùi `ticks` tick, hoặc rút hẳn lệnh mở (`pull`). */
interface SmartSide {
  ticks: number;
  pull: boolean;
  why: string;
}

/** Báo giá lại sớm (vì fill) nhưng cách lần trước ít nhất 2 s (VOLUME_MAKER.md 17.3.5). */
export const VM_MIN_REQUOTE_MS = 2_000;
/** Lệnh đang huỷ mà không có `orderDone` sau ngần này thì coi như xong (đối soát vị thế bù phần lỡ). */
export const VM_STALE_CANCEL_MS = 60_000;
/** Lệnh `done` được giữ để nhận fill tới muộn. */
export const VM_KEEP_DONE_MS = 600_000;
/** Vị thế SoDEX lệch sổ của bot lâu ngần này thì lấy SoDEX làm chuẩn. */
export const VM_DRIFT_ADOPT_MS = 30_000;
/** Lệnh đóng reduce-only bị từ chối liên tiếp ngần này lần thì gửi lệnh đóng chỉ post-only. */
export const VM_CLOSE_REJECTS_FALLBACK = 2;

const initial = (): VolumeMakerState => ({
  phase: "running",
  mid: null,
  lastRefresh: null,
  cycle: 0,
  orders: {},
  requoteDue: false,
  drift: null,
  closeRejects: 0,
  closeReduceOnly: true,
  ledger: emptyLedger(),
  volume: "0",
  makerVolume: "0",
  maxInventory: "0",
  warned: false,
  selfTradeBlocked: 0,
});

type LegacyState = Partial<VolumeMakerState> & { bid?: string | null; ask?: string | null };

/**
 * State lưu trước DEC-100 chỉ có `bid` / `ask`: chuyển thành lệnh đang theo dõi để lần báo giá sau huỷ chúng.
 * Không biết khối lượng gốc nên không giới hạn phần fill (`Infinity`); đối soát vị thế sửa phần lệch nếu có.
 */
function normalize(raw: VolumeMakerState): VolumeMakerState {
  const s = raw as LegacyState;
  if (s.orders !== undefined) return raw;
  const orders: Record<string, TrackedOrder> = {};
  const legacy = (id: string | null | undefined, side: "buy" | "sell") => {
    if (typeof id === "string")
      orders[id] = {
        side,
        role: "open",
        price: "0",
        qty: "Infinity",
        filled: "0",
        status: "live",
        since: 0,
      };
  };
  legacy(s.bid, "buy");
  legacy(s.ask, "sell");
  const rest = Object.fromEntries(
    Object.entries(s).filter(([k]) => k !== "bid" && k !== "ask"),
  ) as Partial<VolumeMakerState>;
  return { ...initial(), ...rest, orders };
}

const BP = new Decimal("0.0001");
/**
 * Smart quoting v2 (DEC-144, sửa ở DEC-152 sau 10 phút chạy thật trên BTC: lùi 3 tick ≈ 0.4 bp không đủ, cửa sổ 6 s
 * quá ngắn, quay về sau 3–4 s nên lệnh bị cuốn ngay khi vừa về). Chỉ áp dụng cho lệnh mở (không chạm lệnh đóng tồn kho):
 * - Khởi động: chưa có đủ `warmupMs` giá thì lùi cả hai phía `momentumBackoffBp`.
 * - Sổ lệnh lệch (một phía 10 mức dày ≥ `imbalanceRatio` lần phía kia): lùi phía mỏng `imbalanceBackoffBp`.
 * - Đà ngắn (giá chạy ≥ `momentumBp` trong `momentumWindowMs`): lùi phía cùng chiều `momentumBackoffBp`.
 * - Xu hướng (giá chạy ≥ `trendBp` trong `trendWindowMs`): rút hẳn lệnh mở phía cùng chiều.
 * Mọi điều chỉnh được giữ thêm `holdMs` sau lần kích hoạt cuối. Lùi theo bp, quy ra tick theo giá (tối thiểu
 * `minTicks`), nên đúng với mọi market. Chỉ lùi xa hơn / rút, không bao giờ đặt sát hơn logic thường.
 */
export const VM_SMART = {
  warmupMs: 6_000,
  imbalanceRatio: 2,
  imbalanceBackoffBp: 1,
  momentumWindowMs: 6_000,
  momentumBp: 2,
  momentumBackoffBp: 2,
  trendWindowMs: 30_000,
  trendBp: 5,
  holdMs: 15_000,
  minTicks: 2,
} as const;

/** Số tick tương ứng `bp` ở giá `mid`, tối thiểu `VM_SMART.minTicks`. */
function bpTicks(bp: number, mid: Decimal, rules: MarketRules): number {
  const t = mid.mul(bp).div(10_000).div(rules.tickSize).ceil().toNumber();
  return Math.max(VM_SMART.minTicks, t);
}

/** Thay đổi giá (bp) từ giá đầu tới giá cuối trong cửa sổ `ms`; null khi chưa đủ điểm. */
function moveBp(s: VolumeMakerState, at: number, ms: number): Decimal | null {
  const xs = (s.recent ?? []).filter((x) => at - x.t <= ms);
  const first = xs[0];
  const last = xs.at(-1);
  if (first === undefined || last === undefined || first === last) return null;
  return dec(last.p).sub(first.p).div(first.p).mul(10_000);
}

const strongest = (a: SmartSide | undefined, b: SmartSide): SmartSide =>
  a === undefined ? b : a.pull || (!b.pull && a.ticks >= b.ticks) ? a : b;

/**
 * Điều chỉnh của từng phía lúc `at`: điều kiện mới kích hoạt (giữ tới `at + holdMs`) cộng điều chỉnh còn trong hạn
 * giữ. Trả về state hold mới để lưu.
 */
function smartAdjust(
  s: VolumeMakerState,
  book: BookTop,
  mid: Decimal,
  rules: MarketRules,
  at: number,
): { buy?: SmartSide; sell?: SmartSide; hold: NonNullable<VolumeMakerState["smartHold"]> } {
  const now: { buy?: SmartSide; sell?: SmartSide } = {};
  const add = (side: "buy" | "sell", x: SmartSide) => {
    now[side] = strongest(now[side], x);
  };
  const since = s.smartSince ?? at;
  if (at - since < VM_SMART.warmupMs) {
    const t = bpTicks(VM_SMART.momentumBackoffBp, mid, rules);
    add("buy", { ticks: t, pull: false, why: "warming up price data" });
    add("sell", { ticks: t, pull: false, why: "warming up price data" });
  }
  const bidN = dec(book.bidNotional);
  const askN = dec(book.askNotional);
  if (askN.gt(0) && bidN.gt(0)) {
    const r = bidN.div(askN);
    const t = bpTicks(VM_SMART.imbalanceBackoffBp, mid, rules);
    if (r.gte(VM_SMART.imbalanceRatio))
      add("sell", {
        ticks: t,
        pull: false,
        why: `bid depth ${r.toDecimalPlaces(1).toString()}× ask depth`,
      });
    else if (r.lte(new Decimal(1).div(VM_SMART.imbalanceRatio)))
      add("buy", {
        ticks: t,
        pull: false,
        why: `ask depth ${new Decimal(1).div(r).toDecimalPlaces(1).toString()}× bid depth`,
      });
  }
  const m = moveBp(s, at, VM_SMART.momentumWindowMs);
  if (m?.abs().gte(VM_SMART.momentumBp)) {
    const up = m.gt(0);
    add(up ? "sell" : "buy", {
      ticks: bpTicks(VM_SMART.momentumBackoffBp, mid, rules),
      pull: false,
      why: `price ${up ? "up" : "down"} ${m.abs().toDecimalPlaces(1).toString()} bp in ${String(VM_SMART.momentumWindowMs / 1000)} s`,
    });
  }
  const tr = moveBp(s, at, VM_SMART.trendWindowMs);
  if (tr?.abs().gte(VM_SMART.trendBp)) {
    const up = tr.gt(0);
    add(up ? "sell" : "buy", {
      ticks: 0,
      pull: true,
      why: `trend ${up ? "up" : "down"} ${tr.abs().toDecimalPlaces(1).toString()} bp in ${String(VM_SMART.trendWindowMs / 1000)} s`,
    });
  }
  // Giữ điều chỉnh thêm `holdMs`: điều kiện vừa kích hoạt gia hạn, hết hạn thì bỏ (khởi động không cần giữ).
  const hold: NonNullable<VolumeMakerState["smartHold"]> = {};
  const out: { buy?: SmartSide; sell?: SmartSide } = {};
  for (const side of ["buy", "sell"] as const) {
    const prev = s.smartHold?.[side];
    const live = prev !== undefined && prev.until > at ? prev : undefined;
    const fresh = now[side];
    if (fresh !== undefined && fresh.why !== "warming up price data")
      hold[side] = { ...strongest(live, fresh), until: at + VM_SMART.holdMs };
    else if (live !== undefined) hold[side] = live;
    const pick = fresh === undefined ? hold[side] : strongest(hold[side], fresh);
    if (pick !== undefined) out[side] = { ticks: pick.ticks, pull: pick.pull, why: pick.why };
  }
  return { ...out, hold };
}

/** Sổ lệnh cũ hơn ngần này thì không dùng; báo giá theo giá khớp gần nhất, lùi 1 tick. */
export const VM_BOOK_MAX_AGE_MS = 10_000;

/** Sổ lệnh còn mới và không chéo, hoặc null. */
function freshBook(s: VolumeMakerState, at: number): BookTop | null {
  const b = s.book ?? null;
  if (b === null || s.bookAt == null || at - s.bookAt > VM_BOOK_MAX_AGE_MS) return null;
  return dec(b.bid).lt(b.ask) ? b : null;
}

/**
 * Giá theo mức sổ lệnh (DEC-135): mức 0 = giá tốt nhất phía mình; spread từ 3 tick trở lên thì vào trong spread
 * 1 tick (market ít thanh khoản vẫn đứng đầu sổ). Mức n = lùi n tick. Bid luôn dưới ask nên hai lệnh của bot
 * không bao giờ chạm nhau; lệnh post-only không chéo sổ.
 */
function bookPrice(book: BookTop, side: "buy" | "sell", level: number, rules: MarketRules): string {
  const tick = dec(rules.tickSize);
  const bid = dec(book.bid);
  const ask = dec(book.ask);
  const wide = ask.sub(bid).gte(tick.mul(3));
  if (side === "buy")
    return (level === 0 && wide ? bid.add(tick) : bid).sub(tick.mul(level)).toString();
  return (level === 0 && wide ? ask.sub(tick) : ask).add(tick.mul(level)).toString();
}

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

/** Vị thế phẳng (dưới mức tối thiểu SoDEX): coi như 0 khi báo giá, để không đặt lệnh reduce-only bị SoDEX từ chối. */
function isFlat(pos: Decimal, mid: string, rules: MarketRules): boolean {
  const qty = roundQty(pos.abs(), rules);
  return dec(qty).isZero() || !meetsMinimum(mid, qty, rules);
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

/** Phần chưa khớp của một lệnh còn đang theo dõi. */
function remaining(o: TrackedOrder): Decimal {
  return dec(o.qty).sub(o.filled);
}

/** Tổng phần chưa khớp của các lệnh đóng (role = close) chưa xong (live hoặc đang huỷ). */
function pendingClose(s: VolumeMakerState, closingSide: "buy" | "sell"): Decimal {
  let sum = new Decimal(0);
  for (const o of Object.values(s.orders)) {
    if (o.role !== "close" || o.status === "done" || o.side !== closingSide) continue;
    sum = sum.add(remaining(o));
  }
  return sum;
}

/** Giá tick-grid chắc chắn ở đúng phía mid: mua dưới mid, bán trên mid, ít nhất 1 tick. */
function tickAway(mid: Decimal, side: "buy" | "sell", price: Decimal, rules: MarketRules): string {
  const raw = roundPrice(price, rules, side === "buy" ? RoundMode.down : RoundMode.up);
  const p = dec(raw);
  if (side === "buy" && p.gte(mid)) return mid.sub(rules.tickSize).toString();
  if (side === "sell" && p.lte(mid)) return mid.add(rules.tickSize).toString();
  return raw;
}

/**
 * Tính các lệnh mới cho một chu kỳ báo giá: huỷ mọi lệnh đang mở, rồi đặt lệnh theo bảng vị thế.
 * Trả về danh sách hành động (cancels trước, places sau) và state đã cập nhật (orders, cycle, lastRefresh).
 */
function quote(
  c: VolumeMakerConfig,
  s: VolumeMakerState,
  ctx: StepContext,
  at: number,
): { actions: StrategyAction[]; state: VolumeMakerState } {
  const rules = ctx.rules[c.market];
  if (rules === undefined || s.mid === null) return { actions: [], state: s };
  const mid = dec(s.mid);
  const cycle = s.cycle + 1;
  const pos = dec(s.ledger.position);
  const flat = isFlat(pos, s.mid, rules);
  const maxInv = dec(vmMaxInventory(c));
  // Chế độ sổ lệnh mà chưa có sổ lệnh mới: bám giá khớp gần nhất, lùi đúng 1 tick (không dùng khoảng cách bp cũ).
  const d = c.quoteLevel === undefined ? BP.mul(c.distanceBp) : new Decimal(0);
  const orderQty = roundQty(dec(c.orderSize).div(mid), rules);
  // Báo giá theo sổ lệnh khi config có `quoteLevel` và có sổ lệnh mới (DEC-135).
  const book = c.quoteLevel === undefined ? null : freshBook(s, at);
  const level = c.quoteLevel ?? 0;
  // Smart quoting (DEC-144, v2 DEC-152): chỉ khi bật và có sổ lệnh mới; tắt thì không lùi, không rút, đúng logic cũ.
  const smart = c.smartQuoting && book !== null ? smartAdjust(s, book, mid, rules, at) : null;
  const extra = { buy: smart?.buy?.ticks ?? 0, sell: smart?.sell?.ticks ?? 0 };
  const pulled = { buy: smart?.buy?.pull === true, sell: smart?.sell?.pull === true };
  const sideText = (side: "buy" | "sell") => {
    const x = smart?.[side];
    if (x === undefined) return null;
    const name = side === "buy" ? "bid" : "ask";
    return `${x.pull ? `${name} pulled` : `${name} back ${String(x.ticks)} ticks`} (${x.why})`;
  };
  const sig =
    smart === null
      ? null
      : (["buy", "sell"] as const)
          .flatMap((sd) => {
            const x = smart[sd];
            return x === undefined ? [] : [`${sd}:${x.pull ? "pull" : String(x.ticks)}`];
          })
          .join("|") || null;
  const note = [sideText("buy"), sideText("sell")].filter((x) => x !== null).join("; ") || null;

  // Huỷ mọi lệnh đang mở (chúng trở thành cancelling; lệnh đóng đang cancelling vẫn chiếm chỗ khi tính close size).
  const cancels: StrategyAction[] = [];
  const orders: Record<string, TrackedOrder> = {};
  for (const [id, o] of Object.entries(s.orders)) {
    if (o.status === "live") {
      cancels.push({ type: "cancel", clOrdID: id });
      orders[id] = { ...o, status: "cancelling", since: at };
    } else orders[id] = o;
  }

  const places: OrderIntent[] = [];
  let next = { ...s, orders, cycle, lastRefresh: at, requoteDue: false };
  const smartLogs: StrategyAction[] = [];
  if (c.smartQuoting && sig !== (s.smartSig ?? null)) {
    smartLogs.push(
      note === null
        ? {
            type: "log",
            decision: "Smart quoting back to normal",
            why: "Order book and price are calm; quoting at the set position.",
          }
        : {
            type: "log",
            decision: "Smart quoting adjusted",
            why: `${note.charAt(0).toUpperCase()}${note.slice(1)}.`,
          },
    );
    next = { ...next, smartNote: note, smartSig: sig };
  }
  if (smart !== null) next = { ...next, smartHold: smart.hold, smartSince: s.smartSince ?? at };

  // Phẳng: báo giá hai phía đối xứng, mỗi phía một lệnh kích thước gốc (VOLUME_MAKER.md 17.3).
  if (flat) {
    const bidPrice =
      book !== null
        ? bookPrice(book, "buy", level + extra.buy, rules)
        : tickAway(mid, "buy", mid.mul(new Decimal(1).sub(d)), rules);
    const askPrice =
      book !== null
        ? bookPrice(book, "sell", level + extra.sell, rules)
        : tickAway(mid, "sell", mid.mul(new Decimal(1).add(d)), rules);
    const bid = order(c, ctx, "buy", bidPrice, orderQty, `vm:${String(cycle)}:bid`);
    const ask = order(c, ctx, "sell", askPrice, orderQty, `vm:${String(cycle)}:ask`);
    // Smart quoting rút phía đang có xu hướng chạy vào (DEC-152).
    if (!pulled.buy && meetsMinimum(bidPrice, bid.quantity, rules)) places.push(bid);
    if (!pulled.sell && meetsMinimum(askPrice, ask.quantity, rules)) places.push(ask);
  } else {
    const long = pos.gt(0);
    const inv = pos.mul(mid).abs();
    const u = Decimal.min(1, inv.div(maxInv));
    const closeSide = long ? "sell" : "buy";
    // Phía đóng: lệnh GTX + reduce-only, gần mid khi tồn kho lớn (ít nhất 1 tick khỏi mid).
    const closeRaw = mid.mul(new Decimal(1)[long ? "add" : "sub"](d.mul(new Decimal(1).sub(u))));
    // Theo sổ lệnh: lệnh đóng đứng ở giá tốt nhất phía đóng để thoát vị thế nhanh.
    const closePrice =
      book !== null
        ? bookPrice(book, closeSide, 0, rules)
        : tickAway(mid, closeSide, closeRaw, rules);
    const closeQty = roundQty(pos.abs().sub(pendingClose(next, closeSide)), rules);
    if (meetsMinimum(closePrice, closeQty, rules)) {
      places.push(
        order(c, ctx, closeSide, closePrice, closeQty, `vm:${String(cycle)}:rc`, s.closeReduceOnly),
      );
    }
    // Phía làm tăng vị thế: lùi xa ít nhất gấp đôi khoảng cách, bỏ hẳn khi chạm giới hạn.
    if (u.lt(1) && !pulled[long ? "buy" : "sell"]) {
      const riskSide = long ? "buy" : "sell";
      const riskRaw = mid.mul(
        new Decimal(1)[long ? "sub" : "add"](d.mul(new Decimal(2).add(u.mul(2)))),
      );
      // Theo sổ lệnh: phía làm tăng vị thế lùi thêm 2 tick, 3 tick khi đã giữ quá nửa giới hạn.
      const riskPrice =
        book !== null
          ? bookPrice(book, riskSide, level + (u.gte("0.5") ? 3 : 2) + extra[riskSide], rules)
          : tickAway(mid, riskSide, riskRaw, rules);
      const room = maxInv.sub(inv).div(mid);
      const riskQty = roundQty(Decimal.min(orderQty, room), rules);
      if (meetsMinimum(riskPrice, riskQty, rules))
        places.push(order(c, ctx, riskSide, riskPrice, riskQty, `vm:${String(cycle)}:${riskSide}`));
    }
  }

  let tracked = orders;
  for (const o of places) {
    const id = o.clOrdID;
    const role = o.reduceOnly ? "close" : "open";
    tracked = {
      ...tracked,
      [id]: {
        side: o.side,
        role,
        price: o.price ?? "0",
        qty: o.quantity,
        filled: "0",
        status: "live",
        since: at,
      },
    };
  }
  next = { ...next, orders: tracked };
  const actions = [
    ...cancels,
    ...places.map((o) => ({ type: "place" as const, order: o })),
    ...smartLogs,
  ];
  return { actions, state: next };
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
  const actions: StrategyAction[] = [];
  // Huỷ mọi lệnh đang mở.
  for (const [id, o] of Object.entries(s.orders)) {
    if (o.status === "live") actions.push({ type: "cancel", clOrdID: id });
  }
  actions.push({ type: "log", decision: "Volume Maker stopped", why });
  if (close && rules !== undefined) {
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
  const orders: Record<string, TrackedOrder> = {};
  for (const [id, o] of Object.entries(s.orders)) {
    orders[id] = o.status === "live" ? { ...o, status: "cancelling" } : o;
  }
  return { actions, state: { ...s, phase: "halted", orders, requoteDue: false } };
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
  if (c.inventoryLossStop !== undefined && unrealized.neg().gte(c.inventoryLossStop))
    return halt(c, s, ctx, ReasonCode.stopLoss, `Inventory loss reached ${c.inventoryLossStop}.`);
  if (c.volumeTarget !== undefined && dec(s.volume).gte(c.volumeTarget))
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

/**
 * Dọn state: lệnh cancelling quá VM_STALE_CANCEL_MS → done; lệnh done quá VM_KEEP_DONE_MS → xoá.
 * Trả về state gốc nếu không đổi gì (để engine bỏ qua lần ghi đó).
 */
function housekeep(s: VolumeMakerState, at: number): VolumeMakerState {
  let changed = false;
  const orders: Record<string, TrackedOrder> = {};
  for (const [id, o] of Object.entries(s.orders)) {
    if (o.status === "cancelling" && at - o.since >= VM_STALE_CANCEL_MS) {
      orders[id] = { ...o, status: "done" };
      changed = true;
    } else if (o.status === "done" && at - o.since >= VM_KEEP_DONE_MS) {
      changed = true; // bỏ lệnh cũ
    } else {
      orders[id] = o;
    }
  }
  return changed ? { ...s, orders } : s;
}

export function stepVolumeMaker(
  c: VolumeMakerConfig,
  raw: VolumeMakerState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<VolumeMakerState> {
  let s = normalize(raw);
  if (s.phase === "halted" && e.type !== "fill") return { actions: [], state: s };
  switch (e.type) {
    case "tick": {
      if (e.market !== c.market) return { actions: [], state: s };
      // Giữ giá vài giây gần nhất cho Smart quoting (DEC-144); chỉ khi bật, state cũ không đổi.
      const recent = c.smartQuoting
        ? [...(s.recent ?? []), { t: e.at, p: e.price }].filter(
            (x) => e.at - x.t <= Math.max(VM_SMART.momentumWindowMs, VM_SMART.trendWindowMs),
          )
        : s.recent;
      const state = {
        ...s,
        mid: e.price,
        ...(recent === undefined ? {} : { recent }),
        ...(c.smartQuoting && (s.smartSince ?? null) === null ? { smartSince: e.at } : {}),
      };
      const g = guards(c, state, ctx, e.at);
      if (g !== null) return g;
      // Báo giá đầu tiên ngay khi có giá.
      if (state.lastRefresh === null) {
        const { actions, state: next } = quote(c, state, ctx, e.at);
        return guards(c, next, ctx, e.at) ?? { actions, state: next };
      }
      return { actions: [], state };
    }
    case "timer": {
      if (e.market?.market === c.market && e.market.book !== null)
        s = { ...s, book: e.market.book, bookAt: e.at };
      const g = guards(c, s, ctx, e.at);
      if (g !== null) return g;
      const hk = housekeep(s, e.at);
      if (s.lastRefresh === null || hk !== s) {
        if (hk !== s) return { actions: [], state: hk };
      }
      const elapsed = s.lastRefresh !== null ? e.at - s.lastRefresh : Infinity;
      const due = s.requoteDue && elapsed >= VM_MIN_REQUOTE_MS;
      const interval = elapsed >= c.refreshSeconds * 1000;
      if (!due && !interval) return { actions: [], state: s };
      const { actions, state: next } = quote(c, s, ctx, e.at);
      return guards(c, next, ctx, e.at) ?? { actions, state: next };
    }
    case "fill": {
      const o = s.orders[e.clOrdID];
      if (o === undefined) return { actions: [], state: s };
      const cap = remaining(o);
      const qty = Decimal.min(cap, e.quantity);
      if (!qty.gt(0)) return { actions: [], state: s };
      const fee = qty.lt(dec(e.quantity)) ? dec(e.fee).mul(qty).div(e.quantity).toString() : e.fee;
      const ledger = applyFill(s.ledger, o.side, e.price, qty, fee);
      const notional = dec(e.price).mul(qty);
      const mid = s.mid ?? e.price;
      const inv = dec(ledger.position).mul(mid).abs();
      const filled = dec(o.filled).add(qty);
      const isDone = o.qty !== "Infinity" && filled.gte(o.qty);
      const orders = {
        ...s.orders,
        [e.clOrdID]: {
          ...o,
          filled: filled.toString(),
          status: isDone ? ("done" as const) : o.status,
          since: isDone ? e.at : o.since,
        },
      };
      const state: VolumeMakerState = {
        ...s,
        ledger,
        volume: dec(s.volume).add(notional).toString(),
        makerVolume: dec(s.makerVolume).add(notional).toString(),
        maxInventory: Decimal.max(s.maxInventory, inv).toString(),
        orders,
        requoteDue: true,
      };
      return guards(c, state, ctx, e.at) ?? { actions: [], state };
    }
    case "orderAck": {
      const o = s.orders[e.clOrdID];
      if (o?.role !== "close") return { actions: [], state: s };
      return { actions: [], state: { ...s, closeRejects: 0 } };
    }
    case "orderReject": {
      const o = s.orders[e.clOrdID];
      if (o === undefined) return { actions: [], state: s };
      const orders = { ...s.orders, [e.clOrdID]: { ...o, status: "done" as const, since: e.at } };
      const blocked = e.code === "SELF_TRADE_BLOCKED";
      let state: VolumeMakerState = {
        ...s,
        orders,
        selfTradeBlocked: s.selfTradeBlocked + (blocked ? 1 : 0),
        requoteDue: true,
      };
      if (blocked)
        return {
          actions: [
            {
              type: "log",
              decision: "Quote skipped",
              why: "It would have traded with your own order (SELF_TRADE_BLOCKED).",
            },
          ],
          state,
        };
      // Lệnh đóng reduce-only bị từ chối: có thể SoDEX không chấp nhận GTX kèm reduceOnly.
      if (
        o.role === "close" &&
        s.closeReduceOnly &&
        e.code !== "POST_ONLY_WOULD_TRADE" &&
        e.code !== "RISK_PER_TRADE"
      ) {
        const closeRejects = s.closeRejects + 1;
        if (closeRejects >= VM_CLOSE_REJECTS_FALLBACK) {
          state = { ...state, closeRejects: 0, closeReduceOnly: false };
          return {
            actions: [
              {
                type: "log",
                decision: "Close orders sent post-only",
                why: "SoDEX rejected reduce-only close orders; closing now without reduce-only, still capped by your position.",
              },
            ],
            state,
          };
        }
        return { actions: [], state: { ...state, closeRejects } };
      }
      return { actions: [], state };
    }
    case "orderDone": {
      const o = s.orders[e.clOrdID];
      if (o === undefined) return { actions: [], state: s };
      if (o.status === "done") return { actions: [], state: s };
      return {
        actions: [],
        state: {
          ...s,
          orders: { ...s.orders, [e.clOrdID]: { ...o, status: "done", since: e.at } },
        },
      };
    }
    case "positionSync": {
      if (e.market !== c.market) return { actions: [], state: s };
      const rules = ctx.rules[c.market];
      const sdex = dec(e.size);
      const ours = dec(s.ledger.position);
      const gap = sdex.sub(ours).abs();
      if (rules === undefined) return { actions: [], state: s };
      if (gap.lt(rules.stepSize)) return { actions: [], state: { ...s, drift: null } };
      const persist = s.drift !== null && e.at - s.drift.since >= VM_DRIFT_ADOPT_MS;
      if (!persist) {
        const since = s.drift?.since ?? e.at;
        return { actions: [], state: { ...s, drift: { size: e.size, since } } };
      }
      const position = sdex.toString();
      const avgCost = sdex.isZero() ? new Decimal(0).toString() : e.entryPrice;
      return {
        actions: [
          {
            type: "log",
            decision: "Position re-synced from SoDEX",
            why: `SoDEX position ${e.size} differed from the bot's ${s.ledger.position} for ${String(Math.round(VM_DRIFT_ADOPT_MS / 1000))} s.`,
          },
          { type: "flag", needsAttention: true },
        ],
        state: { ...s, ledger: { ...s.ledger, position, avgCost }, drift: null, requoteDue: true },
      };
    }
    case "fundingPaid":
    case "fundingRate":
    case "marginRatio":
    case "leaderFill":
    case "leaderPosition":
      return { actions: [], state: s };
  }
}

export const volumeMaker: StrategyModule<VolumeMakerConfig, VolumeMakerState> = {
  initialState: initial,
  step: stepVolumeMaker,
};
