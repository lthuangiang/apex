#!/usr/bin/env bash
# Build image các app DRIFT và đẩy lên repo private Docker Hub; tuỳ chọn deploy luôn lên VPS (DEC-70).
# Chạy được từ bất kỳ đâu: script tự về gốc repo.
#
#   infra/deploy/build-push.sh                          # build + push cả 11 app
#   infra/deploy/build-push.sh web api                  # chỉ một số app
#   infra/deploy/build-push.sh --deploy                 # build + push + deploy lên DEPLOY_TARGET
#   infra/deploy/build-push.sh --deploy engine web      # chỉ build engine, web; app khác giữ image đang chạy
#   infra/deploy/build-push.sh --deploy root@1.2.3.4    # deploy lên máy khác
#   infra/deploy/build-push.sh --deploy-only 20261106101500   # không build, deploy một tag đã push
#
# Biến môi trường (đều có mặc định):
#   DRIFT_IMAGE      repo Docker Hub        (mặc định docker.io/lthuangiang/drift)
#   PLATFORM         kiến trúc của VPS      (mặc định linux/amd64; VPS ARM như Hetzner CAX: linux/arm64)
#   TAG              tag của lần build      (mặc định yyyyMMddHHmmss lúc build, theo giờ máy)
#   DEPLOY_TARGET    user@host của VPS      (mặc định root@149.28.148.63)
#   DEPLOY_SSH_PASS  mật khẩu SSH, chỉ khi chưa dùng SSH key (cần `brew install sshpass`)
# Hai biến DEPLOY_* có thể để trong infra/deploy/.deploy.local (đã nằm trong .gitignore, không bao giờ commit):
#   DEPLOY_TARGET=root@149.28.148.63
#   DEPLOY_SSH_PASS=...
# Không đặt mật khẩu thì ssh hỏi một lần; các lệnh sau dùng lại kết nối đó (ControlMaster).
# Mỗi image có 2 tag: <app>-<TAG> và <app>-latest.
# Cần `docker login` trước (Docker Desktop đã đăng nhập là đủ).
#
# Deploy trên VPS (cd /opt/drift, một docker-compose.yml duy nhất): đổi DRIFT_TAG trong .env → docker compose pull
# → docker compose run --rm migrate → docker compose up -d → xoá image DRIFT cũ (giữ tag hiện tại và tag liền trước)
# + layer treo. Không chép file nào lên VPS.
set -euo pipefail

cd "$(dirname "$0")/../.."
[ -f pnpm-workspace.yaml ] || { echo "error: cannot find the repo root" >&2; exit 1; }

LOCAL_CONF="infra/deploy/.deploy.local"
# shellcheck disable=SC1090
[ ! -f "$LOCAL_CONF" ] || . "$LOCAL_CONF"

IMAGE="${DRIFT_IMAGE:-docker.io/lthuangiang/drift}"
PLATFORM="${PLATFORM:-linux/amd64}"
# Ngày giờ phút giây lúc build (giờ máy): mỗi lần build một tag riêng, để rollback được.
TAG="${TAG:-$(date +%Y%m%d%H%M%S)}"
ALL_APPS=(api backtest engine jobs marketdata mcp realtime reco scheduler signer web)
DEFAULT_TARGET="${DEPLOY_TARGET:-root@149.28.148.63}"

is_app() {
  local a
  for a in "${ALL_APPS[@]}"; do [ "$a" = "$1" ] && return 0; done
  return 1
}

DEPLOY=0
BUILD=1
TARGET=""
APPS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --deploy)
      DEPLOY=1
      # user@host không bắt buộc: thiếu thì dùng DEPLOY_TARGET.
      if [ $# -gt 1 ] && [[ "$2" == *@* ]]; then TARGET="$2"; shift; fi
      shift ;;
    --deploy-only)
      DEPLOY=1; BUILD=0; TAG="${2:?--deploy-only needs a tag}"; shift 2 ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) APPS+=("$1"); shift ;;
  esac
done
TARGET="${TARGET:-$DEFAULT_TARGET}"
[ ${#APPS[@]} -gt 0 ] || APPS=("${ALL_APPS[@]}")
for app in "${APPS[@]}"; do
  is_app "$app" && [ -f "apps/$app/Dockerfile" ] || {
    echo "error: unknown app '$app' (apps: ${ALL_APPS[*]})" >&2; exit 1;
  }
done

docker info >/dev/null 2>&1 || { echo "error: Docker is not running" >&2; exit 1; }

# ---------- SSH: một kết nối dùng chung cho mọi lệnh tới VPS ----------
SSH_SOCK="${TMPDIR:-/tmp}/drift-deploy-$$.sock"
SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ControlMaster=auto -o "ControlPath=$SSH_SOCK" -o ControlPersist=600)
remote() { ssh "${SSH_OPTS[@]}" "$TARGET" "$@"; }
close_ssh() { ssh "${SSH_OPTS[@]}" -O exit "$TARGET" >/dev/null 2>&1 || true; }

PREV=""
if [ "$DEPLOY" = 1 ]; then
  echo "==> connect $TARGET"
  if [ -n "${DEPLOY_SSH_PASS:-}" ]; then
    command -v sshpass >/dev/null || { echo "error: DEPLOY_SSH_PASS needs sshpass (brew install sshpass)" >&2; exit 1; }
    SSHPASS="$DEPLOY_SSH_PASS" sshpass -e ssh "${SSH_OPTS[@]}" -fN "$TARGET"
  else
    # Hỏi mật khẩu (hoặc dùng SSH key) một lần, trước khi build, để không phải chờ build xong mới biết sai.
    ssh "${SSH_OPTS[@]}" -fN "$TARGET"
  fi
  trap close_ssh EXIT
  remote "test -f /opt/drift/.env" || { echo "error: /opt/drift/.env missing on $TARGET" >&2; exit 1; }
  PREV="$(remote "sed -n 's/^DRIFT_TAG=//p' /opt/drift/.env" | tail -n 1)"
  echo "    running tag: ${PREV:-none}"
  if [ "$BUILD" = 1 ] && [ ${#APPS[@]} -ne ${#ALL_APPS[@]} ] && [ -z "$PREV" ]; then
    echo "error: no DRIFT_TAG on $TARGET yet; build all 11 apps for the first deploy" >&2; exit 1
  fi
fi

# ---------- Build + push ----------
if [ "$BUILD" = 1 ]; then
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

  # Chỉ build vài app: app còn lại được gắn thêm tag mới trỏ vào đúng image đang chạy trên VPS (chép trên
  # registry, không build lại), vì compose dùng một DRIFT_TAG chung cho mọi app.
  if [ "$DEPLOY" = 1 ] && [ ${#APPS[@]} -ne ${#ALL_APPS[@]} ]; then
    for app in "${ALL_APPS[@]}"; do
      built=0
      for b in "${APPS[@]}"; do [ "$b" = "$app" ] && built=1; done
      [ "$built" = 1 ] && continue
      echo "==> $app: reuse $app-$PREV as $app-$TAG"
      docker buildx imagetools create -t "$IMAGE:$app-$TAG" "$IMAGE:$app-$PREV" >/dev/null
    done
  fi
fi

# ---------- Deploy ----------
# Đúng các bước làm tay trên VPS: /opt/drift chỉ có một docker-compose.yml, nên KHÔNG chép compose của repo lên
# (sẽ ghi đè file đó) và không dùng deploy.sh. Thứ tự: đổi DRIFT_TAG → pull → migrate → up -d → dọn image.
# Dọn sau khi app mới đã lên (không phải trước khi pull) để lỗi pull / migrate không làm sập bản đang chạy.
if [ "$DEPLOY" = 1 ]; then
  echo "==> deploy ${PREV:-none} -> $TAG on $TARGET"
  remote "bash -s" "$TAG" "${PREV:-}" <<'REMOTE'
set -euo pipefail
TAG="$1"
PREV="${2:-}"
cd /opt/drift
if grep -q '^DRIFT_TAG=' .env; then sed -i "s/^DRIFT_TAG=.*/DRIFT_TAG=$TAG/" .env; else echo "DRIFT_TAG=$TAG" >> .env; fi
echo "DRIFT_TAG=$(sed -n 's/^DRIFT_TAG=//p' .env)"
docker compose pull
docker compose run --rm migrate
docker compose up -d
docker compose ps
# Dọn (DEC-214): chỉ xoá image DRIFT không thuộc tag hiện tại hay tag liền trước (rollback một bản không
# phải tải lại), rồi layer treo. Không đụng image hạ tầng (postgres, redis, nats, vault, traefik…), không prune toàn bộ.
IMAGE="$(sed -n 's/^DRIFT_IMAGE=//p' .env | tail -n 1)"
if [ -n "$IMAGE" ]; then
  docker images "$IMAGE" --format '{{.Repository}}:{{.Tag}}' | while read -r ref; do
    rel="${ref##*:}"; rel="${rel#*-}"
    case "$rel" in "$TAG" | "$PREV" | latest) ;; *) docker rmi "$ref" >/dev/null 2>&1 || true ;; esac
  done
fi
docker image prune -f
REMOTE
  echo "deployed $TAG (rollback: infra/deploy/build-push.sh --deploy-only ${PREV:-<old tag>})"
fi
