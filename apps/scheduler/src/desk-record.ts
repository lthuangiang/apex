import { botVersions, deskApplies, outbox, type Db } from "@drift/db";
import { RECORD_CONFIG } from "@drift/shared";
import { and, eq, inArray, isNotNull, lte } from "drizzle-orm";

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
