import { outbox, type Db } from "@drift/db";
import { eq, sql } from "drizzle-orm";

// Relay outbox → NATS (ARCHITECTURE.md mục 3.3.4). Nhiều replica chạy song song an toàn nhờ
// `FOR UPDATE SKIP LOCKED`; nếu publish thành công mà chưa kịp đánh dấu thì message có thể lặp lại,
// nên consumer phải idempotent (C10).

export type Publish = (topic: string, payload: unknown, msgId: string) => Promise<void>;

export async function relayOnce(db: Db, publish: Publish, batch = 100): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string; topic: string; payload: unknown }>(
      sql`select id, topic, payload from outbox where published_at is null order by created_at limit ${batch} for update skip locked`,
    );
    for (const row of rows.rows) {
      await publish(row.topic, row.payload, row.id);
      await tx.update(outbox).set({ publishedAt: new Date() }).where(eq(outbox.id, row.id));
    }
    return rows.rows.length;
  });
}
