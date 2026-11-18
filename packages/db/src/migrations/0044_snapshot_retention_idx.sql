-- Retention snapshot tín hiệu (#229): index một phần cho job của scheduler. Migrator của drizzle chạy trong transaction nên
-- không dùng được CONCURRENTLY (như 0043); lock_timeout để migration báo lỗi thay vì xếp hàng sau một transaction dài
-- và chặn mọi lệnh ghi phía sau (#238 review). Xem DEPLOY.md 2.14 (tạo trước bằng CONCURRENTLY).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "bot_events_signal_idx" ON "bot_events" USING btree ("occurred_at") WHERE "bot_events"."payload" ? 'signal';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "orders_context_created_idx" ON "orders" USING btree ("created_at") WHERE "orders"."context" IS NOT NULL;
