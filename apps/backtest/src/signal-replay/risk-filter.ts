import { Decimal } from "@drift/shared";

import { inWindow, type PauseWindow } from "./macro-calendar";

// D1 · Bộ lọc rủi ro (#274): replay trên lệnh THẬT của bot VB / MM tiền thật (`bots.mode = live`). Câu hỏi: nếu bot ngừng
// vào lệnh mới trong các khung macro (và tin toàn thị trường, khi có nguồn), Cost per $1M và volume đổi thế nào.
// Cost per $1M theo quy ước của Signal Analysis (DEC-318 mục 4): net cost = −net ÷ volume × 1e6, dương = tốn, âm = có lời
// (không chặn ở 0). Phí đã gồm builder fee (`fills.fee`).
// - Volume Builder: mỗi lượt = fill vào `vf:<n>:in` tới khi hết vị thế (`groupTrades`, như DEC-318 mục 5); net = kết quả
//   giá theo chiều × size − phí của lượt. Bỏ lượt có fill vào đầu tiên nằm trong khung (cả lệnh ra của lượt đó).
// - Market Making: không có lượt rõ ràng, nên mỗi fill tính theo markout 5 phút (cách của DEC-318 mục 3: close nến 1 phút
//   chứa fill + 300 s): net = q × (giá markout − giá khớp) − phí, q = +size mua / −size bán. "Vào lệnh mới" = fill làm tăng
//   |vị thế| của bot; chỉ bỏ các fill đó trong khung, fill giảm vị thế giữ nguyên. Đây là xấp xỉ: không mô phỏng lại đường
//   vị thế sau khi bỏ (bot thật sẽ báo giá khác đi).

export interface VbRoundTrip {
  botId: string;
  market: string;
  t0: number;
  side: "long" | "short";
  entryPrice: Decimal;
  exitPrice: Decimal;
  qty: Decimal;
  fees: Decimal;
  volume: Decimal;
}

export interface MmFill {
  botId: string;
  market: string;
  at: number;
  side: "buy" | "sell";
  price: Decimal;
  size: Decimal;
  fee: Decimal;
  /** Close nến 1 phút chứa fill + 5 phút; thiếu → fill không tính (đếm riêng). */
  markout: Decimal | null;
  /** Fill làm tăng |vị thế| của bot (tính từ vị thế đầu kỳ + các fill trước). */
  opening: boolean;
}

/** Đánh dấu fill mở vị thế theo thứ tự thời gian, bắt đầu từ vị thế có dấu `start` của bot. */
export function markOpening<T extends { side: "buy" | "sell"; size: Decimal; at: number }>(
  fills: readonly T[],
  start: Decimal,
): (T & { opening: boolean })[] {
  let pos = start;
  return [...fills]
    .sort((a, b) => a.at - b.at)
    .map((f) => {
      const next = f.side === "buy" ? pos.add(f.size) : pos.sub(f.size);
      const opening = next.abs().gt(pos.abs());
      pos = next;
      return { ...f, opening };
    });
}

export const vbNet = (t: VbRoundTrip): Decimal =>
  (t.side === "long" ? t.exitPrice.sub(t.entryPrice) : t.entryPrice.sub(t.exitPrice))
    .mul(t.qty)
    .sub(t.fees);

export const mmNet = (f: MmFill): Decimal | null =>
  f.markout === null
    ? null
    : (f.side === "buy" ? f.size : f.size.neg()).mul(f.markout.sub(f.price)).sub(f.fee);

export interface CostBlock {
  n: number;
  volume: Decimal;
  net: Decimal;
  /** Dương = tốn; null khi chưa có volume. */
  costPerMillion: Decimal | null;
}

export function costBlock(items: readonly { net: Decimal; volume: Decimal }[]): CostBlock {
  const volume = items.reduce((s, x) => s.add(x.volume), new Decimal(0));
  const net = items.reduce((s, x) => s.add(x.net), new Decimal(0));
  return {
    n: items.length,
    volume,
    net,
    costPerMillion: volume.isZero() ? null : net.neg().div(volume).mul(1_000_000),
  };
}

export interface FilterResult {
  baseline: CostBlock;
  /** Sau khi bỏ lượt / fill vào lệnh mới trong khung. */
  filtered: CostBlock;
  /** Phần bị bỏ. */
  skipped: CostBlock;
  /** filtered − baseline (âm = rẻ hơn). */
  costPerMillionChange: Decimal | null;
  /** % volume mất (dương = mất). */
  volumeLostPct: Decimal | null;
  /** Số lượt / fill không có giá markout (không tính). */
  noPrice: number;
  byWindow: { kind: string; at: number; n: number; volume: Decimal; net: Decimal }[];
}

function compare(
  items: readonly { net: Decimal; volume: Decimal; at: number; skip: boolean }[],
  windows: readonly PauseWindow[],
  noPrice: number,
): FilterResult {
  const baseline = costBlock(items);
  const filtered = costBlock(items.filter((x) => !x.skip));
  const skipped = costBlock(items.filter((x) => x.skip));
  const byWindow = windows.map((w) => {
    const inside = items.filter((x) => x.skip && x.at >= w.start && x.at < w.end);
    const b = costBlock(inside);
    return { kind: w.kind, at: w.at, n: b.n, volume: b.volume, net: b.net };
  });
  return {
    baseline,
    filtered,
    skipped,
    costPerMillionChange:
      baseline.costPerMillion === null || filtered.costPerMillion === null
        ? null
        : filtered.costPerMillion.sub(baseline.costPerMillion),
    volumeLostPct: baseline.volume.isZero() ? null : skipped.volume.div(baseline.volume).mul(100),
    noPrice,
    byWindow,
  };
}

/** D1 cho Volume Builder: bỏ lượt có fill vào đầu tiên trong khung. */
export function filterVb(
  trades: readonly VbRoundTrip[],
  windows: readonly PauseWindow[],
): FilterResult {
  return compare(
    trades.map((t) => ({
      net: vbNet(t),
      volume: t.volume,
      at: t.t0,
      skip: inWindow(windows, t.t0) !== null,
    })),
    windows,
    0,
  );
}

/** D1 cho Market Making: bỏ fill mở vị thế trong khung; fill thiếu giá markout không tính. */
export function filterMm(fills: readonly MmFill[], windows: readonly PauseWindow[]): FilterResult {
  let noPrice = 0;
  const items = fills.flatMap((f) => {
    const net = mmNet(f);
    if (net === null) {
      noPrice += 1;
      return [];
    }
    return [
      {
        net,
        volume: f.price.mul(f.size),
        at: f.at,
        skip: f.opening && inWindow(windows, f.at) !== null,
      },
    ];
  });
  return compare(items, windows, noPrice);
}
