import { dec, Decimal, type DecimalInput } from "@drift/shared";

import { applyFill, emptyLedger } from "../core/ledger";

// Paper mode (AI_DESK_RECOMMENDED.md mục 8.2, DEC-105): mô phỏng khớp lệnh và số dư giả, hàm thuần. Engine gọi qua
// PaperGateway; không có gì ở đây chạm tới SoDEX. Luật khớp bảo thủ hơn `sim/exchange` (unit test chiến lược):
// - limit chỉ khớp khi giá ĐI XUYÊN QUA mức đặt (chạm thì không khớp);
// - market khớp ở giá kế tiếp ± trượt giá 0.05% (như BACKTEST_SLIPPAGE), phí taker;
// - thiếu số dư giả thì từ chối lệnh, như SoDEX.

/** Trượt giá của lệnh market khi mô phỏng (tỷ lệ thô), khớp `BACKTEST_SLIPPAGE`. */
export const PAPER_SLIPPAGE = "0.0005";

export interface PaperPosition {
  /** Spot: lượng coin đang giữ (≥ 0). Perps: có dấu, âm là short. */
  qty: string;
  avgCost: string;
}

export interface PaperBook {
  cash: string;
  positions: Record<string, PaperPosition>;
  fees: string;
  funding: string;
  fills: number;
}

export interface PaperOrder {
  market: string;
  engine: "spot" | "perps";
  side: "buy" | "sell";
  type: "limit" | "market";
  price?: string | undefined;
  /** Phần chưa khớp. */
  quantity: string;
  timeInForce: string;
  reduceOnly: boolean;
}

export type PaperRejectCode =
  "NO_PRICE" | "POST_ONLY_WOULD_TRADE" | "INSUFFICIENT_BALANCE" | "REDUCE_ONLY_NO_POSITION";

export const newPaperBook = (capital: DecimalInput): PaperBook => ({
  cash: dec(capital).toString(),
  positions: {},
  fees: "0",
  funding: "0",
  fills: 0,
});

/** Lệnh limit bị giá đi xuyên qua (mua: giá < mức đặt; bán: giá > mức đặt). Market luôn khớp được. */
export function paperCrosses(
  o: Pick<PaperOrder, "side" | "type" | "price">,
  price: DecimalInput,
): boolean {
  if (o.type === "market" || o.price === undefined) return true;
  return o.side === "buy" ? dec(price).lt(o.price) : dec(price).gt(o.price);
}

/** Giá khớp: market = giá ± trượt giá (bất lợi cho người dùng); limit = đúng giá đặt. */
export function paperFillPrice(
  o: Pick<PaperOrder, "side" | "type" | "price">,
  price: DecimalInput,
  slippage: DecimalInput = PAPER_SLIPPAGE,
): string {
  if (o.type === "limit" && o.price !== undefined) return dec(o.price).toString();
  const s = dec(slippage);
  return dec(price)
    .mul(o.side === "buy" ? new Decimal(1).add(s) : new Decimal(1).sub(s))
    .toString();
}

const pos = (b: PaperBook, market: string): PaperPosition =>
  b.positions[market] ?? { qty: "0", avgCost: "0" };

/** Tiền giả + coin giả × giá + lãi lỗ chưa chốt của perps. Market thiếu giá thì tính theo giá vốn. */
export function paperEquity(
  b: PaperBook,
  engines: Readonly<Record<string, "spot" | "perps">>,
  prices: Readonly<Record<string, string>>,
): Decimal {
  let eq = dec(b.cash);
  for (const [m, p] of Object.entries(b.positions)) {
    const price = dec(prices[m] ?? p.avgCost);
    const q = dec(p.qty);
    eq = engines[m] === "perps" ? eq.add(q.mul(price.sub(p.avgCost))) : eq.add(q.mul(price));
  }
  return eq;
}

/**
 * Kiểm tra số dư giả trước khi nhận lệnh. `open`: các lệnh paper khác của bot còn treo (giữ chỗ như SoDEX khoá số
 * dư). `refPrice`: giá gần nhất của market. `feeRate`: phí taker + builder (bảo thủ).
 */
export function paperCheck(input: {
  book: PaperBook;
  open: readonly PaperOrder[];
  order: PaperOrder;
  refPrice: string | null;
  leverage: number;
  feeRate: DecimalInput;
  engines: Readonly<Record<string, "spot" | "perps">>;
  prices: Readonly<Record<string, string>>;
}): PaperRejectCode | null {
  const { book, order: o, refPrice } = input;
  if (refPrice === null) return "NO_PRICE";
  if (o.type === "limit" && o.timeInForce === "GTX" && paperCrosses(o, refPrice))
    return "POST_ONLY_WOULD_TRADE";
  const price = dec(o.type === "limit" && o.price !== undefined ? o.price : refPrice);
  const qty = dec(o.quantity);
  const fee = dec(input.feeRate);
  const at = (x: PaperOrder) =>
    dec(x.type === "limit" && x.price !== undefined ? x.price : refPrice);
  if (o.engine === "spot") {
    if (o.side === "buy") {
      const reserved = input.open
        .filter((x) => x.engine === "spot" && x.side === "buy")
        .reduce((s, x) => s.add(dec(x.quantity).mul(at(x)).mul(fee.add(1))), new Decimal(0));
      return dec(book.cash)
        .sub(reserved)
        .gte(qty.mul(price).mul(fee.add(1)))
        ? null
        : "INSUFFICIENT_BALANCE";
    }
    const reserved = input.open
      .filter((x) => x.engine === "spot" && x.side === "sell" && x.market === o.market)
      .reduce((s, x) => s.add(x.quantity), new Decimal(0));
    return dec(pos(book, o.market).qty).sub(reserved).gte(qty) ? null : "INSUFFICIENT_BALANCE";
  }
  const p = dec(pos(book, o.market).qty);
  if (o.reduceOnly) {
    const reducing = o.side === "buy" ? p.lt(0) : p.gt(0);
    return reducing ? null : "REDUCE_ONLY_NO_POSITION";
  }
  const lev = new Decimal(Math.max(1, input.leverage));
  const used = Object.entries(book.positions)
    .filter(([m]) => input.engines[m] === "perps")
    .reduce((s, [, x]) => s.add(dec(x.qty).abs().mul(x.avgCost).div(lev)), new Decimal(0));
  const reserved = input.open
    .filter((x) => x.engine === "perps" && !x.reduceOnly)
    .reduce((s, x) => s.add(dec(x.quantity).mul(at(x)).div(lev)), new Decimal(0));
  const free = paperEquity(book, input.engines, input.prices).sub(used).sub(reserved);
  return free.gte(qty.mul(price).div(lev).add(qty.mul(price).mul(fee)))
    ? null
    : "INSUFFICIENT_BALANCE";
}

/** Ghi một lần khớp mô phỏng vào số dư giả. */
export function paperApplyFill(
  b: PaperBook,
  o: Pick<PaperOrder, "market" | "engine" | "side">,
  price: DecimalInput,
  qty: DecimalInput,
  fee: DecimalInput,
): PaperBook {
  const cur = pos(b, o.market);
  const before = { ...emptyLedger(), position: cur.qty, avgCost: cur.avgCost };
  const after = applyFill(before, o.side, price, qty, "0");
  const notional = dec(price).mul(qty);
  const cash =
    o.engine === "spot"
      ? o.side === "buy"
        ? dec(b.cash).sub(notional).sub(fee)
        : dec(b.cash).add(notional).sub(fee)
      : dec(b.cash).add(after.realized).sub(fee);
  const positions = Object.fromEntries(Object.entries(b.positions).filter(([m]) => m !== o.market));
  if (!dec(after.position).isZero())
    positions[o.market] = { qty: after.position, avgCost: after.avgCost };
  return {
    cash: cash.toString(),
    positions,
    fees: dec(b.fees).add(fee).toString(),
    funding: b.funding,
    fills: b.fills + 1,
  };
}

/** Funding của một kỳ cho vị thế perps giả: trả = vị thế × giá × rate (dương = trả). */
export function paperFunding(
  b: PaperBook,
  market: string,
  price: DecimalInput,
  rate: DecimalInput,
): { book: PaperBook; amount: string } {
  const q = dec(pos(b, market).qty);
  if (q.isZero()) return { book: b, amount: "0" };
  const amount = q.mul(price).mul(rate);
  return {
    book: {
      ...b,
      cash: dec(b.cash).sub(amount).toString(),
      funding: dec(b.funding).add(amount).toString(),
    },
    amount: amount.toString(),
  };
}
