import { z } from "zod";

import { dec, type Decimal } from "../money";
import { summarizeByDay, type DayObs } from "../stats/day-bootstrap";

import type { VersionConfigChange } from "./versions";

// Sổ thí nghiệm (Catalyst Intelligence Phase 0, #377, DEC-TBD-catalyst-p0 / DEC-TBD-sr-experiments). Một giả thuyết, một
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

/** Một lệnh giấy news để ghép cặp. `resultPct` = kết quả sau phí (%), null khi chưa đóng. */
export interface PairTrade {
  storyId: string | null;
  articleId: string | null;
  market: string;
  status: string;
  resultPct: string | null;
  openedAt: Date;
  exitedAt: Date | null;
}

export interface ExperimentPair {
  key: string;
  /** Kết quả sau phí của thí nghiệm − của Baseline (điểm %). */
  diff: Decimal;
  /** Giờ vào lệnh của thí nghiệm (cụm ngày của bootstrap). */
  at: number;
  /** Lúc cặp đủ (lệnh đóng sau của hai bên): thứ tự để lấy đúng 100 cặp đầu. */
  completeAt: number;
}

/** "Cùng bài" = cùng câu chuyện (bài thử lại của một câu chuyện vẫn là một tin) và cùng market; không có story thì theo bài. */
function pairKey(t: PairTrade): string | null {
  const unit =
    t.storyId === null ? (t.articleId === null ? null : `a:${t.articleId}`) : `s:${t.storyId}`;
  return unit === null ? null : `${unit}|${t.market}`;
}

const closedOk = (t: PairTrade) =>
  t.status === "closed" && t.resultPct !== null && t.exitedAt !== null;

/**
 * Ghép lệnh đã đóng của thí nghiệm (mở từ `since` = lúc lưu version) với lệnh đã đóng của Baseline trên cùng bài + market.
 * Mỗi khoá chỉ một cặp (lệnh mở sớm nhất mỗi bên). Thứ tự theo lúc cặp đủ, rồi theo khoá (tất định).
 */
export function pairWithBaseline(
  experiment: readonly PairTrade[],
  baseline: readonly PairTrade[],
  since: Date,
): ExperimentPair[] {
  const first = (rows: readonly PairTrade[]) => {
    const m = new Map<string, PairTrade>();
    for (const t of rows) {
      if (!closedOk(t)) continue;
      const k = pairKey(t);
      if (k === null) continue;
      const cur = m.get(k);
      if (cur === undefined || t.openedAt < cur.openedAt) m.set(k, t);
    }
    return m;
  };
  const exp = first(experiment.filter((t) => t.openedAt >= since));
  const base = first(baseline);
  const out: ExperimentPair[] = [];
  for (const [key, e] of exp) {
    const b = base.get(key);
    if (b === undefined) continue;
    out.push({
      key,
      diff: dec(e.resultPct ?? "0").sub(dec(b.resultPct ?? "0")),
      at: e.openedAt.getTime(),
      completeAt: Math.max(e.exitedAt?.getTime() ?? 0, b.exitedAt?.getTime() ?? 0),
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
