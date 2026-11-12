ALTER TABLE "users" ALTER COLUMN "ai_desk" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "adaptive_dca" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Ai đang dùng được AI Adaptive DCA (đi theo cờ AI Desk cũ) vẫn giữ quyền; sau đó AI Desk (và Copy Trading) bật cho mọi
-- tài khoản (DEC-TBD-desk-for-all). Team vẫn tắt / bật từng tài khoản ở Users.
UPDATE "users" SET "adaptive_dca" = "ai_desk";--> statement-breakpoint
UPDATE "users" SET "ai_desk" = true WHERE "ai_desk" = false;
