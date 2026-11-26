import type { LotteryLedgerItem, lotteryDrawEntriesSchema } from "@drift/shared";
import type { z } from "zod";

type LotteryDrawEntries = z.infer<typeof lotteryDrawEntriesSchema>;

// Popup box mới nhận / vé trúng (#556, bản phác docs/mockups/rewards/received/, người dùng duyệt 2026-11-26). Logic thuần.
// Phân loại CHỈ theo `reason` của ledger (không suy đoán): transfer vào có `reason: lottery_prize` → phần vé trúng (gộp
// theo `round`); transfer vào khác (kể cả reason lạ) → phần "Received". Số box lấy từ ledger, số vé trúng lấy từ `wins`
// của `draw/entries`; không ghép vé với box (API không nối). Mốc "đã xem" ở localStorage theo ví (không nhạy cảm, không
// gửi server).

export const SEEN_PREFIX = "desklabs.rewards.seen.";

export interface Seen {
  /** `tsMs` lớn nhất của dòng ledger đã báo. */
  ledgerTsMs: number;
  /** Các round Weekly draw đã báo kết quả. */
  drawRounds: number[];
}

/** Kết quả Weekly draw dùng cho popup (từ `draw/entries` khi đã có kết quả). */
export interface DrawResult {
  round: number;
  status: string;
  wins: number;
  tickets: number | null;
  won: { tokenId: number; level: string; prizeLevel: string | null }[];
}

export interface ReceivedEvents {
  /** Box nhận (transfer vào, reason khác lottery_prize), mới nhất trước. */
  received: LotteryLedgerItem[];
  /** Box thưởng quay số theo round (round giảm dần). */
  prizes: { round: number | null; items: LotteryLedgerItem[] }[];
  /** Kết quả vòng chưa báo (wins > 0). */
  draw: DrawResult | null;
}

export const emptyEvents = (e: ReceivedEvents): boolean =>
  e.received.length === 0 && e.prizes.length === 0 && e.draw === null;

const keyOf = (address: string) => `${SEEN_PREFIX}${address.toLowerCase()}`;

const listeners = new Set<() => void>();

export function subscribeSeen(listener: () => void): () => void {
  listeners.add(listener);
  // Tab khác ghi mốc → tab này đọc lại (đóng popup nếu không còn gì mới).
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(SEEN_PREFIX)) listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

function parseSeen(raw: string | null): Seen | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (typeof v !== "object" || v === null) return null;
    const o = v as { ledgerTsMs?: unknown; drawRounds?: unknown };
    if (typeof o.ledgerTsMs !== "number" || !Array.isArray(o.drawRounds)) return null;
    return {
      ledgerTsMs: o.ledgerTsMs,
      drawRounds: o.drawRounds.filter((r): r is number => typeof r === "number"),
    };
  } catch {
    return null;
  }
}

/** Chuỗi thô của mốc (ổn định cho `useSyncExternalStore`); null = chưa có hoặc bị chặn. */
export function readSeenRaw(address: string | null): string | null {
  if (address === null) return null;
  try {
    return window.localStorage.getItem(keyOf(address));
  } catch {
    return null;
  }
}

export function readSeen(address: string | null): Seen | null {
  return parseSeen(readSeenRaw(address));
}

export function writeSeen(address: string, seen: Seen): void {
  try {
    window.localStorage.setItem(keyOf(address), JSON.stringify(seen));
  } catch {
    // Không lưu được (private window…): lần sau có thể báo lại, không mất dữ liệu.
  }
  for (const l of listeners) l();
}

const isTransferIn = (r: LotteryLedgerItem) => r.kind === "transfer" && r.direction !== "out";
const isPrize = (r: LotteryLedgerItem) => isTransferIn(r) && r.reason === "lottery_prize";

/** Kết quả vòng từ `draw/entries` (chỉ khi `wins` là số). */
export function drawResultOf(
  d:
    | Pick<LotteryDrawEntries, "round" | "status" | "wins" | "tickets" | "entries">
    | null
    | undefined,
): DrawResult | null {
  if (d == null || typeof d.wins !== "number") return null;
  return {
    round: d.round,
    status: d.status,
    wins: d.wins,
    tickets: d.tickets ?? null,
    won: (d.entries ?? [])
      .filter((e) => e.won === true)
      .map((e) => ({ tokenId: e.tokenId, level: e.level, prizeLevel: e.prizeLevel ?? null })),
  };
}

/**
 * Lần ký đầu trên trình duyệt (chưa có mốc): coi mọi thứ hiện có là đã xem, không báo lịch sử cũ. Ledger rỗng thì mốc =
 * giờ hiện tại.
 */
export function initialSeen(
  items: readonly LotteryLedgerItem[],
  draw: DrawResult | null,
  now: number,
): Seen {
  const max = items.reduce<number | null>((m, r) => (m === null || r.tsMs > m ? r.tsMs : m), null);
  return { ledgerTsMs: max ?? now, drawRounds: draw === null ? [] : [draw.round] };
}

/** Sự kiện chưa báo so với mốc. */
export function newEvents(
  items: readonly LotteryLedgerItem[],
  draw: DrawResult | null,
  seen: Seen,
): ReceivedEvents {
  const fresh = items.filter((r) => isTransferIn(r) && r.tsMs > seen.ledgerTsMs);
  const received = fresh.filter((r) => !isPrize(r)).sort((a, b) => b.tsMs - a.tsMs);
  const byRound = new Map<number | null, LotteryLedgerItem[]>();
  for (const r of fresh.filter(isPrize)) {
    const k = r.round ?? null;
    byRound.set(k, [...(byRound.get(k) ?? []), r]);
  }
  const prizes = [...byRound.entries()]
    .map(([round, list]) => ({ round, items: list.sort((a, b) => a.tsMs - b.tsMs) }))
    .sort((a, b) => (b.round ?? -1) - (a.round ?? -1));
  const d = draw !== null && draw.wins > 0 && !seen.drawRounds.includes(draw.round) ? draw : null;
  return { received, prizes, draw: d };
}

/** Mốc sau khi đóng popup: `tsMs` lớn nhất đã hiện và các round đã hiện. */
export function markSeen(seen: Seen, events: ReceivedEvents): Seen {
  const ts = [...events.received, ...events.prizes.flatMap((p) => p.items)].map((r) => r.tsMs);
  const rounds = new Set(seen.drawRounds);
  if (events.draw !== null) rounds.add(events.draw.round);
  for (const p of events.prizes) if (p.round !== null) rounds.add(p.round);
  return {
    ledgerTsMs: Math.max(seen.ledgerTsMs, ...ts),
    drawRounds: [...rounds].sort((a, b) => a - b),
  };
}

const LEVEL_ORDER = ["common", "uncommon", "rare", "superrare"];

/** Đếm box theo level, thứ tự Common → SuperRare, level lạ sau cùng. */
export function levelCounts(items: readonly LotteryLedgerItem[]): { level: string; n: number }[] {
  const m = new Map<string, number>();
  for (const r of items)
    if (r.level != null && r.level !== "") m.set(r.level, (m.get(r.level) ?? 0) + 1);
  const rank = (l: string) => {
    const i = LEVEL_ORDER.indexOf(l.toLowerCase().replace(/[\s_-]/g, ""));
    return i === -1 ? LEVEL_ORDER.length : i;
  };
  return [...m.entries()]
    .map(([level, n]) => ({ level, n }))
    .sort((a, b) => rank(a.level) - rank(b.level));
}
