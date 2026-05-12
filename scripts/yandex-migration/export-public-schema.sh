#!/usr/bin/env bash
# export-public-schema.sh
# pg_dump --schema-only --schema=public из источника (Supabase) в файл.
set -euo pipefail

OUT_DEFAULT=".migration/supabase_schema.sql"

print_help() {
  cat <<EOF
export-public-schema — schema-only dump из source DATABASE_URL (Supabase)

Usage:
  bash scripts/yandex-migration/export-public-schema.sh [OUTPUT_PATH]

Default output: $OUT_DEFAULT

ENV:
  SOURCE_DATABASE_URL   postgres://...  (required) — Supabase БД-источник.
                        Передавайте через env, НЕ через файл (пароль не
                        должен попадать в репозиторий).

Run:
  SOURCE_DATABASE_URL=postgres://... \\
    bash scripts/yandex-migration/export-public-schema.sh

Что делает:
  pg_dump --schema-only --schema=public --no-owner --no-acl \\
          --no-publications --no-subscriptions --no-tablespaces

Затем этот файл пропускается через prepare-yandex-schema.mjs
для получения yandex_schema.sql.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "ERROR: pg_dump не найден в PATH. Установите PostgreSQL client tools." >&2
  exit 127
fi

: "${SOURCE_DATABASE_URL:?ERROR: SOURCE_DATABASE_URL не задан}"

OUT="${1:-$OUT_DEFAULT}"
mkdir -p "$(dirname "$OUT")"

echo "[export-public-schema] dumping schema → $OUT"
pg_dump \
  --schema-only \
  --schema=public \
  --no-owner \
  --no-acl \
  --no-publications \
  --no-subscriptions \
  --no-tablespaces \
  --file="$OUT" \
  "$SOURCE_DATABASE_URL"

size=$(wc -c < "$OUT")
echo "[export-public-schema] done: $OUT (${size} bytes)"
