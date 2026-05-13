# 05 — Перенос данных схемы `public` (Supabase → Yandex Managed PG)

Ран-бук «накат данных». Предполагается, что:

- Схема в Yandex уже накатана через [04_schema_prepare.md](04_schema_prepare.md).
- Auth-таблица `app_auth.users` уже создана и заполнена через [03_auth_users.md](03_auth_users.md).
- Все недостающие RPC восстановлены через [01_recover_runtime_functions.md](01_recover_runtime_functions.md).
- `.migration/yandex.env` создан из `.migration/yandex.env.example` и подгружен.

## ENV / DSN (важно для Phase 11+)

Используются **две DSN для source** + одна для target. Полный шаблон —
[`.migration/yandex.env.example`](../../.migration/yandex.env.example).

| Переменная | Кем читается | Особенности |
|---|---|---|
| `SOURCE_DATABASE_URL` | psql / pg_dump / pg_restore (libpq) | `sslmode=require` (libpq принимает), без `uselibpqcompat`. |
| `SOURCE_DATABASE_URL_NODE` | TS-скрипты (Node `pg`) | Тот же DSN + `uselibpqcompat=true&sslmode=require`. Без флага Node-`pg` трактует `sslmode=require` как `verify-full` и падает на Supabase self-signed AWS chain. Скрипты делают fallback `SOURCE_DATABASE_URL_NODE \|\| SOURCE_DATABASE_URL`. |
| `TARGET_DATABASE_URL` | все клиенты | Yandex Managed PG. `sslmode=verify-full&sslrootcert=...`. DSN ОБЯЗАТЕЛЬНО в двойных кавычках в `.env` (иначе `&` интерпретируется bash'ем как фоновый оператор). |
| `TARGET_SSL` / `TARGET_SSL_CA_PATH` | TS-скрипты | Дополняют URL для Node `pg`. Путь к CA — **абсолютный** (cwd скриптов часто `fot-server/`). |

**НЕ использовать** `DATABASE_URL` текущего fot-server'а в роли target — это
другая база и другой проект. Source — Supabase, target — Yandex.

Источник для `pg_dump` обязан быть **session pooler** (port 5432) или
**direct connection**, а **не transaction pooler** (port 6543). pg_dump
требует session-state для long-running COPY и snapshot consistency.

### Windows / PowerShell notes

- Миграционные команды запускать из **Git Bash**, не PowerShell — `.env`
  читается через `source`. Под PowerShell `.env`-loader потребует
  `Get-Content | ForEach-Object`-костыля.
- PG client tools 17+ нужны. Установка: `scoop install postgresql`
  (даёт v18.x — back-compatible с PG17 source/target). Путь:
  `C:/Users/<you>/scoop/apps/postgresql/current/bin` добавить в PATH.
- Yandex Managed PG в большинстве случаев открывает только pooler
  port 6432 (Odyssey), прямой 5432 закрыт firewall'ом. Pooler в transaction
  mode сбрасывает session-level `SET` между statements — поэтому
  `apply-yandex-schema.sh` по умолчанию использует `--single-transaction`
  (отключается через `NO_SINGLE_TRANSACTION=true` для локальных стендов с
  прямым доступом).
- TS-скрипты используют `spawnSync('psql', [..., '-f', '-'])` со stdin вместо
  `-c "..."` — это обходит баг Windows escape для double-quoted идентификаторов
  внутри SQL (см. Phase 11 `fix-sequences` regression).

## Финальный порядок проверок (TL;DR)

```
1. PRE schema   (apply-yandex-schema.sh yandex_schema_pre_data.sql)
2. DATA restore (restore-public-data.sh)             ← БЕЗ --disable-triggers
3. POST schema  (apply-yandex-schema.sh yandex_schema_post_data.sql)
4. fix sequences
5. verify counts
6. validate main auth FK              (validate-auth-fk: user_profiles_id)
7. apply 089 + validate secondary FKs (validate-auth-fks: остальные 5)
8. preflight (sanity для бэкенда, включая группу app_auth_foreign_keys)
```

Шаг 8 (preflight) валидирует пройденные шаги 6-7 через отдельную
группу `app_auth_foreign_keys`: проверяет, что все 6 FK на `app_auth.users`
существуют, ссылаются на правильную схему и `convalidated=true`. Group
запускается ПОСЛЕ `validate-auth-fk` + `validate-auth-fks` — иначе
выдаст ожидаемые critical fails «FK отсутствует».

До шага 3 на target нет FK / UNIQUE / INDEX / TRIGGER — `verify-public-data`
и `validate-auth-fk` запускать **после** post-data, иначе VALIDATE упадёт
(FK ещё не существует) и тестовые insert'ы из verify-скрипта могут вести
себя иначе, чем под полной обвязкой.

## Скрипты

Все живут в `scripts/yandex-migration/` (корень репо) и
`fot-server/scripts/yandex-migration/`:

| Файл | Назначение |
|---|---|
| [export-public-schema.sh](../../scripts/yandex-migration/export-public-schema.sh) | `pg_dump --schema-only` из Supabase |
| [apply-yandex-schema.sh](../../scripts/yandex-migration/apply-yandex-schema.sh) | apply `yandex_schema.sql` на Yandex |
| [export-public-data.sh](../../scripts/yandex-migration/export-public-data.sh) | `pg_dump --data-only --format=custom` из Supabase |
| [restore-public-data.sh](../../scripts/yandex-migration/restore-public-data.sh) | `pg_restore` на Yandex |
| [verify-public-data.ts](../../scripts/yandex-migration/verify-public-data.ts) | `count(*)` source vs target по всем `public.*` |
| [fix-sequences.ts](../../scripts/yandex-migration/fix-sequences.ts) | `setval` для SERIAL после restore |
| [validate-auth-fk.ts](../../fot-server/scripts/yandex-migration/validate-auth-fk.ts) | проверка + `VALIDATE` FK `user_profiles → app_auth.users` |

Bash-скрипты — `set -euo pipefail`, у всех `--help`, проверяют наличие
`pg_dump` / `pg_restore` / `psql` в PATH.

## ENV — единый набор для всего ран-бука

```bash
export SOURCE_DATABASE_URL='postgres://postgres:***@db.<project>.supabase.co:5432/postgres?sslmode=require'
export TARGET_DATABASE_URL='postgres://fot_app:***@<cluster>.mdb.yandexcloud.net:6432/fot?sslmode=verify-full'
export TARGET_SSL_CA_PATH="$HOME/.postgresql/root.crt"   # YC root CA
```

Пароли **только** в env. В скриптах их нет; в репозитории их нет;
в файлах отчёта их нет. Если кому-то нужен `psql` ad-hoc — пусть
поднимает свой `~/.pgpass`, не правит скрипт.

## Шаги

### 1. Schema-only export из Supabase

```bash
bash scripts/yandex-migration/export-public-schema.sh
# → .migration/supabase_schema.sql
```

### 2. Прогон через transform

```bash
node scripts/yandex-migration/prepare-yandex-schema.mjs \
  --input  .migration/supabase_schema.sql \
  --output .migration/yandex_schema.sql \
  --report .migration/schema_transform_report.md \
  --recovered-functions-migration            docs/migrations/087_recover_runtime_functions.sql \
  --auth-primary-fk-validator                fot-server/scripts/yandex-migration/validate-auth-fk.ts \
  --auth-secondary-fk-replacement-migration  docs/migrations/089_yandex_auth_user_fks.sql
```

Три ack-флага декларируют, что recovered runtime-функции и FK на
`auth.users` будут восстановлены отдельно:

- 087 покрывает 4 recovered-функции;
- `validate-auth-fk.ts` пересоздаёт главный FK `user_profiles_id_fkey`
  → `app_auth.users(id)` (см. шаг 10);
- 089 пересоздаёт 5 secondary FK на `app_auth.users(id)` (см. шаг 11).

С тремя флагами эти находки в отчёте трактуются как **warnings**,
а не critical. `--auth-fk-replacement-migration <path>` — устаревший
single-flag alias (DEPRECATED, сохранён для backward-compat).

**Остаются critical** независимо от флагов:
- FK на `storage.objects` — нет replacement plan;
- inline FK на `auth.users` внутри `CREATE TABLE` — транформер не
  извлекает `REFERENCES` из DDL колонки. Оператор правит
  `yandex_schema_pre_data.sql` руками ДО шага 3.

Проверьте отчёт — если в `critical_fail` есть что-то кроме известных
ожидаемых пунктов, разрулите вручную ДО шага 3. В разделе
«FK на auth.users — replacement plan» отчёта таблица из 6 колонок
сопоставляет каждый стрипнутый FK с конкретным заменителем
(primary/secondary/manual).

### 3. Применить **pre-data** часть схемы в Yandex

```bash
bash scripts/yandex-migration/apply-yandex-schema.sh \
  .migration/yandex_schema_pre_data.sql
```

`prepare-yandex-schema.mjs` (см. шаг 2) автоматически разделил вывод на
три файла: combined `yandex_schema.sql`, `yandex_schema_pre_data.sql` и
`yandex_schema_post_data.sql`.

В pre-data: схемы, types, sequences, **таблицы без FK/INDEX/TRIGGER**,
функции, comments. Этого достаточно, чтобы шаг 7 (data restore) положил
данные без FK-violation'ов — constraint'ы и индексы ещё не существуют.

> Альтернатива: применить combined `yandex_schema.sql` целиком. Тогда на
> шаге 7 потребуется `USE_DISABLE_TRIGGERS=true`, который **на Yandex
> Managed PG не работает** (нет SUPERUSER и
> session_replication_role=replica). Используйте combined только для
> локального PG / AWS RDS с `rds_superuser`.

### 4. (опционально) Применить миграции, не вошедшие в schema-dump

```bash
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/migrations/087_recover_runtime_functions.sql

psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/migrations/088_yandex_app_auth.sql
```

Это создаст runtime-RPC и `app_auth.users` (если не было в source).

### 5. Backfill auth-данных

```bash
cd fot-server
npm run migrate:yandex:auth-users -- --dry-run
# проверить отчёт
npm run migrate:yandex:auth-users -- --apply
```

Подробно — [03_auth_users.md](03_auth_users.md).

### 6. Data-only export из Supabase

```bash
bash scripts/yandex-migration/export-public-data.sh
# → .migration/supabase_public_data.dump (custom format)
```

### 7. Restore данных в Yandex

```bash
# Чистый таргет — без CLEAN_TARGET_TABLES
bash scripts/yandex-migration/restore-public-data.sh
```

Скрипт по умолчанию **не** использует `pg_restore --disable-triggers`:
этот флаг требует SUPERUSER или session_replication_role=replica, чего
регулярному пользователю Yandex Managed PG не дают. Поскольку шаг 3
наложил только pre-data (без FK / UNIQUE / INDEX / TRIGGER), данные
ложатся без violation'ов в чистом виде.

Если повторяете restore поверх уже залитых данных:

```bash
CLEAN_TARGET_TABLES=true CONFIRM_DROP=true \
  bash scripts/yandex-migration/restore-public-data.sh
```

`CLEAN_TARGET_TABLES` сделает `TRUNCATE … CASCADE` **только** для таблиц,
которые есть в дампе. Никакие external-таблицы (например, наполненная
`app_auth.users` из шага 5) не пострадают.

> `USE_DISABLE_TRIGGERS=true` — opt-in для не-Yandex окружений (локальный
> PG, AWS RDS с rds_superuser). На Yandex применять **нельзя**, см.
> `--help` скрипта.

### 7а. Применить **post-data** часть схемы

```bash
bash scripts/yandex-migration/apply-yandex-schema.sh \
  .migration/yandex_schema_post_data.sql
```

Это создаст FK constraints, PK, UNIQUE, CHECK, indexes, triggers и
выполнит `DISABLE ROW LEVEL SECURITY` для всех таблиц, у которых был
RLS в исходном дампе.

После этого таблицы получают полную обвязку — последующие INSERT/UPDATE
будут отлавливаться constraint'ами штатно.

### 8. Поправить SERIAL-counters

```bash
cd fot-server
npm run migrate:yandex:fix-sequences -- --dry-run   # посмотреть план
npm run migrate:yandex:fix-sequences                # выполнить
```

Отчёт: `.migration/sequences_report.md`. Все
SERIAL/BIGSERIAL/IDENTITY-sequence, привязанные к колонкам (через
`pg_depend`), получают `setval` по `MAX(col)`.

### 9. Сверка row-counts

```bash
cd fot-server
npm run migrate:yandex:verify-public
```

Отчёт: `.migration/verify_public_data_report.{json,md}`. Скрипт смотрит:

- focus-таблицы (см. список в коде — 27 ключевых: `user_profiles`,
  `employees`, `skud_events`, `data_api_keys`, и т. д.) — в отчёте
  отдельным блоком;
- все остальные `public.*` base tables — следующим блоком;
- exit 1, если хоть один `count(*)` не совпал.

### 10. Создать + активировать главный FK `user_profiles → app_auth.users`

```bash
cd fot-server
npm run migrate:yandex:validate-auth-fk
```

Скрипт владеет **полным lifecycle** этого cross-schema FK (миграция 088
сама FK не создаёт — она только об `app_auth.users`):

1. **Sanity** — `app_auth.users` и `public.user_profiles` существуют.
2. **Orphans** — `user_profiles.id` без записи в `app_auth.users`.
   Если > 0 → печатает первые 20 и exit 1 (повторите шаг 5 backfill).
3. **Legacy cleanup** — если есть FK `public.user_profiles → auth.users`
   (Supabase-наследие), убирает его idempotent'но.
4. **Create FK** — если FK `user_profiles_id_fkey_app_auth` отсутствует,
   создаёт его с `NOT VALID`.
5. **VALIDATE** — выполняет `ALTER TABLE … VALIDATE CONSTRAINT`. На
   уже-валидированном FK это no-op.

Флаги: `--check-only` (только проверки, без модификаций — для CI),
`--skip-validate` (создаёт FK, но не валидирует — для поэтапной выкатки).

### 11. Восстановить 5 secondary FK на `app_auth.users(id)`

После validate-auth-fk главный FK работает, но на target отсутствуют
5 побочных FK, которые в source ссылались на `auth.users`. Они
стрипнуты transform-ом и должны быть пересозданы против `app_auth.users`.

```bash
# (опционально) idempotent NOT VALID создание через миграцию
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/migrations/089_yandex_auth_user_fks.sql

# полный lifecycle (sanity + orphans + create + VALIDATE + post-check)
cd fot-server
npm run migrate:yandex:validate-auth-fks
```

Список 5 FK (атрибуты — см. [03_auth_users.md](03_auth_users.md)):

| FK | column | ON DELETE |
|---|---|---|
| `user_profiles_approved_by_fkey` | `approved_by` | NO ACTION |
| `audit_logs_user_id_fkey` | `user_id` | NO ACTION |
| `employee_assignments_created_by_fkey` | `created_by` | NO ACTION |
| `fk_push_subscriptions_user` | `user_id` | CASCADE |
| `tender_salary_history_created_by_fkey` | `created_by` | NO ACTION |

`validate-auth-fks` для каждого FK:
1. orphan-check `column IS NOT NULL AND NOT EXISTS app_auth.users` —
   при orphans > 0 печатает первые 20 значений и **не валидирует**;
2. drop legacy FK на `auth.users` (если остался от dump'а);
3. CREATE NOT VALID если FK на `app_auth.users` отсутствует;
4. VALIDATE CONSTRAINT;
5. post-check `pg_constraint.convalidated = true`.

Аналогичные флаги: `--check-only`, `--skip-validate`. Exit 0 только
если все 5 FK получили `convalidated = true`.

### 12. Финальный preflight (sanity для бэкенда)

```bash
cd fot-server
npm run migrate:yandex:preflight
```

`preflight-yandex-db.ts` запускает 10 групп проверок, в т.ч. новую
**`app_auth_foreign_keys`** — она read-only проверяет, что шаги 10-11
действительно завершились корректно:

- Все 6 ожидаемых FK существуют (1 primary + 5 secondary).
- Каждый ссылается **именно на `app_auth.users`** (не на `auth.users`).
- `pg_constraint.convalidated = true` для всех.

| Поле в отчёте | Что показывает |
|---|---|
| `constraint_name` | Фактическое имя из `pg_constraint.conname` (может отличаться от `expectedName`, если оператор переименовал) |
| `source_table` | `public.<table>` |
| `source_column` | Имя колонки |
| `referenced_schema` | Ожидается `app_auth` |
| `referenced_table` | Ожидается `users` |
| `convalidated` | Ожидается `true` |
| `status` | `ok` / `missing` / `wrong_target` / `not_validated` / `skipped_table_missing` |

Critical fail в этой группе блокирует переключение бэкенда на новый
кластер — ссылочная целостность Auth-данных не гарантируется.

## Что НЕ переносится этим ран-буком

- **Файлы** в Cloudflare R2 / Yandex Object Storage — миграция объектного
  хранилища (бакет `skud-object-maps` и т. д.) — отдельная задача.
- **Логи** (`audit_logs` старые) — переносятся вместе со всеми данными
  через шаг 7; если хочется обрезать историю до N дней — сделайте `DELETE`
  на target после шага 7.
- **Расширения**: `btree_gist`, `pg_trgm`, `pgcrypto` — включаются на
  уровне кластера ДО шага 3 (см. [04_schema_prepare.md](04_schema_prepare.md)).

## Чек-лист «всё готово»

После завершения всех шагов:

- [ ] `verify-public-data` → 0 diffs.
- [ ] `fix-sequences` → 0 errors.
- [ ] `validate-auth-fk` → success.
- [ ] `validate-auth-fks` → все 5 FK получили `convalidated=true`.
- [ ] `migrate:yandex:preflight` → 0 critical_fail, **группа
      `app_auth_foreign_keys` — все 6 FK в статусе `ok`**.
- [ ] `psql "$TARGET_DATABASE_URL" -c "SELECT count(*) FROM app_auth.users"` →
      примерно равно ожидаемому числу активных пользователей.
- [ ] `psql "$TARGET_DATABASE_URL" -c "SELECT count(*) FROM public.user_profiles"` →
      то же число.
- [ ] Бэкап target БД (`pg_dump --format=custom`) сделан **до** того, как
      переключите боевой бэкенд на новый кластер.
- [ ] В `fot-server/.env` (на бою) `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
      указывают на новый URL (Yandex-эквивалент или прокси). Это тема
      следующего ран-бука (после полной отвязки от supabase-js).
