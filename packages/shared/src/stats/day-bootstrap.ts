import { Decimal } from "../money";

// Khoảng tin cậy 95% bằng block bootstrap theo NGÀY (UTC) của giờ vào lệnh (DEC-321; chuyển từ
// apps/backtest/src/signal-replay/stats.ts để Signal research live paper #271 dùng chung đúng một thuật toán). Lệnh cùng
// ngày tương quan với nhau (một tin toàn thị trường, một tuần tăng giá), nên lấy mẫu lại cả ngày, không lấy từng lệnh. Báo
// kèm số cụm (ngày). Khoảng xấp xỉ chuẩn (± 1.96 × sd ÷ √n, coi lệnh độc lập) giữ lại làm field phụ. Phần bootstrap tính
// bằng số thực (thống kê, không phải tiền), seed cố định nên tất định. Đơn vị giá trị tuỳ nơi gọi (bp hoặc %).

const DAY = 86_400_000;
const Z95 = 1.96;
/** z của power 80%, để ước tính số lệnh cần. */
const Z_POWER = 0.8416;
export const BOOTSTRAP_RESAMPLES = 2_000;
export const BOOTSTRAP_SEED = 274;
/** Nhóm dưới ngần này lệnh là "mỏng" (#269: chỉ tách nhóm khi ≥ 30). */
export const THIN_SAMPLE = 30;
const num = (x: number) => new Decimal(x.toPrecision(12));

/** Một quan sát: giá trị và giờ vào lệnh (ms) để gom cụm theo ngày. */
export interface DayObs {
  v: Decimal;
  at: number;
}

export interface DaySummary {
  n: number;
  /** Số ngày (UTC) có lệnh: số cụm độc lập dùng cho khoảng tin cậy. */
  clusters: number;
  mean: Decimal | null;
  /** Độ lệch chuẩn từng lệnh. */
  sd: Decimal | null;
  /** Khoảng tin cậy 95% theo block bootstrap ngày; < 2 ngày → null. */
  ciLow: Decimal | null;
  ciHigh: Decimal | null;
  /** Sai số chuẩn của trung bình theo bootstrap ngày. */
  seMean: Decimal | null;
  /** Khoảng xấp xỉ chuẩn, coi lệnh độc lập (phụ, hẹp hơn thực tế khi lệnh tương quan). */
  normalCiLow: Decimal | null;
  normalCiHigh: Decimal | null;
  thin: boolean;
}

/** PRNG tất định (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Block bootstrap theo ngày: trả phân vị 2.5% / 97.5% và sd của trung bình; < 2 cụm → null. */
function dayBootstrap(obs: readonly DayObs[]): { lo: number; hi: number; se: number } | null {
  const days = new Map<number, { sum: number; n: number }>();
  for (const o of obs) {
    const k = Math.floor(o.at / DAY);
    const b = days.get(k) ?? { sum: 0, n: 0 };
    b.sum += o.v.toNumber();
    b.n += 1;
    days.set(k, b);
  }
  const blocks = [...days.values()];
  const k = blocks.length;
  if (k < 2) return null;
  const next = rng(BOOTSTRAP_SEED);
  const means: number[] = [];
  for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < k; i++) {
      const b = blocks[Math.floor(next() * k)];
      if (b === undefined) continue;
      sum += b.sum;
      n += b.n;
    }
    means.push(sum / n);
  }
  return percentile95(means);
}

/**
 * Khoảng 95% theo phân vị của các giá trị bootstrap (quy ước chung cho mọi khoảng tin cậy dùng hàm này: 2.5% lấy `floor`,
 * 97.5% lấy `ceil`) và sai số chuẩn (sd của các giá trị). Cần ≥ 2 giá trị.
 */
function percentile95(values: number[]): { lo: number; hi: number; se: number } {
  values.sort((a, b) => a - b);
  const m = values.reduce((s, x) => s + x, 0) / values.length;
  const se = Math.sqrt(values.reduce((s, x) => s + (x - m) ** 2, 0) / (values.length - 1));
  return {
    lo: values[Math.floor(0.025 * (values.length - 1))] ?? m,
    hi: values[Math.ceil(0.975 * (values.length - 1))] ?? m,
    se,
  };
}

export interface DayDiff {
  /** Trung bình nhóm a − trung bình nhóm b (mỗi nhóm là trung bình mọi quan sát); thiếu một nhóm → null. */
  diff: Decimal | null;
  ciLow: Decimal | null;
  ciHigh: Decimal | null;
  /** Số ngày (UTC) có ít nhất một quan sát ở một trong hai nhóm. */
  clusters: number;
}

/**
 * Chênh hai trung bình (a − b) với khoảng 95% bằng block bootstrap theo ngày GHÉP CẶP (#282): mỗi lần lấy mẫu lại cùng một
 * tập ngày cho cả hai nhóm (cùng thị trường cùng ngày tương quan), rồi lấy chênh hai trung bình (tổng ÷ số quan sát của
 * mỗi nhóm). Cùng PRNG, seed, số lần lấy mẫu và quy ước phân vị với `summarizeByDay`. < 2 ngày → không có khoảng.
 */
export function diffByDayBootstrap(a: readonly DayObs[], b: readonly DayObs[]): DayDiff {
  const mean = (xs: readonly DayObs[]) =>
    xs.length === 0 ? null : xs.reduce((s, o) => s.add(o.v), new Decimal(0)).div(xs.length);
  const ma = mean(a);
  const mb = mean(b);
  const diff = ma === null || mb === null ? null : ma.sub(mb);
  const days = new Map<number, { sa: number; na: number; sb: number; nb: number }>();
  const put = (o: DayObs, first: boolean) => {
    const k = Math.floor(o.at / DAY);
    const d = days.get(k) ?? { sa: 0, na: 0, sb: 0, nb: 0 };
    if (first) {
      d.sa += o.v.toNumber();
      d.na += 1;
    } else {
      d.sb += o.v.toNumber();
      d.nb += 1;
    }
    days.set(k, d);
  };
  for (const o of a) put(o, true);
  for (const o of b) put(o, false);
  const blocks = [...days.values()];
  const k = blocks.length;
  const none = { diff, ciLow: null, ciHigh: null, clusters: k };
  if (diff === null || k < 2) return none;
  const next = rng(BOOTSTRAP_SEED);
  const ds: number[] = [];
  for (let r = 0; r < BOOTSTRAP_RESAMPLES; r++) {
    let sa = 0;
    let na = 0;
    let sb = 0;
    let nb = 0;
    for (let i = 0; i < k; i++) {
      const x = blocks[Math.floor(next() * k)];
      if (x === undefined) continue;
      sa += x.sa;
      na += x.na;
      sb += x.sb;
      nb += x.nb;
    }
    // Lần lấy mẫu không có quan sát của một nhóm thì bỏ (không định nghĩa được chênh).
    if (na > 0 && nb > 0) ds.push(sa / na - sb / nb);
  }
  if (ds.length < 2) return none;
  const q = percentile95(ds);
  return { diff, ciLow: num(q.lo), ciHigh: num(q.hi), clusters: k };
}

export function summarizeByDay(obs: readonly DayObs[], thinSample = THIN_SAMPLE): DaySummary {
  const n = obs.length;
  const clusters = new Set(obs.map((o) => Math.floor(o.at / DAY))).size;
  const empty = {
    sd: null,
    ciLow: null,
    ciHigh: null,
    seMean: null,
    normalCiLow: null,
    normalCiHigh: null,
  };
  if (n === 0) return { n, clusters, mean: null, ...empty, thin: true };
  const mean = obs.reduce((s, o) => s.add(o.v), new Decimal(0)).div(n);
  if (n < 2) return { n, clusters, mean, ...empty, thin: true };
  const variance = obs.reduce((s, o) => s.add(o.v.sub(mean).pow(2)), new Decimal(0)).div(n - 1);
  const sd = variance.sqrt();
  const half = sd.div(Math.sqrt(n)).mul(Z95);
  const boot = dayBootstrap(obs);
  return {
    n,
    clusters,
    mean,
    sd,
    ciLow: boot === null ? null : num(boot.lo),
    ciHigh: boot === null ? null : num(boot.hi),
    seMean: boot === null ? null : num(boot.se),
    normalCiLow: mean.sub(half),
    normalCiHigh: mean.add(half),
    thin: n < thinSample,
  };
}

/**
 * Số lệnh cần để khoảng tin cậy 95% của trung bình không chạm 0 với power 80%: ((1.96 + 0.84) × sd hiệu dụng ÷ mean)²,
 * sd hiệu dụng = sai số chuẩn bootstrap theo ngày × √n (gồm cả tương quan trong ngày). Chưa đủ dữ liệu (n < 2 hoặc < 2 ngày)
 * hoặc trung bình ≤ 0 → null; nơi gọi phân biệt hai trường hợp.
 */
export function tradesNeededByDay(s: DaySummary): number | null {
  if (s.mean === null || s.seMean === null || s.mean.lte(0)) return null;
  const sdEff = s.seMean.mul(Math.sqrt(s.n));
  return Math.ceil(
    sdEff
      .mul(Z95 + Z_POWER)
      .div(s.mean)
      .pow(2)
      .toNumber(),
  );
}
