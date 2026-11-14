import { dec, Decimal } from "./money";

// Hàm thuần cho chi phí làm market (DEC-227): markout của fill so với giá giữa sau Δt, vòng mua bán đóng lỗ,
// spread thường gặp, dao động 1 phút. Không I/O. Thiếu dữ liệu → null, không bao giờ 0.

export interface MarkoutFill {
  at: number;
  side: "buy" | "sell";
  price: string;
  size: string;
}

/** Giá giữa theo thời điểm (ms), đã sắp tăng dần. */
export interface MidPoint {
  at: number;
  mid: string;
}

/** Mid gần nhất trong ±`tolMs` quanh `at` (tìm nhị phân); không có → null. */
export function midNear(mids: readonly MidPoint[], at: number, tolMs = 2_000): Decimal | null {
  let lo = 0;
  let hi = mids.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if ((mids[m]?.at ?? 0) < at) lo = m + 1;
    else hi = m;
  }
  let best: MidPoint | null = null;
  for (const i of [lo - 1, lo]) {
    const p = mids[i];
    if (p === undefined || Math.abs(p.at - at) > tolMs) continue;
    if (best === null || Math.abs(p.at - at) < Math.abs(best.at - at)) best = p;
  }
  return best === null ? null : dec(best.mid);
}

/**
 * Markout trung bình theo notional (bps, dương = có lợi cho bên đặt lệnh) sau `afterMs`. Mua: (mid sau − giá) ÷ giá;
 * bán ngược dấu. Fill không có mid quanh mốc thì bỏ; không còn fill nào → null.
 */
export function avgMarkout(
  fills: readonly MarkoutFill[],
  mids: readonly MidPoint[],
  afterMs: number,
): Decimal | null {
  let notional = new Decimal(0);
  let sum = new Decimal(0);
  for (const f of fills) {
    const mid = midNear(mids, f.at + afterMs);
    if (mid === null) continue;
    const p = dec(f.price);
    const n = p.mul(dec(f.size));
    const bps = (f.side === "buy" ? mid.sub(p) : p.sub(mid)).div(p).mul(10_000);
    notional = notional.add(n);
    sum = sum.add(n.mul(bps));
  }
  return notional.gt(0) ? sum.div(notional) : null;
}

/** Trung vị |giá giữa sau `afterMs` − giá giữa lúc fill| (bps) trên các fill có đủ hai mốc; không có → null. */
export function medianMidMove(
  fills: readonly MarkoutFill[],
  mids: readonly MidPoint[],
  afterMs: number,
): Decimal | null {
  const moves: Decimal[] = [];
  for (const f of fills) {
    const a = midNear(mids, f.at);
    const b = midNear(mids, f.at + afterMs);
    if (a === null || b === null || a.lte(0)) continue;
    moves.push(b.sub(a).abs().div(a).mul(10_000));
  }
  return median(moves);
}

/**
 * Vòng mua bán: vị thế đi từ 0 rồi về 0 (đảo chiều qua 0 thì tách làm hai). Lỗ theo Price PnL (dòng tiền khớp, chưa
 * trừ phí). `losersLoseMore`: lỗ trung bình mỗi đơn vị của vòng lỗ lớn hơn lãi trung bình mỗi đơn vị của vòng lãi; thiếu
 * vòng lỗ hoặc vòng lãi → null. Chưa có vòng nào đóng → null.
 */
export function roundTrips(
  fills: readonly MarkoutFill[],
): { losing: number; total: number; losersLoseMore: boolean | null } | null {
  let pos = new Decimal(0);
  let cash = new Decimal(0);
  let opened = new Decimal(0);
  let losing = 0;
  let total = 0;
  const loss: Decimal[] = [];
  const win: Decimal[] = [];
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    const p = dec(f.price);
    let q = dec(f.size).mul(f.side === "buy" ? 1 : -1);
    while (!q.isZero()) {
      // Phần đưa vị thế về đúng 0 (nếu đổi chiều), phần còn lại mở vòng mới.
      const toZero = pos.isZero() || pos.isNegative() === q.isNegative() ? null : pos.neg();
      const step = toZero !== null && q.abs().gt(toZero.abs()) ? toZero : q;
      if (pos.isZero() || pos.isNegative() === step.isNegative()) opened = opened.add(step.abs());
      pos = pos.add(step);
      cash = cash.sub(step.mul(p));
      q = q.sub(step);
      if (pos.isZero()) {
        total += 1;
        const perUnit = opened.gt(0) ? cash.div(opened) : new Decimal(0);
        if (cash.lt(0)) {
          losing += 1;
          loss.push(perUnit.neg());
        } else if (cash.gt(0)) win.push(perUnit);
        cash = new Decimal(0);
        opened = new Decimal(0);
      }
    }
  }
  if (total === 0) return null;
  const avg = (xs: Decimal[]) => xs.reduce((s, x) => s.add(x), new Decimal(0)).div(xs.length);
  return {
    losing,
    total,
    losersLoseMore: loss.length === 0 || win.length === 0 ? null : avg(loss).gt(avg(win)),
  };
}

/** Trung vị số tick từ histogram `{ ticks: số mẫu }`; rỗng → null. */
export function medianTicks(hist: Readonly<Record<string, number>>): number | null {
  const entries = Object.entries(hist)
    .map(([k, n]) => [Number(k), n] as const)
    .filter(([k, n]) => Number.isFinite(k) && n > 0)
    .sort((a, b) => a[0] - b[0]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return null;
  let seen = 0;
  for (const [k, n] of entries) {
    seen += n;
    if (seen * 2 >= total) return k;
  }
  return entries.at(-1)?.[0] ?? null;
}

/** Độ lệch chuẩn % thay đổi giữa các giá đóng liên tiếp (bps); dưới 2 thay đổi → null. */
export function swingBps(closes: readonly string[]): Decimal | null {
  const r: Decimal[] = [];
  for (let i = 1; i < closes.length; i += 1) {
    const a = dec(closes[i - 1] ?? "0");
    const b = dec(closes[i] ?? "0");
    if (a.gt(0)) r.push(b.sub(a).div(a).mul(10_000));
  }
  if (r.length < 2) return null;
  const mean = r.reduce((s, x) => s.add(x), new Decimal(0)).div(r.length);
  const v = r.reduce((s, x) => s.add(x.sub(mean).pow(2)), new Decimal(0)).div(r.length - 1);
  return v.sqrt();
}

function median(xs: readonly Decimal[]): Decimal | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a.cmp(b));
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? (s[m] ?? null) : (s[m - 1] ?? new Decimal(0)).add(s[m] ?? 0).div(2);
}
