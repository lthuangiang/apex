-- Signal research #375: giờ đồng hồ thật (đồng hồ scheduler) để đo độ trễ theo chặng. Cột nullable, tương thích ngược;
-- dòng cũ để null ("Not measured yet"). Không đổi cột nào logic giao dịch đang dùng.
ALTER TABLE "signal_articles" ADD COLUMN "claude_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signal_articles" ADD COLUMN "claude_done_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signal_events" ADD COLUMN "decided_clock_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "decided_clock_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "opened_clock_at" timestamp with time zone;