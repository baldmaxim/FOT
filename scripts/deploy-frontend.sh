#!/usr/bin/env bash
# Локальная сборка fot-app + заливка dist/ на vds через tar-pipe.
# Атомарный swap: новый dist приходит в dist.new, старый бэкапится, потом mv.
#
# Требует:
#   - SSH-alias `vds` (~/.ssh/config) — настраивается один раз на каждой машине
#   - fot-app/.env.production.local с прод-значениями (см. ниже)
#
# Запуск:
#   bash scripts/deploy-frontend.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$ROOT_DIR/fot-app"
FRONTEND_NPM_CI="${FRONTEND_NPM_CI:-auto}"
MODE="${1:-run}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy-frontend.sh
  bash scripts/deploy-frontend.sh --check

Environment:
  FRONTEND_NPM_CI=1    Force local `npm ci` before build.
  FRONTEND_NPM_CI=0    Never run `npm ci` automatically.
  FRONTEND_NPM_CI=auto Run `npm ci` only if node_modules is missing. Default.

Safety checks:
  - fetches `origin/main`
  - refuses to deploy if local HEAD != origin/main
  - refuses to deploy if there are uncommitted changes inside fot-app/
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

ensure_synced_with_origin_main() {
  local local_head remote_head
  git -C "$ROOT_DIR" fetch origin main >/dev/null
  local_head="$(git -C "$ROOT_DIR" rev-parse HEAD)"
  remote_head="$(git -C "$ROOT_DIR" rev-parse origin/main)"

  if [[ "$local_head" != "$remote_head" ]]; then
    die "локальный HEAD не совпадает с origin/main. Сначала подтяни/запушь нужный релиз."
  fi
}

ensure_clean_frontend_tree() {
  local untracked
  if ! git -C "$ROOT_DIR" diff --quiet -- fot-app; then
    git -C "$ROOT_DIR" status --short -- fot-app >&2
    die "во frontend-дереве есть незакоммиченные изменения."
  fi

  if ! git -C "$ROOT_DIR" diff --cached --quiet -- fot-app; then
    git -C "$ROOT_DIR" status --short -- fot-app >&2
    die "во frontend-дереве есть проиндексированные, но не закоммиченные изменения."
  fi

  untracked="$(git -C "$ROOT_DIR" ls-files --others --exclude-standard -- fot-app)"
  if [[ -n "$untracked" ]]; then
    printf '%s\n' "$untracked" >&2
    die "во frontend-дереве есть untracked-файлы."
  fi
}

maybe_install_frontend_deps() {
  case "$FRONTEND_NPM_CI" in
    1)
      echo "→ npm ci для fot-app..."
      npm ci
      ;;
    0)
      ;;
    auto)
      if [[ ! -d node_modules ]]; then
        echo "→ node_modules отсутствует, запускаю npm ci для fot-app..."
        npm ci
      fi
      ;;
    *)
      die "FRONTEND_NPM_CI должен быть one of: 0, 1, auto"
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

if [[ ! -f "$APP_DIR/.env.production.local" ]]; then
  cat >&2 <<'EOF'
Error: fot-app/.env.production.local не найден.

Создай его один раз с прод-значениями. Минимум:

  VITE_API_URL=https://fotsu10.fvds.ru/api
  VITE_SENTRY_DSN=<тот же, что в /var/www/fot/fot-app/.env на сервере>
  SENTRY_AUTH_TOKEN=<тот же>
  SENTRY_ORG=odintsovorg
  SENTRY_PROJECT=fot-app

Файл уже в .gitignore (через паттерн *.local).
EOF
  exit 1
fi

ensure_synced_with_origin_main
ensure_clean_frontend_tree

cd "$APP_DIR"

RELEASE="$(git -C "$ROOT_DIR" rev-parse --short HEAD)"

if [[ "$MODE" == "check" ]]; then
  echo "✓ Frontend preflight OK (release: $RELEASE)"
  exit 0
fi

maybe_install_frontend_deps

# Прод-env в shell — @sentry/vite-plugin читает SENTRY_* только из process.env
set -a
source .env.production.local
set +a

export VITE_SENTRY_RELEASE="$RELEASE"
export SENTRY_RELEASE="$RELEASE"

echo "→ Сборка fot-app (release: $RELEASE)..."
NODE_OPTIONS='--max-old-space-size=2048' npm run build

echo "→ Заливка dist/ на vds..."
tar czf - -C dist . | ssh vds '
set -e
TARGET=/var/www/fot/fot-app
rm -rf "$TARGET/dist.new"
mkdir -p "$TARGET/dist.new"
tar xzf - -C "$TARGET/dist.new"
rm -rf "$TARGET/dist.old"
[ -d "$TARGET/dist" ] && mv "$TARGET/dist" "$TARGET/dist.old"
mv "$TARGET/dist.new" "$TARGET/dist"
rm -rf "$TARGET/dist.old"
'

echo "✓ Фронт задеплоен (release: $RELEASE)"
