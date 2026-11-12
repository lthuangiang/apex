ALTER TABLE "users" ALTER COLUMN "volume_bots" SET DEFAULT true;--> statement-breakpoint
-- DEC-94: mở Market Making và Volume Farming cho mọi tài khoản; team vẫn tắt được từng người ở Users.
UPDATE "users" SET "volume_bots" = true;
