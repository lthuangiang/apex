CREATE TABLE "telegram_link_tokens" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"chat_id" bigint NOT NULL,
	"username" text,
	"status" text NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"last_sent_at" timestamp with time zone,
	"blocked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "telegram_link_tokens" ADD CONSTRAINT "telegram_link_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_links" ADD CONSTRAINT "telegram_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_link_tokens_token_hash_key" ON "telegram_link_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "telegram_link_tokens_user_idx" ON "telegram_link_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_links_chat_id_key" ON "telegram_links" USING btree ("chat_id");