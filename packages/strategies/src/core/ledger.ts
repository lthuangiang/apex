import { dec, Decimal, type DecimalInput } from "@drift/shared";

// Sổ cái của một bot: vị thế (dương = long / đang giữ), giá vốn trung bình, PnL đã chốt, phí, funding.
// Mọi phép tính bằng Decimal (CODING_STANDARDS C9).

export interface Ledger {
  position: string;
  avgCost: string;
  realized: string;
  fees: string;
  funding: string;
  /** Vốn đã bỏ ra cao nhất (để đo % lỗ). */
  invested: string;
}

export const emptyLedger = (): Ledger => ({
  position: "0",
  avgCost: "0",
  realized: "0",
  fees: "0",
  funding: "0",
  invested: "0",
});

export function applyFill(
  l: Ledger,
  side: "buy" | "sell",
  price: DecimalInput,
  qty: DecimalInput,
  fee: DecimalInput,
): Ledger {
  const p = dec(price);
  const q = side === "buy" ? dec(qty) : dec(qty).neg();
  const pos = dec(l.position);
  const avg = dec(l.avgCost);
  let realized = dec(l.realized);
  let newPos = pos.add(q);
  let newAvg = avg;
  if (pos.isZero() || pos.isPositive() === q.isPositive()) {
    // Mở thêm cùng chiều: giá vốn bình quân.
    newAvg = newPos.isZero() ? new Decimal(0) : pos.mul(avg).add(q.mul(p)).div(newPos);
  } else {
    // Đóng (một phần hoặc đảo chiều).
    const closing = Decimal.min(pos.abs(), q.abs());
    realized = realized.add(closing.mul(p.sub(avg)).mul(pos.isPositive() ? 1 : -1));
    if (q.abs().gt(pos.abs())) newAvg = p;
    if (newPos.isZero()) newAvg = new Decimal(0);
  }
  newPos = pos.add(q);
  const invested = Decimal.max(dec(l.invested), newPos.abs().mul(newAvg));
  return {
    position: newPos.toString(),
    avgCost: newAvg.toString(),
    realized: realized.toString(),
    fees: dec(l.fees).add(fee).toString(),
    funding: l.funding,
    invested: invested.toString(),
  };
}

/** Funding dương = trả (giảm lãi). */
export const applyFunding = (l: Ledger, amount: DecimalInput): Ledger => ({
  ...l,
  funding: dec(l.funding).add(amount).toString(),
});

/** Lãi ròng hiện tại = đã chốt + chưa chốt theo giá `mark` − phí − funding. */
export function netPnl(l: Ledger, mark: DecimalInput): Decimal {
  const unrealized = dec(l.position).mul(dec(mark).sub(l.avgCost));
  return dec(l.realized).add(unrealized).sub(l.fees).sub(l.funding);
}
