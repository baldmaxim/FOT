#!/usr/bin/env bash
# Production deploy for fot.su10.ru.
#
# Builds artifacts locally, uploads them to the server through ssh/tar, swaps
# dist directories atomically, and restarts PM2 where needed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

FOT_SSH="${FOT_SSH:-root@45.80.128.254}"
FOT_ROOT="${FOT_ROOT:-/srv/sites/fot.su10.ru}"
FOT_BRANCH="${FOT_BRANCH:-main}"

FRONTEND_NPM_CI="${FRONTEND_NPM_CI:-auto}"
BACKEND_NPM_CI="${BACKEND_NPM_CI:-auto}"
BACKEND_SOURCEMAPS="${BACKEND_SOURCEMAPS:-0}"
DATA_API_PIP_INSTALL="${DATA_API_PIP_INSTALL:-auto}"

ALLOW_DIRTY="${ALLOW_DIRTY:-0}"
SKIP_VERIFY="${SKIP_VERIFY:-0}"

SCOPE="${1:-both}"
MODE="run"
REMOTE_BEFORE=""
REMOTE_AFTER=""

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-production.sh [frontend|backend|data-api|both|all] [--check]

Scopes:
  frontend   Build local fot-app and upload dist/ only.
  backend    Build local fot-server, upload dist/, restart fot-server.
  data-api   Pull code on server, update venv if needed, restart fot-data-api.
  both       Deploy backend + frontend. Default.
  all        Deploy backend + frontend + data-api.

Environment:
  FOT_SSH=root@45.80.128.254      SSH target.
  FOT_ROOT=/srv/sites/fot.su10.ru Server project root.
  FOT_BRANCH=main                 Git branch deployed on server.

  FRONTEND_NPM_CI=auto|1|0        Local npm ci policy for fot-app.
  BACKEND_NPM_CI=auto|1|0         Local and remote npm ci policy for fot-server.
  BACKEND_SOURCEMAPS=1            Upload backend sourcemaps to Sentry.
  DATA_API_PIP_INSTALL=auto|1|0   Server pip install policy for fot-data-api.

  ALLOW_DIRTY=1                   Allow dirty local deploy scope.
  SKIP_VERIFY=1                   Skip post-deploy curl checks.

Examples:
  bash scripts/deploy-production.sh --check
  bash scripts/deploy-production.sh frontend
  BACKEND_NPM_CI=1 bash scripts/deploy-production.sh backend
  bash scripts/deploy-production.sh all
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

ensure_current_branch() {
  local current_branch
  current_branch="$(git -C "$ROOT_DIR" branch --show-current)"
  [[ "$current_branch" == "$FOT_BRANCH" ]] || die "локальная ветка '$current_branch', ожидалась '$FOT_BRANCH'"
}

ensure_synced_with_origin() {
  local local_head remote_head
  log "Проверяю origin/$FOT_BRANCH..."
  git -C "$ROOT_DIR" fetch origin "$FOT_BRANCH" >/dev/null
  local_head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  remote_head="$(git -C "$ROOT_DIR" rev-parse "origin/$FOT_BRANCH")"
  [[ "$local_head" == "$remote_head" ]] || die "локальный HEAD не совпадает с origin/$FOT_BRANCH. Сначала pull/push нужный релиз."
}

ensure_clean_paths() {
  if [[ "$ALLOW_DIRTY" == "1" ]]; then
    log "ALLOW_DIRTY=1: пропускаю проверку локальных изменений для $*"
    return
  fi

  if ! git -C "$ROOT_DIR" diff --quiet -- "$@"; then
    git -C "$ROOT_DIR" status --short -- "$@" >&2
    die "в deploy-scope есть незакоммиченные изменения"
  fi

  if ! git -C "$ROOT_DIR" diff --cached --quiet -- "$@"; then
    git -C "$ROOT_DIR" status --short -- "$@" >&2
    die "в deploy-scope есть staged, но незакоммиченные изменения"
  fi

  local untracked
  untracked="$(git -C "$ROOT_DIR" ls-files --others --exclude-standard -- "$@")"
  if [[ -n "$untracked" ]]; then
    printf '%s\n' "$untracked" >&2
    die "в deploy-scope есть untracked-файлы"
  fi
}

ensure_clean_scope() {
  includes_frontend && ensure_clean_paths fot-app
  includes_backend && ensure_clean_paths fot-server
  includes_data_api && ensure_clean_paths fot-data-api
}

local_preflight() {
  require_cmd git
  require_cmd ssh
  require_cmd tar
  require_cmd npm

  validate_policy FRONTEND_NPM_CI "$FRONTEND_NPM_CI"
  validate_policy BACKEND_NPM_CI "$BACKEND_NPM_CI"
  validate_policy DATA_API_PIP_INSTALL "$DATA_API_PIP_INSTALL"

  ensure_current_branch
  ensure_synced_with_origin
  ensure_clean_scope

  if includes_frontend && [[ ! -f "$ROOT_DIR/fot-app/.env.production.local" ]]; then
    cat >&2 <<'EOF'
Error: fot-app/.env.production.local не найден.

Минимум:
  VITE_API_URL=https://fot.su10.ru/api
  VITE_SENTRY_DSN=...
  SENTRY_AUTH_TOKEN=...
  SENTRY_ORG=odintsovorg
  SENTRY_PROJECT=fot-app
EOF
    exit 1
  fi
}

remote_check() {
  log "Проверяю сервер $FOT_SSH..."
  ssh "$FOT_SSH" bash -s -- "$FOT_ROOT" "$FOT_BRANCH" <<'REMOTE'
set -euo pipefail
root="$1"
branch="$2"

test -d "$root" || { echo "Error: project root not found: $root" >&2; exit 1; }
cd "$root"

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$branch" ]]; then
  echo "Error: server branch '$current_branch', expected '$branch'" >&2
  exit 1
fi

status="$(git status --porcelain)"
if [[ -n "$status" ]]; then
  printf '%s\n' "$status" >&2
  echo "Error: server working tree is not clean" >&2
  exit 1
fi

test -f fot-server/.env || { echo "Error: fot-server/.env missing" >&2; exit 1; }
test -f fot-app/.env || { echo "Error: fot-app/.env missing" >&2; exit 1; }
test -f fot-data-api/.env || { echo "Error: fot-data-api/.env missing" >&2; exit 1; }
test -f .migration/yandex-ca.pem || { echo "Error: .migration/yandex-ca.pem missing" >&2; exit 1; }

echo "✓ Remote preflight OK ($(hostname), $(git rev-parse --short HEAD))"
REMOTE
}

remote_update_code() {
  local output
  log "Обновляю код на сервере..."
  output="$(ssh "$FOT_SSH" bash -s -- "$FOT_ROOT" "$FOT_BRANCH" <<'REMOTE'
set -euo pipefail
root="$1"
branch="$2"

cd "$root"

current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$branch" ]]; then
  echo "Error: server branch '$current_branch', expected '$branch'" >&2
  exit 1
fi

status="$(git status --porcelain)"
if [[ -n "$status" ]]; then
  printf '%s\n' "$status" >&2
  echo "Error: server working tree is not clean" >&2
  exit 1
fi

before="$(git rev-parse --short HEAD)"
git pull --ff-only origin "$branch"
after="$(git rev-parse --short HEAD)"

echo "FOT_BEFORE=$before"
echo "FOT_AFTER=$after"
echo "✓ Server code: $before -> $after"
REMOTE
)"
  echo "$output"
  REMOTE_BEFORE="$(printf '%s\n' "$output" | awk -F= '/^FOT_BEFORE=/{print $2}' | tail -1)"
  REMOTE_AFTER="$(printf '%s\n' "$output" | awk -F= '/^FOT_AFTER=/{print $2}' | tail -1)"
}

maybe_install_npm_local() {
  local policy="$1"
  case "$policy" in
    1)
      npm ci
      ;;
    0)
      ;;
    auto)
      if [[ ! -d node_modules ]]; then
        npm ci
      fi
      ;;
  esac
}

build_backend() {
  log "Собираю backend локально..."
  cd "$ROOT_DIR/fot-server"
  maybe_install_npm_local "$BACKEND_NPM_CI"
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
    export SENTRY_RELEASE
    SENTRY_RELEASE="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
    npm run sentry:sourcemaps
  fi
}

upload_backend() {
  log "Готовлю backend на сервере..."
  ssh "$FOT_SSH" bash -s -- "$FOT_ROOT" "$BACKEND_NPM_CI" "$REMOTE_BEFORE" "$REMOTE_AFTER" <<'REMOTE'
set -euo pipefail
root="$1"
backend_npm_ci="$2"
before="$3"
after="$4"
app_dir="$root/fot-server"

cd "$app_dir"

need_npm_ci=0
case "$backend_npm_ci" in
  1)
    need_npm_ci=1
    ;;
  0)
    need_npm_ci=0
    ;;
  auto)
    if [[ ! -d node_modules ]]; then
      need_npm_ci=1
    elif [[ -n "$before" && -n "$after" ]] && git -C "$root" diff --name-only "$before" "$after" -- fot-server/package-lock.json | grep -q .; then
      need_npm_ci=1
    fi
    ;;
esac

if (( need_npm_ci == 1 )); then
  npm ci --omit=dev
fi

rm -rf dist.new
mkdir -p dist.new
REMOTE

  log "Заливаю backend dist/..."
  tar czf - -C "$ROOT_DIR/fot-server/dist" . | ssh "$FOT_SSH" "tar xzf - -C '$FOT_ROOT/fot-server/dist.new'"

  log "Активирую backend и перезапускаю PM2..."
  ssh "$FOT_SSH" bash -s -- "$FOT_ROOT" "$(git -C "$ROOT_DIR" rev-parse --short HEAD)" <<'REMOTE'
set -euo pipefail
root="$1"
release="$2"
app_dir="$root/fot-server"

cd "$app_dir"
test -d dist.new || { echo "Error: dist.new not found" >&2; exit 1; }

rm -rf dist.old
[ -d dist ] && mv dist dist.old
mv dist.new dist
rm -rf dist.old

eval "$(
node <<'NODE'
const fs = require('fs');
const dotenv = require('dotenv');
const env = dotenv.parse(fs.readFileSync('.env'));
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;
for (const [key, value] of Object.entries(env)) {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    console.log(`export ${key}=${quote(value)};`);
  }
}
NODE
)"
export SENTRY_RELEASE="$release"

if pm2 describe fot-server >/dev/null 2>&1; then
  pm2 restart fot-server --update-env
else
  pm2 start "$app_dir/dist/index.js" --name fot-server --cwd "$app_dir"
fi

pm2 status fot-server
REMOTE
}

build_frontend() {
  log "Собираю frontend локально..."
  cd "$ROOT_DIR/fot-app"
  maybe_install_npm_local "$FRONTEND_NPM_CI"

  set -a
  source .env.production.local
  set +a

  export VITE_SENTRY_RELEASE
  export SENTRY_RELEASE
  VITE_SENTRY_RELEASE="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"
  SENTRY_RELEASE="$VITE_SENTRY_RELEASE"

  NODE_OPTIONS='--max-old-space-size=2048' npm run build
}

upload_frontend() {
  log "Заливаю frontend dist/..."
  tar czf - -C "$ROOT_DIR/fot-app/dist" . | ssh "$FOT_SSH" bash -s -- "$FOT_ROOT" <<'REMOTE'
set -euo pipefail
target="$1/fot-app"
rm -rf "$target/dist.new"
mkdir -p "$target/dist.new"
tar xzf - -C "$target/dist.new"
rm -rf "$target/dist.old"
[ -d "$target/dist" ] && mv "$target/dist" "$target/dist.old"
mv "$target/dist.new" "$target/dist"
rm -rf "$target/dist.old"
find "$target/dist" -type d -exec chmod 755 {} \;
find "$target/dist" -type f -exec chmod 644 {} \;
REMOTE
}

deploy_data_api() {
  log "Обновляю fot-data-api на сервере..."
  ssh "$FOT_SSH" bash -s -- "$FOT_ROOT" "$DATA_API_PIP_INSTALL" "$REMOTE_BEFORE" "$REMOTE_AFTER" <<'REMOTE'
set -euo pipefail
root="$1"
pip_policy="$2"
before="$3"
after="$4"
app_dir="$root/fot-data-api"

cd "$app_dir"

need_pip=0
case "$pip_policy" in
  1)
    need_pip=1
    ;;
  0)
    need_pip=0
    ;;
  auto)
    if [[ ! -d .venv ]]; then
      need_pip=1
    elif [[ -n "$before" && -n "$after" ]] && git -C "$root" diff --name-only "$before" "$after" -- fot-data-api/requirements.txt | grep -q .; then
      need_pip=1
    fi
    ;;
esac

if [[ ! -d .venv ]]; then
  python3.12 -m venv .venv
fi

if (( need_pip == 1 )); then
  .venv/bin/pip install -r requirements.txt
fi

.venv/bin/python -m compileall -q app

if pm2 describe fot-data-api >/dev/null 2>&1; then
  pm2 restart fot-data-api --update-env
else
  pm2 start ".venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4001" \
    --name fot-data-api \
    --cwd "$app_dir" \
    --interpreter none
fi

pm2 status fot-data-api
REMOTE
}

verify_deploy() {
  if [[ "$SKIP_VERIFY" == "1" ]]; then
    log "SKIP_VERIFY=1: пропускаю проверки"
    return
  fi

  log "Проверяю сервер..."
  ssh "$FOT_SSH" bash -s -- "$FOT_ROOT" "$SCOPE" <<'REMOTE'
set -euo pipefail
root="$1"
scope="$2"

pm2 status

case "$scope" in
  backend|both|all)
    curl -fsS http://127.0.0.1:3001/health
    echo
    ;;
esac

case "$scope" in
  data-api|all)
    curl -fsS http://127.0.0.1:4001/external/v1/health
    echo
    ;;
esac

case "$scope" in
  frontend|both|all)
    test -f "$root/fot-app/dist/index.html"
    ;;
esac
REMOTE

  if includes_frontend || includes_backend; then
    curl -fsS -I https://fot.su10.ru/ >/dev/null
  fi

  if includes_backend; then
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

  log "Проверки прошли"
}

main() {
  local_preflight
  remote_check

  if [[ "$MODE" == "check" ]]; then
    echo "✓ Preflight OK ($SCOPE)"
    exit 0
  fi

  remote_update_code

  if includes_backend; then
    build_backend
    upload_backend
  fi

  if includes_frontend; then
    build_frontend
    upload_frontend
  fi

  if includes_data_api; then
    deploy_data_api
  fi

  ssh "$FOT_SSH" 'pm2 save'
  verify_deploy
  echo "✓ Deploy завершён: $SCOPE"
}

main
