-- #593 (DEC-402 mục 6, DEC-403): độ sâu sổ lệnh lúc quyết định ("Book at the time") trên snapshot Context: tổng
-- notional 10 mức mỗi phía. Chỉ thêm cột nullable; bản trước không đọc / ghi các cột này nên migrate trước hoặc rollback
-- không cần làm gì. Trigger chặn UPDATE của hai bảng không ảnh hưởng ALTER TABLE.
ALTER TABLE "signal_context_coins" ADD COLUMN "book_bids_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_context_coins" ADD COLUMN "book_asks_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "book_bids_usd" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "book_asks_usd" numeric(38, 18);