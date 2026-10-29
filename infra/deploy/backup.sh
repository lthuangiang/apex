#!/usr/bin/env bash
# Backup hằng ngày trên VPS (cron từ bootstrap-vps.sh). DEC-70.
#   - Postgres: pg_dump định dạng custom.
#   - Vault (vaultdata + vaultinit), NATS, chứng chỉ Let's Encrypt: tar.gz của volume.
# Giữ 14 ngày trong /opt/drift/backups. Nếu đặt BACKUP_AGE_RECIPIENT (khoá công khai `age`) và RCLONE_REMOTE trong
# .env thì mã hoá rồi chép ra ngoài VPS. Bản Vault chứa unseal key + root token: KHÔNG BAO GIỜ chép ra ngoài khi
# chưa mã hoá.
set -euo pipefail
cd /opt/drift
env_get() { sed -n "s/^$1=//p" .env | tail -n 1; }
PROJECT="$(env_get COMPOSE_PROJECT_NAME)"; PROJECT="${PROJECT:-drift}"
BACKUP_AGE_RECIPIENT="$(env_get BACKUP_AGE_RECIPIENT)"
RCLONE_REMOTE="$(env_get RCLONE_REMOTE)"
OUT=/opt/drift/backups
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$OUT"

compose() {
  docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app --profile prod "$@"
}

compose exec -T postgres pg_dump -U drift -Fc drift > "$OUT/pg-$STAMP.dump"

for vol in vaultdata vaultinit natsdata letsencrypt; do
  # Ghi qua stdout để file thuộc user deploy (không phải root của container).
  docker run --rm -v "${PROJECT}_${vol}:/data:ro" alpine:3.20 tar czf - -C /data . \
    > "$OUT/${vol}-$STAMP.tar.gz"
done
chmod 600 "$OUT"/*-"$STAMP".*

if [ -n "$BACKUP_AGE_RECIPIENT" ] && [ -n "$RCLONE_REMOTE" ] && command -v rclone >/dev/null; then
  for f in "$OUT"/*-"$STAMP".*; do
    age -r "$BACKUP_AGE_RECIPIENT" -o "$f.age" "$f"
  done
  rclone copy "$OUT" "$RCLONE_REMOTE" --include "*-$STAMP.*.age"
  rm -f "$OUT"/*-"$STAMP".*.age
  echo "backup: $STAMP copied to $RCLONE_REMOTE (encrypted)"
else
  echo "backup: $STAMP kept on this server only (set BACKUP_AGE_RECIPIENT + RCLONE_REMOTE for off-site)"
fi

find "$OUT" -type f \( -name '*.dump' -o -name '*.tar.gz' \) -mtime +14 -delete
