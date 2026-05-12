#!/usr/bin/env bash
# apply-yandex-schema.sh
# Применить .migration/yandex_schema.sql к Yandex Managed PG.
set -euo pipefail

IN_DEFAULT=".migration/yandex_schema.sql"

print_help() {
  cat <<EOF
apply-yandex-schema — apply prepared schema SQL to TARGET (Yandex Managed PG)

Usage:
  bash scripts/yandex-migration/apply-yandex-schema.sh [INPUT_PATH]

Default input: $IN_DEFAULT (output prepare-yandex-schema.mjs)

ENV:
  TARGET_DATABASE_URL   postgres://...  (required) — Yandex Managed PG.
  CONFIRM_DROP          true|false      (default: false). Если SQL
                        содержит активные DROP statements (не в комментариях),
                        скрипт откажется применять без CONFIRM_DROP=true.

Run:
  TARGET_DATABASE_URL=postgres://... \\
    bash scripts/yandex-migration/apply-yandex-schema.sh

Что делает:
  1. Проверяет наличие psql.
  2. SELECT version() на target — убеждается, что коннект жив.
  3. Сканирует input на активные DROP — если есть и CONFIRM_DROP != true,
     отказывает (защита от случайного применения yandex_schema поверх живых
     данных).
  4. Применяет SQL через psql -v ON_ERROR_STOP=1 — первая ошибка обрывает
     применение, чтобы схема не осталась в полуразобранном состоянии.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql не найден в PATH. Установите PostgreSQL client tools." >&2
  exit 127
fi

: "${TARGET_DATABASE_URL:?ERROR: TARGET_DATABASE_URL не задан}"

IN="${1:-$IN_DEFAULT}"
CONFIRM_DROP="${CONFIRM_DROP:-false}"

if [[ ! -f "$IN" ]]; then
  echo "ERROR: входной файл не найден: $IN" >&2
  exit 2
fi

echo "[apply-yandex-schema] target version:"
psql "$TARGET_DATABASE_URL" -tA -c 'SELECT version();' || {
  echo "ERROR: не удалось выполнить SELECT version() на TARGET_DATABASE_URL" >&2
  exit 3
}

# Активные (не закомментированные) DROP — комментарии prepare-yandex-schema.mjs
# идут как "-- DROP ...", их регэксп игнорирует.
if grep -nE '^[[:space:]]*DROP[[:space:]]+(TABLE|SCHEMA|FUNCTION|TRIGGER|INDEX|VIEW|SEQUENCE|TYPE|MATERIALIZED[[:space:]]+VIEW)' "$IN" >/dev/null 2>&1; then
  if [[ "$CONFIRM_DROP" != "true" ]]; then
    echo "ABORT: $IN содержит активные DROP-statements."
    echo "       Запустите с CONFIRM_DROP=true, если это намеренно."
    grep -nE '^[[:space:]]*DROP[[:space:]]+(TABLE|SCHEMA|FUNCTION|TRIGGER|INDEX|VIEW|SEQUENCE|TYPE)' "$IN" | head -20
    exit 4
  fi
  echo "[apply-yandex-schema] CONFIRM_DROP=true — применяем как есть, включая DROP."
fi

echo "[apply-yandex-schema] applying $IN"
psql \
  "$TARGET_DATABASE_URL" \
  --variable=ON_ERROR_STOP=1 \
  --no-psqlrc \
  --file="$IN"

echo "[apply-yandex-schema] done."
