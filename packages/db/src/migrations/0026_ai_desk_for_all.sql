ALTER TABLE "users" ALTER COLUMN "ai_desk" SET DEFAULT true;--> statement-breakpoint
-- AI Desk (và Copy Trading, chung cờ) bật cho mọi tài khoản hiện có (DEC-TBD-desk-for-all). Team vẫn tắt được từng tài khoản ở Users.
UPDATE "users" SET "ai_desk" = true WHERE "ai_desk" = false;
