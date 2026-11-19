-- Signal research (#290): usage Claude theo từng bài. Chỉ thêm cột nullable, không default (Postgres chỉ sửa metadata,
-- không viết lại bảng). Bài cũ để null = "Not available", không bao giờ 0.
ALTER TABLE "signal_articles" ADD COLUMN "claude_calls" integer;--> statement-breakpoint
ALTER TABLE "signal_articles" ADD COLUMN "claude_input_tokens" integer;--> statement-breakpoint
ALTER TABLE "signal_articles" ADD COLUMN "claude_cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "signal_articles" ADD COLUMN "claude_cache_read_tokens" integer;--> statement-breakpoint
ALTER TABLE "signal_articles" ADD COLUMN "claude_output_tokens" integer;--> statement-breakpoint
ALTER TABLE "signal_articles" ADD COLUMN "claude_model" text;--> statement-breakpoint
ALTER TABLE "signal_articles" ADD COLUMN "claude_prompt_version" text;