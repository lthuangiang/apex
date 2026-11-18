import { dec } from "@drift/shared";
import {
  MM_QUOTE_SNAPSHOT_MAX_BYTES,
  type MmQuoteOrder,
  type MmQuoteReason,
  type MmQuoteSnapshot,
} from "@drift/shared/mm-quote";

import type { StepResult, StrategyAction, StrategyEvent } from "../core/types";

import { vmMaxInventory, type VolumeMakerConfig } from "./schema";

import type { VolumeMakerState } from "./index";

// Snapshot báo giá Market Making (#230): dữ liệu cho trang team "Signal Analysis › MM" (#220). Gắn vào các dòng
// Decisions về báo giá mà chiến lược đã ghi sẵn; không thêm dòng mới, không đổi lệnh hay state (chỉ đọc kết quả của
// bước). Hàm thuần; lỗi bất ngờ thì không gắn gì.

/** Các dòng Decisions được gắn snapshot (đều là quyết định về báo giá / rút / cắt). */
export const MM_QUOTE_DECISIONS: ReadonlySet<string> = new Set([
  "Order requests",
  "Smart quoting adjusted",
  "Smart quoting back to normal",
  "Quotes paused on a fast move",
  "Quoting again after a fast move",
  "Closing at the best price",
  "Ask pulled",
  "Bid pulled",
  "Position cut",
]);

/** Tham số định giá Binance của chiến lược (truyền vào để file này không import giá trị từ `index`). */
export interface MmOracleParams {
  marginBp: number;
  maxAgeMs: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;
/** Chuỗi thập phân không ký hiệu mũ. */
const fixed = (v: string) => dec(v).toFixed();
/** (giá − gốc) ÷ gốc × 10 000, 2 chữ số; null khi thiếu. */
function bpOf(price: string | null, ref: string | null): number | null {
  if (price === null || ref === null) return null;
  const r = dec(ref);
  if (!r.gt(0)) return null;
  return r2(dec(price).sub(r).div(r).mul(10_000).toNumber());
}
const sideOrder = (a: "buy" | "sell", b: "buy" | "sell") => (a === b ? 0 : a === "buy" ? -1 : 1);

/** Lý do chung của bước (không tính dòng "Ask / Bid pulled", lý do riêng `pulled`). */
function stepReason(
  c: VolumeMakerConfig,
  before: VolumeMakerState,
  after: VolumeMakerState,
  e: StrategyEvent,
  actions: readonly StrategyAction[],
): MmQuoteReason {
  const logs = new Set(actions.flatMap((a) => (a.type === "log" ? [a.decision] : [])));
  if (logs.has("Position cut")) return "cut";
  if (logs.has("Quotes paused on a fast move")) return "fast_pause";
  if (logs.has("Ask pulled") || logs.has("Bid pulled")) return "pulled";
  if (after.cycle <= before.cycle) return "sample";
  if (before.lastRefresh === null) return "first";
  if (e.type === "book") return "book_moved";
  if (e.type === "timer") {
    const elapsed = e.at - before.lastRefresh;
    return before.requoteDue && elapsed < c.refreshSeconds * 1000 ? "requote" : "refresh";
  }
  return "requote";
}

export interface QuoteSnapshotInput {
  c: VolumeMakerConfig;
  before: VolumeMakerState;
  after: VolumeMakerState;
  e: StrategyEvent;
  actions: readonly StrategyAction[];
  oracle: MmOracleParams;
  reason: MmQuoteReason;
  /** Lệnh vừa bị rút (dòng "Ask / Bid pulled"); thiếu = lệnh của bước. */
  pulled?: string;
}

export function quoteSnapshot(i: QuoteSnapshotInput): MmQuoteSnapshot {
  const { c, before, after, e } = i;
  const at = e.at;
  // Giá Binance còn mới (giống `quote` / `onFair`).
  const fairAge =
    after.fairBinanceAt == null ? null : Math.max(0, Math.round(at - after.fairBinanceAt));
  const fairUsed =
    c.smartQuoting && after.fair != null && fairAge !== null && fairAge <= i.oracle.maxAgeMs;
  const fairRef = fairUsed && after.fair != null ? fixed(after.fair) : null;
  // Số lệnh bị kẹp trong bước: phần tăng của cửa sổ `oracleWin` (cửa sổ mới thì đếm từ 0).
  const wb = before.oracleWin;
  const wa = after.oracleWin;
  const clamps =
    wa === undefined ? 0 : Math.max(0, wa.clamps - (wb?.since === wa.since ? wb.clamps : 0));
  const book = after.book ?? null;
  const usable = book !== null && dec(book.bid).gt(0) && dec(book.ask).gt(book.bid);
  const mid = usable ? dec(book.bid).add(book.ask).div(2).toFixed() : null;
  const ref = mid ?? (after.mid === null ? null : fixed(after.mid));

  const placed = new Set(i.actions.flatMap((a) => (a.type === "place" ? [a.order.clOrdID] : [])));
  const row = (id: string, st: MmQuoteOrder["st"]): MmQuoteOrder | null => {
    const o = after.orders[id] ?? before.orders[id];
    if (o === undefined) return null;
    const market = !dec(o.price).gt(0);
    const price = market ? null : fixed(o.price);
    return {
      id,
      side: o.side,
      role: o.role,
      st,
      price,
      size: fixed(o.qty),
      bp: bpOf(price, ref),
      fairBp: bpOf(price, fairRef),
    };
  };
  let orders: MmQuoteOrder[];
  if (i.pulled !== undefined) {
    const x = row(i.pulled, "pulled");
    orders = x === null ? [] : [x];
  } else {
    // Lệnh mới, lệnh vừa huỷ để báo giá lại, rồi lệnh nằm từ trước (đang sống sau bước).
    const cancelled = new Set(i.actions.flatMap((a) => (a.type === "cancel" ? [a.clOrdID] : [])));
    const rank = { new: 0, cancel: 1, live: 2, pulled: 3 } as const;
    orders = [
      ...Object.entries(after.orders)
        .filter(([, o]) => o.status === "live")
        .map(([id]) => row(id, placed.has(id) ? "new" : "live")),
      ...[...cancelled].filter((id) => !placed.has(id)).map((id) => row(id, "cancel")),
    ]
      .filter((x): x is MmQuoteOrder => x !== null)
      .sort((a, b) => rank[a.st] - rank[b.st] || sideOrder(a.side, b.side))
      .slice(0, 4);
  }
  const sides = [...new Set(orders.filter((o) => o.st !== "live").map((o) => o.side))].sort(
    sideOrder,
  );

  const pos = dec(after.ledger.position);
  const entry = dec(after.ledger.avgCost);
  const notionalRef = after.mid ?? mid;
  const fastPause = after.fastPauseUntil != null && at < after.fastPauseUntil;
  return {
    v: 1,
    reason: i.reason,
    sides,
    fair: {
      price: after.fair == null ? null : fixed(after.fair),
      ageMs: fairAge,
      used: fairUsed,
      clampBp: fairUsed ? i.oracle.marginBp : null,
      clamps,
    },
    book: {
      bid: book === null ? null : fixed(book.bid),
      ask: book === null ? null : fixed(book.ask),
      mid,
      ageMs:
        book === null || after.bookAt == null ? null : Math.max(0, Math.round(at - after.bookAt)),
      last: after.mid === null ? null : fixed(after.mid),
    },
    quote: {
      level: c.quoteLevel ?? null,
      distanceBp: c.quoteLevel === undefined ? fixed(c.distanceBp) : null,
    },
    inv: {
      position: pos.toFixed(),
      entry: pos.isZero() || !entry.gt(0) ? null : entry.toFixed(),
      notional:
        notionalRef === null ? "0.00" : pos.abs().mul(notionalRef).toDecimalPlaces(2).toFixed(2),
      maxUsd: fixed(vmMaxInventory(c)),
      maxOrders: c.maxInventory === undefined ? (c.maxOrders ?? 2) : null,
    },
    smart: {
      on: c.smartQuoting,
      sig: after.smartSig == null ? null : after.smartSig.slice(0, 40),
      fastPause,
    },
    orders,
  };
}

/** Giữ snapshot dưới `MM_QUOTE_SNAPSHOT_MAX_BYTES`: bớt lệnh cuối (lệnh nằm từ trước) tới khi vừa. */
function bounded(s: MmQuoteSnapshot): MmQuoteSnapshot {
  let out = s;
  while (JSON.stringify(out).length >= MM_QUOTE_SNAPSHOT_MAX_BYTES && out.orders.length > 0)
    out = { ...out, orders: out.orders.slice(0, -1) };
  return out;
}

/**
 * Gắn `payload.quote` vào các dòng Decisions về báo giá của bước (chỉ khi engine ghi event, `ctx.decisionPayload`).
 * Chỉ thêm `payload` vào action `log`; lệnh, thứ tự action và state giữ nguyên. Lỗi bất ngờ thì trả kết quả gốc.
 */
export function withQuoteSnapshots(
  c: VolumeMakerConfig,
  before: VolumeMakerState,
  r: StepResult<VolumeMakerState>,
  e: StrategyEvent,
  oracle: MmOracleParams,
): StepResult<VolumeMakerState> {
  try {
    if (!r.actions.some((a) => a.type === "log" && MM_QUOTE_DECISIONS.has(a.decision))) return r;
    const reason = stepReason(c, before, r.state, e, r.actions);
    let shared: MmQuoteSnapshot | undefined;
    let lastCancel: string | undefined;
    const actions = r.actions.map((a): StrategyAction => {
      if (a.type === "cancel") lastCancel = a.clOrdID;
      if (a.type !== "log" || !MM_QUOTE_DECISIONS.has(a.decision)) return a;
      const base = { c, before, after: r.state, e, actions: r.actions, oracle };
      // "Ask / Bid pulled" đi ngay sau lệnh huỷ của chính nó (`onFair`).
      const pulled = a.decision === "Ask pulled" || a.decision === "Bid pulled";
      const quote = pulled
        ? bounded(
            quoteSnapshot({
              ...base,
              reason: "pulled",
              ...(lastCancel === undefined ? {} : { pulled: lastCancel }),
            }),
          )
        : (shared ??= bounded(quoteSnapshot({ ...base, reason })));
      return { ...a, payload: { ...a.payload, quote } };
    });
    return { actions, state: r.state };
  } catch {
    return r;
  }
}
