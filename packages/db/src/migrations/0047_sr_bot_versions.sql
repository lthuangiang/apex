-- Signal research: News bot versions (#303, DEC-328). Thêm bảng / cột nullable; seed version Baseline = tham số quyết
-- định của NEWS_RULES lúc migration (news-v3, test `baselineVersionConfig()` so sánh), gắn lệnh / story / event Filter-
-- Decide-Watch của news-v3 vào Baseline (news-v2 để version_id null: chỉ là lịch sử, DEC-329). `created_at` của Baseline
-- = lúc news-v3 bắt đầu = sớm nhất trong (collected_at của bài, at của event, opened_at của lệnh) có rule_version
-- news-v3; chưa có gì thì now(). Trigger: config bất biến, tối đa 3 version `running`.
CREATE TABLE "signal_bot_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"number" integer NOT NULL,
	"name" text NOT NULL,
	"config" jsonb NOT NULL,
	"status" text NOT NULL,
	"created_by" uuid,
	"saved_from_version_id" uuid,
	"is_baseline" boolean DEFAULT false NOT NULL,
	"status_changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signal_classifier_versions" (
	"prompt_version" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "signal_paper_trades_open_uq";--> statement-breakpoint
ALTER TABLE "signal_events" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "classifier_version" text;--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "shadow_reason" text;--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "opposite_story_id" uuid;--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "opposite_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "opposite_exit_price" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "opposite_result_usdc" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_paper_trades" ADD COLUMN "opposite_result_pct" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_stories" ADD COLUMN "version_id" uuid;--> statement-breakpoint
ALTER TABLE "signal_bot_versions" ADD CONSTRAINT "signal_bot_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "signal_bot_versions_number_uq" ON "signal_bot_versions" USING btree ("number");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_bot_versions_baseline_uq" ON "signal_bot_versions" USING btree ("is_baseline") WHERE "signal_bot_versions"."is_baseline";--> statement-breakpoint
CREATE INDEX "signal_bot_versions_status_idx" ON "signal_bot_versions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "signal_paper_trades_version_idx" ON "signal_paper_trades" USING btree ("version_id","status","opened_at");--> statement-breakpoint
CREATE INDEX "signal_stories_version_key_idx" ON "signal_stories" USING btree ("version_id","story_key","first_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_paper_trades_open_uq" ON "signal_paper_trades" USING btree ("lane","version_id","label","market") WHERE "signal_paper_trades"."status" = 'open' and "signal_paper_trades"."label" in ('live', 'shadow');--> statement-breakpoint
ALTER TABLE "signal_bot_versions" ADD CONSTRAINT "signal_bot_versions_status_ck" CHECK ("status" in ('running', 'paused', 'stopped', 'retired'));--> statement-breakpoint
CREATE FUNCTION "signal_bot_versions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.config IS DISTINCT FROM OLD.config OR NEW.number <> OLD.number OR NEW.name <> OLD.name
    OR NEW.is_baseline <> OLD.is_baseline OR NEW.created_at <> OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.saved_from_version_id IS DISTINCT FROM OLD.saved_from_version_id
  ) THEN
    RAISE EXCEPTION 'signal bot version is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'running' AND (TG_OP = 'INSERT' OR OLD.status <> 'running') THEN
    PERFORM pg_advisory_xact_lock(hashtext('signal_bot_versions_running'));
    IF (SELECT count(*) FROM "signal_bot_versions" WHERE "status" = 'running' AND "id" <> NEW.id) >= 3 THEN
      RAISE EXCEPTION 'at most 3 signal bot versions can run at once' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "signal_bot_versions_guard_trg" BEFORE INSERT OR UPDATE ON "signal_bot_versions"
  FOR EACH ROW EXECUTE FUNCTION "signal_bot_versions_guard"();--> statement-breakpoint
INSERT INTO "signal_bot_versions" ("id", "number", "name", "config", "status", "is_baseline", "status_changed_at", "created_at", "updated_at")
SELECT gen_random_uuid(), 3, 'Baseline', '{"news":{"hack_exploit":{"enabled":true,"maxHoldHours":24},"listing":{"enabled":true,"maxHoldHours":24},"delisting":{"enabled":true,"maxHoldHours":48},"etf_approved":{"enabled":true,"maxHoldHours":72},"etf_delayed_or_rejected":{"enabled":true,"maxHoldHours":48},"regulatory_action":{"enabled":true,"maxHoldHours":72},"favorable_ruling":{"enabled":true,"maxHoldHours":72},"treasury_buy":{"enabled":true,"maxHoldHours":48},"treasury_sell":{"enabled":true,"maxHoldHours":48},"earnings_beat":{"enabled":true,"maxHoldHours":72},"earnings_miss":{"enabled":true,"maxHoldHours":72},"token_unlock":{"enabled":true,"maxHoldHours":48}},"minLevel":"low","maxSourceDelayMinutes":30,"sizeUsdc":"500","tpMultiple":"1.5","slMultiple":"0.75","minTpCostMultiple":"2","assets":{"mode":"all","markets":[],"crypto":true,"stocks":true},"maxOpenTrades":20,"maxNewTradesPerDay":null,"onOppositeNews":"keep"}'::jsonb, 'running', true, now(), t.at, now()
FROM (
  SELECT LEAST(
    now(),
    coalesce((SELECT min("collected_at") FROM "signal_articles" WHERE "rule_version" = 'news-v3'), now()),
    coalesce((SELECT min("at") FROM "signal_events" WHERE "rule_version" = 'news-v3'), now()),
    coalesce((SELECT min("opened_at") FROM "signal_paper_trades" WHERE "rule_version" = 'news-v3'), now())
  ) AS at
) t;--> statement-breakpoint
UPDATE "signal_paper_trades" SET "version_id" = (SELECT "id" FROM "signal_bot_versions" WHERE "is_baseline")
WHERE "lane" = 'news' AND "label" = 'live' AND "rule_version" = 'news-v3';--> statement-breakpoint
UPDATE "signal_paper_trades" t SET "classifier_version" = a."claude_prompt_version"
FROM "signal_articles" a WHERE a."id" = t."article_id" AND t."lane" = 'news';--> statement-breakpoint
UPDATE "signal_stories" SET "version_id" = (SELECT "id" FROM "signal_bot_versions" WHERE "is_baseline")
WHERE "rule_version" = 'news-v3';--> statement-breakpoint
UPDATE "signal_events" SET "version_id" = (SELECT "id" FROM "signal_bot_versions" WHERE "is_baseline")
WHERE "stage" IN ('filter', 'decide', 'watch') AND "rule_version" = 'news-v3';--> statement-breakpoint
INSERT INTO "signal_classifier_versions" ("prompt_version", "model", "started_at")
SELECT "claude_prompt_version", min(coalesce("claude_model", 'claude-haiku-4-5')), min(coalesce("classified_at", "collected_at"))
FROM "signal_articles" WHERE "claude_prompt_version" IS NOT NULL
GROUP BY "claude_prompt_version";
