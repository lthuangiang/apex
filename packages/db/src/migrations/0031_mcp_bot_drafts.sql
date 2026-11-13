CREATE TABLE "bot_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"bot_id" uuid,
	"strategy" text NOT NULL,
	"name" text,
	"config" jsonb NOT NULL,
	"source" text DEFAULT 'mcp' NOT NULL,
	"client_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_drafts" ADD CONSTRAINT "bot_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_drafts" ADD CONSTRAINT "bot_drafts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_drafts_user_idx" ON "bot_drafts" USING btree ("user_id","expires_at");