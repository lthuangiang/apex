ALTER TABLE "desk_applies" ADD COLUMN "record_status" text DEFAULT 'measuring' NOT NULL;--> statement-breakpoint
ALTER TABLE "desk_applies" ADD COLUMN "record" jsonb;--> statement-breakpoint
ALTER TABLE "desk_applies" ADD COLUMN "verdict" text;--> statement-breakpoint
ALTER TABLE "desk_applies" ADD COLUMN "record_error" text;--> statement-breakpoint
ALTER TABLE "desk_applies" ADD COLUMN "checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "desk_applies" ADD COLUMN "switched_back_version" integer;--> statement-breakpoint
CREATE INDEX "desk_applies_record_idx" ON "desk_applies" USING btree ("record_status","applied_at");