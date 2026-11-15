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
  /** Lần cuối nhận giá sổ lệnh qua WS (DEC-248); còn mới thì REST 3 s chỉ cập nhật độ dày, không đè giá. */
  bookStreamAt?: number | null;
  /** Đếm request lệnh (đặt + huỷ) gửi SoDEX trong cửa sổ 1 phút, ghi Decisions (DEC-248). */
  reqWin?: { since: number; n: number };
  /** Lần cắt vị thế gần nhất (DEC-249). */
  cutAt?: number | null;
  /** Giá trong cửa sổ xu hướng gần nhất cho Smart quoting (DEC-144, DEC-152). */
  /** Giá gần đây cho momentum / trend; không còn ghi từ DEC-247, giữ để đọc state cũ. */
  recent?: { t: number; p: string }[];
  /** Điều chỉnh Smart quoting đang áp dụng (để chỉ ghi Decisions khi đổi); null = bình thường. */
  smartNote?: string | null;
  /** Chữ ký hành động Smart quoting đang áp dụng ("bid:pull|ask:15"); ghi Decisions chỉ khi chữ ký đổi (DEC-152). */
  smartSig?: string | null;
  /** Lúc Smart quoting bắt đầu có giá (để khởi động đủ dữ liệu, DEC-152). */
  smartSince?: number | null;
  /** Điều chỉnh đang được giữ của từng phía, tới `until` (DEC-152). */
  smartHold?: Partial<Record<"buy" | "sell", SmartSide & { until: number }>> | null;
  /** Lúc vị thế bắt đầu mở (từ phẳng), cho "Close only at your entry price or better"; null = phẳng. */
  positionSince?: number | null;
  /** Đã quá `VM_ENTRY_CLOSE_MS` và đã chuyển sang cách đóng thường (ghi Decisions một lần). */
  entryCloseExpired?: boolean;
  /** Giá vài giây gần nhất cho "Pause on fast moves". */
  fastRecent?: { t: number; p: string }[];
  /** Đang tạm rút lệnh mở vì giá chạy nhanh, tới thời điểm này (ms); null = bình thường. */
  fastPauseUntil?: number | null;
  /** Giá Binance quy đổi gần nhất (Smart quoting) và lúc nhận. */
  fair?: string | null;
  fairAt?: number | null;
  /** Giờ Binance của giá đó: độ mới tính theo giờ này (luồng Binance khựng thì giá cũ dù engine vừa nhận). */
  fairBinanceAt?: number | null;
  /** Số liệu định giá theo Binance từ lần ghi Decisions trước: số lệnh bị rút, số lệnh đặt lùi ra. */
  oracleWin?: { since: number; pulls: number; clamps: number };
}

/** Điều chỉnh Smart quoting của một phía: lùi `ticks` tick, hoặc rút hẳn lệnh mở (`pull`). */
interface SmartSide {
  ticks: number;
  pull: boolean;
  why: string;
}

/**
 * Định giá theo Binance (Smart quoting): lệnh mở thêm vị thế không bao giờ vượt giá Binance quy đổi ± `marginBp`; lệnh
 * mở mà giá Binance đã chạy qua thì rút. Giá cũ hơn `maxAgeMs` (tính theo giờ Binance) thì không dùng. Số liệu ghi
 * Decisions mỗi `logEveryMs`.
 */
export const VM_ORACLE = { marginBp: 0.5, maxAgeMs: 1_500, logEveryMs: 60_000 } as const;

/**
 * Cắt vị thế (DEC-249, chỉ khi bật Smart quoting): đang giữ vị thế mà giá Binance quy đổi đã chạy ngược giá vào
 * ≥ `bp` thì huỷ mọi lệnh và đóng cả vị thế bằng lệnh market IOC reduce-only. Lệnh đóng post-only không đuổi kịp giá
 * chạy một chiều (2026-11-15: BTC +1% trong 2 phút, 16 lệnh đóng bị từ chối PostOnly, lỗ ~97 bp trên một lệnh).
 * Backtest BTC / ETH 4.5 giờ: ngưỡng 15 bp kích hoạt 1–4 lần / giờ, CPM gần như không đổi lúc thường. Không cắt lại
 * trong `coolMs` khi lệnh cắt trước chưa xong.
 */
export const VM_CUT = { bp: 15, coolMs: 5_000 } as const;

/** Báo giá lại sớm (vì fill) nhưng cách lần trước ít nhất 2 s (VOLUME_MAKER.md 17.3.5). */
export const VM_MIN_REQUOTE_MS = 2_000;
/**
 * Sổ lệnh thời gian thực (DEC-248, chỉ khi bật Smart quoting): giá tốt nhất SoDEX chạy ra xa lệnh của mình (bid tốt nhất
 * cao hơn bid của mình, ask tốt nhất thấp hơn ask của mình) thì đặt lại riêng phía đó, cách lần báo giá trước ít nhất
 * `minRequoteMs`. Giá chạy về phía lệnh thì giữ nguyên (việc rút theo giá Binance lo phần an toàn), phía vừa bị khớp chờ
 * chu kỳ thường: đuổi theo giá lúc đang chạy làm lệnh bị từ chối PostOnly và tốn request (chạy thử 2026-11-15: 37%
 * PostOnly, ~85 request / phút với 1 s, hai phía). Giá WS còn mới trong `freshMs` thì REST 3 s chỉ cập nhật độ dày 10
 * mức. Mỗi `logEveryMs` ghi số request đã gửi.
 */
export const VM_BOOK_STREAM = { minRequoteMs: 1_500, freshMs: 1_500, logEveryMs: 60_000 } as const;
/**
 * Lệnh mở đang huỷ quá ngần này mà SoDEX chưa xác nhận (DEC-253): phía đó không đặt thêm lệnh mở cho tới khi có xác
 * nhận (hoặc hết `VM_STALE_CANCEL_MS`). Lệnh huỷ tới trước khi lệnh vào sổ thì SoDEX trả `OrderNotFound`, lệnh vào sổ
 * sau đó và vẫn có thể khớp; đặt thêm lệnh cùng phía lúc đó làm vị thế vượt "Holds up to" (2026-11-15: hai lệnh mua cùng
 * khớp, vị thế gấp đôi). Lệnh vừa huỷ trong chu kỳ này không tính (xác nhận thường về sau ~0,4 s).
 */
export const VM_UNSURE_CANCEL_MS = 1_000;
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
 * - Khởi động: chưa có đủ `warmupMs` giá thì lùi cả hai phía `warmupBackoffBp`.
 * - Sổ lệnh lệch (một phía 10 mức dày ≥ `imbalanceRatio` lần phía kia): lùi phía mỏng `imbalanceBackoffBp`.
 * Đà ngắn (momentum) và xu hướng (trend) đã bỏ ở DEC-247: backtest cho thấy kẹp theo giá Binance (DEC-242) làm thay
 * tốt hơn, còn hai tín hiệu này làm BTC đắt hơn và giảm mạnh số lệnh khớp.
 * Mọi điều chỉnh được giữ thêm `holdMs` sau lần kích hoạt cuối. Lùi theo bp, quy ra tick theo giá (tối thiểu
 * `minTicks`), nên đúng với mọi market. Chỉ lùi xa hơn / rút, không bao giờ đặt sát hơn logic thường.
 */
export const VM_SMART = {
  warmupMs: 6_000,
  imbalanceRatio: 2,
  imbalanceBackoffBp: 1,
  warmupBackoffBp: 2,
  holdMs: 15_000,
  minTicks: 2,
} as const;

/** Số tick tương ứng `bp` ở giá `mid`, tối thiểu `VM_SMART.minTicks`. */
function bpTicks(bp: number, mid: Decimal, rules: MarketRules): number {
  const t = mid.mul(bp).div(10_000).div(rules.tickSize).ceil().toNumber();
  return Math.max(VM_SMART.minTicks, t);
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
    const t = bpTicks(VM_SMART.warmupBackoffBp, mid, rules);
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

/** "Close only at your entry price or better": giữ vị thế quá ngần này thì đóng theo cách thường (PM chốt B2). */
export const VM_ENTRY_CLOSE_MS = 30 * 60_000;
/**
 * "Pause on fast moves": giá (cao nhất − thấp nhất) trong `windowMs` ≥ max(`ticks` bước giá, `minBp` bp của giá) → rút lệnh
 * mở `waitMs`. Ngưỡng tối thiểu theo bp để không bật liên tục ở market có bước giá rất nhỏ (BTC 3 tick ≈ 0,45 bp), PM
 * chốt sau bản rà soát strategy (thay ngưỡng 3 tick của C1).
 */
export const VM_FAST = { ticks: 3, minBp: 2, windowMs: 6_000, waitMs: 15_000 } as const;

/** Giá chạy trong cửa sổ (cao nhất − thấp nhất) và ngưỡng kích hoạt (giá); null khi chưa đủ điểm. */
function fastMove(
  xs: readonly { p: string }[],
  rules: MarketRules,
): { range: Decimal; threshold: Decimal; bp: Decimal } | null {
  if (xs.length < 2) return null;
  let hi = dec(xs[0]?.p ?? "0");
  let lo = hi;
  for (const x of xs) {
    const p = dec(x.p);
    if (p.gt(hi)) hi = p;
    if (p.lt(lo)) lo = p;
  }
  const last = dec(xs.at(-1)?.p ?? "0");
  if (last.lte(0)) return null;
  const range = hi.sub(lo);
  const threshold = Decimal.max(
    dec(rules.tickSize).mul(VM_FAST.ticks),
    last.mul(VM_FAST.minBp).div(10_000),
  );
  return { range, threshold, bp: range.div(last).mul(10_000) };
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
  /** Chỉ đặt lại các phía này (DEC-248); phía khác giữ nguyên lệnh đang sống, không đặt thêm. */
  only?: ReadonlySet<"buy" | "sell">,
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
  // Pause on fast moves: rút mọi lệnh mở, giữ lệnh đóng reduce-only (PM chốt C2).
  const paused = c.pauseOnFastMoves && s.fastPauseUntil != null && at < s.fastPauseUntil;
  // Lệnh mở đang huỷ chưa được xác nhận quá VM_UNSURE_CANCEL_MS: có thể vẫn khớp, không đặt thêm cùng phía (DEC-253).
  const unsure = { buy: false, sell: false };
  for (const o of Object.values(s.orders))
    if (o.status === "cancelling" && o.role === "open" && at - o.since >= VM_UNSURE_CANCEL_MS)
      unsure[o.side] = true;
  const pulled = {
    buy: paused || smart?.buy?.pull === true,
    sell: paused || smart?.sell?.pull === true,
  };
  // Định giá theo Binance: lệnh mở thêm vị thế không vượt giá Binance quy đổi ± lề (bán không thấp hơn, mua không cao
  // hơn). Lệnh đóng vẫn đứng ở giá tốt nhất.
  const fair =
    c.smartQuoting &&
    s.fair != null &&
    s.fairBinanceAt != null &&
    at - s.fairBinanceAt <= VM_ORACLE.maxAgeMs
      ? dec(s.fair)
      : null;
  let clamps = 0;
  const oracle = (side: "buy" | "sell", price: string): string => {
    if (fair === null) return price;
    const m = new Decimal(VM_ORACLE.marginBp).div(10_000);
    const limit =
      side === "sell"
        ? roundPrice(fair.mul(new Decimal(1).add(m)), rules, RoundMode.up)
        : roundPrice(fair.mul(new Decimal(1).sub(m)), rules, RoundMode.down);
    const out = side === "sell" ? Decimal.max(price, limit) : Decimal.min(price, limit);
    if (!out.eq(price)) clamps += 1;
    return out.toString();
  };
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
  const closeIds = new Set<string>();
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
  const fastLogs: StrategyAction[] = [];
  if (c.pauseOnFastMoves && !paused && s.fastPauseUntil != null) {
    fastLogs.push({
      type: "log",
      decision: "Quoting again after a fast move",
      why: `Price stayed calm for ${String(VM_FAST.waitMs / 1000)} s.`,
    });
    next = { ...next, fastPauseUntil: null };
  }
  // Mốc giữ vị thế cho "Close only at your entry price or better".
  next = { ...next, positionSince: flat ? null : (s.positionSince ?? at) };
  if (flat) next = { ...next, entryCloseExpired: false };

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
    const bid = order(c, ctx, "buy", oracle("buy", bidPrice), orderQty, `vm:${String(cycle)}:bid`);
    const ask = order(
      c,
      ctx,
      "sell",
      oracle("sell", askPrice),
      orderQty,
      `vm:${String(cycle)}:ask`,
    );
    // Smart quoting rút phía đang có xu hướng chạy vào (DEC-152).
    if (!pulled.buy && meetsMinimum(bid.price ?? bidPrice, bid.quantity, rules)) places.push(bid);
    if (!pulled.sell && meetsMinimum(ask.price ?? askPrice, ask.quantity, rules)) places.push(ask);
  } else {
    const long = pos.gt(0);
    const inv = pos.mul(mid).abs();
    const u = Decimal.min(1, inv.div(maxInv));
    const closeSide = long ? "sell" : "buy";
    // Phía đóng: lệnh GTX + reduce-only, gần mid khi tồn kho lớn (ít nhất 1 tick khỏi mid).
    const closeRaw = mid.mul(new Decimal(1)[long ? "add" : "sub"](d.mul(new Decimal(1).sub(u))));
    // Theo sổ lệnh: lệnh đóng đứng ở giá tốt nhất phía đóng để thoát vị thế nhanh.
    const bestClose =
      book !== null
        ? bookPrice(book, closeSide, 0, rules)
        : tickAway(mid, closeSide, closeRaw, rules);
    // Close only at your entry price or better (PM chốt B1–B2): long bán ở max(giá tốt nhất, giá vào), short mua ở
    // min(…); giá vào chưa gồm phí. Giữ quá 30 phút → đóng theo cách thường, ghi Decisions một lần.
    const entry = dec(s.ledger.avgCost);
    const held = at - (next.positionSince ?? at);
    const atEntry = c.closeAtEntry && entry.gt(0) && held < VM_ENTRY_CLOSE_MS;
    let closePrice = bestClose;
    if (atEntry) {
      const e = dec(roundPrice(entry, rules, long ? RoundMode.up : RoundMode.down));
      closePrice = (long ? Decimal.max(bestClose, e) : Decimal.min(bestClose, e)).toString();
    } else if (c.closeAtEntry && entry.gt(0) && s.entryCloseExpired !== true) {
      fastLogs.push({
        type: "log",
        decision: "Closing at the best price",
        why: `The position was open for ${String(VM_ENTRY_CLOSE_MS / 60_000)} min without closing at your entry price or better.`,
      });
      next = { ...next, entryCloseExpired: true };
    }
    const closeQty = roundQty(pos.abs().sub(pendingClose(next, closeSide)), rules);
    if (meetsMinimum(closePrice, closeQty, rules)) {
      const rc = order(
        c,
        ctx,
        closeSide,
        closePrice,
        closeQty,
        `vm:${String(cycle)}:rc`,
        s.closeReduceOnly,
      );
      closeIds.add(rc.clOrdID);
      places.push(rc);
    }
    // Phía làm tăng vị thế: lùi xa ít nhất gấp đôi khoảng cách, bỏ hẳn khi chạm giới hạn.
    if (u.lt(1) && !pulled[long ? "buy" : "sell"]) {
      const riskSide = long ? "buy" : "sell";
      const riskRaw = mid.mul(
        new Decimal(1)[long ? "sub" : "add"](d.mul(new Decimal(2).add(u.mul(2)))),
      );
      // Theo sổ lệnh: phía làm tăng vị thế lùi thêm 2 tick, 3 tick khi đã giữ quá nửa giới hạn.
      const riskPrice = oracle(
        riskSide,
        book !== null
          ? bookPrice(book, riskSide, level + (u.gte("0.5") ? 3 : 2) + extra[riskSide], rules)
          : tickAway(mid, riskSide, riskRaw, rules),
      );
      const room = maxInv.sub(inv).div(mid);
      const riskQty = roundQty(Decimal.min(orderQty, room), rules);
      if (meetsMinimum(riskPrice, riskQty, rules))
        places.push(order(c, ctx, riskSide, riskPrice, riskQty, `vm:${String(cycle)}:${riskSide}`));
    }
  }

  // Smart quoting giữ lệnh nằm yên (giữ chỗ trong hàng chờ): lệnh mở đang sống có đúng giá và khối lượng của báo giá
  // mới thì không huỷ, không đặt lại.
  const kept = new Set<string>();
  for (let i = c.smartQuoting ? places.length - 1 : -1; i >= 0; i -= 1) {
    const p = places[i];
    if (p === undefined || closeIds.has(p.clOrdID)) continue;
    const same = Object.entries(s.orders).find(
      ([id, o]) =>
        !kept.has(id) &&
        o.status === "live" &&
        o.role === "open" &&
        o.side === p.side &&
        dec(o.price).eq(p.price ?? "0") &&
        dec(o.qty).eq(p.quantity) &&
        dec(o.filled).isZero(),
    );
    if (same === undefined) continue;
    kept.add(same[0]);
    orders[same[0]] = same[1];
    places.splice(i, 1);
  }
  // Phía còn lệnh mở chưa xác nhận huỷ: không đặt lệnh mở mới, giữ nguyên lệnh mở đang nằm (DEC-253).
  for (const side of ["buy", "sell"] as const) {
    if (!unsure[side]) continue;
    for (let i = places.length - 1; i >= 0; i -= 1) {
      const p = places[i];
      if (p?.side === side && !closeIds.has(p.clOrdID)) places.splice(i, 1);
    }
    for (const [id, o] of Object.entries(s.orders))
      if (o.status === "live" && o.role === "open" && o.side === side) {
        kept.add(id);
        orders[id] = o;
      }
  }
  // Đặt lại theo sổ lệnh (DEC-248): chỉ lệnh mở của các phía được nêu; lệnh đóng không bao giờ bị đụng ở đây (huỷ nó
  // thì lệnh đóng mới chỉ được đặt sau khi SoDEX xác nhận huỷ, vị thế nằm không có lệnh đóng).
  if (only !== undefined) {
    for (let i = places.length - 1; i >= 0; i -= 1) {
      const p = places[i];
      if (p !== undefined && (!only.has(p.side) || closeIds.has(p.clOrdID))) places.splice(i, 1);
    }
    for (const [id, o] of Object.entries(s.orders))
      if (o.status === "live" && (!only.has(o.side) || o.role === "close")) {
        kept.add(id);
        orders[id] = o;
      }
  }
  let tracked = orders;
  for (const o of places) {
    const id = o.clOrdID;
    // Vai trò lưu theo lúc đặt, không suy từ reduceOnly: sau khi chuyển sang lệnh đóng post-only thường (SoDEX từ chối
    // reduce-only), lệnh đóng vẫn là "close" để tính phần còn treo khi đặt lệnh đóng kế tiếp.
    const role = closeIds.has(id) ? "close" : "open";
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
  if (clamps > 0) {
    const w = next.oracleWin ?? { since: at, pulls: 0, clamps: 0 };
    next = { ...next, oracleWin: { ...w, clamps: w.clamps + clamps } };
  }
  const actions = [
    ...cancels.filter((a) => !(a.type === "cancel" && kept.has(a.clOrdID))),
    ...places.map((o) => ({ type: "place" as const, order: o })),
    ...smartLogs,
    ...fastLogs,
  ];
  return { actions, state: next };
}

function halt(
  c: VolumeMakerConfig,
  s: VolumeMakerState,
  ctx: StepContext,
  reason: ReasonCode,
  why: string,
  at: number,
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
  const orders: Record<string, TrackedOrder> = {};
  for (const [id, o] of Object.entries(s.orders)) {
    orders[id] = o.status === "live" ? { ...o, status: "cancelling", since: at } : o;
  }
  if (close && rules !== undefined) {
    const o = order(
      c,
      ctx,
      pos.gt(0) ? "sell" : "buy",
      "0",
      roundQty(pos.abs(), rules),
      `vm:${String(s.cycle)}:close`,
      true,
      true,
    );
    actions.push({ type: "place", order: o });
    // Ghi sổ lệnh đóng để fill của nó vào sổ cái (phí taker, trượt giá) dù bot đã dừng.
    orders[o.clOrdID] = {
      side: o.side,
      role: "close",
      price: "0",
      qty: o.quantity,
      filled: "0",
      status: "live",
      since: at,
    };
  }
  actions.push({ type: "stop", reason, close: false });
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
      at,
    );
  const unrealized =
    s.mid === null ? new Decimal(0) : dec(s.ledger.position).mul(dec(s.mid).sub(s.ledger.avgCost));
  if (c.inventoryLossStop !== undefined && unrealized.neg().gte(c.inventoryLossStop))
    return halt(
      c,
      s,
      ctx,
      ReasonCode.stopLoss,
      `Inventory loss reached ${c.inventoryLossStop}.`,
      at,
    );
  if (c.volumeTarget !== undefined && dec(s.volume).gte(c.volumeTarget))
    return halt(c, s, ctx, ReasonCode.maxCycles, `Volume target ${c.volumeTarget} reached.`, at);
  if (c.runUntil !== "target_or_budget" && c.untilAt !== undefined && at >= c.untilAt)
    return halt(c, s, ctx, ReasonCode.maxCycles, "Run time ended.", at);
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

/** Báo giá đầu tiên ngay khi có giá. */
function firstQuote(
  c: VolumeMakerConfig,
  state: VolumeMakerState,
  ctx: StepContext,
  at: number,
): StepResult<VolumeMakerState> {
  const { actions, state: next } = quote(c, state, ctx, at);
  return guards(c, next, ctx, at) ?? { actions, state: next };
}

/**
 * Giá Binance quy đổi mới: lưu lại (lần báo giá kế tiếp dùng để chặn giá lệnh mở). Lệnh mở thêm vị thế đang sống mà giá
 * Binance đã chạy qua (ask thấp hơn, bid cao hơn) thì rút ngay và báo giá lại sớm; mỗi lệnh rút ghi Decisions kèm giờ
 * Binance. Mỗi phút ghi một dòng số liệu nếu có rút hoặc đặt lùi ra.
 */
function onFair(
  c: VolumeMakerConfig,
  s: VolumeMakerState,
  e: Extract<StrategyEvent, { type: "fair" }>,
  ctx: StepContext,
): StepResult<VolumeMakerState> {
  if (e.market !== c.market || !c.smartQuoting) return { actions: [], state: s };
  // Giá Binance đã cũ (luồng Binance khựng, tin tới trễ): không dùng để rút lệnh; lần báo giá kế tiếp cũng bỏ qua.
  if (e.at - e.binanceAt > VM_ORACLE.maxAgeMs)
    return { actions: [], state: { ...s, fair: e.fair, fairAt: e.at, fairBinanceAt: e.binanceAt } };
  const fair = dec(e.fair);
  const cut = cutPosition(c, s, e, fair, ctx);
  if (cut !== null) return cut;
  const actions: StrategyAction[] = [];
  const orders = { ...s.orders };
  const win = s.oracleWin ?? { since: e.at, pulls: 0, clamps: 0 };
  let pulls = win.pulls;
  for (const [id, o] of Object.entries(orders)) {
    if (o.status !== "live" || o.role !== "open") continue;
    const through = o.side === "sell" ? fair.gt(o.price) : fair.lt(o.price);
    if (!through) continue;
    pulls += 1;
    actions.push({ type: "cancel", clOrdID: id });
    actions.push({
      type: "log",
      decision: o.side === "sell" ? "Ask pulled" : "Bid pulled",
      why: `At ${new Date(e.binanceAt).toISOString().slice(11, 23)} UTC the Binance price (${fair.toDecimalPlaces(2).toString()}) moved through the ${o.side === "sell" ? "ask" : "bid"} at ${o.price}.`,
    });
    orders[id] = { ...o, status: "cancelling", since: e.at };
  }
  let state: VolumeMakerState = {
    ...s,
    orders,
    fair: e.fair,
    fairAt: e.at,
    fairBinanceAt: e.binanceAt,
    oracleWin: { ...win, pulls },
    ...(pulls > win.pulls ? { requoteDue: true } : {}),
  };
  const span = e.at - win.since;
  if (span >= VM_ORACLE.logEveryMs) {
    if (pulls > 0 || win.clamps > 0)
      actions.push({
        type: "log",
        decision: "Binance pricing",
        why: `Last ${String(Math.round(span / 1000))} s: ${String(pulls)} quotes pulled after the Binance price moved through them; ${String(win.clamps)} quotes placed further out to stay ${String(VM_ORACLE.marginBp)} bp past the Binance price.`,
      });
    state = { ...state, oracleWin: { since: e.at, pulls: 0, clamps: 0 } };
  }
  return { actions, state };
}

/** Cắt vị thế khi giá Binance chạy ngược giá vào ≥ `VM_CUT.bp` (DEC-249); null khi không cần cắt. */
function cutPosition(
  c: VolumeMakerConfig,
  s: VolumeMakerState,
  e: Extract<StrategyEvent, { type: "fair" }>,
  fair: Decimal,
  ctx: StepContext,
): StepResult<VolumeMakerState> | null {
  const rules = ctx.rules[c.market];
  const pos = dec(s.ledger.position);
  const entry = dec(s.ledger.avgCost);
  if (rules === undefined || s.mid === null || !entry.gt(0) || isFlat(pos, s.mid, rules))
    return null;
  if (s.cutAt != null && e.at - s.cutAt < VM_CUT.coolMs) return null;
  const long = pos.gt(0);
  const against = (long ? entry.sub(fair) : fair.sub(entry)).div(entry).mul(10_000);
  if (against.lt(VM_CUT.bp)) return null;
  const actions: StrategyAction[] = [];
  const orders: Record<string, TrackedOrder> = {};
  for (const [id, o] of Object.entries(s.orders)) {
    if (o.status === "live") {
      actions.push({ type: "cancel", clOrdID: id });
      orders[id] = { ...o, status: "cancelling", since: e.at };
    } else orders[id] = o;
  }
  const qty = roundQty(pos.abs(), rules);
  const o = order(
    c,
    ctx,
    long ? "sell" : "buy",
    "0",
    qty,
    `vm:${String(s.cycle)}:cut:close`,
    true,
    true,
  );
  actions.push({ type: "place", order: o });
  orders[o.clOrdID] = {
    side: o.side,
    role: "close",
    price: "0",
    qty,
    filled: "0",
    status: "live",
    since: e.at,
  };
  actions.push({
    type: "log",
    decision: "Position cut",
    why: `At ${new Date(e.binanceAt).toISOString().slice(11, 23)} UTC the Binance price (${fair.toDecimalPlaces(2).toString()}) was ${against.toDecimalPlaces(1).toString()} bp against your ${long ? "long" : "short"} entry at ${entry.toDecimalPlaces(2).toString()}. Closed ${qty} at market.`,
  });
  return {
    actions,
    state: {
      ...s,
      orders,
      cutAt: e.at,
      fair: e.fair,
      fairAt: e.at,
      fairBinanceAt: e.binanceAt,
      requoteDue: true,
    },
  };
}

/**
 * Giá tốt nhất SoDEX mới (DEC-248): lưu lại; cách lần báo giá trước ≥ `minRequoteMs` và giá đã chạy ra xa lệnh của mình
 * thì đặt lại riêng phía đó. Chỉ trả hành động khi có lệnh cần đặt / huỷ (không thì không tăng chu kỳ).
 */
function onBook(
  c: VolumeMakerConfig,
  s: VolumeMakerState,
  e: Extract<StrategyEvent, { type: "book" }>,
  ctx: StepContext,
): StepResult<VolumeMakerState> {
  if (e.market !== c.market || !c.smartQuoting || !dec(e.bid).lt(e.ask))
    return { actions: [], state: s };
  const book: BookTop = {
    bid: e.bid,
    ask: e.ask,
    bidNotional: s.book?.bidNotional ?? "0",
    askNotional: s.book?.askNotional ?? "0",
  };
  const state: VolumeMakerState = { ...s, book, bookAt: e.at, bookStreamAt: e.at };
  if (s.lastRefresh === null || e.at - s.lastRefresh < VM_BOOK_STREAM.minRequoteMs)
    return { actions: [], state };
  // Chỉ phía có lệnh mở đang sống bị giá tốt nhất bỏ lại phía sau. Lệnh đóng để chu kỳ thường lo: huỷ nó ở đây thì
  // lệnh đóng mới chỉ được đặt khi SoDEX xác nhận huỷ (tránh đóng hai lần), vị thế nằm không có lệnh đóng.
  const behind = new Set<"buy" | "sell">();
  for (const o of Object.values(s.orders)) {
    if (o.status !== "live" || o.role !== "open") continue;
    if (o.side === "buy" && dec(o.price).lt(e.bid)) behind.add("buy");
    if (o.side === "sell" && dec(o.price).gt(e.ask)) behind.add("sell");
  }
  if (behind.size === 0) return { actions: [], state };
  const g = guards(c, state, ctx, e.at);
  if (g !== null) return g;
  const { actions, state: next } = quote(c, state, ctx, e.at, behind);
  if (!actions.some((a) => a.type === "place" || a.type === "cancel"))
    return { actions: [], state };
  return guards(c, next, ctx, e.at) ?? { actions, state: next };
}

export function stepVolumeMaker(
  c: VolumeMakerConfig,
  raw: VolumeMakerState,
  e: StrategyEvent,
  ctx: StepContext,
): StepResult<VolumeMakerState> {
  const r = stepCore(c, raw, e, ctx);
  if (!c.smartQuoting) return r;
  // Đếm request lệnh gửi SoDEX (DEC-248): mỗi phút một dòng Decisions để theo dõi hạn mức theo địa chỉ ví.
  const sent = r.actions.filter((a) => a.type === "place" || a.type === "cancel").length;
  // Không gửi gì và chưa hết cửa sổ: trả nguyên kết quả để nhịp không có gì mới không phải ghi state.
  if (
    sent === 0 &&
    r.state.reqWin !== undefined &&
    e.at - r.state.reqWin.since < VM_BOOK_STREAM.logEveryMs
  )
    return r;
  const win = r.state.reqWin ?? { since: e.at, n: 0 };
  const n = win.n + sent;
  const span = e.at - win.since;
  if (span < VM_BOOK_STREAM.logEveryMs)
    return { ...r, state: { ...r.state, reqWin: { since: win.since, n } } };
  const log: StrategyAction[] =
    n > 0
      ? [
          {
            type: "log",
            decision: "Order requests",
            why: `Last ${String(Math.round(span / 1000))} s: ${String(n)} requests to SoDEX (new orders and cancels).`,
          },
        ]
      : [];
  return { actions: [...r.actions, ...log], state: { ...r.state, reqWin: { since: e.at, n: 0 } } };
}

function stepCore(
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
      const state = {
        ...s,
        mid: e.price,
        ...(c.smartQuoting && (s.smartSince ?? null) === null ? { smartSince: e.at } : {}),
      };
      const g = guards(c, state, ctx, e.at);
      if (g !== null) return g;
      // Pause on fast moves: giá chạy ≥ max(3 bước giá, 2 bp) trong 6 s → rút lệnh mở ngay, giữ lệnh đóng.
      const rules = ctx.rules[c.market];
      if (c.pauseOnFastMoves && rules !== undefined) {
        const fastRecent = [...(state.fastRecent ?? []), { t: e.at, p: e.price }].filter(
          (x) => e.at - x.t <= VM_FAST.windowMs,
        );
        const moved = fastMove(fastRecent, rules);
        const fast = moved?.range.gte(moved.threshold) === true;
        const wasPaused = state.fastPauseUntil != null && e.at < state.fastPauseUntil;
        const withRecent: VolumeMakerState = {
          ...state,
          fastRecent,
          ...(fast ? { fastPauseUntil: e.at + VM_FAST.waitMs } : {}),
        };
        if (fast && !wasPaused && state.lastRefresh !== null) {
          const { actions, state: next } = quote(c, withRecent, ctx, e.at);
          const log: StrategyAction = {
            type: "log",
            decision: "Quotes paused on a fast move",
            why: `Price moved ${moved.bp.toDecimalPlaces(1).toString()} bp in ${String(VM_FAST.windowMs / 1000)} s; quoting again after ${String(VM_FAST.waitMs / 1000)} s of calm.`,
          };
          return guards(c, next, ctx, e.at) ?? { actions: [...actions, log], state: next };
        }
        if (state.lastRefresh !== null) return { actions: [], state: withRecent };
        return firstQuote(c, withRecent, ctx, e.at);
      }
      // Báo giá đầu tiên ngay khi có giá.
      if (state.lastRefresh === null) {
        const { actions, state: next } = quote(c, state, ctx, e.at);
        return guards(c, next, ctx, e.at) ?? { actions, state: next };
      }
      return { actions: [], state };
    }
    case "timer": {
      if (e.market?.market === c.market && e.market.book !== null) {
        const ws = s.bookStreamAt != null && e.at - s.bookStreamAt <= VM_BOOK_STREAM.freshMs;
        const rest = e.market.book;
        s =
          ws && s.book != null
            ? {
                ...s,
                book: { ...s.book, bidNotional: rest.bidNotional, askNotional: rest.askNotional },
              }
            : { ...s, book: rest, bookAt: e.at };
      }
      const g = guards(c, s, ctx, e.at);
      if (g !== null) return g;
      // Dọn lệnh cũ rồi xử lý tiếp trong cùng nhịp (DEC-251). Trước đây nhịp nào có dọn thì bỏ qua báo giá; bot chạy
      // quá VM_KEEP_DONE_MS (10 phút) thì gần như nhịp nào cũng có một lệnh vừa quá hạn, bot đứng hàng chục giây không
      // đặt lệnh (2026-11-15: khoảng trống 38–42 s, có lần hơn 2 phút, lệnh đóng không được đặt khi đang giữ vị thế).
      s = housekeep(s, e.at);
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
      // Đã dừng: fill (lệnh đóng lúc dừng, khớp trễ) chỉ vào sổ cái, không chạy lại guard (không đặt thêm lệnh đóng).
      if (state.phase === "halted") return { actions: [], state };
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
      // Lệnh đóng đã huỷ xong mà còn vị thế: đặt lại lệnh đóng sớm (≥ VM_MIN_REQUOTE_MS), không chờ hết chu kỳ. Lệnh
      // mở đã huỷ xong mà phía đó không còn lệnh mở nào: phía đó có thể đang chờ xác nhận này (DEC-253), báo giá lại sớm.
      const openGap =
        o.role === "open" &&
        !Object.entries(s.orders).some(
          ([id, x]) =>
            id !== e.clOrdID && x.role === "open" && x.side === o.side && x.status === "live",
        );
      const reclose = (o.role === "close" && !dec(s.ledger.position).isZero()) || openGap;
      return {
        actions: [],
        state: {
          ...s,
          orders: { ...s.orders, [e.clOrdID]: { ...o, status: "done", since: e.at } },
          ...(reclose ? { requoteDue: true } : {}),
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
    case "fair":
      return onFair(c, s, e, ctx);
    case "book":
      return onBook(c, s, e, ctx);
    case "fundingPaid":
    case "fundingRate":
    case "marginRatio":
    case "leaderFill":
    case "leaderPosition":
    case "resumed":
      return { actions: [], state: s };
  }
}

export const volumeMaker: StrategyModule<VolumeMakerConfig, VolumeMakerState> = {
  initialState: initial,
  step: stepVolumeMaker,
};
