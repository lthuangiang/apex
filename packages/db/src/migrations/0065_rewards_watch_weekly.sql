-- #567: mốc tin tuần SoDEX rewards (tổng kết tuần, điểm tuần) trên rewards_watch. Chỉ thêm cột nullable; bản trước
-- không đọc các cột này, nên migrate trước hoặc rollback không cần làm gì.
ALTER TABLE "rewards_watch" ADD COLUMN "snapshot_week_sent" integer;--> statement-breakpoint
ALTER TABLE "rewards_watch" ADD COLUMN "points_week_sent" integer;--> statement-breakpoint
ALTER TABLE "rewards_watch" ADD COLUMN "weekly_check_at" timestamp with time zone;