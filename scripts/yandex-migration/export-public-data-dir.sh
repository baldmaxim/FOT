#!/usr/bin/env bash
# export-public-data-dir.sh
# pg_dump --data-only --schema=public --format=directory --jobs=N.
#
# Используется когда single-file dump падает на Supabase pooler из-за
# AWS NLB session timeout. Directory format дампит каждую таблицу/партицию
# в отдельном connection, поэтому ни одно соединение не висит слишком
# долго. parallel jobs (default 2) ускоряет, не перегружая pooler.
#
# Output: .migration/supabase_public_data.dir/ (директория, не файл)
set -euo pipefail

OUT_DEFAULT=".migration/supabase_public_data.dir"
JOBS_DEFAULT=2

print_help() {
  cat <<EOF
export-public-data-dir — data-only dump в directory-format + parallel jobs

Usage:
  bash scripts/yandex-migration/export-public-data-dir.sh [OUTPUT_DIR]

Default output: $OUT_DEFAULT
Default jobs:   $JOBS_DEFAULT (ENV: JOBS)

ENV:
  SOURCE_DATABASE_URL   postgres://...  (libpq-compatible).
  JOBS                  integer (default: $JOBS_DEFAULT). Кол-во parallel
                        connection'ов. Supabase pooler выдерживает 2-4,
                        больше — риск получить connection limit error.

Note:
  Directory format создаёт <OUTPUT_DIR>/ с toc.dat + по файлу на таблицу.
  Это входной формат для pg_restore -Fd. Restore-скрипт его принимает.
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
JOBS="${JOBS:-$JOBS_DEFAULT}"

if [[ -d "$OUT" ]]; then
  echo "[export-public-data-dir] предыдущий $OUT существует, удаляю"
  rm -rf "$OUT"
fi

echo "[export-public-data-dir] dumping public data → $OUT (jobs=$JOBS)"
pg_dump \
  --data-only \
  --schema=public \
  --format=directory \
  --jobs="$JOBS" \
  --no-owner \
  --no-acl \
  --no-publications \
  --no-subscriptions \
  --no-tablespaces \
  --file="$OUT" \
  "$SOURCE_DATABASE_URL"

# Размер директории
if command -v du >/dev/null 2>&1; then
  size=$(du -sh "$OUT" 2>/dev/null | awk '{print $1}')
  echo "[export-public-data-dir] done: $OUT ($size)"
else
  echo "[export-public-data-dir] done: $OUT"
fi
