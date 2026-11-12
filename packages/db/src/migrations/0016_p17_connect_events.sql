CREATE TABLE "connect_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connect_events" ADD CONSTRAINT "connect_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connect_events_user_idx" ON "connect_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "connect_events_time_idx" ON "connect_events" USING btree ("occurred_at");