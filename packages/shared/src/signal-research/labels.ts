// Nhãn phân loại và cổng precision của classifier (#304, DEC-328 mục 2). Người trong team gắn Right / Wrong cho bài mà
// classifier gọi là tín hiệu (catalyst ≠ none và qua bước Score); precision tính theo version prompt của classifier. Hàm
// ở đây thuần, không I/O.

export const ClassificationVerdict = { right: "right", wrong: "wrong" } as const;
export type ClassificationVerdict =
  (typeof ClassificationVerdict)[keyof typeof ClassificationVerdict];
export const CLASSIFICATION_VERDICTS = Object.values(ClassificationVerdict) as [
  ClassificationVerdict,
  ...ClassificationVerdict[],
];

/** Lý do khi nhãn là Wrong (thứ tự như thiết kế `bot-versions-labels.html`). */
export const ClassificationWrongReason = {
  personNotCompany: "person_not_company",
  wrongType: "wrong_type",
  wrongAsset: "wrong_asset",
  passingMention: "passing_mention",
  promotional: "promotional",
  other: "other",
} as const;
export type ClassificationWrongReason =
  (typeof ClassificationWrongReason)[keyof typeof ClassificationWrongReason];
export const CLASSIFICATION_WRONG_REASONS = Object.values(ClassificationWrongReason) as [
  ClassificationWrongReason,
  ...ClassificationWrongReason[],
];

/** Ghi chú tuỳ chọn của nhãn: tối đa ngần này ký tự. */
export const LABEL_NOTE_MAX = 500;

/** Cổng: classifier qua khi có ≥ 50 bài đã gắn nhãn và precision ≥ 80% (DEC-328 mục 2). */
export const CLASSIFIER_GATE = { minLabels: 50, minPrecisionPct: 80 } as const;

/**
 * Trạng thái cổng của một classifier: `passed`; `underPrecision` (đã có nhãn và precision < 80%, kể cả khi chưa đủ 50);
 * `needsLabels` (precision ≥ 80% hoặc chưa có nhãn, nhưng < 50 nhãn); `unknown` (lệnh không biết classifier nào tạo ra).
 */
export const ClassifierGateStatus = {
  passed: "passed",
  needsLabels: "needsLabels",
  underPrecision: "underPrecision",
  unknown: "unknown",
} as const;
export type ClassifierGateStatus = (typeof ClassifierGateStatus)[keyof typeof ClassifierGateStatus];
export const CLASSIFIER_GATE_STATUSES = Object.values(ClassifierGateStatus) as [
  ClassifierGateStatus,
  ...ClassifierGateStatus[],
];

/**
 * Kết luận của MỘT bài khi nhiều người gắn nhãn: đa số; hoà tính là Wrong (bảo thủ: cổng chỉ mở khi đa số đồng ý là
 * đúng). Không có nhãn nào → null (bài chưa được gắn nhãn).
 */
export function articleVerdict(votes: {
  right: number;
  wrong: number;
}): ClassificationVerdict | null {
  if (votes.right + votes.wrong === 0) return null;
  return votes.right > votes.wrong ? "right" : "wrong";
}

/**
 * Khoảng tin cậy Wilson (mặc định 95%, z = 1.96) của tỉ lệ `right / n`, theo đơn vị % (0–100). n = 0 → null. Ở 40 / 50
 * khoảng là ≈ 67.0–88.8% (khoảng xấp xỉ chuẩn ±11% của thiết kế, "69% to 91%", là cùng ý: 50 nhãn chỉ là mức sàn).
 */
export function wilsonInterval(
  right: number,
  n: number,
  z = 1.96,
): { lo: number; hi: number } | null {
  if (!Number.isInteger(right) || !Number.isInteger(n) || n <= 0 || right < 0 || right > n)
    return null;
  const p = right / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const round = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 10_000) / 100;
  return { lo: round(center - half), hi: round(center + half) };
}

export interface ClassifierGate {
  labeled: number;
  right: number;
  /** % (0–100), 2 chữ số thập phân; null khi chưa có nhãn. */
  precisionPct: number | null;
  interval: { lo: number; hi: number } | null;
  passes: boolean;
  status: Exclude<ClassifierGateStatus, "unknown">;
  /** Số nhãn còn thiếu để đủ 50 (0 khi đã đủ). */
  labelsToGo: number;
}

/**
 * Cổng của một classifier từ số bài đã gắn nhãn và số bài kết luận Right. So sánh bằng số nguyên (right × 100 ≥ 80 × n)
 * để 79.9% không bao giờ được làm tròn thành 80%.
 */
export function classifierGate(input: { labeled: number; right: number }): ClassifierGate {
  const { labeled, right } = input;
  const enough = labeled >= CLASSIFIER_GATE.minLabels;
  const precise = labeled > 0 && right * 100 >= CLASSIFIER_GATE.minPrecisionPct * labeled;
  const passes = enough && precise;
  return {
    labeled,
    right,
    precisionPct: labeled === 0 ? null : Math.round((right / labeled) * 10_000) / 100,
    interval: wilsonInterval(right, labeled),
    passes,
    status: passes ? "passed" : labeled > 0 && !precise ? "underPrecision" : "needsLabels",
    labelsToGo: Math.max(0, CLASSIFIER_GATE.minLabels - labeled),
  };
}

/** Lý do sai hay gặp nhất (đếm theo nhãn Wrong), nhiều trước; hoà thì theo thứ tự của thiết kế. Bỏ lý do 0 lần. */
export function commonMistakes(
  counts: ReadonlyMap<ClassificationWrongReason, number>,
): { reason: ClassificationWrongReason; n: number }[] {
  return CLASSIFICATION_WRONG_REASONS.flatMap((reason) => {
    const n = counts.get(reason) ?? 0;
    return n > 0 ? [{ reason, n }] : [];
  }).sort(
    (a, b) =>
      b.n - a.n ||
      CLASSIFICATION_WRONG_REASONS.indexOf(a.reason) -
        CLASSIFICATION_WRONG_REASONS.indexOf(b.reason),
  );
}
