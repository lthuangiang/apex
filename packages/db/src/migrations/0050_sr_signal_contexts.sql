-- Signal research: ngữ cảnh của tín hiệu tin (#329; #330 snapshot + H3, #331 H1, #332 H2). Một dòng mỗi bài qua Score,
-- chụp đúng lúc quyết định (bước 4, trước Filter), chỉ từ dữ liệu có timestamp < decided_at; không bao giờ tính lại
-- (trigger chặn UPDATE). Chỉ ghi, không chặn lệnh. Không có cột OI: SoDEX không có lịch sử OI trong dữ liệu đã lưu.
CREATE TABLE "signal_contexts" (
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
	"h1_agreeing_wallets" integer,
	"h1_opposing_wallets" integer,
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
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_contexts_source_ck" CHECK ("signal_contexts"."source" in ('live', 'backfilled')),
	CONSTRAINT "signal_contexts_direction_ck" CHECK ("signal_contexts"."direction" in ('long', 'short')),
	CONSTRAINT "signal_contexts_h1_ck" CHECK ("signal_contexts"."h1_status" in ('yes', 'no', 'against', 'na')),
	CONSTRAINT "signal_contexts_h2_ck" CHECK ("signal_contexts"."h2_status" in ('yes', 'no', 'na')),
	CONSTRAINT "signal_contexts_h3_ck" CHECK ("signal_contexts"."h3_status" in ('yes', 'no', 'na')),
	CONSTRAINT "signal_contexts_payer_ck" CHECK ("signal_contexts"."h2_payer" is null or "signal_contexts"."h2_payer" in ('long', 'short', 'none')),
	CONSTRAINT "signal_contexts_breakout_ck" CHECK ("signal_contexts"."range_breakout" is null or "signal_contexts"."range_breakout" in ('up', 'down', 'none'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "signal_contexts_article_uq" ON "signal_contexts" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "signal_contexts_decided_idx" ON "signal_contexts" USING btree ("decided_at");--> statement-breakpoint
CREATE INDEX "leader_events_market_at_idx" ON "leader_events" USING btree ("source","market","at");--> statement-breakpoint
CREATE FUNCTION "signal_contexts_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'signal context snapshot is immutable' USING ERRCODE = 'check_violation';
END
$$;--> statement-breakpoint
CREATE TRIGGER "signal_contexts_immutable_trg" BEFORE UPDATE ON "signal_contexts"
  FOR EACH ROW EXECUTE FUNCTION "signal_contexts_immutable"();
