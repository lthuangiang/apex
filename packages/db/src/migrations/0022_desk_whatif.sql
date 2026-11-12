CREATE TABLE "desk_applies" (
	"id" uuid PRIMARY KEY NOT NULL,
	"whatif_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"option" text NOT NULL,
	"from_version" integer NOT NULL,
	"to_version" integer NOT NULL,
	"baseline_config" jsonb NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "desk_whatifs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"item_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"bot_version" integer NOT NULL,
	"item_fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"source" text,
	"options" jsonb NOT NULL,
	"window_from" timestamp with time zone NOT NULL,
	"window_to" timestamp with time zone NOT NULL,
	"error" text,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "desk_applies" ADD CONSTRAINT "desk_applies_whatif_id_desk_whatifs_id_fk" FOREIGN KEY ("whatif_id") REFERENCES "public"."desk_whatifs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_applies" ADD CONSTRAINT "desk_applies_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_applies" ADD CONSTRAINT "desk_applies_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_whatifs" ADD CONSTRAINT "desk_whatifs_item_id_desk_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."desk_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_whatifs" ADD CONSTRAINT "desk_whatifs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desk_whatifs" ADD CONSTRAINT "desk_whatifs_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "desk_applies_whatif" ON "desk_applies" USING btree ("whatif_id");--> statement-breakpoint
CREATE INDEX "desk_applies_bot_idx" ON "desk_applies" USING btree ("bot_id","applied_at");--> statement-breakpoint
CREATE INDEX "desk_whatifs_item_idx" ON "desk_whatifs" USING btree ("item_id","created_at");