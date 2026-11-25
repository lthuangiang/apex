-- #530 PR1 (DEC-392): sự kiện tin nêu nhiều coin. `event_key` = khoá của sự kiện (null = tín hiệu một
-- coin), `event_coins` = số coin của sự kiện; bot chia `sizeUsdc` cho số này. Chỉ thêm cột, mặc định 1 = hành vi cũ.
ALTER TABLE "news_signals" ADD COLUMN "event_key" text;--> statement-breakpoint
ALTER TABLE "news_signals" ADD COLUMN "event_coins" integer DEFAULT 1 NOT NULL;