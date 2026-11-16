import type { BotDetail, DecisionOutcome } from "@drift/shared";

// BD-02 (docs/mockups/bd02-decisions, quy tắc chốt khi review): gộp các quyết định lặp lại liên tiếp của Trading Agent.
// - Chỉ gộp "Bid pulled", "Ask pulled" (mỗi phía riêng) và "Quote skipped": cùng tên event thật, liên tiếp, mỗi cái cách
//   cái trước ≤ 60 s.
// - Không bao giờ gộp mọi tên khác (Order filled, Position cut, Stopped, Paused / Resumed, Smart quoting…, Order requests,
//   cảnh báo chi phí, lỗi) và mọi quyết định có kết quả Unknown hoặc Rejected.

export type BotEvent = BotDetail["events"][number];

export const GROUPABLE_DECISIONS: ReadonlySet<string> = new Set([
  "Bid pulled",
  "Ask pulled",
  "Quote skipped",
]);
export const GROUP_GAP_MS = 60_000;

export type DecisionRow =
  | { kind: "single"; event: BotEvent }
  /** `events` mới nhất trước, như danh sách gốc; có ít nhất 2 phần tử. */
  | { kind: "group"; key: string; name: string; events: readonly BotEvent[] };

function groupable(e: BotEvent): boolean {
  return (
    e.decision !== null &&
    GROUPABLE_DECISIONS.has(e.decision) &&
    e.outcome !== "unknown" &&
    e.outcome !== "rejected"
  );
}

/** `events` theo thứ tự mới nhất trước (như API trả). Giữ nguyên thứ tự. */
export function groupDecisions(events: readonly BotEvent[]): DecisionRow[] {
  const rows: DecisionRow[] = [];
  let run: BotEvent[] = [];
  const flush = () => {
    const [first] = run;
    if (first === undefined) return;
    if (run.length === 1) rows.push({ kind: "single", event: first });
    else rows.push({ kind: "group", key: first.id, name: first.decision ?? "", events: run });
    run = [];
  };
  for (const e of events) {
    const prev = run.at(-1);
    const joins =
      prev !== undefined &&
      groupable(e) &&
      e.decision === prev.decision &&
      Date.parse(prev.occurredAt) - Date.parse(e.occurredAt) <= GROUP_GAP_MS;
    if (!joins) flush();
    if (groupable(e)) run.push(e);
    else rows.push({ kind: "single", event: e });
  }
  flush();
  return rows;
}

/** Thứ tự đếm trong pill tổng hợp của nhóm: xấu nhất trước. */
export const SUMMARY_ORDER: readonly DecisionOutcome[] = [
  "unknown",
  "rejected",
  "open",
  "partly_filled",
  "filled",
  "cancelled",
  "not_placed",
];

export function groupSummary(
  events: readonly BotEvent[],
): { outcome: DecisionOutcome; n: number }[] {
  return SUMMARY_ORDER.map((outcome) => ({
    outcome,
    n: events.filter((e) => e.outcome === outcome).length,
  })).filter((x) => x.n > 0);
}

/** Nhãn pill dùng lại `orders.status.*` (README quy tắc 5). */
export function outcomeStatusKey(
  o: DecisionOutcome,
): "open" | "partially_filled" | "filled" | "cancelled" | "rejected" | "unknown" | "not_placed" {
  return o === "partly_filled" ? "partially_filled" : o;
}

/** Link tới lệnh trong Execution & Orders: cuộn tới dòng, làm nổi bật; không có trên trang đang tải thì lọc. */
export function orderHref(botId: string, e: BotEvent, order: string): string {
  const q = new URLSearchParams({ botId, order });
  if (e.decision !== null) q.set("decision", e.decision);
  q.set("at", e.occurredAt);
  return `/orders?${q.toString()}`;
}

/** Đuôi clOrdID để đọc: "…3e9-0". */
export function orderTail(clOrdId: string): string {
  return clOrdId.slice(-5);
}
