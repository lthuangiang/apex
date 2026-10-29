#!/usr/bin/env bash
# Chạy trên VPS (user deploy), do workflow .github/workflows/deploy.yml gọi: deploy.sh <git-sha>
# pull image → hạ tầng lên trước → migrate → mọi service lên và healthy → ghi tag. Không healthy trong 5 phút thì
# quay về tag trước. Migration không được rollback, nên migration phải tương thích ngược (docs/DEPLOY.md). DEC-70.
set -euo pipefail

TAG="${1:?usage: deploy.sh <tag>}"
cd /opt/drift
[ -f .env ] || { echo ".env missing in /opt/drift" >&2; exit 1; }

compose() {
  docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app --profile prod "$@"
}
set_tag() {
  if grep -q '^DRIFT_TAG=' .env; then sed -i "s/^DRIFT_TAG=.*/DRIFT_TAG=$1/" .env; else echo "DRIFT_TAG=$1" >> .env; fi
}

PREV="$(sed -n 's/^DRIFT_TAG=//p' .env)"
echo "deploy: $PREV -> $TAG"
set_tag "$TAG"

compose pull --quiet
compose up -d --no-build --wait --wait-timeout 300 postgres pgbouncer redis nats vault vault-init
compose run --rm --no-build migrate

if compose up -d --no-build --remove-orphans --wait --wait-timeout 300; then
  echo "deploy: $TAG healthy"
  # Giữ image vài ngày gần nhất để rollback được; xoá phần còn lại cho ổ 40 GB.
  docker image prune -af --filter "until=72h" >/dev/null
  exit 0
fi

echo "deploy: $TAG not healthy" >&2
compose ps >&2
if [ -n "$PREV" ] && [ "$PREV" != "$TAG" ]; then
  echo "deploy: rolling back to $PREV" >&2
  set_tag "$PREV"
  compose up -d --no-build --remove-orphans --wait --wait-timeout 300 || true
fi
exit 1
