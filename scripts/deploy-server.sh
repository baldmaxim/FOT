#!/usr/bin/env bash
# Server-side production deploy for fot.su10.ru.
#
# Source/git live in a disposable build context (/opt/fot-build).
# Only built artefacts are copied into the live site (/srv/sites/fot.su10.ru).
# Runtime config (.env, .migration/yandex-ca.pem) stays in the site folder
# and is never touched by this script.
#
# Run on the production server:
#   cd /opt/fot-build
#   bash scripts/deploy-server.sh both

set -euo pipefail

BUILD_DIR="${BUILD_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
SITE_DIR="${SITE_DIR:-/srv/sites/fot.su10.ru}"

FOT_BRANCH="${FOT_BRANCH:-main}"
FOT_REMOTE="${FOT_REMOTE:-personal}"
EXPECTED_HOSTNAME="${EXPECTED_HOSTNAME:-hub}"
ALLOW_HOSTNAME_MISMATCH="${ALLOW_HOSTNAME_MISMATCH:-0}"
BUILD_CLEAN_HARD="${BUILD_CLEAN_HARD:-0}"

FRONTEND_NPM_CI="${FRONTEND_NPM_CI:-auto}"
BACKEND_NPM_CI="${BACKEND_NPM_CI:-auto}"
BACKEND_SOURCEMAPS="${BACKEND_SOURCEMAPS:-0}"
DATA_API_PIP_INSTALL="${DATA_API_PIP_INSTALL:-auto}"

SKIP_VERIFY="${SKIP_VERIFY:-0}"

SCOPE="${1:-both}"
MODE="run"
BEFORE=""
AFTER=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-server.sh [frontend|backend|data-api|both|all] [--check]

Run this script on the production server from the build context (/opt/fot-build).
Git/source live in BUILD_DIR; only built artefacts are published into SITE_DIR.

Scopes:
  frontend   Sync code, build fot-app in BUILD_DIR, publish dist/ to SITE_DIR.
  backend    Sync code, build fot-server in BUILD_DIR, publish + restart fot-server.
  data-api   Sync code, publish app/, update venv if needed, restart fot-data-api.
  both       Deploy backend + frontend. Default.
  all        Deploy backend + frontend + data-api.

Environment:
  BUILD_DIR=/opt/fot-build
  SITE_DIR=/srv/sites/fot.su10.ru
  FOT_BRANCH=main
  FOT_REMOTE=personal          # git remote the server tracks (baldmaxim/FOT)
  EXPECTED_HOSTNAME=hub
  ALLOW_HOSTNAME_MISMATCH=1
  BUILD_CLEAN_HARD=1            # also wipe gitignored paths (node_modules) in BUILD_DIR

  FRONTEND_NPM_CI=auto|1|0
  BACKEND_NPM_CI=auto|1|0
  BACKEND_SOURCEMAPS=1
  DATA_API_PIP_INSTALL=auto|1|0
  SKIP_VERIFY=1

Examples:
  bash scripts/deploy-server.sh --check
  bash scripts/deploy-server.sh both
  BACKEND_NPM_CI=1 bash scripts/deploy-server.sh backend
  bash scripts/deploy-server.sh all
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

log() {
  echo "→ $*"
}

case "$SCOPE" in
  --check)
    MODE="check"
    SCOPE="both"
    shift || true
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  frontend|backend|data-api|both|all)
    shift || true
    ;;
  *)
    usage >&2
    die "неизвестный scope: $SCOPE"
    ;;
esac

while (($#)); do
  case "$1" in
    --check)
      MODE="check"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      die "неизвестный аргумент: $1"
      ;;
  esac
  shift
done

includes_frontend() {
  [[ "$SCOPE" == "frontend" || "$SCOPE" == "both" || "$SCOPE" == "all" ]]
}

includes_backend() {
  [[ "$SCOPE" == "backend" || "$SCOPE" == "both" || "$SCOPE" == "all" ]]
}

includes_data_api() {
  [[ "$SCOPE" == "data-api" || "$SCOPE" == "all" ]]
}

validate_policy() {
  local name="$1"
  local value="$2"
  case "$value" in
    auto|1|0) ;;
    *) die "$name должен быть one of: auto, 1, 0" ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "команда не найдена: $1"
}

dotenv_exports() {
  local env_file="$1"
  node - "$env_file" <<'NODE'
const fs = require('fs');
const envPath = process.argv[2];

function fallbackParse(text) {
  const parsed = {};
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    parsed[match[1]] = value;
  }
  return parsed;
}

const text = fs.readFileSync(envPath, 'utf8');
let parsed;
try {
  parsed = require('dotenv').parse(text);
} catch {
  parsed = fallbackParse(text);
}

const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
for (const [key, value] of Object.entries(parsed)) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    console.log(`export ${key}=${quote(value)};`);
  }
}
NODE
}

load_env_file() {
  local env_file="$1"
  test -f "$env_file" || die "env-файл не найден: $env_file"
  eval "$(dotenv_exports "$env_file")"
}

ensure_expected_host() {
  if [[ -z "$EXPECTED_HOSTNAME" ]]; then
    return
  fi

  local current
  current="$(hostname)"
  if [[ "$current" != "$EXPECTED_HOSTNAME" && "$ALLOW_HOSTNAME_MISMATCH" != "1" ]]; then
    die "hostname '$current', ожидался '$EXPECTED_HOSTNAME'. Это защита от запуска не на том сервере."
  fi
}

# Atomic publish of a freshly-built directory into the site folder.
# $1 build-side source dir, $2 site-side target dir (lives on one filesystem
# with its parent, so the final mv-swap is atomic).
publish_dir() {
  local src="$1"
  local target="$2"
  local parent
  parent="$(dirname "$target")"

  test -d "$src" || die "нет собранной директории: $src"
  mkdir -p "$parent"

  rm -rf "$target.new"
  cp -a "$src" "$target.new"

  rm -rf "$target.old"
  [ -d "$target" ] && mv "$target" "$target.old"
  mv "$target.new" "$target"
  rm -rf "$target.old"
}

server_preflight() {
  require_cmd git
  require_cmd node
  require_cmd npm
  require_cmd pm2
  require_cmd curl
  require_cmd nginx
  require_cmd cp

  includes_data_api && require_cmd python3.12

  validate_policy FRONTEND_NPM_CI "$FRONTEND_NPM_CI"
  validate_policy BACKEND_NPM_CI "$BACKEND_NPM_CI"
  validate_policy DATA_API_PIP_INSTALL "$DATA_API_PIP_INSTALL"

  ensure_expected_host

  test -d "$BUILD_DIR" || die "BUILD_DIR не найден: $BUILD_DIR"
  cd "$BUILD_DIR"
  git rev-parse --is-inside-work-tree >/dev/null || die "BUILD_DIR не git-репозиторий: $BUILD_DIR"

  local current_branch
  current_branch="$(git branch --show-current || true)"
  if [[ -n "$current_branch" && "$current_branch" != "$FOT_BRANCH" ]]; then
    log "ветка BUILD_DIR '$current_branch', будет принудительно переключена на '$FOT_BRANCH'"
  fi

  test -f "$SITE_DIR/fot-server/.env" || die "$SITE_DIR/fot-server/.env missing"
  test -f "$SITE_DIR/fot-app/.env" || die "$SITE_DIR/fot-app/.env missing"
  test -f "$SITE_DIR/fot-data-api/.env" || die "$SITE_DIR/fot-data-api/.env missing"
  test -f "$SITE_DIR/.migration/yandex-ca.pem" || die "$SITE_DIR/.migration/yandex-ca.pem missing"

  nginx -t >/dev/null
}

update_code() {
  log "Синхронизирую BUILD_DIR с $FOT_REMOTE/$FOT_BRANCH..."
  cd "$BUILD_DIR"

  BEFORE="$(git rev-parse --short HEAD 2>/dev/null || echo '')"
  git fetch "$FOT_REMOTE" "$FOT_BRANCH" --prune
  git checkout -f -B "$FOT_BRANCH" "$FOT_REMOTE/$FOT_BRANCH"
  git reset --hard "$FOT_REMOTE/$FOT_BRANCH"
  if [[ "$BUILD_CLEAN_HARD" == "1" ]]; then
    git clean -fdx
  else
    git clean -fd
  fi
  AFTER="$(git rev-parse --short HEAD)"

  echo "✓ BUILD_DIR code: ${BEFORE:-none} -> $AFTER"
}

# True when build-dir deps must be (re)installed for the build itself.
need_npm_ci() {
  local policy="$1"
  local sentinel="$2"
  shift 2

  case "$policy" in
    1)
      return 0
      ;;
    0)
      return 1
      ;;
    auto)
      if [[ ! -e "$sentinel" ]]; then
        return 0
      fi
      if [[ -n "$BEFORE" && -n "$AFTER" && "$BEFORE" != "$AFTER" ]]; then
        git -C "$BUILD_DIR" diff --name-only "$BEFORE" "$AFTER" -- "$@" | grep -q . && return 0
      fi
      return 1
      ;;
  esac
}

# True when runtime prod-deps in the site folder must be refreshed.
site_deps_stale() {
  local node_modules="$1"
  local force="$2"
  local lockfile="$3"

  [[ ! -d "$node_modules" ]] && return 0
  [[ "$force" == "1" ]] && return 0
  if [[ -n "$BEFORE" && -n "$AFTER" && "$BEFORE" != "$AFTER" ]]; then
    git -C "$BUILD_DIR" diff --name-only "$BEFORE" "$AFTER" -- "$lockfile" | grep -q . && return 0
  fi
  return 1
}

deploy_backend() {
  local app_dir="$BUILD_DIR/fot-server"
  local site_dir="$SITE_DIR/fot-server"
  log "Собираю backend в BUILD_DIR..."
  cd "$app_dir"

  if need_npm_ci "$BACKEND_NPM_CI" "node_modules/.bin/tsc" fot-server/package.json fot-server/package-lock.json; then
    npm ci
  fi

  rm -rf dist.new
  npm run build -- --outDir dist.new
  test -f dist.new/index.js || die "backend build не создал dist.new/index.js"

  rm -rf dist.old
  [ -d dist ] && mv dist dist.old
  mv dist.new dist
  rm -rf dist.old

  load_env_file "$site_dir/.env"
  export SENTRY_RELEASE="$AFTER"

  if [[ "$BACKEND_SOURCEMAPS" == "1" ]]; then
    npm run sentry:sourcemaps
  fi

  log "Публикую backend в SITE_DIR..."
  cp "$app_dir/package.json" "$site_dir/package.json"
  cp "$app_dir/package-lock.json" "$site_dir/package-lock.json"

  if site_deps_stale "$site_dir/node_modules" "$BACKEND_NPM_CI" fot-server/package-lock.json; then
    log "Обновляю prod-зависимости backend в SITE_DIR..."
    ( cd "$site_dir" && npm ci --omit=dev )
  fi

  publish_dir "$app_dir/dist" "$site_dir/dist"

  if pm2 describe fot-server >/dev/null 2>&1; then
    pm2 restart fot-server --update-env
  else
    pm2 start "$site_dir/dist/index.js" --name fot-server --cwd "$site_dir"
  fi
}

deploy_frontend() {
  local app_dir="$BUILD_DIR/fot-app"
  local site_dir="$SITE_DIR/fot-app"
  log "Собираю frontend в BUILD_DIR..."
  cd "$app_dir"

  if need_npm_ci "$FRONTEND_NPM_CI" "node_modules/.bin/vite" fot-app/package.json fot-app/package-lock.json; then
    npm ci
  fi

  load_env_file "$site_dir/.env"
  export VITE_SENTRY_RELEASE="$AFTER"
  export SENTRY_RELEASE="$AFTER"

  rm -rf dist.new
  ./node_modules/.bin/tsc -b
  NODE_OPTIONS='--max-old-space-size=2048' ./node_modules/.bin/vite build --outDir dist.new
  test -f dist.new/index.html || die "frontend build не создал dist.new/index.html"
  find dist.new -name '*.map' -type f -delete

  rm -rf dist.old
  [ -d dist ] && mv dist dist.old
  mv dist.new dist
  rm -rf dist.old

  log "Публикую frontend в SITE_DIR..."
  publish_dir "$app_dir/dist" "$site_dir/dist"

  find "$site_dir/dist" -type d -exec chmod 755 {} \;
  find "$site_dir/dist" -type f -exec chmod 644 {} \;
}

deploy_data_api() {
  local app_dir="$BUILD_DIR/fot-data-api"
  local site_dir="$SITE_DIR/fot-data-api"
  log "Обновляю Public Data API..."

  local need_pip=0
  case "$DATA_API_PIP_INSTALL" in
    1)
      need_pip=1
      ;;
    0)
      need_pip=0
      ;;
    auto)
      if [[ ! -x "$site_dir/.venv/bin/uvicorn" ]]; then
        need_pip=1
      elif [[ -n "$BEFORE" && -n "$AFTER" && "$BEFORE" != "$AFTER" ]]; then
        git -C "$BUILD_DIR" diff --name-only "$BEFORE" "$AFTER" -- fot-data-api/requirements.txt | grep -q . && need_pip=1
      fi
      ;;
  esac

  log "Публикую data-api код в SITE_DIR..."
  publish_dir "$app_dir/app" "$site_dir/app"
  cp "$app_dir/requirements.txt" "$site_dir/requirements.txt"

  if [[ ! -d "$site_dir/.venv" ]]; then
    python3.12 -m venv "$site_dir/.venv"
    need_pip=1
  fi

  if (( need_pip == 1 )); then
    "$site_dir/.venv/bin/pip" install -r "$site_dir/requirements.txt"
  fi

  ( cd "$site_dir" && .venv/bin/python -m compileall -q app )

  if pm2 describe fot-data-api >/dev/null 2>&1; then
    pm2 restart fot-data-api --update-env
  else
    pm2 start ".venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4001" \
      --name fot-data-api \
      --cwd "$site_dir" \
      --interpreter none
  fi
}

verify_deploy() {
  if [[ "$SKIP_VERIFY" == "1" ]]; then
    log "SKIP_VERIFY=1: пропускаю проверки"
    return
  fi

  log "Проверяю сервисы..."
  nginx -t >/dev/null
  pm2 status

  if includes_backend; then
    curl -fsS http://127.0.0.1:3001/health
    echo
  fi

  if includes_data_api; then
    curl -fsS http://127.0.0.1:4001/external/v1/health
    echo
  fi

  if includes_frontend; then
    test -f "$SITE_DIR/fot-app/dist/index.html"
    curl -fsS -I https://fot.su10.ru/ >/dev/null
  fi

  if includes_backend; then
    local status_code
    status_code="$(curl -sS -o /dev/null -w '%{http_code}' \
      https://fot.su10.ru/api/auth/login \
      -X POST \
      -H 'Content-Type: application/json' \
      -d '{}')"
    [[ "$status_code" =~ ^(400|422)$ ]] || die "неожиданный статус /api/auth/login: $status_code"
  fi

  if includes_data_api; then
    curl -fsS https://fot.su10.ru/external/v1/health >/dev/null
  fi

  echo "✓ Проверки прошли"
}

main() {
  server_preflight

  if [[ "$MODE" == "check" ]]; then
    verify_deploy
    echo "✓ Server check OK ($SCOPE)"
    exit 0
  fi

  update_code

  if includes_backend; then
    deploy_backend
  fi

  if includes_frontend; then
    deploy_frontend
  fi

  if includes_data_api; then
    deploy_data_api
  fi

  pm2 save
  verify_deploy
  echo "✓ Deploy завершён: $SCOPE"
}

main
