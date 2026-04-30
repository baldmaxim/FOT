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

# Корень репо
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR/fot-app"

if [[ ! -f .env.production.local ]]; then
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

# Прод-env в shell — @sentry/vite-plugin читает SENTRY_* только из process.env
set -a
source .env.production.local
set +a

RELEASE=$(git -C "$ROOT_DIR" rev-parse --short HEAD)
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
