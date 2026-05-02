#!/usr/bin/env bash
# Локальный build + upload для FOT:
#   1. Бэкенд: локальный build + upload dist/ + PM2 restart на vds
#   2. Фронтенд: локальный build + upload dist/ на vds
#
# Запуск:
#   bash scripts/deploy-both.sh
#   bash scripts/deploy-both.sh --check

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-run}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-both.sh
  bash scripts/deploy-both.sh --check

Pass-through environment:
  FRONTEND_NPM_CI=1      Force local `npm ci` for fot-app before build.
  BACKEND_NPM_CI=1       Force local `npm ci` and remote production deps
                         refresh for fot-server.
  BACKEND_SOURCEMAPS=0   Skip backend sourcemaps upload.

Behavior:
  - first runs frontend/backend preflight
  - then builds/uploads backend from local machine and restarts PM2
  - then builds/uploads frontend from local machine
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

case "$MODE" in
  run|"")
    ;;
  --check)
    MODE="check"
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    die "неизвестный аргумент: $MODE"
    ;;
esac

echo "→ Preflight frontend..."
bash "$ROOT_DIR/scripts/deploy-frontend.sh" --check

echo "→ Preflight backend..."
bash "$ROOT_DIR/scripts/deploy-backend.sh" --check

if [[ "$MODE" == "check" ]]; then
  echo "✓ Both preflight OK"
  exit 0
fi

echo "→ Деплой backend..."
bash "$ROOT_DIR/scripts/deploy-backend.sh"

echo "→ Деплой frontend..."
bash "$ROOT_DIR/scripts/deploy-frontend.sh"

echo "✓ Полный деплой завершён"
