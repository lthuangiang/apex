#!/bin/sh
# Chạy một lần khi Postgres khởi tạo volume mới: tạo role riêng cho signer.
# Quyền trên bảng cấp bằng migration (0002_signer_grants). Không có mật khẩu mặc định.
set -eu
if [ -z "${SIGNER_DB_PASSWORD:-}" ]; then
  echo "SIGNER_DB_PASSWORD is required" >&2
  exit 1
fi
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v pw="$SIGNER_DB_PASSWORD" <<'SQL'
CREATE ROLE drift_signer LOGIN PASSWORD :'pw';
GRANT CONNECT ON DATABASE drift TO drift_signer;
GRANT USAGE ON SCHEMA public TO drift_signer;
SQL
