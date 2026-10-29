ALTER TABLE "users" ADD COLUMN "default_max_loss_pct" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;