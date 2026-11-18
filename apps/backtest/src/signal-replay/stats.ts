import {
  Decimal,
  summarizeByDay,
  THIN_SAMPLE,
  tradesNeededByDay,
  type DayObs,
  type DaySummary,
} from "@drift/shared";

import { PAPER_SIZE_USDC, type SignalTrade } from "./types";

// Thống kê và cổng của replay tín hiệu (#274, cổng theo #263 / #269). Kết quả mỗi lệnh tính bằng bp (Decimal).
// - Random baseline: mỗi lệnh thật so với lệnh vào ngẫu nhiên CÙNG thời điểm, cùng market, cùng TP / SL / max hold, chiều
//   ngẫu nhiên theo tỉ lệ Long / Short của phần TRONG MẪU (2/3 đầu) của nhóm, áp cho cả hai giai đoạn. Dùng giá trị kỳ vọng
//   (không bốc thăm): random = pLong × kết quả Long + (1 − pLong) × kết quả Short. Nhóm toàn Long / toàn Short (p = 1 / 0):
//   phần chênh ≡ 0, không bao giờ thắng random (gắn cờ).
// - Khoảng tin cậy 95%: block bootstrap theo NGÀY vào lệnh (UTC). Lệnh cùng ngày tương quan với nhau (C phá vỡ cùng lúc trên
//   nhiều market, B cực đoan cùng giờ), nên lấy mẫu lại cả ngày, không lấy từng lệnh. Báo kèm số cụm (ngày). Thuật toán ở
//   `@drift/shared` (`summarizeByDay`), dùng chung với live paper của #271.
// - Chia theo thời gian vào lệnh: 2/3 đầu (trong mẫu), 1/3 sau (ngoài mẫu).
// - Cổng (ngoài mẫu): ≥ 100 lệnh; trung bình sau phí ≥ 2 × chi phí trung bình và cận dưới khoảng tin cậy > 0; phần chênh so
//   với random có cận dưới > 0; trung bình sau phí cùng dấu ở cả hai giai đoạn (2/3 và 1/3). Mức sụt lớn nhất chỉ để báo
//   (ngưỡng "chấp nhận được" của #263 chưa chốt).

export const GATE_V1 = {
  minOutOfSample: 100,
  minMeanCostMultiple: new Decimal(2),
  thinSample: THIN_SAMPLE,
} as const;

// Thuật toán bootstrap theo ngày nằm ở packages/shared/src/stats/day-bootstrap.ts (dùng chung với Signal research live
// paper #271); tên cũ giữ nguyên cho replay.
export type Obs = DayObs;
export type Summary = DaySummary;
export const summarize = (obs: readonly Obs[]): Summary => summarizeByDay(obs, GATE_V1.thinSample);
export const tradesNeeded = tradesNeededByDay;

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
