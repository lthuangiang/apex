-- Bot `news_signal` chạy tiền thật trên SoDEX mainnet (#419 PR 2, DEC-360). Chỉ schema, chưa có logic giao dịch.
-- news_signals: tín hiệu dùng chung, bất biến (trigger chặn UPDATE / DELETE), unique (story_key, cycle_at).
-- news_signal_deliveries: mỗi tín hiệu một tác dụng trên một bot, PK (signal_id, bot_id).
-- news_signal_trades: mỗi account × market chỉ một lệnh open / closing (partial unique). Chỉ mainnet.
-- news_signal_commands: Edit TP/SL / Close now, unique (trade_id, seq).
-- bots.signal_version_id: version Signal research gốc của bot news_signal.
-- Chạy sau 0058 (#423, PR #428).
CREATE TABLE "news_signal_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trade_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"seq" integer NOT NULL,
	"tp" numeric(38, 18),
	"sl" numeric(38, 18),
	"status" text DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_signal_commands_kind_ck" CHECK ("news_signal_commands"."kind" in ('edit_tpsl', 'close')),
	CONSTRAINT "news_signal_commands_status_ck" CHECK ("news_signal_commands"."status" in ('queued', 'applying', 'applied', 'rejected', 'unknown')),
	CONSTRAINT "news_signal_commands_prices_ck" CHECK (("news_signal_commands"."kind" = 'close' and "news_signal_commands"."tp" is null and "news_signal_commands"."sl" is null) or ("news_signal_commands"."kind" = 'edit_tpsl' and ("news_signal_commands"."tp" is not null or "news_signal_commands"."sl" is not null)))
);
--> statement-breakpoint
CREATE TABLE "news_signal_deliveries" (
	"signal_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"epoch" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_signal_deliveries_signal_id_bot_id_pk" PRIMARY KEY("signal_id","bot_id"),
	CONSTRAINT "news_signal_deliveries_outcome_ck" CHECK ("news_signal_deliveries"."outcome" in ('accepted', 'dropped')),
	CONSTRAINT "news_signal_deliveries_reason_ck" CHECK (("news_signal_deliveries"."outcome" = 'dropped') = ("news_signal_deliveries"."reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "news_signal_trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"status" text NOT NULL,
	"size_usdc" numeric(38, 18) NOT NULL,
	"entry_limit_price" numeric(38, 18) NOT NULL,
	"qty" numeric(38, 18) DEFAULT '0' NOT NULL,
	"entry_avg_price" numeric(38, 18),
	"tp_price" numeric(38, 18),
	"sl_price" numeric(38, 18),
	"tpsl_seq" integer DEFAULT 0 NOT NULL,
	"max_hold_until" timestamp with time zone NOT NULL,
	"max_hold_off_at" timestamp with time zone,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"exit_avg_price" numeric(38, 18),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_signal_trades_side_ck" CHECK ("news_signal_trades"."side" in ('long', 'short')),
	CONSTRAINT "news_signal_trades_status_ck" CHECK ("news_signal_trades"."status" in ('open', 'closing', 'closed')),
	CONSTRAINT "news_signal_trades_closed_ck" CHECK (("news_signal_trades"."status" = 'closed') = ("news_signal_trades"."closed_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "news_signals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"story_key" text NOT NULL,
	"cycle_at" timestamp with time zone NOT NULL,
	"article_id" text NOT NULL,
	"market" text NOT NULL,
	"kind" text NOT NULL,
	"catalyst" text NOT NULL,
	"side" text NOT NULL,
	"level" text NOT NULL,
	"first_published_at" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"quote_bid" numeric(38, 18),
	"quote_ask" numeric(38, 18),
	"quote_mid" numeric(38, 18),
	"quote_at" timestamp with time zone,
	"typical_by_hold_hours" jsonb NOT NULL,
	"classifier_version" text NOT NULL,
	"asset_map_version" text NOT NULL,
	"rule_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_signals_kind_ck" CHECK ("news_signals"."kind" in ('crypto', 'stock')),
	CONSTRAINT "news_signals_side_ck" CHECK ("news_signals"."side" in ('long', 'short')),
	CONSTRAINT "news_signals_level_ck" CHECK ("news_signals"."level" in ('high', 'medium', 'low')),
	CONSTRAINT "news_signals_expiry_ck" CHECK ("news_signals"."expires_at" > "news_signals"."decided_at")
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "signal_version_id" uuid;--> statement-breakpoint
ALTER TABLE "news_signal_commands" ADD CONSTRAINT "news_signal_commands_trade_id_news_signal_trades_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."news_signal_trades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_signal_commands" ADD CONSTRAINT "news_signal_commands_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_signal_deliveries" ADD CONSTRAINT "news_signal_deliveries_signal_id_news_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."news_signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_signal_deliveries" ADD CONSTRAINT "news_signal_deliveries_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_signal_trades" ADD CONSTRAINT "news_signal_trades_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_signal_trades" ADD CONSTRAINT "news_signal_trades_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_signal_trades" ADD CONSTRAINT "news_signal_trades_signal_id_news_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."news_signals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "news_signal_commands_trade_seq_uq" ON "news_signal_commands" USING btree ("trade_id","seq");--> statement-breakpoint
CREATE INDEX "news_signal_commands_pending_idx" ON "news_signal_commands" USING btree ("status","created_at") WHERE "news_signal_commands"."status" in ('queued', 'applying', 'unknown');--> statement-breakpoint
CREATE INDEX "news_signal_deliveries_bot_idx" ON "news_signal_deliveries" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "news_signal_trades_account_market_open_uq" ON "news_signal_trades" USING btree ("sodex_account_id","market") WHERE "news_signal_trades"."status" in ('open', 'closing');--> statement-breakpoint
CREATE UNIQUE INDEX "news_signal_trades_bot_seq_uq" ON "news_signal_trades" USING btree ("bot_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "news_signal_trades_bot_signal_uq" ON "news_signal_trades" USING btree ("bot_id","signal_id");--> statement-breakpoint
CREATE INDEX "news_signal_trades_bot_status_idx" ON "news_signal_trades" USING btree ("bot_id","status","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "news_signals_story_cycle_uq" ON "news_signals" USING btree ("story_key","cycle_at");--> statement-breakpoint
CREATE INDEX "news_signals_expires_idx" ON "news_signals" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "news_signals_decided_idx" ON "news_signals" USING btree ("decided_at");--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_signal_version_id_signal_bot_versions_id_fk" FOREIGN KEY ("signal_version_id") REFERENCES "public"."signal_bot_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "news_signals_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'news signal is immutable' USING ERRCODE = 'check_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "news_signals_immutable_trg" BEFORE UPDATE OR DELETE ON "news_signals"
  FOR EACH ROW EXECUTE FUNCTION "news_signals_immutable"();
