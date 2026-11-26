import { outbox, rewardsWatch, sodexAccounts, type Db } from "@drift/db";
import type {
  RewardsBoxReceivedData,
  RewardsClaimableData,
  RewardsDrawWonData,
  RewardsNotificationType,
  RewardsWatchPauseReason,
  RewardsWatchPausedData,
} from "@drift/shared";
import type { RewardsReadClient, RewardsReadFailure } from "@drift/sodex";
import { and, asc, eq, isNotNull, lt, lte } from "drizzle-orm";

import {
  backoffMs,
  baselineMark,
  freshItems,
  levelCounts,
  nextCheckAt,
  nextMark,
  prizeRounds,
  prizesByRound,
  receivedItems,
  rememberRounds,
  type LedgerItem,
  type LedgerMark,
} from "./classify";
import type { RewardsDecrypt } from "./signer-decrypt";

// Job báo box mới SoDEX rewards (#558, DEC-398, plan-558 mục 2). Chạy ở scheduler (một leader). Mỗi lượt lấy các dòng
// `rewards_watch` tới hạn, mỗi user: xin signer giải mã token (biến cục bộ, bỏ sau lượt), đọc `lottery/treasures` +
// `lottery/ledger` (+ `lottery/draw/entries` khi có giải quay số mới) qua client CHỈ ĐỌC dùng chung, so với mốc "đã thấy"
// ở DB, rồi ghi thông báo vào outbox `jobs.notify` CÙNG transaction với mốc mới (crash giữa chừng thì lượt sau đọc lại,
// `dedupeKey` chặn bản trùng). Không bao giờ claim / open / merge, không log token.

export interface RewardsPauseStore {
  /** Gateway trả 429: dừng cả job tới mốc này (ms), vì hạn mức tính theo IP. */
  get(): Promise<number | null>;
  set(untilMs: number): Promise<void>;
}

export interface RewardsWatchJobDeps {
  db: Db;
  now: () => Date;
  reader: Pick<RewardsReadClient, "getTreasures" | "getLedger" | "getDrawEntries">;
  decrypt: RewardsDecrypt;
  pause: RewardsPauseStore;
  /** Chu kỳ đọc mỗi user (`REWARDS_WATCH_INTERVAL_MIN`). */
  intervalMs: number;
  /** Số user tối đa mỗi lượt (trần weight vẫn do bucket của client quyết). */
  batch: number;
  /** Ghi cảnh báo khi lỗi bất ngờ ở một user (review PR #569: không nuốt lỗi). Thiếu thì không ghi. */
  log?: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface RewardsWatchTickResult {
  checked: number;
  baselined: number;
  notified: number;
  paused: number;
  errors: number;
  /** Lượt dừng sớm: hết ngân sách weight của DeskLabs (`budget`) hay gateway 429 (`rate_limited`). */
  stopped: "budget" | "rate_limited" | null;
}

/** Gateway không có `retryAfter` khi 429: dừng 60 s. */
export const REWARDS_DEFAULT_RETRY_MS = 60_000;
/** Token còn dưới 60 s thì coi như hết hạn (không gọi SoDEX). */
export const REWARDS_EXPIRY_MARGIN_MS = 60_000;
export const LEDGER_PAGE = 100;
export const LEDGER_MAX_PAGES = 3;

type Row = typeof rewardsWatch.$inferSelect;
type Stop = "budget" | "rate_limited";

interface Notice {
  type: RewardsNotificationType;
  data: RewardsClaimableData | RewardsBoxReceivedData | RewardsDrawWonData | RewardsWatchPausedData;
  dedupeKey: string;
}

const notifyRow = (userId: string, n: Notice) => ({
  topic: "jobs.notify",
  payload: { userId, type: n.type, data: n.data, dedupeKey: n.dedupeKey },
});

/** Kết quả đọc không phải `ok`: dừng cả lượt (budget / 429), tạm dừng user (401) hay lùi (lỗi khác). */
type Outcome = { stop: Stop } | { pause: RewardsWatchPauseReason } | { error: string };

async function failureOutcome(
  f: RewardsReadFailure,
  deps: RewardsWatchJobDeps,
  now: Date,
): Promise<Outcome> {
  switch (f.kind) {
    case "budget":
      return { stop: "budget" };
    case "rate_limited":
      await deps.pause.set(now.getTime() + (f.retryAfterMs ?? REWARDS_DEFAULT_RETRY_MS));
      return { stop: "rate_limited" };
    case "unauthorized":
      return { pause: "unauthorized" };
    case "invalid_token":
      return { pause: "unauthorized" };
    case "error":
      return { error: f.code };
  }
}

/** Tạm dừng: xoá ciphertext, ghi lý do, báo một lần (`dedupeKey` theo phiên rewards). */
async function pauseRow(
  db: Db,
  row: Row,
  reason: RewardsWatchPauseReason,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(rewardsWatch)
      .set({
        status: "paused",
        pauseReason: reason,
        tokenCiphertext: null,
        kmsKeyRef: null,
        lastCheckedAt: now,
      })
      .where(and(eq(rewardsWatch.userId, row.userId), eq(rewardsWatch.status, "active")));
    await tx.insert(outbox).values(
      notifyRow(row.userId, {
        type: "rewards_watch_paused",
        data: { reason },
        dedupeKey: `rw:paused:${row.jti8 ?? String(row.tokenExp.getTime())}`,
      }),
    );
  });
}

async function backoffRow(db: Db, row: Row, code: string, now: Date, intervalMs: number) {
  const errors = row.consecutiveErrors + 1;
  await db
    .update(rewardsWatch)
    .set({
      consecutiveErrors: errors,
      lastErrorCode: code,
      lastCheckedAt: now,
      nextCheckAt: new Date(now.getTime() + backoffMs(intervalMs, errors)),
    })
    .where(eq(rewardsWatch.userId, row.userId));
}

/** Đọc ledger tới mốc (tối đa 3 trang); baseline chỉ đọc trang đầu. */
async function readLedger(
  deps: RewardsWatchJobDeps,
  token: string,
  mark: LedgerMark | null,
  now: Date,
): Promise<{ items: LedgerItem[] } | Outcome> {
  const out: LedgerItem[] = [];
  for (let page = 0; page < (mark === null ? 1 : LEDGER_MAX_PAGES); page += 1) {
    const r = await deps.reader.getLedger(token, {
      limit: LEDGER_PAGE,
      offset: page * LEDGER_PAGE,
    });
    if (r.kind !== "ok") return failureOutcome(r, deps, now);
    const items = r.data.items;
    if (mark === null) return { items };
    const { fresh, reachedMark } = freshItems(items, mark);
    out.push(...fresh);
    if (reachedMark || items.length < LEDGER_PAGE) break;
  }
  return { items: out };
}

async function processRow(
  deps: RewardsWatchJobDeps,
  row: Row,
  result: RewardsWatchTickResult,
): Promise<Stop | null> {
  const { db } = deps;
  const now = deps.now();
  // Đổi ví / ngắt SoDEX mà dòng còn: tạm dừng (api / đối soát thường đã xoá dòng; đây là lưới an toàn).
  const [account] = await db
    .select({ userId: sodexAccounts.userId, status: sodexAccounts.status })
    .from(sodexAccounts)
    .where(eq(sodexAccounts.id, row.sodexAccountId))
    .limit(1);
  if (account?.userId !== row.userId || account.status !== "connected") {
    await pauseRow(db, row, "wallet_changed", now);
    result.paused += 1;
    return null;
  }
  if (row.tokenExp.getTime() - REWARDS_EXPIRY_MARGIN_MS <= now.getTime()) {
    await pauseRow(db, row, "expired", now);
    result.paused += 1;
    return null;
  }

  const dec = await deps.decrypt(row.userId);
  if (dec.kind === "not_active") return null;
  if (dec.kind === "unusable") {
    await pauseRow(db, row, "unauthorized", now);
    result.paused += 1;
    return null;
  }
  if (dec.kind === "unavailable") {
    await backoffRow(db, row, "signer_unavailable", now, deps.intervalMs);
    result.errors += 1;
    return null;
  }
  const token = dec.token;

  const handle = async (o: Outcome): Promise<Stop | null> => {
    if ("stop" in o) return o.stop;
    if ("pause" in o) {
      await pauseRow(db, row, o.pause, now);
      result.paused += 1;
    } else {
      await backoffRow(db, row, o.error, now, deps.intervalMs);
      result.errors += 1;
    }
    return null;
  };

  const treasures = await deps.reader.getTreasures(token);
  if (treasures.kind !== "ok") return handle(await failureOutcome(treasures, deps, now));
  const granted = treasures.data.lifetime?.granted ?? null;

  const mark: LedgerMark | null =
    row.baselinePending || row.ledgerMarkTsMs === null
      ? null
      : { tsMs: row.ledgerMarkTsMs, ids: row.ledgerMarkIds };
  const ledger = await readLedger(deps, token, mark, now);
  if (!("items" in ledger)) return handle(ledger);
  result.checked += 1;

  const scheduled = {
    consecutiveErrors: 0,
    lastErrorCode: null,
    lastCheckedAt: now,
    nextCheckAt: nextCheckAt(now, deps.intervalMs, row.userId),
  };

  if (mark === null) {
    // Lượt đầu: chỉ đặt mốc = hiện tại, không báo lịch sử cũ.
    const base = baselineMark(ledger.items, now.getTime());
    await db
      .update(rewardsWatch)
      .set({
        ...scheduled,
        baselinePending: false,
        ledgerMarkTsMs: base.tsMs,
        ledgerMarkIds: [...base.ids],
        grantedMark: granted,
        drawRoundsSeen: rememberRounds(row.drawRoundsSeen, prizeRounds(ledger.items)),
      })
      .where(and(eq(rewardsWatch.userId, row.userId), eq(rewardsWatch.status, "active")));
    result.baselined += 1;
    return null;
  }

  const fresh = ledger.items;
  const notices: Notice[] = [];
  if (granted !== null && row.grantedMark !== null && granted > row.grantedMark)
    notices.push({
      type: "rewards_claimable",
      data: { count: granted - row.grantedMark },
      dedupeKey: `rw:claim:${String(granted)}`,
    });
  const received = receivedItems(fresh);
  if (received.length > 0)
    notices.push({
      type: "rewards_box_received",
      data: { count: received.length, levels: levelCounts(received) },
      dedupeKey: `rw:recv:${String(Math.max(...received.map((i) => i.tsMs)))}`,
    });
  const newRounds: number[] = [];
  for (const [round, boxes] of prizesByRound(fresh)) {
    let wins: number | null = null;
    let tickets: number | null = null;
    // Số vé trúng chỉ đọc lần đầu gặp round (`wins` là số, đã xác nhận bằng dữ liệu thật vòng 10).
    if (round !== null && !row.drawRoundsSeen.includes(round)) {
      const entries = await deps.reader.getDrawEntries(token, { round });
      if (entries.kind === "ok") {
        wins = typeof entries.data.wins === "number" ? entries.data.wins : null;
        tickets = entries.data.tickets ?? null;
      } else if (entries.kind === "rate_limited") {
        await failureOutcome(entries, deps, now);
      }
      newRounds.push(round);
    }
    notices.push({
      type: "rewards_draw_won",
      data: { round, boxes: boxes.length, wins, tickets },
      dedupeKey: `rw:prize:${round === null ? "none" : String(round)}:${String(Math.max(...boxes.map((i) => i.tsMs)))}`,
    });
  }

  const next = nextMark(mark, fresh);
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(rewardsWatch)
      .set({
        ...scheduled,
        ledgerMarkTsMs: next.tsMs,
        ledgerMarkIds: [...next.ids],
        grantedMark: granted ?? row.grantedMark,
        drawRoundsSeen: rememberRounds(row.drawRoundsSeen, newRounds),
      })
      .where(and(eq(rewardsWatch.userId, row.userId), eq(rewardsWatch.status, "active")))
      .returning({ userId: rewardsWatch.userId });
    // Dòng vừa bị tắt / xoá giữa lượt: không báo.
    if (updated.length === 0 || notices.length === 0) return;
    await tx.insert(outbox).values(notices.map((n) => notifyRow(row.userId, n)));
  });
  result.notified += notices.length;
  return null;
}

/** Một lượt của job. Không ném lỗi theo từng user: lỗi một user thì lùi user đó, lượt tiếp tục. */
export async function runRewardsWatchTick(
  deps: RewardsWatchJobDeps,
): Promise<RewardsWatchTickResult> {
  const result: RewardsWatchTickResult = {
    checked: 0,
    baselined: 0,
    notified: 0,
    paused: 0,
    errors: 0,
    stopped: null,
  };
  const now = deps.now();
  const until = await deps.pause.get();
  if (until !== null && until > now.getTime()) {
    result.stopped = "rate_limited";
    return result;
  }
  const due = await deps.db
    .select()
    .from(rewardsWatch)
    .where(and(eq(rewardsWatch.status, "active"), lte(rewardsWatch.nextCheckAt, now)))
    .orderBy(asc(rewardsWatch.nextCheckAt))
    .limit(deps.batch);
  for (const row of due) {
    let stop: Stop | null;
    try {
      stop = await processRow(deps, row, result);
    } catch (err) {
      // Lỗi DB / bất ngờ: lùi user này. Log chỉ tên / mã lỗi + userId, không message / body (có thể chứa dữ liệu).
      result.errors += 1;
      deps.log?.warn(
        {
          userId: row.userId,
          errorName: err instanceof Error ? err.name : typeof err,
          errorCode:
            typeof err === "object" && err !== null && "code" in err ? String(err.code) : undefined,
        },
        "rewards watch: user check failed",
      );
      await backoffRow(deps.db, row, "internal", deps.now(), deps.intervalMs).catch(
        () => undefined,
      );
      continue;
    }
    if (stop !== null) {
      result.stopped = stop;
      break;
    }
  }
  return result;
}

/** Dòng đã tạm dừng quá ngần này thì xoá hẳn (mốc không còn ích). */
export const PAUSED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Dọn dẹp: dòng `paused` không còn ciphertext (phòng thủ, pauseRow đã xoá) và xoá dòng `paused` quá 30 ngày. Trả số
 * dòng bị xoá.
 */
export async function purgeRewardsWatch(db: Db, now: Date): Promise<number> {
  await db
    .update(rewardsWatch)
    .set({ tokenCiphertext: null, kmsKeyRef: null })
    .where(and(eq(rewardsWatch.status, "paused"), isNotNull(rewardsWatch.tokenCiphertext)));
  const deleted = await db
    .delete(rewardsWatch)
    .where(
      and(
        eq(rewardsWatch.status, "paused"),
        lt(rewardsWatch.updatedAt, new Date(now.getTime() - PAUSED_RETENTION_MS)),
      ),
    )
    .returning({ userId: rewardsWatch.userId });
  return deleted.length;
}
