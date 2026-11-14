import type { MmMarketCost } from "./api/mm-cost";
import { roundTrips, type MarkoutFill } from "./mm-markout";
import { dec, Decimal, type DecimalInput } from "./money";

// Mô hình chi phí Market Making v1 (DEC-228). Hàm thuần, không I/O.
// - PnL giá (bps trên volume) = a × bước − k × dao động 1 phút, chặn ≤ 0: không bao giờ dự kiến lãi từ giá.
//   a ≤ 0,5 vì một vòng ăn tối đa 1 bước trên notional một chiều mà volume tính cả hai chiều.
// - Có bot của chính người xem: trộn (n × thực + 50 × mô hình) / (n + 50), n = số vòng đóng 24 giờ.
// - Hệ số (a, k) fit mỗi ngày từ bot thật bằng bình phương tối thiểu có trọng số theo volume.

/** Hệ số khởi đầu (version 0): a = nửa trần; k từ bot ETH thật ngày 2026-11-14 (bước 0,52, dao động 9,53, −0,78 bps). */
export const MM_MODEL_SEED = { version: 0, a: "0.25", k: "0.095" } as const;
export const MM_A_MAX = 0.5;
/** "Up to … / day" = 5% volume 24h, cho tới khi đo được tỷ lệ thật của bot. */
export const MM_CAPACITY_SHARE = "0.05";
/** Dưới mức này là "Too little volume" (USD / ngày). */
export const MM_MIN_CAPACITY = 100_000;
/** Trọng số của mô hình khi trộn với số thật (tính như 50 vòng). */
export const MM_BLEND_ROUNDS = 50;
/** Ngưỡng dữ liệu của mô hình: ≥ 12 giờ nến 1m, ≥ 50% số phút trong 24 giờ có volume. */
export const MM_MIN_CANDLE_MINUTES = 720;
export const MM_MIN_ACTIVE_MINUTES = 720;
/**
 * Một phút chỉ tính là "có volume" khi volume quote của phút đó ≥ $50: market thưa trên SoDEX gần như phút nào cũng có
 * giao dịch rất nhỏ (XPL-USD trung vị $0,2 / phút, đo 2026-11-14), nên đếm volume > 0 không chặn được (DEC-228).
 */
export const MM_ACTIVE_MINUTE_MIN_USD = 50;

/** Nến 1 phút có đủ volume quote (close × volume ≥ `MM_ACTIVE_MINUTE_MIN_USD`) để tính là một phút có giao dịch. */
export function isActiveMinute(c: { close: DecimalInput; volume: DecimalInput }): boolean {
  return dec(c.close).mul(c.volume).gte(MM_ACTIVE_MINUTE_MIN_USD);
}
/** Một điểm fit chỉ tính khi bot có ≥ 50 vòng đóng trong ngày; dưới 5 điểm thì giữ a, chỉ fit k. */
export const MM_FIT_MIN_ROUNDS = 50;
export const MM_FIT_MIN_POINTS = 5;
export const MM_SUGGEST_MAX = 3;

/** PnL giá mô hình (bps trên volume), chặn ≤ 0. */
export function modelPnlBps(
  stepBps: Decimal,
  swingBps: Decimal,
  a: DecimalInput,
  k: DecimalInput,
): Decimal {
  return Decimal.min(0, dec(a).mul(stepBps).sub(dec(k).mul(swingBps)));
}

/** Trộn số thật của bot người xem với mô hình theo số vòng đóng. */
export function blendPnlBps(model: Decimal, actual: Decimal | null, rounds: number): Decimal {
  if (actual === null || rounds <= 0) return model;
  return actual
    .mul(rounds)
    .add(model.mul(MM_BLEND_ROUNDS))
    .div(rounds + MM_BLEND_ROUNDS);
}

/**
 * PnL giá của các fill trong cửa sổ (bps trên volume), gồm phần chưa chốt: tiền mặt của các fill + phần mua / bán ròng
 * trong cửa sổ định giá ở `mid` hiện tại. Không có volume → null.
 */
export function windowPnl(
  fills: readonly MarkoutFill[],
  mid: DecimalInput | null,
): { bps: Decimal | null; volume: Decimal; rounds: number } {
  let cash = new Decimal(0);
  let net = new Decimal(0);
  let volume = new Decimal(0);
  for (const f of fills) {
    const n = dec(f.price).mul(f.size);
    volume = volume.add(n);
    if (f.side === "buy") {
      cash = cash.sub(n);
      net = net.add(f.size);
    } else {
      cash = cash.add(n);
      net = net.sub(f.size);
    }
  }
  const rounds = roundTrips(fills)?.total ?? 0;
  if (volume.isZero()) return { bps: null, volume, rounds };
  if (!net.isZero() && mid === null) return { bps: null, volume, rounds };
  const pnl = cash.add(net.mul(mid ?? 0));
  return { bps: pnl.div(volume).mul(10_000), volume, rounds };
}

export interface FitPoint {
  stepBps: DecimalInput;
  swingBps: DecimalInput;
  /** PnL giá thật (bps trên volume). */
  pnlBps: DecimalInput;
  /** Trọng số (volume). */
  weight: DecimalInput;
}

/**
 * Fit y = a × bước − k × dao động (bình phương tối thiểu có trọng số). Dưới `MM_FIT_MIN_POINTS` điểm: giữ `aFixed`,
 * chỉ fit k. a bị ép trong [0; 0,5] (ép thì fit lại k với a đó), k ≥ 0. Không có điểm → null.
 */
export function fitModel(
  points: readonly FitPoint[],
  aFixed: DecimalInput = MM_MODEL_SEED.a,
): { a: Decimal; k: Decimal; points: number } | null {
  const ps = points
    .map((p) => ({ x1: dec(p.stepBps), x2: dec(p.swingBps), y: dec(p.pnlBps), w: dec(p.weight) }))
    .filter((p) => p.w.gt(0));
  if (ps.length === 0) return null;
  const fitK = (a: Decimal) => {
    // y = a·x1 − k·x2 → k = Σ w·x2·(a·x1 − y) / Σ w·x2²
    let num = new Decimal(0);
    let den = new Decimal(0);
    for (const p of ps) {
      num = num.add(p.w.mul(p.x2).mul(a.mul(p.x1).sub(p.y)));
      den = den.add(p.w.mul(p.x2).mul(p.x2));
    }
    return den.isZero() ? new Decimal(0) : Decimal.max(0, num.div(den));
  };
  if (ps.length < MM_FIT_MIN_POINTS) {
    const a = dec(aFixed);
    return { a, k: fitK(a), points: ps.length };
  }
  // Phương trình chuẩn cho y = a·x1 + c·x2 (c = −k).
  let s11 = new Decimal(0);
  let s12 = new Decimal(0);
  let s22 = new Decimal(0);
  let s1y = new Decimal(0);
  let s2y = new Decimal(0);
  for (const p of ps) {
    s11 = s11.add(p.w.mul(p.x1).mul(p.x1));
    s12 = s12.add(p.w.mul(p.x1).mul(p.x2));
    s22 = s22.add(p.w.mul(p.x2).mul(p.x2));
    s1y = s1y.add(p.w.mul(p.x1).mul(p.y));
    s2y = s2y.add(p.w.mul(p.x2).mul(p.y));
  }
  const det = s11.mul(s22).sub(s12.mul(s12));
  if (det.isZero()) {
    const a = dec(aFixed);
    return { a, k: fitK(a), points: ps.length };
  }
  const aRaw = s1y.mul(s22).sub(s2y.mul(s12)).div(det);
  const a = Decimal.min(MM_A_MAX, Decimal.max(0, aRaw));
  if (!a.eq(aRaw)) return { a, k: fitK(a), points: ps.length };
  const k = s11.mul(s2y).sub(s12.mul(s1y)).div(det).neg();
  return k.lt(0) ? { a, k: new Decimal(0), points: ps.length } : { a, k, points: ps.length };
}

/** Sức chứa / ngày từ volume 24h. */
export function capacityPerDay(volume24h: DecimalInput | null): Decimal | null {
  return volume24h === null ? null : dec(volume24h).mul(MM_CAPACITY_SHARE);
}

type Rankable = Pick<
  MmMarketCost,
  "market" | "totalCostPerMillion" | "capacityPerDay" | "tooLittleVolume"
>;

const costKey = (r: Rankable) => {
  // "0 or less" là một nhóm: cùng nhóm thì xếp theo sức chứa.
  const c = r.totalCostPerMillion === null ? null : dec(r.totalCostPerMillion);
  return c === null ? null : Decimal.max(0, c);
};

/**
 * Xếp hạng: đủ dữ liệu và đủ sức chứa (rẻ nhất trước, cùng chi phí — kể cả cùng "0 or less" — thì sức chứa lớn trước),
 * rồi "Too little volume" (cùng luật), rồi thiếu dữ liệu (theo tên). Trả về danh sách và tối đa 3 market gợi ý.
 */
export function rankMmMarkets<T extends Rankable>(
  rows: readonly T[],
): { ranked: T[]; suggested: string[] } {
  const tier = (r: T) => (costKey(r) === null ? 2 : r.tooLittleVolume ? 1 : 0);
  const cap = (r: T) => (r.capacityPerDay === null ? new Decimal(0) : dec(r.capacityPerDay));
  const ranked = [...rows].sort((x, y) => {
    const t = tier(x) - tier(y);
    if (t !== 0) return t;
    const cx = costKey(x);
    const cy = costKey(y);
    if (cx !== null && cy !== null && !cx.eq(cy)) return cx.cmp(cy);
    const c = cap(y).cmp(cap(x));
    return c !== 0 ? c : x.market.localeCompare(y.market);
  });
  const suggested = ranked
    .filter((r) => tier(r) === 0)
    .slice(0, MM_SUGGEST_MAX)
    .map((r) => r.market);
  return { ranked, suggested };
}
