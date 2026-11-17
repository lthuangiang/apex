ALTER TABLE "orders" ADD COLUMN "missing_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "orders" ADD COLUMN "unknown_gave_up_at" timestamp with time zone;