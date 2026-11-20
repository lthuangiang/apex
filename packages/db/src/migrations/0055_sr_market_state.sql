-- Catalyst P0 (#376): trạng thái thị trường lúc quyết định trong snapshot ngữ cảnh (BTC trend 24 h, volatility 4 h của tài sản).
-- Nullable: snapshot trước #376 là "Not recorded". Chỉ để tách kết quả, không đổi quyết định.
ALTER TABLE "signal_contexts" ADD COLUMN "market_version" text;--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "market_btc_change_24h_pct" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "market_btc_trend" text;--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "market_vol_4h_pct" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "market_vol_percentile" numeric(10, 4);--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD COLUMN "market_volatility" text;--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD CONSTRAINT "signal_contexts_btc_trend_ck" CHECK ("signal_contexts"."market_btc_trend" is null or "signal_contexts"."market_btc_trend" in ('up', 'flat', 'down'));--> statement-breakpoint
ALTER TABLE "signal_contexts" ADD CONSTRAINT "signal_contexts_volatility_ck" CHECK ("signal_contexts"."market_volatility" is null or "signal_contexts"."market_volatility" in ('low', 'normal', 'high'));