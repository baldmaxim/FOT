#!/usr/bin/env bash
# Локальная сборка fot-server + выкладка dist/ на vds:
#   - проверяет, что origin/main не отстаёт от локального HEAD
#   - локально устанавливает dev-зависимости при необходимости
#   - локально билдит dist/
#   - на сервере делает git pull --ff-only
#   - при необходимости обновляет production-зависимости
#   - атомарно меняет dist/ и перезапускает PM2
#
# Запуск:
#   bash scripts/deploy-backend.sh
#   bash scripts/deploy-backend.sh --check

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_NPM_CI="${BACKEND_NPM_CI:-auto}"
BACKEND_SOURCEMAPS="${BACKEND_SOURCEMAPS:-1}"
MODE="${1:-run}"
SERVER_PREP_FILE=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-backend.sh
  bash scripts/deploy-backend.sh --check

Environment:
  BACKEND_NPM_CI=1       Force local `npm ci` before build and remote
                         `npm ci --omit=dev` before restart.
  BACKEND_NPM_CI=0       Never run `npm ci` automatically.
  BACKEND_NPM_CI=auto    Run local `npm ci` if node_modules is missing.
                         Run remote `npm ci --omit=dev` if node_modules is
                         missing or if deployed range changed package-lock.json.
                         Default.
  BACKEND_SOURCEMAPS=0   Skip local `npm run sentry:sourcemaps`.

Behavior:
  - fetches `origin/main`
  - refuses to continue if local HEAD contains commits not pushed to origin/main
  - refuses to deploy if there are uncommitted changes inside fot-server/
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

ensure_clean_backend_tree() {
  local untracked
  if ! git -C "$ROOT_DIR" diff --quiet -- fot-server; then
    git -C "$ROOT_DIR" status --short -- fot-server >&2
    die "в backend-дереве есть незакоммиченные изменения."
  fi

  if ! git -C "$ROOT_DIR" diff --cached --quiet -- fot-server; then
    git -C "$ROOT_DIR" status --short -- fot-server >&2
    die "в backend-дереве есть проиндексированные, но не закоммиченные изменения."
  fi

  untracked="$(git -C "$ROOT_DIR" ls-files --others --exclude-standard -- fot-server)"
  if [[ -n "$untracked" ]]; then
    printf '%s\n' "$untracked" >&2
    die "в backend-дереве есть untracked-файлы."
  fi
}

maybe_install_backend_deps_local() {
  case "$BACKEND_NPM_CI" in
    1)
      echo "→ npm ci для fot-server локально..."
      npm ci
      ;;
    0)
      ;;
    auto)
      if [[ ! -d node_modules ]]; then
        echo "→ node_modules отсутствует, запускаю npm ci для fot-server локально..."
        npm ci
      fi
      ;;
    *)
      die "BACKEND_NPM_CI должен быть one of: 0, 1, auto"
      ;;
  esac
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
ensure_clean_backend_tree

RELEASE="$(git -C "$ROOT_DIR" rev-parse --short origin/main)"

if [[ "$MODE" == "check" ]]; then
  echo "✓ Backend preflight OK (release from origin/main: $RELEASE)"
  exit 0
fi

cd "$ROOT_DIR/fot-server"

maybe_install_backend_deps_local

echo "→ Локальная сборка fot-server (release: $RELEASE)..."
npm run build

if [[ "$BACKEND_SOURCEMAPS" == "1" ]]; then
  if [[ -f .env.production.local ]]; then
    set -a
    source .env.production.local
    set +a
  elif [[ -f .env ]]; then
    set -a
    source .env
    set +a
  fi

  export SENTRY_RELEASE="$RELEASE"
  echo "→ Загрузка backend sourcemaps в Sentry локально..."
  npm run sentry:sourcemaps
fi

echo "→ Подготовка сервера для fot-server (release: $RELEASE)..."

SERVER_PREP_FILE="$(mktemp)"
trap 'rm -f "$SERVER_PREP_FILE"' EXIT

ssh vds bash -s -- "$RELEASE" "$BACKEND_NPM_CI" >"$SERVER_PREP_FILE" <<'REMOTE'
set -euo pipefail

release="$1"
backend_npm_ci="$2"
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
  echo "→ npm ci --omit=dev для fot-server на сервере..."
  npm ci --omit=dev
fi

upload_dir="$app_dir/dist.new"
rm -rf "$upload_dir"
mkdir -p "$upload_dir"

echo "UPLOAD_DIR=$upload_dir"
echo "BEFORE=$before"
echo "AFTER=$after"
REMOTE

cat "$SERVER_PREP_FILE"
UPLOAD_DIR="$(grep '^UPLOAD_DIR=' "$SERVER_PREP_FILE" | tail -1 | cut -d= -f2-)"

if [[ -z "$UPLOAD_DIR" ]]; then
  die "сервер не вернул путь для загрузки dist"
fi

echo "→ Заливка backend dist/ на vds..."
tar czf - -C dist . | ssh vds "tar xzf - -C '$UPLOAD_DIR'"

echo "→ Активация backend dist/ и рестарт PM2..."
ssh vds bash -s -- "$RELEASE" <<'REMOTE'
set -euo pipefail

release="$1"
repo_dir="/var/www/fot"
app_dir="$repo_dir/fot-server"

cd "$app_dir"

if [[ ! -d dist.new ]]; then
  echo "Error: dist.new не найден" >&2
  exit 1
fi

rm -rf dist.old
[ -d dist ] && mv dist dist.old
mv dist.new dist
rm -rf dist.old

set -a
source <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' .env)
set +a

export SENTRY_RELEASE="$release"

pm2 restart fot-server --update-env
pm2 status fot-server

echo "✓ Бэкенд задеплоен (release: $release)"
REMOTE
