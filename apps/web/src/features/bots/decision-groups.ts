import { NORMAL_REJECT_CODES, type BotDetail, type DecisionOutcome } from "@drift/shared";

// BD-02 (docs/mockups/bd02-decisions, quy tắc chốt khi review): gộp các quyết định lặp lại liên tiếp của Trading Agent.
// - Chỉ gộp "Bid pulled", "Ask pulled" (mỗi phía riêng) và "Quote skipped": cùng tên event thật, liên tiếp, mỗi cái cách
//   cái trước ≤ 60 s.
// - Không bao giờ gộp mọi tên khác (Order filled, Position cut, Stopped, Paused / Resumed, Smart quoting…, Order requests,
//   cảnh báo chi phí, lỗi) và mọi quyết định có kết quả Unknown hoặc Rejected.
// Volume Farm (DEC-TBD-vb-decisions-grouping): các lần thử vào lệnh liên tiếp của CÙNG một lượt ("Enter long" / "Enter
// short", lệnh `vf:<n>:in:<k>`, DEC-300) gộp thành một dòng; xem `entryTryOf`.

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
  | { kind: "group"; key: string; name: string; events: readonly BotEvent[] }
  /**
   * Các lần thử vào lệnh liên tiếp của một lượt Volume Farm, cùng một phía, mới nhất trước (ít nhất 2). `name` = quyết
   * định chung ("Enter long" / "Enter short"); tín hiệu đổi phía giữa các lần thử thì bắt đầu dòng mới (review #215 B1).
   */
  | { kind: "entry"; key: string; name: string; events: readonly BotEvent[] };

const ENTRY_DECISION = /^Enter (long|short)$/;

/**
 * Số thứ tự lần thử (0 = lần đầu của lượt) khi event gộp được vào một lượt vào lệnh; null thì là dòng riêng. Chỉ lần thử có
 * kết quả thật: không gộp Unknown (quy tắc 1.7 / 1.8) và không gộp lệnh bị từ chối vì lý do khác post-only (lỗi cần thấy).
 * Event cũ chưa có `entryTry` không gộp (không đoán lượt).
 */
export function entryTryOf(e: BotEvent): number | null {
  if (e.decision === null || !ENTRY_DECISION.test(e.decision) || e.entryTry === null) return null;
  if (e.outcome === null || e.outcome === "unknown") return null;
  if (e.outcome === "rejected" && e.rejectCode !== NORMAL_REJECT_CODES.postOnly) return null;
  return e.entryTry;
}

function groupable(e: BotEvent): boolean {
  return (
    e.decision !== null &&
    GROUPABLE_DECISIONS.has(e.decision) &&
    e.outcome !== "unknown" &&
    e.outcome !== "rejected"
  );
}

/**
 * `events` theo thứ tự mới nhất trước (như API trả). Giữ nguyên thứ tự. Lượt vào lệnh: event cũ hơn nối vào nhóm khi nó là
 * lần thử NGAY TRƯỚC (số thứ tự nhỏ hơn đúng 1) và CÙNG phía (cùng tên quyết định); lần thử 0 là lần đầu của lượt nên nhóm
 * dừng ở đó. Không có giới hạn 60 s (một lượt có thể thử nhiều phút); event khác xen giữa thì tách nhóm như BD-02.
 * Trạng thái mở / đóng theo event cũ nhất: nhóm ở cuối danh sách tự đóng khi lần thử cũ nhất rơi ra ngoài 50 event gần nhất.
 */
export function groupDecisions(events: readonly BotEvent[]): DecisionRow[] {
  const rows: DecisionRow[] = [];
  let run: BotEvent[] = [];
  let entry = false;
  const flush = () => {
    const [first] = run;
    const oldest = run.at(-1);
    if (first === undefined || oldest === undefined) return;
    // Khoá theo event CŨ NHẤT của nhóm: event mới vào đầu nhóm sau mỗi lần poll không đổi khoá, nên nhóm đang mở vẫn mở.
    if (run.length === 1) rows.push({ kind: "single", event: first });
    else
      rows.push({
        kind: entry ? "entry" : "group",
        key: oldest.id,
        name: first.decision ?? "",
        events: run,
      });
    run = [];
  };
  for (const e of events) {
    const prev = run.at(-1);
    const step = entryTryOf(e);
    const prevStep = prev === undefined ? null : entryTryOf(prev);
    const joins =
      prev !== undefined &&
      (entry
        ? step !== null &&
          prevStep !== null &&
          step === prevStep - 1 &&
          e.decision === prev.decision
        : groupable(e) &&
          e.decision === prev.decision &&
          Date.parse(prev.occurredAt) - Date.parse(e.occurredAt) <= GROUP_GAP_MS);
    if (!joins) flush();
    if (run.length === 0) entry = step !== null;
    if (step !== null || groupable(e)) run.push(e);
    else rows.push({ kind: "single", event: e });
  }
  flush();
  return rows;
}

/** Thời gian của một lượt vào lệnh (lần thử đầu → lần thử mới nhất) để hiện "{n} tries in {duration}". */
export function entryDuration(
  events: readonly BotEvent[],
):
  | { unit: "seconds"; n: number }
  | { unit: "minutes"; n: number }
  | { unit: "hours"; h: number; m: number } {
  const newest = events[0]?.occurredAt;
  const oldest = events.at(-1)?.occurredAt;
  const ms =
    newest === undefined || oldest === undefined
      ? 0
      : Math.max(0, Date.parse(newest) - Date.parse(oldest));
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return { unit: "seconds", n: Math.max(1, seconds) };
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return { unit: "minutes", n: minutes };
  return { unit: "hours", h: Math.floor(minutes / 60), m: minutes % 60 };
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

// Tên quyết định mà engine và các chiến lược ghi (packages/strategies, apps/engine). Banner của Orders chỉ ghi lại
// `decision` lấy từ URL khi nó là một trong các tên này, để link tự soạn không đặt được câu chữ tuỳ ý lên trang.
const KNOWN_DECISIONS: ReadonlySet<string> = new Set([
  "AI DCA stopped",
  "Ask pulled",
  "Bid pulled",
  "Binance pricing",
  "Builder fee changed",
  "Buy skipped",
  "Catch up",
  "Close orders sent post-only",
  "Closing at the best price",
  "Closing both legs",
  "Continue",
  "Copy",
  "Copy stopped",
  "Cost at 80% of budget",
  "Cycle not started",
  "Entered",
  "Exit",
  "Grid not started",
  "Grid resumed",
  "Grid started",
  "Hard stop",
  "Holding",
  "Initial allocation",
  "Leg rejected",
  "Market entries rejected",
  "Not entering",
  "Order requests",
  "Paused",
  "Position cut",
  "Position re-synced from SoDEX",
  "Price back in range",
  "Price left the grid range",
  "Quote skipped",
  "Quotes paused on a fast move",
  "Quoting again after a fast move",
  "Rebalanced",
  "Reduce",
  "Running",
  "Skipped",
  "Skipped entry",
  "Smart quoting adjusted",
  "Smart quoting back to normal",
  "Stop loss on SoDEX not set",
  "Stop loss set on SoDEX",
  "Stopped",
  "Stopping",
  "TWAP finished",
  "Volume Farm stopped",
  "Volume Maker stopped",
  "Waiting",
]);
/** Tên có số hoặc phía (`Bought at level 3`, `Cycle 2 started`, `Order filled`…). */
const KNOWN_DECISION_PATTERNS: readonly RegExp[] = [
  /^(Bought|Sold) at level \d+$/,
  /^Buy \d+ filled$/,
  /^(Closed|Enter) (long|short)$/,
  /^Cycle \d+ (started|not started|resumed|took profit|closed)$/,
  /^(Extra|Safety) order \d+ filled$/,
  /^Initial buy \d+ of \d+$/,
  /^Order (open|partially_filled|filled|cancelled|rejected|unknown|not_placed)$/,
  /^Slice \d+ skipped$/,
];

export function isKnownDecision(name: string): boolean {
  return KNOWN_DECISIONS.has(name) || KNOWN_DECISION_PATTERNS.some((p) => p.test(name));
}

/** Thời điểm ISO 8601 có ngày giờ (như `occurredAt` API trả); không hợp lệ → null. */
export function validIsoTime(v: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.test(v))
    return null;
  return Number.isNaN(Date.parse(v)) ? null : v;
}

/** Đuôi clOrdID để đọc: "…3e9-0". */
export function orderTail(clOrdId: string): string {
  return clOrdId.slice(-5);
}
