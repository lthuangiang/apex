import { Decimal } from "@drift/shared";

import { PAPER_SIZE_USDC, type SignalTrade } from "./types";

// Thống kê và cổng của replay tín hiệu (#274, cổng theo #263 / #269). Kết quả mỗi lệnh tính bằng bp (Decimal).
// - Random baseline: mỗi lệnh thật so với lệnh vào ngẫu nhiên CÙNG thời điểm, cùng market, cùng TP / SL / max hold, chiều
//   ngẫu nhiên theo tỉ lệ Long / Short của phần TRONG MẪU (2/3 đầu) của nhóm, áp cho cả hai giai đoạn. Dùng giá trị kỳ vọng
//   (không bốc thăm): random = pLong × kết quả Long + (1 − pLong) × kết quả Short. Nhóm toàn Long / toàn Short (p = 1 / 0):
//   phần chênh ≡ 0, không bao giờ thắng random (gắn cờ).
// - Khoảng tin cậy 95%: block bootstrap theo NGÀY vào lệnh (UTC). Lệnh cùng ngày tương quan với nhau (C phá vỡ cùng lúc trên
//   nhiều market, B cực đoan cùng giờ), nên lấy mẫu lại cả ngày, không lấy từng lệnh. Báo kèm số cụm (ngày). Khoảng xấp xỉ
//   chuẩn (± 1.96 × sd ÷ √n, coi lệnh độc lập) giữ lại làm field phụ. Phần bootstrap tính bằng số thực (thống kê, không phải
//   tiền), seed cố định nên tất định.
// - Chia theo thời gian vào lệnh: 2/3 đầu (trong mẫu), 1/3 sau (ngoài mẫu).
// - Cổng (ngoài mẫu): ≥ 100 lệnh; trung bình sau phí ≥ 2 × chi phí trung bình và cận dưới khoảng tin cậy > 0; phần chênh so
//   với random có cận dưới > 0; trung bình sau phí cùng dấu ở cả hai giai đoạn (2/3 và 1/3). Mức sụt lớn nhất chỉ để báo
//   (ngưỡng "chấp nhận được" của #263 chưa chốt).

const DAY = 86_400_000;
const Z95 = 1.96;
/** z của power 80%, để ước tính số lệnh cần. */
const Z_POWER = 0.8416;
const BOOTSTRAP_RESAMPLES = 2_000;
const BOOTSTRAP_SEED = 274;

export const GATE_V1 = {
  minOutOfSample: 100,
  minMeanCostMultiple: new Decimal(2),
  thinSample: 30,
} as const;

/** Một quan sát: giá trị (bp) và giờ vào lệnh (ms) để gom cụm theo ngày. */
export interface Obs {
  v: Decimal;
  at: number;
}

export interface Summary {
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
function dayBootstrap(obs: readonly Obs[]): { lo: number; hi: number; se: number } | null {
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
  means.sort((a, b) => a - b);
  const m = means.reduce((s, x) => s + x, 0) / means.length;
  const se = Math.sqrt(means.reduce((s, x) => s + (x - m) ** 2, 0) / (means.length - 1));
  return {
    lo: means[Math.floor(0.025 * (means.length - 1))] ?? m,
    hi: means[Math.ceil(0.975 * (means.length - 1))] ?? m,
    se,
  };
}

const num = (x: number) => new Decimal(x.toPrecision(12));

export function summarize(obs: readonly Obs[]): Summary {
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
    thin: n < GATE_V1.thinSample,
  };
}

/**
 * Số lệnh cần để khoảng tin cậy 95% của trung bình không chạm 0 với power 80%: ((1.96 + 0.84) × sd hiệu dụng ÷ mean)²,
 * sd hiệu dụng = sai số chuẩn bootstrap theo ngày × √n (gồm cả tương quan trong ngày). Chưa đủ dữ liệu (n < 2 hoặc < 2 ngày)
 * hoặc trung bình ≤ 0 → null; nơi gọi phân biệt hai trường hợp.
 */
export function tradesNeeded(s: Summary): number | null {
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

/**
 * Gắn kết quả random kỳ vọng vào mọi lệnh đã vào trong `trades`, với tỉ lệ Long lấy từ `basis` (phần trong mẫu). `basis`
 * rỗng → không gắn (random null).
 */
export function attachRandom(
  trades: readonly SignalTrade[],
  basis: readonly SignalTrade[] = trades,
): { longShare: number | null } {
  const base = basis.filter((t) => t.status === "entered");
  if (base.length === 0) return { longShare: null };
  const p = base.filter((t) => t.direction === "long").length / base.length;
  for (const t of trades) {
    if (t.status !== "entered") continue;
    t.randomAfterFeesBp =
      t.longAfterFeesBp === null || t.shortAfterFeesBp === null
        ? null
        : t.longAfterFeesBp.mul(p).add(t.shortAfterFeesBp.mul(1 - p));
  }
  return { longShare: p };
}

export interface Drawdown {
  bp: Decimal;
  /** Trên `PAPER_SIZE_USDC` mỗi lệnh. */
  usd: Decimal;
}

/** Mức sụt lớn nhất của kết quả sau phí cộng dồn, xếp theo giờ thoát (bp cộng dồn; ≥ 0). */
export function maxDrawdown(trades: readonly SignalTrade[]): Drawdown {
  const closed = trades
    .filter((t) => t.resultAfterFeesBp !== null && t.exitAt !== null)
    .sort((a, b) => (a.exitAt ?? 0) - (b.exitAt ?? 0));
  let cum = new Decimal(0);
  let peak = new Decimal(0);
  let worst = new Decimal(0);
  for (const t of closed) {
    cum = cum.add(t.resultAfterFeesBp ?? 0);
    if (cum.gt(peak)) peak = cum;
    if (peak.sub(cum).gt(worst)) worst = peak.sub(cum);
  }
  return { bp: worst, usd: worst.div(10_000).mul(PAPER_SIZE_USDC) };
}

export interface PeriodStats {
  n: number;
  from: number | null;
  to: number | null;
  afterFees: Summary;
  random: Summary;
  /** Kết quả sau phí − random, trên các lệnh có cả hai. */
  difference: Summary;
  avgCostBp: Decimal | null;
  long: Summary;
  short: Summary;
  exits: Record<string, number>;
  avgMovedBeforeEntryBp: Decimal | null;
  maxDrawdown: Drawdown;
}

const avg = (xs: readonly Decimal[]) =>
  xs.length === 0 ? null : xs.reduce((s, v) => s.add(v), new Decimal(0)).div(xs.length);

const obsOf = (trades: readonly SignalTrade[], f: (t: SignalTrade) => Decimal | null): Obs[] =>
  trades.flatMap((t) => {
    const v = f(t);
    return v === null ? [] : [{ v, at: t.entryAt ?? t.seenAt }];
  });

export function periodStats(trades: readonly SignalTrade[]): PeriodStats {
  const res = (t: SignalTrade) => t.resultAfterFeesBp;
  const exits: Record<string, number> = {};
  for (const t of trades)
    if (t.exitReason !== null) exits[t.exitReason] = (exits[t.exitReason] ?? 0) + 1;
  return {
    n: trades.length,
    from: trades[0]?.entryAt ?? null,
    to: trades.at(-1)?.entryAt ?? null,
    afterFees: summarize(obsOf(trades, res)),
    random: summarize(obsOf(trades, (t) => t.randomAfterFeesBp)),
    difference: summarize(
      obsOf(trades, (t) =>
        t.resultAfterFeesBp === null || t.randomAfterFeesBp === null
          ? null
          : t.resultAfterFeesBp.sub(t.randomAfterFeesBp),
      ),
    ),
    avgCostBp: avg(trades.map((t) => t.costBp).filter((v): v is Decimal => v !== null)),
    long: summarize(
      obsOf(
        trades.filter((t) => t.direction === "long"),
        res,
      ),
    ),
    short: summarize(
      obsOf(
        trades.filter((t) => t.direction === "short"),
        res,
      ),
    ),
    exits,
    avgMovedBeforeEntryBp: avg(
      trades.map((t) => t.movedBeforeEntryBp).filter((v): v is Decimal => v !== null),
    ),
    maxDrawdown: maxDrawdown(trades),
  };
}

export type GateStatus = "collecting" | "failing" | "passing";

/** Vì sao không có số lệnh cần. */
export type TradesNeededNote =
  | "estimate"
  | "no data yet"
  | "cannot pass at this average"
  | "cannot reach 2× cost at this average"
  | "cannot beat random at this difference";

export interface GateResult {
  status: GateStatus;
  checks: {
    outOfSampleTrades: { ok: boolean; have: number; need: number };
    meanAtLeast2xCostAndCiAbove0: { ok: boolean };
    beatsRandomCiAbove0: { ok: boolean };
    sameSignBothPeriods: { ok: boolean };
  };
  /** Chỉ để báo, không phải điều kiện qua cổng: ngưỡng "mức sụt chấp nhận được" (#263) chưa chốt. */
  maxDrawdown: {
    group: Drawdown;
    outOfSample: Drawdown;
    threshold: null;
    note: string;
  };
  /** Số lệnh ngoài mẫu ước tính cần (max của 100, n cho trung bình, n cho phần chênh); null kèm lý do ở `tradesNeededNote`. */
  outOfSampleTradesNeeded: number | null;
  tradesNeededNote: TradesNeededNote;
  /** Nhóm toàn Long / toàn Short: không thắng random được theo cách dựng. */
  randomNote: string | null;
  stillNeeds: string[];
}

export interface GroupReport {
  entered: number;
  skipped: number;
  skipReasons: Record<string, number>;
  /** Tỉ lệ Long của phần trong mẫu, dùng cho random baseline của cả nhóm. */
  longShare: number | null;
  all: PeriodStats;
  inSample: PeriodStats;
  outOfSample: PeriodStats;
  gate: GateResult;
}

const fmt = (d: Decimal | null) => (d === null ? "n/a" : d.toDecimalPlaces(1).toString());

export function gateOf(
  inS: PeriodStats,
  outS: PeriodStats,
  opts: { longShare?: number | null; group?: Drawdown } = {},
): GateResult {
  const g = GATE_V1;
  const mean = outS.afterFees.mean;
  const cost = outS.avgCostBp;
  const target = cost === null ? null : cost.mul(g.minMeanCostMultiple);
  const nOk = outS.n >= g.minOutOfSample;
  const meanOk =
    mean !== null && target !== null && mean.gte(target) && outS.afterFees.ciLow?.gt(0) === true;
  const diffOk = outS.difference.ciLow?.gt(0) === true;
  const a = inS.afterFees.mean;
  const signOk = a !== null && mean !== null && !a.isZero() && a.isPositive() === mean.isPositive();

  let note: TradesNeededNote = "estimate";
  let needed: number | null = null;
  const diffMean = outS.difference.mean;
  if (outS.n < 2 || mean === null || outS.afterFees.seMean === null) note = "no data yet";
  else if (mean.lte(0)) note = "cannot pass at this average";
  else if (target !== null && mean.lt(target)) note = "cannot reach 2× cost at this average";
  else if (diffMean === null || diffMean.lte(0)) note = "cannot beat random at this difference";
  else {
    const needMean = tradesNeeded(outS.afterFees);
    const needDiff = tradesNeeded(outS.difference);
    if (needMean === null || needDiff === null) note = "no data yet";
    else needed = Math.max(g.minOutOfSample, needMean, needDiff);
  }

  const p = opts.longShare ?? null;
  const randomNote =
    p === 1 || p === 0
      ? `all ${p === 1 ? "long" : "short"}: cannot beat random by construction`
      : null;

  const still: string[] = [];
  if (!nOk) still.push(`${String(g.minOutOfSample - outS.n)} more out-of-sample trades`);
  if (!meanOk)
    still.push(
      `average after fees ${fmt(mean)} bp needs ≥ 2× cost (${fmt(target)} bp) with the likely range above 0`,
    );
  if (!diffOk)
    still.push(
      `difference vs random ${fmt(outS.difference.mean)} bp needs its likely range above 0`,
    );
  if (!signOk) still.push("same sign in both periods");
  if (randomNote !== null) still.push(randomNote);
  if (needed === null) still.push(note);
  else if (needed > outS.n)
    still.push(`about ${String(needed)} out-of-sample trades at the current effect`);
  const pass = nOk && meanOk && diffOk && signOk;
  return {
    status: pass ? "passing" : nOk ? "failing" : "collecting",
    checks: {
      outOfSampleTrades: { ok: nOk, have: outS.n, need: g.minOutOfSample },
      meanAtLeast2xCostAndCiAbove0: { ok: meanOk },
      beatsRandomCiAbove0: { ok: diffOk },
      sameSignBothPeriods: { ok: signOk },
    },
    maxDrawdown: {
      group: opts.group ?? outS.maxDrawdown,
      outOfSample: outS.maxDrawdown,
      threshold: null,
      note: "Informational only: the acceptable drawdown threshold (#263) is pending a decision.",
    },
    outOfSampleTradesNeeded: needed,
    tradesNeededNote: note,
    randomNote,
    stillNeeds: still,
  };
}

/**
 * Báo cáo một nhóm (loại × biến thể): chia 2/3 – 1/3 theo giờ vào lệnh, gắn random với tỉ lệ Long của phần trong mẫu,
 * chấm cổng.
 */
export function groupReport(trades: readonly SignalTrade[]): GroupReport {
  const entered = trades
    .filter((t) => t.status === "entered")
    .sort((a, b) => (a.entryAt ?? 0) - (b.entryAt ?? 0));
  const cut = Math.floor((entered.length * 2) / 3);
  const inTrades = entered.slice(0, cut);
  const { longShare } = attachRandom(entered, inTrades);
  const inS = periodStats(inTrades);
  const outS = periodStats(entered.slice(cut));
  const all = periodStats(entered);
  const skipReasons: Record<string, number> = {};
  for (const t of trades)
    if (t.status === "skipped" && t.skipReason !== null) {
      // Gộp lý do "Too thin…" có số khác nhau thành một nhóm.
      const key = t.skipReason.split(":")[0] ?? t.skipReason;
      skipReasons[key] = (skipReasons[key] ?? 0) + 1;
    }
  return {
    entered: entered.length,
    skipped: trades.length - entered.length,
    skipReasons,
    longShare,
    all,
    inSample: inS,
    outOfSample: outS,
    gate: gateOf(inS, outS, { longShare, group: all.maxDrawdown }),
  };
}
