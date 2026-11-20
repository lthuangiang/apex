-- Signal research: địa chỉ ví cùng chiều / ngược chiều của H1 trong snapshot ngữ cảnh (để trace link tới trang trader).
-- Nullable: snapshot cũ chỉ có số lượng.
ALTER TABLE "signal_contexts" ADD COLUMN "h1_agreeing_addresses" text[];--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "h1_opposing_addresses" text[];