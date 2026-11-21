ALTER TABLE "signal_bot_versions" ADD COLUMN "owner_user_id" uuid;--> statement-breakpoint
ALTER TABLE "signal_classification_labels" ADD COLUMN "labeler" text DEFAULT 'team' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signal_research" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_bot_versions" ADD CONSTRAINT "signal_bot_versions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "signal_bot_versions_owner_status_idx" ON "signal_bot_versions" USING btree ("owner_user_id","status");--> statement-breakpoint
ALTER TABLE "signal_classification_labels" ADD CONSTRAINT "signal_classification_labels_labeler_ck" CHECK ("signal_classification_labels"."labeler" in ('team', 'tester'));--> statement-breakpoint
-- #423 (DEC-TBD-sr-menu-beta): Signal Research ra menu chính (BETA). `users.signal_research` mặc định tắt. Version có chủ
-- (`owner_user_id`, null = team) và trần 3 version `running` tính RIÊNG cho từng chủ (team là một chủ, mỗi người dùng một
-- chủ): khoá advisory theo chủ, đếm theo chủ. `owner_user_id` bất biến như config. Nhãn có `labeler` (team / tester) ghi
-- lúc lưu; nhãn cũ là `team` vì trước đây chỉ role team gắn được. Phần còn lại của guard giữ nguyên như 0056.
CREATE OR REPLACE FUNCTION "signal_bot_versions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.config IS DISTINCT FROM OLD.config OR NEW.number <> OLD.number OR NEW.name <> OLD.name
    OR NEW.is_baseline <> OLD.is_baseline OR NEW.created_at <> OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.saved_from_version_id IS DISTINCT FROM OLD.saved_from_version_id
    OR NEW.hypothesis IS DISTINCT FROM OLD.hypothesis
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
  ) THEN
    RAISE EXCEPTION 'signal bot version is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.experiment_finished_at IS NOT NULL AND (
    NEW.experiment_finished_at IS DISTINCT FROM OLD.experiment_finished_at
    OR NEW.experiment_result IS DISTINCT FROM OLD.experiment_result
  ) THEN
    RAISE EXCEPTION 'a finished experiment is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.is_baseline AND (NEW.experiment_finished_at IS NOT NULL OR NEW.experiment_result IS NOT NULL) THEN
    RAISE EXCEPTION 'baseline is never an experiment' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.is_baseline AND NEW.owner_user_id IS NOT NULL THEN
    RAISE EXCEPTION 'baseline belongs to the team' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'running' AND (TG_OP = 'INSERT' OR OLD.status <> 'running') THEN
    IF NEW.owner_user_id IS NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext('signal_bot_versions_running'));
    ELSE
      PERFORM pg_advisory_xact_lock(hashtext('signal_bot_versions_running:' || NEW.owner_user_id::text));
    END IF;
    IF (SELECT count(*) FROM "signal_bot_versions" WHERE "status" = 'running' AND "id" <> NEW.id
        AND "owner_user_id" IS NOT DISTINCT FROM NEW.owner_user_id) >= 3 THEN
      RAISE EXCEPTION 'at most 3 signal bot versions can run at once per owner' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
