#!/usr/bin/env bash
# Build lại và chạy toàn bộ DRIFT local (hạ tầng dev + app), kèm migration. Chạy lại sau mỗi lần đổi code.
#
#   scripts/dev-up.sh              # build lại + chạy mọi service
#   scripts/dev-up.sh web api      # chỉ build lại + restart các service này (hạ tầng / migration vẫn chạy)
#   DEV_FULL_REPLICAS=1 scripts/dev-up.sh   # giữ số bản như docker-compose.yml (mặc định local: 1 bản / service)
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

# Local chỉ chạy 1 instance mỗi service (docker-compose.yml đặt 2–3 bản cho giống production nhiều instance).
# Máy dev nhẹ hơn và khởi động nhanh hơn. Cần thử nhiều instance (lock, race giữa engine…) thì chạy
# `DEV_FULL_REPLICAS=1 scripts/dev-up.sh` để giữ số bản trong docker-compose.yml.
# Đọc số bản bằng node (đã có sẵn cho pnpm); service đặt 0 bản (migrate) không bị đụng tới.
scale_args() {
  [ "${DEV_FULL_REPLICAS:-}" = "1" ] && return 0
  "${COMPOSE[@]}" config --format json | node -e '
    const only = process.argv.slice(1);
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      for (const [name, svc] of Object.entries(JSON.parse(s).services)) {
        const n = svc.deploy?.replicas ?? 1;
        if (n > 1 && (only.length === 0 || only.includes(name))) console.log(`--scale\n${name}=1`);
      }
    });' "$@"
}

if [ "$#" -gt 0 ]; then
  step "Build lại và restart: $*"
  SCALE=()
  while IFS= read -r a; do SCALE+=("$a"); done < <(scale_args "$@")
  # --no-deps: chỉ đụng tới đúng các service được nêu. Không có cờ này, build lại api còn khởi động lại signer
  # (api phụ thuộc signer), làm bot đang chạy không ký được lệnh huỷ trong vài giây (sự cố 2026-11-04, DEC-111).
  "${COMPOSE[@]}" up -d --build --no-deps ${SCALE[@]+"${SCALE[@]}"} "$@"
else
  step "Build lại và chạy mọi service"
  SCALE=()
  while IFS= read -r a; do SCALE+=("$a"); done < <(scale_args)
  "${COMPOSE[@]}" up -d --build ${SCALE[@]+"${SCALE[@]}"}
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
