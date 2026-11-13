#!/usr/bin/env bash
# App nào cần build lại cho release (DEC-TBD-release-layers). In tên app, mỗi dòng một app.
#
#   infra/deploy/changed-apps.sh <tag-trước> <tag-hoặc-commit>   # so sánh hai mốc
#   infra/deploy/changed-apps.sh "" <tag>                       # không có tag trước → in cả 10 app
#
# Quy tắc theo file đổi giữa hai mốc (git diff --name-only):
# - apps/<app>/**                                   → app đó
# - packages/**, pnpm-lock.yaml, package.json, pnpm-workspace.yaml, tsconfig*, .dockerignore,
#   .github/workflows/release.yml, infra/deploy/changed-apps.sh  → cả 10 app
# - còn lại (docs, e2e, infra khác…)                → không app nào
# Biến DRY_RUN=1: in thêm lý do của từng app (để PM xem log).
set -euo pipefail

ALL_APPS=(api backtest engine jobs marketdata realtime reco scheduler signer web)
PREV="${1:-}"
CUR="${2:?usage: changed-apps.sh <prev-tag> <tag>}"

say() { [ "${DRY_RUN:-0}" != 1 ] || echo "# $*" >&2; }

if [ -z "$PREV" ] || ! git rev-parse -q --verify "$PREV^{commit}" >/dev/null; then
  say "no previous tag: build all"
  printf '%s\n' "${ALL_APPS[@]}"
  exit 0
fi

files="$(git diff --name-only "$PREV" "$CUR")"
say "$(printf '%s\n' "$files" | grep -c . || true) files changed between $PREV and $CUR"

if printf '%s\n' "$files" |
  grep -qE '^(packages/|pnpm-lock\.yaml$|package\.json$|pnpm-workspace\.yaml$|tsconfig[^/]*$|\.dockerignore$|\.github/workflows/release\.yml$|infra/deploy/changed-apps\.sh$)'; then
  say "shared file changed: build all ($(printf '%s\n' "$files" | grep -E '^(packages/|pnpm-lock\.yaml$|package\.json$|pnpm-workspace\.yaml$|tsconfig[^/]*$|\.dockerignore$|\.github/workflows/release\.yml$|infra/deploy/changed-apps\.sh$)' | head -3 | tr '\n' ' '))"
  printf '%s\n' "${ALL_APPS[@]}"
  exit 0
fi

for app in "${ALL_APPS[@]}"; do
  if printf '%s\n' "$files" | grep -q "^apps/$app/"; then
    say "$app: $(printf '%s\n' "$files" | grep "^apps/$app/" | head -3 | tr '\n' ' ')"
    echo "$app"
  else
    say "$app: unchanged, reuse $PREV"
  fi
done
