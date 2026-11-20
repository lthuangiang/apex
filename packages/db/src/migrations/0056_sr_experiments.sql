ALTER TABLE "signal_bot_versions" ADD COLUMN "hypothesis" text;--> statement-breakpoint
ALTER TABLE "signal_bot_versions" ADD COLUMN "experiment_finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "signal_bot_versions" ADD COLUMN "experiment_result" jsonb;--> statement-breakpoint
-- #377 (DEC-TBD-sr-experiments): giả thuyết bất biến như config; kết quả thí nghiệm ghi MỘT lần (lúc version tự dừng vì đủ
-- 100 cặp) và không bao giờ trên Baseline. Phần còn lại của guard giữ nguyên như 0047.
CREATE OR REPLACE FUNCTION "signal_bot_versions_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.config IS DISTINCT FROM OLD.config OR NEW.number <> OLD.number OR NEW.name <> OLD.name
    OR NEW.is_baseline <> OLD.is_baseline OR NEW.created_at <> OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR NEW.saved_from_version_id IS DISTINCT FROM OLD.saved_from_version_id
    OR NEW.hypothesis IS DISTINCT FROM OLD.hypothesis
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
  IF NEW.status = 'running' AND (TG_OP = 'INSERT' OR OLD.status <> 'running') THEN
    PERFORM pg_advisory_xact_lock(hashtext('signal_bot_versions_running'));
    IF (SELECT count(*) FROM "signal_bot_versions" WHERE "status" = 'running' AND "id" <> NEW.id) >= 3 THEN
      RAISE EXCEPTION 'at most 3 signal bot versions can run at once' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
