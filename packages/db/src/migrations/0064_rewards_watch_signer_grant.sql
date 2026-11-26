-- #558 PR2 (DEC-398): signer giải mã phiên rewards của một user cho scheduler. Chỉ cần đọc ba cột của rewards_watch
-- (không ghi: api / scheduler ghi bảng này). Quyền theo cột để signer không đọc mốc hay dữ liệu khác.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'drift_signer') THEN
    GRANT SELECT (user_id, status, token_ciphertext) ON TABLE rewards_watch TO drift_signer;
  END IF;
END
$$;
