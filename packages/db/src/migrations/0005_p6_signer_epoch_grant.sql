-- Signer kiểm tra `epoch` trước khi ký lệnh (ARCHITECTURE.md mục 3.3.2): chỉ cần đọc shard_epochs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drift_signer') THEN
    GRANT SELECT ON TABLE shard_epochs TO drift_signer;
  END IF;
END
$$;
