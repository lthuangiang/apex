import { z } from "zod";

import { dec, type Decimal } from "../money";
import { isoDateTimeSchema } from "../schemas";
import { summarizeByDay, type DayObs } from "../stats/day-bootstrap";

import type { VersionConfigChange } from "./versions";

// Sổ thí nghiệm (Catalyst Intelligence Phase 0, #377, DEC-348 / DEC-351). Một giả thuyết, một
// thí nghiệm, một kết quả: mỗi version (trừ Baseline) so GHÉP CẶP với Baseline cố định trên cùng các bài. Hàm thuần, không
// I/O; không đổi logic giao dịch của version nào.

/** Số cặp lệnh đã đóng một thí nghiệm cần; đủ thì version dừng và chuyển sang Finished. */
export const EXPERIMENT_PAIRS = 100;

/** Giả thuyết: một câu, một dòng, 1–200 ký tự sau khi bỏ khoảng trắng hai đầu. */
export const HYPOTHESIS_MAX = 200;
export const hypothesisSchema = z
  .string()
  .trim()
  .min(1)
  .max(HYPOTHESIS_MAX)
  .refine((s) => !/[\r\n]/.test(s), { message: "one_line" });

export const ExperimentVerdict = {
  collecting: "collecting",
  better: "better",
  worse: "worse",
  noClearDifference: "no_clear_difference",
} as const;
export type ExperimentVerdict = (typeof ExperimentVerdict)[keyof typeof ExperimentVerdict];
export const EXPERIMENT_VERDICTS = Object.values(ExperimentVerdict) as [
  ExperimentVerdict,
  ...ExperimentVerdict[],
];

/**
 * Nhóm "thứ" đã đổi so với Baseline (luật "một thay đổi"): mỗi loại tin là một thứ riêng; Assets (chế độ, loại tài sản, danh
 * sách) là MỘT thứ; mỗi field còn lại là một thứ. Ví dụ "Lowest level Low → High · Assets All → Only BTC-USD, ETH-USD" là 2.
 */
export function changedThings(changes: readonly VersionConfigChange[]): string[] {
  const out: string[] = [];
  for (const c of changes) {
    const k =
      c.field === "newsType"
        ? `newsType:${c.catalyst}`
        : c.field === "assetMode" || c.field === "assetKinds" || c.field === "assets"
          ? "assets"
          : c.field;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/** Thí nghiệm sạch = đổi đúng một thứ so với Baseline. 0 hoặc ≥ 2 thứ là "Not a clean test" (chỉ cảnh báo, không chặn). */
export const cleanTest = (changes: readonly VersionConfigChange[]): boolean =>
  changedThings(changes).length === 1;

/**
 * Một lệnh giấy news THẬT (label `live`) để ghép cặp; lệnh shadow (bị giới hạn chặn) không bao giờ đưa vào đây. `resultPct`
 * = kết quả sau phí (%), null khi chưa đóng. `eventAt` = giờ đăng của bài đầu câu chuyện (cả lệnh thử lại), nên cùng một
 * tin có cùng `eventAt` ở mọi version (câu chuyện và id của nó thì riêng từng version).
 */
export interface PairTrade {
  market: string;
  catalyst: string;
  eventAt: Date;
  status: string;
  resultPct: string | null;
  openedAt: Date;
  exitedAt: Date | null;
}

/** Một khoảng version ở trạng thái `running`; `to` null = đang chạy. */
export interface RunPeriod {
  from: Date;
  to: Date | null;
}

/** Cột `signal_bot_versions.running_periods` (ISO UTC). */
export const runPeriodsSchema = z.array(
  z.object({ from: isoDateTimeSchema, to: isoDateTimeSchema.nullable() }),
);

export const runPeriodsJson = (periods: readonly RunPeriod[]) =>
  periods.map((p) => ({
    from: p.from.toISOString(),
    to: p.to === null ? null : p.to.toISOString(),
  }));

/**
 * Khoảng chạy của một version. Cột null (version lưu trước #377, hoặc Baseline seed) thì ước theo trạng thái: đang chạy →
 * từ lúc lưu tới nay; không chạy → từ lúc lưu tới lần đổi trạng thái gần nhất.
 */
export function runPeriodsOf(v: {
  runningPeriods: unknown;
  status: string;
  createdAt: Date;
  statusChangedAt: Date;
}): RunPeriod[] {
  if (v.runningPeriods !== null) {
    const p = runPeriodsSchema.safeParse(v.runningPeriods);
    if (p.success)
      return p.data.map((x) => ({
        from: new Date(x.from),
        to: x.to === null ? null : new Date(x.to),
      }));
  }
  return [{ from: v.createdAt, to: v.status === "running" ? null : v.statusChangedAt }];
}

/**
 * #385: mốc "Started" của một thí nghiệm = lần đầu version vào `running` (mốc `from` sớm nhất của `running_periods`).
 * - Có khoảng chạy → mốc sớm nhất.
 * - Mảng rỗng → version đã lưu nhưng chưa từng chạy (lưu không bấm Start) → null ("Not started yet").
 * - Cột null hoặc hỏng (version lưu trước #382 / #377, chưa ghi khoảng chạy) → giữ `createdAt` như trước: không có dữ liệu
 *   nào khác cho mốc bắt đầu, và các version này được Start ngay lúc lưu.
 */
export function experimentStartedAt(v: { runningPeriods: unknown; createdAt: Date }): Date | null {
  if (v.runningPeriods === null) return v.createdAt;
  const p = runPeriodsSchema.safeParse(v.runningPeriods);
  if (!p.success) return v.createdAt;
  const first = p.data.reduce<string | null>(
    (min, x) => (min === null || Date.parse(x.from) < Date.parse(min) ? x.from : min),
    null,
  );
  return first === null ? null : new Date(first);
}

/** Mở / đóng khoảng chạy khi version đổi trạng thái (thuần, có test). */
export function nextRunPeriods(periods: readonly RunPeriod[], to: string, at: Date): RunPeriod[] {
  const out = periods.map((p) => ({ ...p }));
  const open = out.length > 0 && out[out.length - 1]?.to === null;
  if (to === "running" && !open) out.push({ from: at, to: null });
  if (to !== "running" && open) {
    const last = out[out.length - 1];
    if (last !== undefined) last.to = at;
  }
  return out;
}

const within = (periods: readonly RunPeriod[], at: Date) =>
  periods.some((p) => p.from <= at && (p.to === null || at < p.to));

export interface ExperimentPair {
  key: string;
  /** Kết quả sau phí của thí nghiệm − của Baseline (điểm %); bên không vào lệnh = 0. */
  diff: Decimal;
  /** Giờ vào lệnh sớm nhất trong cặp (cụm ngày của bootstrap). */
  at: number;
  /** Lúc cặp đủ (lệnh đóng sau cùng trong cặp): thứ tự để lấy đúng 100 cặp đầu. */
  completeAt: number;
}

/** "Cùng tín hiệu" = cùng market, loại tin và giờ đăng của bài đầu câu chuyện (độc lập với version). */
const pairKey = (t: PairTrade) => `${t.market}|${t.catalyst}|${String(t.eventAt.getTime())}`;

const closed = (t: PairTrade) =>
  t.status === "closed" && t.resultPct !== null && t.exitedAt !== null;

/**
 * Ghép cặp trên HỢP các tín hiệu mà ít nhất một bên đã vào lệnh, trong lúc CẢ HAI version đang chạy (khoảng `running`, nên
 * thời gian một bên tạm dừng không bị tính là "không vào lệnh"). Bên không vào lệnh (bỏ qua theo luật của nó, hoặc bị giới
 * hạn chặn: chỉ có lệnh shadow) tính kết quả 0, nên thí nghiệm lọc được tính cả phần lệnh Baseline vào mà version bỏ. Cặp chỉ
 * đếm khi mọi lệnh đã vào trong cặp đều đã đóng. Mỗi bên một lệnh mỗi khoá (lệnh mở sớm nhất). Thứ tự theo lúc cặp đủ, rồi
 * theo khoá (tất định).
 */
export function pairWithBaseline(
  experiment: { trades: readonly PairTrade[]; running: readonly RunPeriod[] },
  baseline: { trades: readonly PairTrade[]; running: readonly RunPeriod[] },
): ExperimentPair[] {
  const first = (rows: readonly PairTrade[]) => {
    const m = new Map<string, PairTrade>();
    for (const t of rows) {
      const k = pairKey(t);
      const cur = m.get(k);
      if (cur === undefined || t.openedAt < cur.openedAt) m.set(k, t);
    }
    return m;
  };
  const exp = first(experiment.trades);
  const base = first(baseline.trades);
  const out: ExperimentPair[] = [];
  for (const key of new Set([...exp.keys(), ...base.keys()])) {
    const sides = [exp.get(key), base.get(key)];
    const entered = sides.filter((t): t is PairTrade => t !== undefined);
    const at = new Date(Math.min(...entered.map((t) => t.openedAt.getTime())));
    if (!within(experiment.running, at) || !within(baseline.running, at)) continue;
    if (!entered.every(closed)) continue;
    const pct = (t: PairTrade | undefined) => dec(t?.resultPct ?? "0");
    out.push({
      key,
      diff: pct(sides[0]).sub(pct(sides[1])),
      at: at.getTime(),
      completeAt: Math.max(...entered.map((t) => t.exitedAt?.getTime() ?? 0)),
    });
  }
  return out.sort(
    (a, b) => a.completeAt - b.completeAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

export interface ExperimentResult {
  pairs: number;
  needed: number;
  /** Trung bình chênh lệch (điểm %); null khi chưa có cặp. */
  meanDiffPct: string | null;
  /** Khoảng 95% block bootstrap theo ngày (DEC-321); null khi < 2 cặp hoặc < 2 ngày. */
  ciLow: string | null;
  ciHigh: string | null;
  /** Số ngày (cụm) của khoảng. */
  clusters: number;
  verdict: ExperimentVerdict;
}

const fix = (d: Decimal | null) => (d === null ? null : d.toDecimalPlaces(6).toFixed());

/**
 * Kết luận trên ĐÚNG `EXPERIMENT_PAIRS` cặp đầu (cặp sau đó không đổi kết quả). Chưa đủ → collecting. Đủ: cả khoảng > 0 →
 * better; cả khoảng < 0 → worse; còn lại (chạm / cắt 0, hoặc không có khoảng vì chỉ một ngày) → no_clear_difference.
 */
export function experimentResult(pairs: readonly ExperimentPair[]): ExperimentResult {
  const used = pairs.slice(0, EXPERIMENT_PAIRS);
  const obs: DayObs[] = used.map((p) => ({ v: p.diff, at: p.at }));
  const s = summarizeByDay(obs);
  let verdict: ExperimentVerdict = ExperimentVerdict.collecting;
  if (used.length >= EXPERIMENT_PAIRS)
    verdict =
      s.ciLow?.gt(0) === true
        ? ExperimentVerdict.better
        : s.ciHigh?.lt(0) === true
          ? ExperimentVerdict.worse
          : ExperimentVerdict.noClearDifference;
  return {
    pairs: used.length,
    needed: EXPERIMENT_PAIRS,
    meanDiffPct: fix(s.mean),
    ciLow: fix(s.ciLow),
    ciHigh: fix(s.ciHigh),
    clusters: s.clusters,
    verdict,
  };
}

/** Kết quả đã đóng băng lúc dừng (cột `experiment_result`). */
export const experimentResultSchema = z.object({
  pairs: z.number().int().nonnegative(),
  needed: z.number().int().positive(),
  meanDiffPct: z.string().nullable(),
  ciLow: z.string().nullable(),
  ciHigh: z.string().nullable(),
  clusters: z.number().int().nonnegative(),
  verdict: z.enum(EXPERIMENT_VERDICTS),
});
