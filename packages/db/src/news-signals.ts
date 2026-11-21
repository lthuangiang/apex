import { and, asc, eq, gt } from "drizzle-orm";

import type { Db } from "./client";
import type { DbTx } from "./read-only";
import { newsSignalDeliveries, newsSignals } from "./schema";

// Truy cập DB tối thiểu cho bot `news_signal` mainnet (#419 PR 2): scheduler ghi tín hiệu, engine đọc tín hiệu chưa hết
// hạn và ghi delivery cho từng bot. Không có logic giao dịch ở đây.

type Q = Db | DbTx;
export type NewsSignalRow = typeof newsSignals.$inferSelect;
export type NewNewsSignal = Omit<typeof newsSignals.$inferInsert, "id" | "createdAt">;
export type NewsSignalDeliveryRow = typeof newsSignalDeliveries.$inferSelect;
export type NewNewsSignalDelivery = Omit<typeof newsSignalDeliveries.$inferInsert, "createdAt">;

/** Kết quả delivery của một tín hiệu trên một bot. */
export const NewsSignalDeliveryOutcome = { accepted: "accepted", dropped: "dropped" } as const;
export type NewsSignalDeliveryOutcome =
  (typeof NewsSignalDeliveryOutcome)[keyof typeof NewsSignalDeliveryOutcome];

/**
 * Ghi một tín hiệu, idempotent theo (`story_key`, `cycle_at`): ghi lại cùng khoá không tạo dòng mới và trả dòng đã có
 * (`created = false`), không ghi đè gì (bảng bất biến).
 */
export async function insertNewsSignal(
  q: Q,
  input: NewNewsSignal,
): Promise<{ signal: NewsSignalRow; created: boolean }> {
  const [row] = await q
    .insert(newsSignals)
    .values(input)
    .onConflictDoNothing({ target: [newsSignals.storyKey, newsSignals.cycleAt] })
    .returning();
  if (row !== undefined) return { signal: row, created: true };
  const [existing] = await q
    .select()
    .from(newsSignals)
    .where(and(eq(newsSignals.storyKey, input.storyKey), eq(newsSignals.cycleAt, input.cycleAt)))
    .limit(1);
  if (existing === undefined)
    throw new Error("news signal insert conflicted but the existing row was not found");
  return { signal: existing, created: false };
}

/**
 * Ghi delivery (`signal_id`, `bot_id`) với ON CONFLICT DO NOTHING. `true` = dòng mới (bot được làm việc với tín hiệu này);
 * `false` = đã có delivery từ trước, không được tạo thêm tác dụng nào.
 */
export async function insertNewsSignalDelivery(
  q: Q,
  input: NewNewsSignalDelivery,
): Promise<boolean> {
  const rows = await q
    .insert(newsSignalDeliveries)
    .values(input)
    .onConflictDoNothing({ target: [newsSignalDeliveries.signalId, newsSignalDeliveries.botId] })
    .returning({ signalId: newsSignalDeliveries.signalId });
  return rows.length > 0;
}

/** Tín hiệu còn hạn (`expires_at` > `now`), cũ trước, tối đa `limit` dòng. */
export async function unexpiredNewsSignals(q: Q, now: Date, limit = 500): Promise<NewsSignalRow[]> {
  return q
    .select()
    .from(newsSignals)
    .where(gt(newsSignals.expiresAt, now))
    .orderBy(asc(newsSignals.decidedAt), asc(newsSignals.id))
    .limit(limit);
}
