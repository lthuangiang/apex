import { createHash } from "node:crypto";

import {
  WEALTH_EXECUTION_ALERT_STATUSES,
  WEALTH_EXECUTION_QUIET_STATUSES,
  WEALTH_EXECUTION_REASONS,
  WEALTH_FUND_FINAL_STATUSES,
  WEALTH_FUND_OPEN_STATUSES,
  WEALTH_KIND_TO_WHAT,
  type WealthAlertWhat,
  type WealthExecutionAlertStatus,
  type WealthFundDetails,
  type WealthFundFinalStatus,
  type WealthRecurringExecutions,
} from "@drift/shared";

// #594 (DEC-404): logic thuần của job cảnh báo SoDEX Wealth: khoá chống trùng, dòng nào vừa chuyển sang trạng thái cần
// báo, mốc mới. Phân loại CHỈ theo giá trị tài liệu SoDEX liệt kê (`@drift/shared` `WEALTH_*`); giá trị lạ không báo, chỉ
// trả về để người gọi log (mục 3b). Không I/O. Khoá đã băm: DB không giữ số tiền hay thời điểm của dòng.

export type FundEntry = WealthFundDetails["entries"][number];
export type Execution = WealthRecurringExecutions["executions"][number];

/** Số khoá tối đa giữ cho fund-details (mới nhất trước) và số kỳ mua đọc mỗi plan. */
export const MAX_FUND_MARKS = 1000;
export const EXECUTIONS_PER_PLAN = 30;

const hash = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n);

/**
 * Khoá ổn định của một dòng fund-details. Có `entryId` thì dùng; không có (mục 3a) thì dựng từ
 * `fundId + kind + requestedAt + requestedShares (thiếu thì cost) + planIndex`. Trả 24 ký tự hex.
 */
export function fundEntryKey(e: FundEntry): string {
  if (e.entryId !== null) return hash(`id|${e.entryId}`, 24);
  const parts = [
    e.fundId,
    e.kind,
    e.requestedAt ?? "",
    e.requestedShares ?? e.cost ?? "",
    e.planIndex ?? "",
  ];
  return hash(`k|${parts.join("|")}`, 24);
}

/** Loại yêu cầu được báo: theo `transactionType`, rồi `source = recurring_buy`, rồi `kind`. Không báo → null. */
export function whatOf(e: FundEntry): WealthAlertWhat | null {
  return (
    WEALTH_KIND_TO_WHAT[e.transactionType ?? ""] ??
    (e.source === "recurring_buy" ? "recurring_buy" : undefined) ??
    WEALTH_KIND_TO_WHAT[e.kind] ??
    null
  );
}

const isFinal = (s: string): s is WealthFundFinalStatus =>
  (WEALTH_FUND_FINAL_STATUSES as readonly string[]).includes(s);
const isOpen = (s: string) => (WEALTH_FUND_OPEN_STATUSES as readonly string[]).includes(s);

export interface FundNotice {
  key: string;
  entry: FundEntry;
  what: WealthAlertWhat;
  status: WealthFundFinalStatus;
}

export interface UnknownValue {
  field: "fund_status" | "exec_status" | "exec_reason";
  value: string;
}

/**
 * So các dòng fund-details với mốc. Dòng được báo khi trạng thái là trạng thái kết thúc và khác trạng thái đã thấy (kể
 * cả dòng mới xuất hiện đã kết thúc). `baseline`: chỉ ghi mốc, không báo. Mốc mới chỉ giữ khoá của dòng còn trong response.
 */
export function classifyFundEntries(
  entries: readonly FundEntry[],
  marks: Readonly<Record<string, string>>,
  baseline: boolean,
): { notices: FundNotice[]; marks: Record<string, string>; unknown: UnknownValue[] } {
  const next: Record<string, string> = {};
  const notices: FundNotice[] = [];
  const unknown: UnknownValue[] = [];
  for (const entry of entries) {
    if (Object.keys(next).length >= MAX_FUND_MARKS) break;
    const what = whatOf(entry);
    if (what === null) continue;
    const key = fundEntryKey(entry);
    if (key in next) continue;
    const status = entry.status;
    next[key] = status;
    if (isFinal(status)) {
      if (!baseline && marks[key] !== status) notices.push({ key, entry, what, status });
    } else if (!isOpen(status)) {
      unknown.push({ field: "fund_status", value: status });
    }
  }
  return { notices, marks: next, unknown };
}

/** Mốc "đã thấy plan" (plan mới gặp lần đầu chỉ đặt mốc). */
export const planMarkKey = (planIndex: string) => `${planIndex}:plan`;

/** Khoá một kỳ mua: `planIndex:` + băm(dcaAddress + ngày lịch). Retry trong ngày nằm trên cùng dòng (tài liệu SoDEX). */
export function executionKey(planIndex: string, dcaAddress: string | null, date: string): string {
  return `${planIndex}:${hash(`${(dcaAddress ?? "").toLowerCase()}|${date}`, 16)}`;
}

export interface ExecutionNotice {
  key: string;
  execution: Execution;
  status: WealthExecutionAlertStatus;
  reasonCode: string | null;
}

/**
 * So các kỳ mua của một plan ACTIVE với mốc. Báo khi `status` thuộc danh sách báo, khác trạng thái đã thấy, và
 * `reasonCode` trống hoặc đã biết. `status` / `reasonCode` lạ: không báo, trả về `unknown` (mục 3b). Plan chưa từng
 * thấy, hoặc `baseline`: chỉ ghi mốc. Trả mốc của plan này (người gọi gộp).
 */
export function classifyExecutions(
  planIndex: string,
  dcaAddress: string | null,
  executions: readonly Execution[],
  marks: Readonly<Record<string, string>>,
  baseline: boolean,
): { notices: ExecutionNotice[]; marks: Record<string, string>; unknown: UnknownValue[] } {
  const planKey = planMarkKey(planIndex);
  const quiet = baseline || !(planKey in marks);
  const next: Record<string, string> = { [planKey]: "seen" };
  const notices: ExecutionNotice[] = [];
  const unknown: UnknownValue[] = [];
  for (const execution of executions.slice(0, EXECUTIONS_PER_PLAN)) {
    const key = executionKey(planIndex, dcaAddress, execution.scheduledLocalDate);
    if (key in next) continue;
    const status = execution.status.toLowerCase();
    next[key] = status;
    const alert = (WEALTH_EXECUTION_ALERT_STATUSES as readonly string[]).includes(status);
    if (!alert) {
      if (!(WEALTH_EXECUTION_QUIET_STATUSES as readonly string[]).includes(status))
        unknown.push({ field: "exec_status", value: execution.status });
      continue;
    }
    const reason = execution.reasonCode;
    if (reason !== null && !(reason in WEALTH_EXECUTION_REASONS)) {
      unknown.push({ field: "exec_reason", value: reason });
      continue;
    }
    if (!quiet && marks[key] !== status)
      notices.push({
        key,
        execution,
        status: status as WealthExecutionAlertStatus,
        reasonCode: reason,
      });
  }
  return { notices, marks: next, unknown };
}

/** User chưa có plan thì đọc lại `recurring-buys` tối đa mỗi ngày một lần. */
export const PLANS_RECHECK_MS = 24 * 60 * 60 * 1000;

/**
 * Có cần đọc `recurring-buys` lượt này không (DEC-404 mục 6: chỉ khi user từng có plan). Từng có = lần đọc trước thấy
 * plan, hoặc fund-details có dòng mua định kỳ; chưa từng đọc / đọc đã quá một ngày thì đọc lại để phát hiện plan mới.
 */
export function shouldReadPlans(
  hasPlans: boolean,
  entries: readonly FundEntry[],
  plansCheckedAt: Date | null,
  nowMs: number,
): boolean {
  if (hasPlans) return true;
  if (entries.some((e) => e.planIndex !== null || whatOf(e) === "recurring_buy")) return true;
  return plansCheckedAt === null || nowMs - plansCheckedAt.getTime() >= PLANS_RECHECK_MS;
}
