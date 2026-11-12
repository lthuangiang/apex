import {
  botVersions,
  deskAiConversations,
  deskApplies,
  deskWhatifs,
  outbox,
  type Db,
} from "@drift/db";
import { DESK_AI_CONFIG, RECORD_CONFIG, WHATIF_CONFIG } from "@drift/shared";
import { and, eq, inArray, isNotNull, lt, lte, or } from "drizzle-orm";

// AI Desk B+ M4 (DEC-166): 7 ngày sau khi version "AI suggested" được áp, xếp job đo thành tích vào hàng đợi
// `backtest.run` (payload `{ applyId }`). Mốc là lúc version thật sự được áp (bot đang chạy thì engine áp sau), không
// phải lúc bấm Apply. Chuyển `measuring` → `queued` trong cùng transaction với outbox nên không xếp trùng.

export async function queueDueRecords(db: Db, now: number): Promise<number> {
  const due = await db
    .select({ id: deskApplies.id })
    .from(deskApplies)
    .innerJoin(
      botVersions,
      and(eq(botVersions.botId, deskApplies.botId), eq(botVersions.version, deskApplies.toVersion)),
    )
    .where(
      and(
        eq(deskApplies.recordStatus, "measuring"),
        isNotNull(deskApplies.toVersion),
        lte(botVersions.appliedAt, new Date(now - RECORD_CONFIG.measureMs)),
      ),
    );
  if (due.length === 0) return 0;
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(deskApplies)
      .set({ recordStatus: "queued", updatedAt: new Date(now) })
      .where(
        and(
          inArray(
            deskApplies.id,
            due.map((d) => d.id),
          ),
          eq(deskApplies.recordStatus, "measuring"),
        ),
      )
      .returning({ id: deskApplies.id });
    if (moved.length > 0)
      await tx
        .insert(outbox)
        .values(moved.map((m) => ({ topic: "backtest.run", payload: { applyId: m.id } })));
    return moved.length;
  });
}

/**
 * Dọn job AI Desk kẹt vì tin trong hàng đợi bị mất (worker bản cũ nhận rồi bỏ lúc deploy, hoặc worker chết giữa chừng):
 * - what-if `queued` quá `staleQueuedMs` hoặc `running` quá 3 lần mức đó → `failed` (`stale`): UI thôi chờ, trang chủ
 *   xếp so sánh mới sau `failedRetryMs`.
 * - Thành tích `queued` quá `RECORD_CONFIG.staleQueuedMs` → `measuring`: `queueDueRecords` xếp lại ở lượt sau. Worker
 *   chỉ xử lý dòng `queued`, chạy trùng cũng ghi cùng kết quả.
 */
export async function sweepStaleDeskJobs(
  db: Db,
  now: number,
): Promise<{ whatifs: number; records: number }> {
  const whatifs = await db
    .update(deskWhatifs)
    .set({ status: "failed", error: "stale", finishedAt: new Date(now) })
    .where(
      or(
        and(
          eq(deskWhatifs.status, "queued"),
          lt(deskWhatifs.createdAt, new Date(now - WHATIF_CONFIG.staleQueuedMs)),
        ),
        and(
          eq(deskWhatifs.status, "running"),
          lt(deskWhatifs.createdAt, new Date(now - 3 * WHATIF_CONFIG.staleQueuedMs)),
        ),
      ),
    )
    .returning({ id: deskWhatifs.id });
  const records = await db
    .update(deskApplies)
    .set({ recordStatus: "measuring", updatedAt: new Date(now) })
    .where(
      and(
        eq(deskApplies.recordStatus, "queued"),
        lt(deskApplies.updatedAt, new Date(now - RECORD_CONFIG.staleQueuedMs)),
      ),
    )
    .returning({ id: deskApplies.id });
  return { whatifs: whatifs.length, records: records.length };
}

/** Desk AI (DEC-165c): chat lưu 90 ngày rồi tự xoá (lượt bị xoá theo, `on delete cascade`). */
export async function purgeOldDeskAiChats(db: Db, now: number): Promise<number> {
  const rows = await db
    .delete(deskAiConversations)
    .where(
      lt(deskAiConversations.createdAt, new Date(now - DESK_AI_CONFIG.retentionDays * 86_400_000)),
    )
    .returning({ id: deskAiConversations.id });
  return rows.length;
}
