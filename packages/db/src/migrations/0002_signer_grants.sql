-- Quyền tối thiểu cho signer (docs/ARCHITECTURE.md mục 3.3.8): chỉ bảng api_keys.
-- Role drift_signer do infra/postgres/01-signer-role.sh tạo; môi trường không có role này (test) thì bỏ qua.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drift_signer') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE api_keys TO drift_signer;
  END IF;
END
$$;
