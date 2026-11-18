-- Signal research, lane tin tức (#271): chỉ thêm bảng mới, không đụng bảng cũ (không khoá bảng đang dùng khi deploy).
CREATE TABLE "signal_articles" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"title" text,
	"content" text,
	"category" integer,
	"published_at" timestamp with time zone NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"matched_currencies" jsonb NOT NULL,
	"candidates" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"status" text NOT NULL,
	"duplicate_of" text,
	"classification" jsonb,
	"classified_at" timestamp with time zone,
	"rule_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_id" text,
	"story_id" uuid,
	"trade_id" uuid,
	"stage" text NOT NULL,
	"outcome" text NOT NULL,
	"reason" text,
	"detail" jsonb,
	"rule_version" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_paper_trades" (
	"id" uuid PRIMARY KEY NOT NULL,
	"lane" text NOT NULL,
	"label" text DEFAULT 'live' NOT NULL,
	"variant" text,
	"story_id" uuid,
	"article_id" text,
	"event_at" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	"score" numeric(20, 10),
	"flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"mfe_pct" numeric(38, 18),
	"mae_pct" numeric(38, 18),
	"market" text NOT NULL,
	"token" text NOT NULL,
	"catalyst" text NOT NULL,
	"direction" text NOT NULL,
	"size_usdc" numeric(38, 18) NOT NULL,
	"qty" numeric(38, 18) NOT NULL,
	"entry_price" numeric(38, 18) NOT NULL,
	"entry_mid" numeric(38, 18) NOT NULL,
	"spread_at_entry_pct" numeric(38, 18) NOT NULL,
	"fee_pct" numeric(38, 18) NOT NULL,
	"entry_fee" numeric(38, 18) NOT NULL,
	"typical_move_pct" numeric(38, 18) NOT NULL,
	"tp_pct" numeric(38, 18) NOT NULL,
	"sl_pct" numeric(38, 18) NOT NULL,
	"tp_price" numeric(38, 18) NOT NULL,
	"sl_price" numeric(38, 18) NOT NULL,
	"max_hold_until" timestamp with time zone NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"moved_before_entry_pct" numeric(38, 18),
	"level_at_entry" text NOT NULL,
	"sources_at_entry" jsonb NOT NULL,
	"outside_market_hours" boolean NOT NULL,
	"later_high" boolean DEFAULT false NOT NULL,
	"price_source" text NOT NULL,
	"status" text NOT NULL,
	"exit_price" numeric(38, 18),
	"exit_reason" text,
	"exited_at" timestamp with time zone,
	"exit_fee" numeric(38, 18),
	"result_usdc" numeric(38, 18),
	"result_pct" numeric(38, 18),
	"rule_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_research_usage" (
	"day" date PRIMARY KEY NOT NULL,
	"soso_requests" integer DEFAULT 0 NOT NULL,
	"claude_calls" integer DEFAULT 0 NOT NULL,
	"claude_input_tokens" bigint DEFAULT 0 NOT NULL,
	"claude_cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"claude_cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"claude_output_tokens" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_source_health" (
	"source" text PRIMARY KEY NOT NULL,
	"last_ok_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text,
	"watermark_at" timestamp with time zone,
	"last_cycle_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_stories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"story_key" text NOT NULL,
	"market" text NOT NULL,
	"catalyst" text NOT NULL,
	"direction" text NOT NULL,
	"first_article_id" text NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"sources" jsonb NOT NULL,
	"level_at_entry" text NOT NULL,
	"later_level" text NOT NULL,
	"rule_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "signal_articles_published_idx" ON "signal_articles" USING btree ("published_at");--> statement-breakpoint
CREATE INDEX "signal_articles_hash_idx" ON "signal_articles" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "signal_articles_status_idx" ON "signal_articles" USING btree ("status","published_at");--> statement-breakpoint
CREATE INDEX "signal_events_at_idx" ON "signal_events" USING btree ("at");--> statement-breakpoint
CREATE INDEX "signal_events_article_idx" ON "signal_events" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX "signal_events_story_idx" ON "signal_events" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "signal_events_trade_idx" ON "signal_events" USING btree ("trade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_paper_trades_open_uq" ON "signal_paper_trades" USING btree ("lane","market") WHERE "signal_paper_trades"."status" = 'open' and "signal_paper_trades"."label" = 'live';--> statement-breakpoint
CREATE INDEX "signal_paper_trades_opened_idx" ON "signal_paper_trades" USING btree ("opened_at");--> statement-breakpoint
CREATE INDEX "signal_paper_trades_story_idx" ON "signal_paper_trades" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "signal_stories_key_idx" ON "signal_stories" USING btree ("story_key","first_seen_at");