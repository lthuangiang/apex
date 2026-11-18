-- Signal Analysis (#233): lệnh đã khớp theo bot. Migrator của drizzle chạy trong transaction nên không dùng được
-- CONCURRENTLY (như 0037); build 0,72 s trên 1,31M lệnh (PR #246). Xem DEPLOY.md 2.13 (tạo trước bằng CONCURRENTLY).
CREATE INDEX IF NOT EXISTS "orders_bot_filled_idx" ON "orders" USING btree ("bot_id","created_at") WHERE "orders"."filled_size" > 0;
