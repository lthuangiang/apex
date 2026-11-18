import { Decimal } from "@drift/shared";

import type { SignalTrade } from "./types";

// Thống kê và cổng của replay tín hiệu (#274, cổng theo #263 / #269). Kết quả mỗi lệnh tính bằng bp (Decimal).
// - Random baseline: mỗi lệnh thật so với lệnh vào ngẫu nhiên CÙNG thời điểm, cùng market, cùng TP / SL / max hold, chiều
//   ngẫu nhiên theo đúng tỉ lệ Long / Short của nhóm. Dùng giá trị kỳ vọng (không bốc thăm): random = pLong × kết quả Long
//   + (1 − pLong) × kết quả Short, nên kết quả tất định và không có nhiễu bốc thăm.
// - Khoảng tin cậy 95% xấp xỉ chuẩn: trung bình ± 1.96 × sd ÷ √n (n < 30 thì gắn "thin").
// - Chia theo thời gian vào lệnh: 2/3 đầu (trong mẫu), 1/3 sau (ngoài mẫu).
// - Cổng (ngoài mẫu): ≥ 100 lệnh; trung bình sau phí ≥ 2 × chi phí trung bình và cận dưới khoảng tin cậy > 0; phần chênh so
//   với random có cận dưới > 0; trung bình sau phí cùng dấu ở cả hai giai đoạn (2/3 và 1/3).

const Z95 = 1.96;
/** z của power 80%, để ước tính số lệnh cần. */
const Z_POWER = 0.8416;

export const GATE_V1 = {
  minOutOfSample: 100,
  minMeanCostMultiple: new Decimal(2),
  thinSample: 30,
} as const;

export interface Summary {
  n: number;
  mean: Decimal | null;
  sd: Decimal | null;
  ciLow: Decimal | null;
  ciHigh: Decimal | null;
  thin: boolean;
}

export function summarize(values: readonly Decimal[]): Summary {
  const n = values.length;
  if (n === 0) return { n, mean: null, sd: null, ciLow: null, ciHigh: null, thin: true };
  const mean = values.reduce((s, v) => s.add(v), new Decimal(0)).div(n);
  if (n < 2) return { n, mean, sd: null, ciLow: null, ciHigh: null, thin: true };
  const variance = values.reduce((s, v) => s.add(v.sub(mean).pow(2)), new Decimal(0)).div(n - 1);
  const sd = variance.sqrt();
  const half = sd.div(Math.sqrt(n)).mul(Z95);
  return {
    n,
    mean,
    sd,
    ciLow: mean.sub(half),
    ciHigh: mean.add(half),
    thin: n < GATE_V1.thinSample,
  };
}

/**
 * Số lệnh cần để khoảng tin cậy 95% của trung bình không chạm 0 với power 80%: ((1.96 + 0.84) × sd ÷ |mean|)². Trung bình
 * ≤ 0 → null (không số lệnh nào làm nó qua cổng).
 */
export function tradesNeeded(s: Summary): number | null {
  if (s.mean === null || s.sd === null || s.mean.lte(0)) return null;
  return Math.ceil(
    s.sd
      .mul(Z95 + Z_POWER)
      .div(s.mean)
      .pow(2)
      .toNumber(),
  );
}

/** Gắn kết quả random kỳ vọng vào từng lệnh đã vào của một nhóm, theo tỉ lệ Long của chính nhóm đó. */
export function attachRandom(trades: SignalTrade[]): { longShare: number | null } {
  const entered = trades.filter((t) => t.status === "entered");
  if (entered.length === 0) return { longShare: null };
  const p = entered.filter((t) => t.direction === "long").length / entered.length;
  for (const t of entered) {
    t.randomAfterFeesBp =
      t.longAfterFeesBp === null || t.shortAfterFeesBp === null
        ? null
        : t.longAfterFeesBp.mul(p).add(t.shortAfterFeesBp.mul(1 - p));
  }
  return { longShare: p };
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
}

const avg = (xs: readonly Decimal[]) =>
  xs.length === 0 ? null : xs.reduce((s, v) => s.add(v), new Decimal(0)).div(xs.length);

export function periodStats(trades: readonly SignalTrade[]): PeriodStats {
  const res = (t: SignalTrade) => t.resultAfterFeesBp;
  const vals = (ts: readonly SignalTrade[]) => ts.map(res).filter((v): v is Decimal => v !== null);
  const paired = trades.filter((t) => t.resultAfterFeesBp !== null && t.randomAfterFeesBp !== null);
  const exits: Record<string, number> = {};
  for (const t of trades)
    if (t.exitReason !== null) exits[t.exitReason] = (exits[t.exitReason] ?? 0) + 1;
  return {
    n: trades.length,
    from: trades[0]?.entryAt ?? null,
    to: trades.at(-1)?.entryAt ?? null,
    afterFees: summarize(vals(trades)),
    random: summarize(
      trades.map((t) => t.randomAfterFeesBp).filter((v): v is Decimal => v !== null),
    ),
    difference: summarize(
      paired.flatMap((t) =>
        t.resultAfterFeesBp === null || t.randomAfterFeesBp === null
          ? []
          : [t.resultAfterFeesBp.sub(t.randomAfterFeesBp)],
      ),
    ),
    avgCostBp: avg(trades.map((t) => t.costBp).filter((v): v is Decimal => v !== null)),
    long: summarize(vals(trades.filter((t) => t.direction === "long"))),
    short: summarize(vals(trades.filter((t) => t.direction === "short"))),
    exits,
    avgMovedBeforeEntryBp: avg(
      trades.map((t) => t.movedBeforeEntryBp).filter((v): v is Decimal => v !== null),
    ),
  };
}

export type GateStatus = "collecting" | "failing" | "passing";

export interface GateResult {
  status: GateStatus;
  checks: {
    outOfSampleTrades: { ok: boolean; have: number; need: number };
    meanAtLeast2xCostAndCiAbove0: { ok: boolean };
    beatsRandomCiAbove0: { ok: boolean };
    sameSignBothPeriods: { ok: boolean };
  };
  /** Số lệnh ngoài mẫu ước tính cần (max của 100, n cho trung bình, n cho phần chênh); null = không qua được ở mức hiện tại. */
  outOfSampleTradesNeeded: number | null;
  stillNeeds: string[];
}

export interface GroupReport {
  entered: number;
  skipped: number;
  skipReasons: Record<string, number>;
  longShare: number | null;
  all: PeriodStats;
  inSample: PeriodStats;
  outOfSample: PeriodStats;
  gate: GateResult;
}

const fmt = (d: Decimal | null) => (d === null ? "n/a" : d.toDecimalPlaces(1).toString());

export function gateOf(inS: PeriodStats, outS: PeriodStats): GateResult {
  const g = GATE_V1;
  const mean = outS.afterFees.mean;
  const cost = outS.avgCostBp;
  const nOk = outS.n >= g.minOutOfSample;
  const meanOk =
    mean !== null &&
    cost !== null &&
    mean.gte(cost.mul(g.minMeanCostMultiple)) &&
    outS.afterFees.ciLow?.gt(0) === true;
  const diffOk = outS.difference.ciLow?.gt(0) === true;
  const a = inS.afterFees.mean;
  const signOk = a !== null && mean !== null && !a.isZero() && a.isPositive() === mean.isPositive();
  const needMean = tradesNeeded(outS.afterFees);
  const needDiff = tradesNeeded(outS.difference);
  const needed =
    needMean === null || needDiff === null ? null : Math.max(g.minOutOfSample, needMean, needDiff);
  const still: string[] = [];
  if (!nOk) still.push(`${String(g.minOutOfSample - outS.n)} more out-of-sample trades`);
  if (!meanOk)
    still.push(
      `average after fees ${fmt(mean)} bp needs ≥ 2× cost (${fmt(cost === null ? null : cost.mul(2))} bp) with the likely range above 0`,
    );
  if (!diffOk)
    still.push(
      `difference vs random ${fmt(outS.difference.mean)} bp needs its likely range above 0`,
    );
  if (!signOk) still.push("same sign in both periods");
  if (needed === null) still.push("at the current average it cannot pass with more trades");
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
    outOfSampleTradesNeeded: needed,
    stillNeeds: still,
  };
}

/** Báo cáo một nhóm (loại × biến thể): gắn random, chia 2/3 – 1/3 theo giờ vào lệnh, chấm cổng. */
export function groupReport(trades: SignalTrade[]): GroupReport {
  const { longShare } = attachRandom(trades);
  const entered = trades
    .filter((t) => t.status === "entered")
    .sort((a, b) => (a.entryAt ?? 0) - (b.entryAt ?? 0));
  const cut = Math.floor((entered.length * 2) / 3);
  const inS = periodStats(entered.slice(0, cut));
  const outS = periodStats(entered.slice(cut));
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
    all: periodStats(entered),
    inSample: inS,
    outOfSample: outS,
    gate: gateOf(inS, outS),
  };
}
