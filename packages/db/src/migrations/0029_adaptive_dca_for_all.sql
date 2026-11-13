ALTER TABLE "users" ALTER COLUMN "adaptive_dca" SET DEFAULT true;--> statement-breakpoint
-- AI Adaptive DCA (Beta) cho mọi tài khoản hiện có (DEC-TBD-adaptive-dca-beta). Team vẫn tắt từng tài khoản ở Users.
UPDATE "users" SET "adaptive_dca" = true WHERE "adaptive_dca" = false;
