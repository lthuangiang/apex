CREATE TABLE "account_analyses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"import_id" uuid,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"metrics" jsonb NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "candles_1m" (
	"market" text NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"open" numeric(38, 18) NOT NULL,
	"high" numeric(38, 18) NOT NULL,
	"low" numeric(38, 18) NOT NULL,
	"close" numeric(38, 18) NOT NULL,
	"volume" numeric(38, 18) NOT NULL,
	CONSTRAINT "candles_1m_market_ts_pk" PRIMARY KEY("market","ts")
);
--> statement-breakpoint
CREATE TABLE "funding_payments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"bot_id" uuid,
	"position_id" bigint NOT NULL,
	"market" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "funding_rates" (
	"market" text NOT NULL,
	"funding_time" timestamp with time zone NOT NULL,
	"rate" numeric(38, 18) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "funding_rates_market_funding_time_pk" PRIMARY KEY("market","funding_time")
);
--> statement-breakpoint
CREATE TABLE "history_positions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"position_id" bigint NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"avg_entry_price" numeric(38, 18) NOT NULL,
	"avg_close_price" numeric(38, 18) NOT NULL,
	"closed_size" numeric(38, 18) NOT NULL,
	"trading_fee" numeric(38, 18) NOT NULL,
	"realized_pnl" numeric(38, 18) NOT NULL,
	"leverage" integer NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "history_trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"trade_id" bigint NOT NULL,
	"order_id" bigint NOT NULL,
	"cl_ord_id" text NOT NULL,
	"market" text NOT NULL,
	"side" text NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"fee" numeric(38, 18),
	"builder_fee" numeric(38, 18),
	"fee_coin" text,
	"is_maker" boolean,
	"traded_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"sodex_account_id" uuid NOT NULL,
	"status" text NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"coverage" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_stats_daily" (
	"market" text NOT NULL,
	"engine" text NOT NULL,
	"date" date NOT NULL,
	"sigma30" double precision,
	"p5" numeric(38, 18),
	"p50" numeric(38, 18),
	"p95" numeric(38, 18),
	"last_price" numeric(38, 18),
	"trend" double precision,
	"range_score" double precision,
	"funding_avg7d" numeric(38, 18),
	"funding_pos21" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_stats_daily_market_date_pk" PRIMARY KEY("market","date")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account_analyses" ADD CONSTRAINT "account_analyses_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_analyses" ADD CONSTRAINT "account_analyses_import_id_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."imports"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "funding_payments" ADD CONSTRAINT "funding_payments_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_positions" ADD CONSTRAINT "history_positions_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "history_trades" ADD CONSTRAINT "history_trades_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_sodex_account_id_sodex_accounts_id_fk" FOREIGN KEY ("sodex_account_id") REFERENCES "public"."sodex_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_analyses_account_idx" ON "account_analyses" USING btree ("sodex_account_id","computed_at");--> statement-breakpoint
CREATE INDEX "account_analyses_import_idx" ON "account_analyses" USING btree ("import_id");--> statement-breakpoint
CREATE UNIQUE INDEX "funding_payments_key" ON "funding_payments" USING btree ("sodex_account_id","position_id","paid_at");--> statement-breakpoint
CREATE INDEX "funding_payments_bot_idx" ON "funding_payments" USING btree ("bot_id");--> statement-breakpoint
CREATE UNIQUE INDEX "history_positions_key" ON "history_positions" USING btree ("sodex_account_id","position_id");--> statement-breakpoint
CREATE INDEX "history_positions_account_time_idx" ON "history_positions" USING btree ("sodex_account_id","closed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "history_trades_key" ON "history_trades" USING btree ("sodex_account_id","engine","trade_id");--> statement-breakpoint
CREATE INDEX "history_trades_account_time_idx" ON "history_trades" USING btree ("sodex_account_id","traded_at");--> statement-breakpoint
CREATE INDEX "imports_account_idx" ON "imports" USING btree ("sodex_account_id","created_at");--> statement-breakpoint
CREATE INDEX "outbox_unpublished_idx" ON "outbox" USING btree ("created_at") WHERE "outbox"."published_at" is null;--> statement-breakpoint
-- candles_1m là Timescale hypertable (DOMAIN.md mục 7.5).
SELECT create_hypertable('candles_1m', 'ts', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
