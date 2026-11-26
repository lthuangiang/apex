import { createHash } from "node:crypto";

// #558 (DEC-398): logic thuần của job báo box mới SoDEX rewards: dòng ledger nào mới so với mốc "đã thấy", phân loại
// CHỈ theo trường SoDEX trả (`kind`, `direction`, `reason`), mốc mới, chu kỳ và lùi. Không I/O, không suy đoán.

export interface LedgerItem {
  kind: string;
  tsMs: number;
  tokenId?: number | null | undefined;
  level?: string | null | undefined;
  direction?: string | null | undefined;
  reason?: string | null | undefined;
  round?: number | null | undefined;
}

export interface LedgerMark {
  tsMs: number;
  /** Khoá các dòng có đúng `tsMs` của mốc (nhiều dòng cùng mili giây). */
  ids: readonly string[];
}

/** Khoá ổn định của một dòng ledger (không có txHash hay địa chỉ). */
export const ledgerItemKey = (i: LedgerItem): string =>
  `${i.kind}:${i.tokenId == null ? "" : String(i.tokenId)}:${String(i.tsMs)}`;

const isNew = (i: LedgerItem, mark: LedgerMark) =>
  i.tsMs > mark.tsMs || (i.tsMs === mark.tsMs && !mark.ids.includes(ledgerItemKey(i)));

/**
 * Dòng mới hơn mốc trong một trang (ledger trả mới nhất trước). `reachedMark` = trang đã chạm tới dòng cũ (không cần đọc
 * trang sau).
 */
export function freshItems(
  items: readonly LedgerItem[],
  mark: LedgerMark,
): { fresh: LedgerItem[]; reachedMark: boolean } {
  const fresh = items.filter((i) => isNew(i, mark));
  return { fresh, reachedMark: fresh.length < items.length };
}

/** Mốc sau khi đã xử lý `seen` (dòng mới), giữ mốc cũ nếu không có gì mới hơn. */
export function nextMark(mark: LedgerMark, seen: readonly LedgerItem[]): LedgerMark {
  const max = seen.reduce((m, i) => Math.max(m, i.tsMs), mark.tsMs);
  const atMax = seen.filter((i) => i.tsMs === max).map(ledgerItemKey);
  const ids = max === mark.tsMs ? [...new Set([...mark.ids, ...atMax])] : [...new Set(atMax)];
  return { tsMs: max, ids };
}

/** Lượt đầu (baseline): mốc = dòng mới nhất hiện có, hoặc giờ hiện tại khi ledger rỗng; không báo gì. */
export function baselineMark(items: readonly LedgerItem[], nowMs: number): LedgerMark {
  if (items.length === 0) return { tsMs: nowMs, ids: [] };
  return nextMark({ tsMs: Number.MIN_SAFE_INTEGER, ids: [] }, items);
}

export const LOTTERY_PRIZE = "lottery_prize";
const isIncoming = (i: LedgerItem) => i.kind === "transfer" && i.direction === "in";

/** Box nhận được (transfer vào, KHÔNG phải giải quay số). */
export function receivedItems(items: readonly LedgerItem[]): LedgerItem[] {
  return items.filter((i) => isIncoming(i) && i.reason !== LOTTERY_PRIZE);
}

/** Box thưởng quay số (`reason: lottery_prize`), gộp theo `round` (thiếu round thì nhóm `null`), giữ thứ tự gặp. */
export function prizesByRound(items: readonly LedgerItem[]): Map<number | null, LedgerItem[]> {
  const out = new Map<number | null, LedgerItem[]>();
  for (const i of items) {
    if (!isIncoming(i) || i.reason !== LOTTERY_PRIZE) continue;
    const round = typeof i.round === "number" ? i.round : null;
    out.set(round, [...(out.get(round) ?? []), i]);
  }
  return out;
}

/** Các round thưởng quay số có trong danh sách (baseline: coi là đã thấy). */
export function prizeRounds(items: readonly LedgerItem[]): number[] {
  return [...prizesByRound(items).keys()].filter((r): r is number => r !== null);
}

/** Số box theo cấp, đúng chuỗi SoDEX trả; giữ thứ tự gặp. */
export function levelCounts(
  items: readonly LedgerItem[],
): { level: string | null; count: number }[] {
  const out = new Map<string | null, number>();
  for (const i of items) {
    const level = typeof i.level === "string" && i.level !== "" ? i.level : null;
    out.set(level, (out.get(level) ?? 0) + 1);
  }
  return [...out].map(([level, count]) => ({ level, count }));
}

export const MAX_DRAW_ROUNDS_KEPT = 20;

/** Thêm round vào danh sách đã báo, giữ 20 round mới nhất. */
export function rememberRounds(seen: readonly number[], add: readonly number[]): number[] {
  return [...new Set([...seen, ...add])].sort((a, b) => a - b).slice(-MAX_DRAW_ROUNDS_KEPT);
}

/** Dàn đều: lệch ±10% chu kỳ theo userId (tất định), để user không dồn cùng một giây. */
export function nextCheckAt(now: Date, intervalMs: number, userId: string): Date {
  const h = createHash("sha256").update(userId).digest().readUInt32BE(0) / 0xffffffff;
  return new Date(now.getTime() + Math.round(intervalMs * (0.9 + 0.2 * h)));
}

export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Lùi sau lỗi thứ `errors` liên tiếp (1, 2, …): chu kỳ × 2^errors, tối đa 6 giờ. Không đọc lại ngay trong lượt. */
export function backoffMs(intervalMs: number, errors: number): number {
  return Math.min(intervalMs * 2 ** Math.min(errors, 20), MAX_BACKOFF_MS);
}
