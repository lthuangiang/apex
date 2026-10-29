CREATE TABLE "bot_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"type" text NOT NULL,
	"decision" text,
	"why" text,
	"result" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_runtime" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"version_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"epoch" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"param_source" text NOT NULL,
	"ai_suggestion_id" uuid,
	"status" text NOT NULL,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"market" text NOT NULL,
	"engine" text NOT NULL,
	"name" text NOT NULL,
	"state" text NOT NULL,
	"reason_code" text,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"active_version_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"order_id" uuid NOT NULL,
	"sodex_trade_id" bigint NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"size" numeric(38, 18) NOT NULL,
	"fee" numeric(38, 18) NOT NULL,
	"builder_fee" numeric(38, 18),
	"fee_coin" text,
	"is_maker" boolean,
	"filled_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"cl_ord_id" text NOT NULL,
	"sodex_order_id" bigint,
	"market" text NOT NULL,
	"engine" text NOT NULL,
	"side" text NOT NULL,
	"type" text NOT NULL,
	"time_in_force" text NOT NULL,
	"price" numeric(38, 18),
	"size" numeric(38, 18) NOT NULL,
	"filled_size" numeric(38, 18) DEFAULT '0' NOT NULL,
	"avg_price" numeric(38, 18),
	"status" text NOT NULL,
	"reduce_only" boolean DEFAULT false NOT NULL,
	"builder_fee" numeric(38, 18),
	"tag" text NOT NULL,
	"epoch" bigint NOT NULL,
	"submitted_at" timestamp with time zone,
	"acked_at" timestamp with time zone,
	"reconciled_at" timestamp with time zone,
	"reject_code" text,
	"reject_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shard_epochs" (
	"shard" integer PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	"owner" text NOT NULL,
	"acquired_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_events" ADD CONSTRAINT "bot_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_runtime" ADD CONSTRAINT "bot_runtime_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_versions" ADD CONSTRAINT "bot_versions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fills" ADD CONSTRAINT "fills_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_events_bot_idx" ON "bot_events" USING btree ("bot_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_versions_bot_version_key" ON "bot_versions" USING btree ("bot_id","version");--> statement-breakpoint
CREATE INDEX "bots_user_idx" ON "bots" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bots_account_state_idx" ON "bots" USING btree ("sodex_account_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "fills_trade_key" ON "fills" USING btree ("sodex_trade_id");--> statement-breakpoint
CREATE INDEX "fills_order_idx" ON "fills" USING btree ("order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "orders_account_cl_ord_key" ON "orders" USING btree ("sodex_account_id","cl_ord_id");--> statement-breakpoint
CREATE INDEX "orders_bot_idx" ON "orders" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");