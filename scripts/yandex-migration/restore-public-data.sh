#!/usr/bin/env bash
# restore-public-data.sh
# pg_restore .migration/supabase_public_data.dump → TARGET.
#
# По умолчанию работает БЕЗ --disable-triggers (Yandex-safe). Чтобы данные
# легли без FK/UNIQUE-violation'ов, схему надо применять в 3 фазы:
#   1) pre-data  — таблицы/sequences/types/functions (БЕЗ FK/INDEX/TRIGGER)
#   2) data      — этот скрипт
#   3) post-data — FK constraints, indexes, triggers, RLS DISABLE
#
# Файлы `*_pre_data.sql` и `*_post_data.sql` создаёт
# prepare-yandex-schema.mjs автоматически рядом с `yandex_schema.sql`.

set -euo pipefail

IN_DEFAULT=".migration/supabase_public_data.dump"

print_help() {
  cat <<EOF
restore-public-data — restore custom-format data dump в TARGET

Usage:
  bash scripts/yandex-migration/restore-public-data.sh [INPUT_PATH]

Default input: $IN_DEFAULT (output export-public-data.sh)

ENV:
  TARGET_DATABASE_URL    postgres://...  (required)
  CLEAN_TARGET_TABLES    true|false  (default: false). Если true — перед
                         restore выполняется TRUNCATE для public.<t> ровно
                         тех таблиц, что есть в дампе.
  CONFIRM_DROP           true|false  (default: false). Требуется в дополнение
                         к CLEAN_TARGET_TABLES=true как двойная защита.
  RESTORE_JOBS           integer (default: 4). Параллельность pg_restore.
  USE_DISABLE_TRIGGERS   true|false  (default: false). NON-YANDEX-ONLY.
                         Добавляет --disable-triggers; требует SUPERUSER
                         или session_replication_role=replica. На Yandex
                         Managed PG ни того, ни другого регулярному
                         пользователю не дают — restore упадёт. См. ниже.

⚠ Yandex Managed PG: --disable-triggers НЕДОСТУПЕН.

Регулярный пользователь Yandex Managed PG не имеет ни SUPERUSER, ни прав
на session_replication_role=replica — pg_restore --disable-triggers
вернёт permission denied прямо на первой INSERT-операции внутри
закрытой части дампа.

Рекомендуемый flow для Yandex (3 фазы):

  # 0. transform (создаёт .pre_data.sql и .post_data.sql рядом с .sql)
  node scripts/yandex-migration/prepare-yandex-schema.mjs \\
    --input  .migration/supabase_schema.sql \\
    --output .migration/yandex_schema.sql \\
    --report .migration/schema_transform_report.md

  # 1. pre-data: схемы, таблицы, sequences, types, functions, comments
  bash scripts/yandex-migration/apply-yandex-schema.sh \\
    .migration/yandex_schema_pre_data.sql

  # 2. data: этот скрипт. FK/INDEX/TRIGGER на target ещё нет, значит
  #          никаких FK/unique-violation'ов; триггеры тоже не сработают.
  bash scripts/yandex-migration/restore-public-data.sh

  # 3. post-data: ALTER TABLE ADD CONSTRAINT (FK + PK + UNIQUE),
  #               CREATE INDEX, CREATE TRIGGER, ALTER TABLE DISABLE RLS
  bash scripts/yandex-migration/apply-yandex-schema.sh \\
    .migration/yandex_schema_post_data.sql

Что делает этот скрипт:
  1. Проверяет наличие pg_restore + psql в PATH.
  2. Если CLEAN_TARGET_TABLES=true && CONFIRM_DROP=true:
     - читает список таблиц из дампа (pg_restore --list),
     - TRUNCATE public.<t1>, public.<t2>, ... CASCADE в одном statement.
     - TRUNCATE'аются ТОЛЬКО таблицы из дампа, ничего лишнего.
  3. pg_restore --data-only --no-owner --no-acl --exit-on-error --jobs=N.
     Без --disable-triggers (Yandex-safe).
     С USE_DISABLE_TRIGGERS=true добавляет --disable-triggers и печатает
     предупреждение про требования к правам.

После restore запустите:
  - apply-yandex-schema.sh .migration/yandex_schema_post_data.sql
    (если использовали 3-фазный flow)
  - npm run migrate:yandex:fix-sequences
  - npm run migrate:yandex:verify-public
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  print_help
  exit 0
fi

if ! command -v pg_restore >/dev/null 2>&1; then
  echo "ERROR: pg_restore не найден в PATH." >&2
  exit 127
fi
if ! command -v psql >/dev/null 2>&1; then
  echo "ERROR: psql не найден в PATH." >&2
  exit 127
fi

: "${TARGET_DATABASE_URL:?ERROR: TARGET_DATABASE_URL не задан}"

IN="${1:-$IN_DEFAULT}"
CLEAN_TARGET_TABLES="${CLEAN_TARGET_TABLES:-false}"
CONFIRM_DROP="${CONFIRM_DROP:-false}"
RESTORE_JOBS="${RESTORE_JOBS:-4}"
USE_DISABLE_TRIGGERS="${USE_DISABLE_TRIGGERS:-false}"

if [[ ! -f "$IN" ]]; then
  echo "ERROR: входной файл не найден: $IN" >&2
  exit 2
fi

if [[ "$CLEAN_TARGET_TABLES" == "true" ]]; then
  if [[ "$CONFIRM_DROP" != "true" ]]; then
    echo "ABORT: CLEAN_TARGET_TABLES=true требует CONFIRM_DROP=true (двойная защита)."
    exit 4
  fi

  echo "[restore-public-data] CLEAN_TARGET_TABLES=true — собираем список таблиц из дампа"

  # pg_restore --list строки вида:
  #   3253; 0 16524 TABLE DATA public skud_events postgres
  # parsing: TABLE DATA → field 5/6, schema=field 7, table=field 8.
  tables=$(pg_restore --list "$IN" \
    | awk '$5=="TABLE" && $6=="DATA" && $7=="public" { print "public." $8 }' \
    | sort -u)

  if [[ -z "$tables" ]]; then
    echo "WARNING: в дампе нет TABLE DATA для public.* — пропускаю TRUNCATE."
  else
    list=$(echo "$tables" | paste -sd, -)
    echo "[restore-public-data] TRUNCATE ${list//,/, } CASCADE"
    psql "$TARGET_DATABASE_URL" \
      --variable=ON_ERROR_STOP=1 \
      --no-psqlrc \
      -c "TRUNCATE $list CASCADE;"
  fi
fi

restore_flags=(
  --dbname="$TARGET_DATABASE_URL"
  --data-only
  --no-owner
  --no-acl
  --exit-on-error
  --jobs="$RESTORE_JOBS"
)

if [[ "$USE_DISABLE_TRIGGERS" == "true" ]]; then
  cat <<'WARN' >&2
[restore-public-data] WARNING: USE_DISABLE_TRIGGERS=true.
   pg_restore --disable-triggers требует superuser ИЛИ
   session_replication_role=replica. На Yandex Managed PG обычному
   пользователю это недоступно — restore упадёт с permission denied.
   Используйте только для:
     - локального PostgreSQL (вы postgres-суперюзер);
     - AWS RDS с ролью rds_superuser;
     - dev/test-инстансов под вашим полным контролем.
   Рекомендуемая альтернатива на Yandex — 3-фазный restore через
   pre-data + data + post-data SQL-файлы (см. `--help`).
WARN
  restore_flags+=(--disable-triggers)
fi

echo "[restore-public-data] pg_restore $IN (jobs=$RESTORE_JOBS, disable_triggers=$USE_DISABLE_TRIGGERS)"
pg_restore "${restore_flags[@]}" "$IN"

echo "[restore-public-data] done."
echo "Next steps (3-фазный Yandex-flow):"
echo "  bash scripts/yandex-migration/apply-yandex-schema.sh \\"
echo "    .migration/yandex_schema_post_data.sql       # POST schema"
echo "  (cd fot-server && npm run migrate:yandex:fix-sequences)"
echo "  (cd fot-server && npm run migrate:yandex:verify-public)"
echo "  (cd fot-server && npm run migrate:yandex:validate-auth-fk)"
