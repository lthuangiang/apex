CREATE TABLE "desk_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"severity" integer NOT NULL,
	"facts" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"badness" numeric(38, 18) NOT NULL,
	"snoozed_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desk_items" ADD CONSTRAINT "desk_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_items" ADD CONSTRAINT "desk_items_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desk_items_bot_rule" ON "desk_items" USING btree ("bot_id","rule");--> statement-breakpoint
CREATE INDEX "desk_items_user_idx" ON "desk_items" USING btree ("user_id");