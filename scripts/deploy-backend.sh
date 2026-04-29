#!/usr/bin/env bash
# Деплой fot-server на vds:
#   - проверяет, что origin/main не отстаёт от локального HEAD
#   - на сервере делает git pull --ff-only
#   - при необходимости запускает npm ci
#   - билдит, грузит sourcemaps и перезапускает PM2
#
# Запуск:
#   bash scripts/deploy-backend.sh
#   bash scripts/deploy-backend.sh --check

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_NPM_CI="${BACKEND_NPM_CI:-auto}"
BACKEND_SOURCEMAPS="${BACKEND_SOURCEMAPS:-1}"
MODE="${1:-run}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-backend.sh
  bash scripts/deploy-backend.sh --check

Environment:
  BACKEND_NPM_CI=1       Always run remote `npm ci` before build.
  BACKEND_NPM_CI=0       Skip remote `npm ci`.
  BACKEND_NPM_CI=auto    Run remote `npm ci` only if node_modules is missing
                         or if deployed range changed fot-server/package-lock.json.
                         Default.
  BACKEND_SOURCEMAPS=0   Skip remote `npm run sentry:sourcemaps`.

Behavior:
  - fetches `origin/main`
  - refuses to continue if local HEAD contains commits not pushed to origin/main
  - deploys commit currently published in `origin/main`
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

fetch_origin_main() {
  git -C "$ROOT_DIR" fetch origin main >/dev/null
}

ensure_remote_contains_local_head() {
  local ahead behind
  read -r ahead behind < <(git -C "$ROOT_DIR" rev-list --left-right --count HEAD...origin/main)

  if (( ahead > 0 )); then
    die "локальный HEAD содержит коммиты, которых нет в origin/main. Сначала запушь нужный релиз."
  fi

  if (( behind > 0 )); then
    echo "→ Локальный checkout отстаёт от origin/main; задеплою актуальный origin/main."
  fi
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

fetch_origin_main
ensure_remote_contains_local_head

RELEASE="$(git -C "$ROOT_DIR" rev-parse --short origin/main)"

if [[ "$MODE" == "check" ]]; then
  echo "✓ Backend preflight OK (release from origin/main: $RELEASE)"
  exit 0
fi

echo "→ Деплой fot-server на vds (release: $RELEASE)..."

ssh vds bash -s -- "$RELEASE" "$BACKEND_NPM_CI" "$BACKEND_SOURCEMAPS" <<'REMOTE'
set -euo pipefail

release="$1"
backend_npm_ci="$2"
backend_sourcemaps="$3"
repo_dir="/var/www/fot"
app_dir="$repo_dir/fot-server"

die() {
  echo "Error: $*" >&2
  exit 1
}

cd "$repo_dir"

remote_branch="$(git branch --show-current)"
if [[ "$remote_branch" != "main" ]]; then
  die "на сервере активна ветка '$remote_branch', ожидалась 'main'"
fi

remote_status="$(git status --porcelain)"
if [[ -n "$remote_status" ]]; then
  printf '%s\n' "$remote_status" >&2
  die "рабочее дерево на сервере не чистое"
fi

before="$(git rev-parse --short HEAD)"
git pull --ff-only origin main
after="$(git rev-parse --short HEAD)"

need_npm_ci=0
case "$backend_npm_ci" in
  1)
    need_npm_ci=1
    ;;
  0)
    need_npm_ci=0
    ;;
  auto)
    if [[ ! -d "$app_dir/node_modules" ]]; then
      need_npm_ci=1
    elif git diff --name-only "$before" "$after" -- fot-server/package-lock.json | grep -q .; then
      need_npm_ci=1
    fi
    ;;
  *)
    die "BACKEND_NPM_CI должен быть one of: 0, 1, auto"
    ;;
esac

cd "$app_dir"

if (( need_npm_ci == 1 )); then
  echo "→ npm ci для fot-server на сервере..."
  npm ci
fi

set -a
source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env)
set +a

export SENTRY_RELEASE="$release"

echo "→ Сборка fot-server..."
npm run build

if [[ "$backend_sourcemaps" == "1" ]]; then
  echo "→ Загрузка backend sourcemaps в Sentry..."
  npm run sentry:sourcemaps
fi

echo "→ Перезапуск PM2..."
pm2 restart fot-server --update-env
pm2 status fot-server

echo "✓ Бэкенд задеплоен (before: $before, after: $after, release: $release)"
REMOTE
