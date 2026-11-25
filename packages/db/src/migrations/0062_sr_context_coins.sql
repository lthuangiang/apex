-- #530 PR2 (DEC-393): snapshot ngữ cảnh cho các coin KHÁC coin chính của một bài nêu nhiều coin. Bảng mới, cùng cột và
-- cùng trigger chặn UPDATE với signal_contexts. signal_contexts KHÔNG đổi (giữ unique theo article_id), nên bản scheduler /
-- api trước PR này vẫn ghi / đọc được (ON CONFLICT (article_id)) khi migration chạy trước hoặc khi rollback. Chỉ thêm.
CREATE TABLE "signal_context_coins" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_id" text NOT NULL,
	"market" text NOT NULL,
	"direction" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"context_version" text NOT NULL,
	"rule_version" text NOT NULL,
	"h1_status" text NOT NULL,
	"h1_wallets_checked" integer,
	"h1_asset_on_hyperliquid" boolean,
	"h1_wallet_set_version" integer,
	"h1_wallet_set_size" integer,
	"h1_agreeing_wallets" integer,
	"h1_opposing_wallets" integer,
	"h1_agreeing_addresses" text[],
	"h1_opposing_addresses" text[],
	"h1_agreeing_usdc" numeric(38, 18),
	"h1_first_at" timestamp with time zone,
	"h2_status" text NOT NULL,
	"h2_funding_rate" numeric(38, 18),
	"h2_funding_time" timestamp with time zone,
	"h2_percentile" numeric(10, 4),
	"h2_samples" integer,
	"h2_payer" text,
	"h2_interval_hours" numeric(10, 2),
	"h3_status" text NOT NULL,
	"h3_moved_pct" numeric(38, 18),
	"h3_typical_move_pct" numeric(38, 18),
	"volume_vs_24h" numeric(38, 18),
	"range_breakout" text,
	"market_version" text,
	"market_btc_change_24h_pct" numeric(38, 18),
	"market_btc_trend" text,
	"market_vol_4h_pct" numeric(38, 18),
	"market_vol_percentile" numeric(10, 4),
	"market_volatility" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_context_coins_source_ck" CHECK ("signal_context_coins"."source" in ('live', 'backfilled')),
	CONSTRAINT "signal_context_coins_direction_ck" CHECK ("signal_context_coins"."direction" in ('long', 'short')),
	CONSTRAINT "signal_context_coins_h1_ck" CHECK ("signal_context_coins"."h1_status" in ('yes', 'no', 'against', 'na')),
	CONSTRAINT "signal_context_coins_h2_ck" CHECK ("signal_context_coins"."h2_status" in ('yes', 'no', 'na')),
	CONSTRAINT "signal_context_coins_h3_ck" CHECK ("signal_context_coins"."h3_status" in ('yes', 'no', 'na')),
	CONSTRAINT "signal_context_coins_payer_ck" CHECK ("signal_context_coins"."h2_payer" is null or "signal_context_coins"."h2_payer" in ('long', 'short', 'none')),
	CONSTRAINT "signal_context_coins_breakout_ck" CHECK ("signal_context_coins"."range_breakout" is null or "signal_context_coins"."range_breakout" in ('up', 'down', 'none')),
	CONSTRAINT "signal_context_coins_btc_trend_ck" CHECK ("signal_context_coins"."market_btc_trend" is null or "signal_context_coins"."market_btc_trend" in ('up', 'flat', 'down')),
	CONSTRAINT "signal_context_coins_volatility_ck" CHECK ("signal_context_coins"."market_volatility" is null or "signal_context_coins"."market_volatility" in ('low', 'normal', 'high'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "signal_context_coins_article_market_uq" ON "signal_context_coins" USING btree ("article_id","market");--> statement-breakpoint
CREATE INDEX "signal_context_coins_decided_idx" ON "signal_context_coins" USING btree ("decided_at");--> statement-breakpoint
CREATE TRIGGER "signal_context_coins_immutable_trg" BEFORE UPDATE ON "signal_context_coins"
  FOR EACH ROW EXECUTE FUNCTION "signal_contexts_immutable"();
