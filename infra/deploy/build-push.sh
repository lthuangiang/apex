#!/usr/bin/env bash
# Build image các app DRIFT và đẩy lên repo private Docker Hub; tuỳ chọn deploy luôn lên VPS (DEC-70).
# Chạy được từ bất kỳ đâu: script tự về gốc repo.
#
#   infra/deploy/build-push.sh                         # build + push cả 10 app
#   infra/deploy/build-push.sh web api                 # chỉ một số app
#   infra/deploy/build-push.sh --deploy root@1.2.3.4   # build + push + deploy
#
# Biến môi trường (đều có mặc định):
#   DRIFT_IMAGE   repo Docker Hub           (mặc định docker.io/lthuangiang/drift)
#   PLATFORM      kiến trúc của VPS          (mặc định linux/amd64; VPS ARM như Hetzner CAX: linux/arm64)
#   TAG           tag của lần build          (mặc định git SHA, không có git thì thời điểm UTC)
# Mỗi image có 2 tag: <app>-<TAG> và <app>-latest.
# Cần `docker login` trước (Docker Desktop đã đăng nhập là đủ).
set -euo pipefail

cd "$(dirname "$0")/../.."
[ -f pnpm-workspace.yaml ] || { echo "error: cannot find the repo root" >&2; exit 1; }

IMAGE="${DRIFT_IMAGE:-docker.io/lthuangiang/drift}"
PLATFORM="${PLATFORM:-linux/amd64}"
TAG="${TAG:-$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
ALL_APPS=(api backtest engine jobs marketdata realtime reco scheduler signer web)

TARGET=""
APPS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy) TARGET="${2:?--deploy needs user@host}"; shift 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) APPS+=("$1"); shift ;;
  esac
done
[ ${#APPS[@]} -gt 0 ] || APPS=("${ALL_APPS[@]}")
for app in "${APPS[@]}"; do
  [ -f "apps/$app/Dockerfile" ] || { echo "error: unknown app '$app' (apps: ${ALL_APPS[*]})" >&2; exit 1; }
done
if [ -n "$TARGET" ] && [ ${#APPS[@]} -ne ${#ALL_APPS[@]} ]; then
  echo "error: --deploy needs all 10 apps built with the same tag" >&2; exit 1
fi

docker info >/dev/null 2>&1 || { echo "error: Docker is not running" >&2; exit 1; }

# WalletConnect Project ID nhúng vào web lúc build (NEXT_PUBLIC_*); đọc từ .env nếu chưa đặt.
WC="${WALLETCONNECT_PROJECT_ID:-}"
[ -n "$WC" ] || [ ! -f .env ] || WC="$(sed -n 's/^WALLETCONNECT_PROJECT_ID=//p' .env | tail -n 1)"

echo "image:    $IMAGE"
echo "platform: $PLATFORM"
echo "tag:      $TAG"
echo "apps:     ${APPS[*]}"
echo

START=$(date +%s)
for app in "${APPS[@]}"; do
  echo "==> $app"
  docker buildx build --platform "$PLATFORM" \
    -f "apps/$app/Dockerfile" \
    --build-arg "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=$WC" \
    -t "$IMAGE:$app-$TAG" -t "$IMAGE:$app-latest" \
    --push .
done
echo
echo "pushed $IMAGE:<app>-$TAG in $(( $(date +%s) - START ))s"

if [ -n "$TARGET" ]; then
  echo "==> deploy $TAG to $TARGET"
  # Chỉ chép compose + infra, không chép .env hay cert.
  rsync -az -e "ssh -o StrictHostKeyChecking=accept-new" --relative docker-compose.yml docker-compose.prod.yml \
    infra/postgres/ infra/vault/ infra/deploy/ "$TARGET:/opt/drift/"
  ssh -o StrictHostKeyChecking=accept-new "$TARGET" "bash /opt/drift/infra/deploy/deploy.sh '$TAG'"
fi
