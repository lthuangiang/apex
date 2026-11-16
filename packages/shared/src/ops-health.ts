import { quantile } from "./api/market-hours";
import { dec, Decimal } from "./money";

// Nhãn sức khoẻ của trang Bot Monitor (docs/mockups/ops, quyết định 2–3; DEC-288). Hàm thuần, so sánh
// bằng decimal. Ngưỡng ghi "proposal" trên canvas dùng làm mức ban đầu.

export const OPS_RULES = {
  /** Requests / min trên mức này → Check (brief của người dùng; chưa có trong docs). */
  requestsPerMinute: 55,
  /** Khoảng báo giá dài nhất (giây) trên mức này → Check (proposal). */
  gapCheckSec: 60,
  /** Market Making: trên mức này → Problem (proposal, 5 phút). */
  gapProblemSec: 300,
  /** Số lần Position cut trong 1 giờ từ mức này → Check (proposal). */
  cutsPerHour: 2,
  /** Cost / $1M (24h) trên bội số này của trung vị cùng chiến lược → Check (proposal). */
  costMedianMultiple: 2,
  /** Cần ít nhất chừng này bot có volume thì mới áp quy tắc trung vị. */
  costMedianMinBots: 3,
  /** Active: bot stopped / archived có mốc dừng trong chừng này ngày. */
  activeStopDays: 7,
  /** All bots: số bot mỗi trang. */
  pageSize: 50,
} as const;

export const OPS_HEALTH = ["problem", "check", "healthy", "not_running", "archived"] as const;
export type OpsHealth = (typeof OPS_HEALTH)[number];

export const OPS_REASON_CODES = [
  "alert_active",
  "rejected_pause",
  "gap_problem",
  "alert_resolved",
  "requests_high",
  "gap_long",
  "cuts_hour",
  "untracked",
  "rejects",
  "cost_high",
  "stale_candles",
] as const;
export type OpsReasonCode = (typeof OPS_REASON_CODES)[number];

/** Một lý do của nhãn. Mốc thời gian là ISO; trang đổi sang giờ của trình duyệt. */
export interface OpsReason {
  code: OpsReasonCode;
  invariant?: string | undefined;
  detail?: string | undefined;
  /** Số (decimal string): requests / min, giây, cost. */
  value?: string | undefined;
  median?: string | undefined;
  count?: number | undefined;
  at?: string | null | undefined;
  until?: string | undefined;
}

export interface OpsHealthInput {
  strategy: string;
  state: string;
  reasonCode: string | null;
  /** Bất biến đang sai (dòng mới nhất của (bot, bất biến) là failing). */
  activeAlerts: readonly { invariant: string; since: string; detail: string }[];
  /** Bất biến đã hết sai trong 24 giờ (mới nhất), nếu có. */
  resolvedAlert: { invariant: string; failedAt: string | null; resolvedAt: string } | null;
  requestsPerMinute: string | null;
  maxQuoteGapSec: string | null;
  positionCutsHour: number;
  untracked: { count: number; at: string | null };
  marketRejects: { count: number; at: string | null };
  /** Mốc dòng "Market entries rejected" gần nhất (24 giờ). */
  rejectedPauseAt: string | null;
  costPerMillion: string | null;
  /** Trung vị Cost / $1M (24h) của chiến lược; null khi chưa đủ bot. */
  costMedian: string | null;
  /** "STALE_CANDLES" trong 1 giờ qua (mốc gần nhất). */
  staleCandlesAt: string | null;
}

const MM = "volume_maker";

/** Problem → Check → Healthy; bot stopped / archived là Not running / Archived trừ khi còn cảnh báo đang mở. */
export function opsHealth(i: OpsHealthInput): { health: OpsHealth; reasons: OpsReason[] } {
  const problem: OpsReason[] = i.activeAlerts.map((a) => ({
    code: "alert_active",
    invariant: a.invariant,
    at: a.since,
    detail: a.detail,
  }));
  const resting = i.state === "stopped" || i.state === "archived";
  if (resting) {
    if (problem.length > 0) return { health: "problem", reasons: problem };
    return { health: i.state === "archived" ? "archived" : "not_running", reasons: [] };
  }
  if (i.state === "paused" && i.reasonCode === "ORDER_REJECTED")
    problem.push({ code: "rejected_pause", at: i.rejectedPauseAt });
  const gap = i.maxQuoteGapSec === null ? null : dec(i.maxQuoteGapSec);
  const gapProblem = i.strategy === MM && (gap?.gt(OPS_RULES.gapProblemSec) ?? false);
  if (gapProblem) problem.push({ code: "gap_problem", value: i.maxQuoteGapSec ?? undefined });

  const check: OpsReason[] = [];
  if (i.resolvedAlert !== null)
    check.push({
      code: "alert_resolved",
      invariant: i.resolvedAlert.invariant,
      at: i.resolvedAlert.failedAt,
      until: i.resolvedAlert.resolvedAt,
    });
  if (i.requestsPerMinute !== null && dec(i.requestsPerMinute).gt(OPS_RULES.requestsPerMinute))
    check.push({ code: "requests_high", value: i.requestsPerMinute });
  if (gap !== null && gap.gt(OPS_RULES.gapCheckSec) && !gapProblem)
    check.push({ code: "gap_long", value: i.maxQuoteGapSec ?? undefined });
  if (i.positionCutsHour >= OPS_RULES.cutsPerHour)
    check.push({ code: "cuts_hour", count: i.positionCutsHour });
  if (i.untracked.count > 0)
    check.push({ code: "untracked", count: i.untracked.count, at: i.untracked.at });
  if (i.marketRejects.count > 0 && !(i.state === "paused" && i.reasonCode === "ORDER_REJECTED"))
    check.push({ code: "rejects", count: i.marketRejects.count, at: i.marketRejects.at });
  if (
    i.costPerMillion !== null &&
    i.costMedian !== null &&
    dec(i.costPerMillion).gt(dec(i.costMedian).mul(OPS_RULES.costMedianMultiple))
  )
    check.push({ code: "cost_high", value: i.costPerMillion, median: i.costMedian });
  if (i.staleCandlesAt !== null) check.push({ code: "stale_candles", at: i.staleCandlesAt });

  if (problem.length > 0) return { health: "problem", reasons: [...problem, ...check] };
  if (check.length > 0) return { health: "check", reasons: check };
  return { health: "healthy", reasons: [] };
}

/** Trung vị Cost / $1M của các bot có số; ít hơn `costMedianMinBots` bot thì không áp quy tắc (null). */
export function opsCostMedian(costs: readonly (string | null)[]): string | null {
  const xs = costs.filter((c): c is string => c !== null).map((c) => dec(c));
  if (xs.length < OPS_RULES.costMedianMinBots) return null;
  return quantile(xs, 0.5)?.toDecimalPlaces(2).toString() ?? null;
}

/** Thứ tự: Problem → Check → Healthy → Not running → Archived; trong mỗi nhóm volume 1 giờ giảm dần (thiếu → cuối). */
export function sortOpsRows<T extends { health: OpsHealth; volumeHour: string | null }>(
  rows: readonly T[],
): T[] {
  const rank = (h: OpsHealth) => OPS_HEALTH.indexOf(h);
  const vol = (r: T) => (r.volumeHour === null ? new Decimal(-1) : dec(r.volumeHour));
  return [...rows].sort((a, b) => rank(a.health) - rank(b.health) || vol(b).cmp(vol(a)));
}
