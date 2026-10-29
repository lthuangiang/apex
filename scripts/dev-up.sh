#!/usr/bin/env bash
# Build lại và chạy toàn bộ DRIFT local (hạ tầng dev + app), kèm migration. Chạy lại sau mỗi lần đổi code.
#
#   scripts/dev-up.sh              # build lại + chạy mọi service
#   scripts/dev-up.sh web api      # chỉ build lại + restart các service này (hạ tầng / migration vẫn chạy)
#
# Không bao giờ chạy `docker compose down -v`: lệnh đó xoá database và dữ liệu Vault.
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE=(docker compose --profile dev --profile app)

step() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m✕ %s\033[0m\n' "$*" >&2; exit 1; }

docker info >/dev/null 2>&1 || fail "Docker chưa chạy. Mở Docker Desktop rồi chạy lại."
[ -f .env ] || fail "Thiếu .env. Chạy: cp .env.example .env rồi điền giá trị."

if [ ! -f infra/certs/dev/ca.crt ]; then
  step "Tạo cert mTLS cho signer (lần đầu)"
  infra/certs/gen-dev-certs.sh infra/certs/dev
fi

step "Hạ tầng dev (postgres, redis, nats, vault, mailpit)"
docker compose --profile dev up -d

step "Migration database"
"${COMPOSE[@]}" build migrate
"${COMPOSE[@]}" run --rm migrate

if [ "$#" -gt 0 ]; then
  step "Build lại và restart: $*"
  "${COMPOSE[@]}" up -d --build "$@"
else
  step "Build lại và chạy mọi service"
  "${COMPOSE[@]}" up -d --build
fi

step "Chờ các service healthy"
deadline=$((SECONDS + 180))
while :; do
  pending=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' | grep -E "starting|unhealthy|Restarting" || true)
  [ -z "$pending" ] && break
  if [ "$SECONDS" -ge "$deadline" ]; then
    printf '%s\n' "$pending"
    fail "Còn service chưa healthy sau 3 phút. Xem log: docker compose logs -f <service>"
  fi
  sleep 3
done

exited=$("${COMPOSE[@]}" ps -a --format '{{.Service}} {{.Status}}' | grep -E "Exited \([1-9]" | grep -v "^migrate " || true)
[ -z "$exited" ] || { printf '%s\n' "$exited"; fail "Có service bị dừng do lỗi. Xem log: docker compose logs <service>"; }

"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
cat <<'EOF'

✓ DRIFT đang chạy
  Web       http://localhost        (chưa đăng nhập → /signup)
  Mã OTP    http://localhost:8025   (Mailpit)
  Log       docker compose logs -f api   (đổi api thành service cần xem)
EOF
