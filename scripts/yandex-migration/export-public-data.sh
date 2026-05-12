#!/usr/bin/env bash
# export-public-data.sh
# pg_dump --data-only --schema=public --format=custom из source.
set -euo pipefail

OUT_DEFAULT=".migration/supabase_public_data.dump"

print_help() {
  cat <<EOF
export-public-data — data-only dump из source (Supabase) в custom format

Usage:
  bash scripts/yandex-migration/export-public-data.sh [OUTPUT_PATH]

Default output: $OUT_DEFAULT

ENV:
  SOURCE_DATABASE_URL   postgres://...  (required) — Supabase БД-источник.

Что делает:
  pg_dump --data-only --schema=public --format=custom --no-owner --no-acl
  Custom format нужен для pg_restore (умеет parallel-restore --jobs, ставит
  --disable-triggers и т. п.).

Размер:
  Может быть существенным (skud_events на десятки GB). Убедитесь, что на
  диске хватает места. Custom-format жмёт примерно как gzip-9.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump не найден в PATH." >&2
  exit 127
fi

: "${SOURCE_DATABASE_URL:?ERROR: SOURCE_DATABASE_URL не задан}"

OUT="${1:-$OUT_DEFAULT}"
mkdir -p "$(dirname "$OUT")"

echo "[export-public-data] dumping public data → $OUT"
pg_dump \
  --data-only \
  --schema=public \
  --format=custom \
  --no-owner \
  --no-acl \
  --no-publications \
  --no-subscriptions \
  --no-tablespaces \
  --file="$OUT" \
  "$SOURCE_DATABASE_URL"

size=$(wc -c < "$OUT")
echo "[export-public-data] done: $OUT (${size} bytes)"
