# 04 — Подготовка SQL-дампа Supabase для Yandex Managed PostgreSQL

Этот документ — пошаговый ран-бук для одного шага миграции: получить
*schema-only* дамп из Supabase, пропустить его через transform-скрипт и
применить в Yandex. Данные не трогаются — это отдельный шаг (`pg_dump`/`COPY`).

Связанные файлы:

- [scripts/yandex-migration/prepare-yandex-schema.mjs](../../scripts/yandex-migration/prepare-yandex-schema.mjs) — сам трансформер.
- [00_inventory_v2.md](00_inventory_v2.md) §6 — список SQL-несовместимостей, которые скрипт убирает.
- [01_recover_runtime_functions.md](01_recover_runtime_functions.md) — функции, которые нужно довосстановить отдельно.
- [03_auth_users.md](03_auth_users.md) — миграция auth-данных параллельно со схемой.

## 1. Снять schema-only дамп из Supabase

```bash
mkdir -p .migration
pg_dump \
  --schema-only \
  --no-owner \
  --no-privileges \
  --no-publications \
  --no-subscriptions \
  --no-tablespaces \
  --schema=public \
  --schema=app_auth \
  --file=.migration/supabase_schema.sql \
  "$SUPABASE_DB_URL"
```

Флаги:

- `--schema-only` — только DDL, без `COPY`/`INSERT` (данные мигрируем отдельно).
- `--no-owner --no-privileges` — не тащим Supabase-ные `OWNER TO supabase_admin` и `GRANT TO anon/authenticated` (скрипт всё равно их вычистит, но дамп получается чище и его легче ревьюить).
- `--schema=public --schema=app_auth` — берём только наши данные. **Без этих фильтров `pg_dump` вытащит все Supabase-only схемы** (`auth`, `storage`, `realtime`, `vault`, `pgsodium`, …) — придётся вычищать вручную.

> Если в продакшене ещё нет схемы `app_auth` (миграция 088 не применена) — оставьте только `--schema=public`. Скрипт переживёт оба варианта.

## 2. Прогнать transform-скрипт

```bash
node scripts/yandex-migration/prepare-yandex-schema.mjs \
  --input  .migration/supabase_schema.sql \
  --output .migration/yandex_schema.sql \
  --report .migration/schema_transform_report.md
```

Скрипт пройдёт по дампу statement-by-statement и:

- **Закомментирует** (полностью оставит в файле как `-- ...`) все Supabase-only конструкции — операторам приятнее видеть, что именно ушло, чем гадать.
- **Эмитит `ALTER TABLE … DISABLE ROW LEVEL SECURITY`** в самом конце файла для каждой таблицы, у которой в дампе был `ENABLE`/`FORCE RLS`.
- **Не тронет** ваш бизнес-DDL (таблицы `public.*`, индексы, функции, триггеры, последовательности).
- **Разделит на pre-data / post-data**. Помимо combined `yandex_schema.sql`, скрипт автоматически создаёт два файла:
  - `yandex_schema_pre_data.sql` — schemas, types, sequences, tables, functions, comments. Применяется **до** restore-данных.
  - `yandex_schema_post_data.sql` — `ALTER TABLE … ADD CONSTRAINT` (FK / PK / UNIQUE / CHECK), `CREATE INDEX`, `CREATE TRIGGER`, `ALTER TABLE … DISABLE ROW LEVEL SECURITY`. Применяется **после** restore-данных.

  Это позволяет на Yandex Managed PG лить данные без `pg_restore --disable-triggers` (которого регулярному пользователю там не дают): FK / UNIQUE constraint просто **ещё не существуют** на момент data load.

### Что именно убирается

| Что | Зачем |
|---|---|
| `CREATE EXTENSION` / `ALTER EXTENSION` | На Yandex расширения создаются через UI/CLI/Terraform (см. §3) — `CREATE EXTENSION` из дампа упадёт с правами |
| Объекты в схемах `auth`/`storage`/`realtime`/`graphql`/`vault`/`net`/`supabase_functions`/`extensions`/`pgsodium` | Этих схем на Yandex нет |
| `INSERT INTO storage.buckets` (и любые `storage.*` вставки) | Файлы переезжают в Yandex Object Storage; PG-таблицы не нужны |
| `GRANT`/`REVOKE`/`ALTER DEFAULT PRIVILEGES` для `anon`/`authenticated`/`service_role`/`supabase_admin` | Этих ролей на Yandex нет |
| `NOTIFY pgrst` | PostgREST не запускается на Yandex |
| `CREATE`/`ALTER`/`DROP POLICY` | RLS-политики теряют смысл (см. §4) |
| `ENABLE`/`FORCE ROW LEVEL SECURITY` | Аналогично |

### Что флагается как **critical** (но НЕ вычищается автоматически)

| Находка | Что делать |
|---|---|
| `ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY … REFERENCES auth.users` | Скрипт стрипает само `ALTER TABLE`, но фиксирует в report. Главный FK `public.user_profiles(id) → app_auth.users(id)` пересоздаётся через `validate-auth-fk.ts`; остальные 5 — через миграцию [089_yandex_auth_user_fks.sql](../migrations/089_yandex_auth_user_fks.sql) + `validate-auth-fks.ts`. Передайте `--auth-fk-replacement-migration docs/migrations/089_yandex_auth_user_fks.sql`, чтобы понизить эти critical до warnings. |
| `CREATE TABLE … REFERENCES auth.users` (inline) | Скрипт оставляет statement (стрипать корректно невозможно — это часть DDL колонки), но фиксирует critical. Перед применением — удалите `REFERENCES auth.users` руками. С флагом `--auth-fk-replacement-migration` тоже понижается до warning. |
| FK на `storage.objects` | Storage уехал в YOS, FK теряет смысл — удалите вручную. **Critical всегда** (нет analog'а 089-миграции для storage). |
| `SECURITY DEFINER` функция без `SET search_path` | Уязвима к search_path-инъекциям. Добавьте `SET search_path = pg_catalog, public` в определение |
| Отсутствие любой из обязательных runtime-функций | Они **не должны** теряться в дампе. Если потеряны — см. [01_recover_runtime_functions.md](01_recover_runtime_functions.md) и `087_recover_runtime_functions.sql` |

### CLI-флаги для понижения critical → warning

| Флаг | Что декларирует |
|---|---|
| `--recovered-functions-migration <path>` | 4 recovered runtime-функции + 1 helper-зависимость (`recalculate_skud_daily_summary`) будут установлены отдельно через `087`. Файл должен существовать. Без флага — critical; с флагом — warning. |
| `--auth-primary-fk-validator <path>` | Главный FK `user_profiles_id_fkey` пересоздаётся через TS-скрипт `validate-auth-fk.ts`. Без флага — critical; с флагом — warning. |
| `--auth-secondary-fk-replacement-migration <path>` | Остальные 5 ALTER-form FK на `auth.users` пересоздаются через `089_yandex_auth_user_fks.sql` (+ `validate-auth-fks.ts`). Без флага — critical; с флагом — warnings. |
| `--auth-fk-replacement-migration <path>` | **DEPRECATED alias**. Сетит одновременно оба ack'а (primary + secondary) с одним PATH; выводит stderr-warning. Сохранён для backward-compat — предпочтительны два отдельных флага. |

**FK на `storage.objects`** не затрагивается ни одним флагом — всегда
critical (для них нет replacement-плана).

**Inline FK на `auth.users` внутри CREATE TABLE** — всегда **critical**,
не понижается даже с обоими флагами. Транформер не может безопасно
извлечь `REFERENCES auth.users` из определения колонки. Оператор
должен вручную отредактировать `yandex_schema_pre_data.sql` (убрать
`REFERENCES auth.users` из CREATE TABLE) ДО `apply-yandex-schema.sh`.

Несуществующий путь у любого флага → **exit 2** (не путать с обычным
critical-fail). Скрипт вернёт **exit 1**, если в отчёте есть
критические находки. Не применяйте `yandex_schema.sql`, пока их не разрулите.

### Раздел отчёта «FK на auth.users — replacement plan»

Если в дампе нашлись FK на `auth.users` (ALTER-form или inline в CREATE
TABLE), скрипт рендерит в `schema_transform_report.md` таблицу из 6 колонок:

**Source constraint** | **Source table** | **Source columns** |
**Referenced** | **Kind** | **Replacement**

`Kind` принимает три значения:

- `primary` — для `user_profiles_id_fkey`. Replacement указывает на
  `validate-auth-fk.ts` (если флаг передан) или помечен как
  **critical (pass --auth-primary-fk-validator)**.
- `secondary` — для остальных ALTER-form FK на `auth.users`. Replacement
  указывает на `089_yandex_auth_user_fks.sql` (если флаг передан) или
  **critical (pass --auth-secondary-fk-replacement-migration)**.
- `manual` — для inline FK (REFERENCES внутри CREATE TABLE). Replacement
  всегда **manual transform required (always critical)**.

Это позволяет оператору связать каждый стрипнутый FK с конкретным
файлом миграции и точно знать, что нужно править руками.

### Чек-лист после прогона на боевом dump'е

Перед тем, как применить split на staging/prod, откройте
`.migration/schema_transform_report.md` и проверьте:

1. **Counts plausible.** `pre + post + stripped ≈ total kept + stripped`.
   Если `pre=0` или `post=0` — почти наверняка баг классификации, не
   применяйте.
2. **Section split** sanity:
   - в `yandex_schema_pre_data.sql` — нет `CREATE INDEX`, `CREATE TRIGGER`,
     `ALTER TABLE … ADD CONSTRAINT`, `ATTACH PARTITION`;
   - в `yandex_schema_post_data.sql` — нет `CREATE TABLE`, `CREATE FUNCTION`,
     `CREATE SEQUENCE`, `CREATE SCHEMA`.
   Быстрая проверка:
   ```bash
   grep -cE "^(CREATE INDEX|CREATE TRIGGER|ALTER TABLE.+(ADD CONSTRAINT|ATTACH PARTITION))" \
     .migration/yandex_schema_pre_data.sql      # ожидаем 0
   grep -cE "^(CREATE TABLE|CREATE FUNCTION|CREATE SEQUENCE|CREATE SCHEMA)" \
     .migration/yandex_schema_post_data.sql     # ожидаем 0
   ```
3. **Партиционирование.** Для `skud_events` / `skud_event_failures`:
   - parent + child-таблицы в pre-data;
   - все `ATTACH PARTITION` в post-data (`grep "ATTACH PARTITION" .migration/yandex_schema_post_data.sql | wc -l` совпадает с числом партиций в источнике);
   - `ALTER INDEX … ATTACH PARTITION` (если есть partitioned-индекс) — в post-data.
4. **`inline_fk_in_create_table` warnings** в отчёте. По умолчанию
   pg_dump выносит FK в `ALTER TABLE ADD CONSTRAINT` — если warning
   нашёлся, посмотрите, на какую таблицу ссылается inline FK. Если
   parent-таблица гарантированно грузится pg_restore'ом раньше child
   (для статических справочников типа `system_roles`, `access_pages`),
   restore пройдёт. Если нет — вручную перенесите `REFERENCES` из
   `CREATE TABLE` в отдельный `ALTER TABLE ADD CONSTRAINT` в
   post-data файле.
5. **SECURITY DEFINER функции** все имеют `SET search_path`. Если хоть
   одна — critical, добавьте `SET search_path = pg_catalog, public` в
   определение.
6. **Required business functions** — все три таблицы должны быть либо `✓`,
   либо помечены как ожидаемо отсутствующие при `--recovered-functions-migration`:
   - **Required business functions (version-controlled)** — 7 функций из
     `docs/migrations/001-086` (например, `get_descendant_department_ids`,
     `is_admin`).
   - **Recovered runtime functions** — 4 функции из `087` (`batch_recalculate…`,
     `bulk_update_employee_ids`, `find_skud_duplicate_ids`, `find_direct_conversation`).
   - **Recovered helper functions (DB-internal dependencies)** — 1 функция
     `recalculate_skud_daily_summary(uuid, bigint, date)` из `087`,
     вызываемая транзитивно изнутри `batch_recalculate_skud_daily_summary`.
   Итого — **12 функций (11 runtime + 1 helper)**, проверяемые preflight'ом.
7. **Staging-прогон.** Реальный dump надо хотя бы раз прогнать
   end-to-end на dev-кластере Yandex: pre → restore data → post →
   fix-sequences → verify counts → validate-auth-fk. Скорее всего
   вылезет какой-то неучтённый edge case (CREATE OPERATOR, CREATE
   CAST, FUNCTION с STABLE STRICT и т. п.) — лучше поймать на
   staging.

## 3. Включить расширения на Yandex Managed PG

На Yandex расширения нельзя поставить через `CREATE EXTENSION`, выполняя SQL — у пользователя БД нет на это прав. Нужно включить их на уровне кластера.

### Через UI

Yandex Cloud → Managed PostgreSQL → ваш кластер → раздел **«Базы данных»** → выбранная БД → **«Изменить»** → пункт **«Расширения»** → проставить галки:

- `btree_gist` — нужен для exclusion-constraint'ов (миграции 020, 048).
- `pg_trgm` — нужен для GIN-индекса полнотекстового поиска по `employees.full_name` (миграция 080).
- `pgcrypto` — нужен для `gen_random_uuid()` (используется почти во всех `CREATE TABLE` с `id uuid`).

### Через CLI

```bash
yc managed-postgresql database update <db-name> \
  --cluster-name=<cluster> \
  --extensions=pg_trgm,btree_gist,pgcrypto
```

### Через Terraform

```hcl
resource "yandex_mdb_postgresql_database" "fot" {
  cluster_id = yandex_mdb_postgresql_cluster.fot.id
  name       = "fot"
  owner      = "fot_app"

  extension { name = "pg_trgm" }
  extension { name = "btree_gist" }
  extension { name = "pgcrypto" }
}
```

После включения убедитесь:

```sql
SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'btree_gist', 'pgcrypto');
```

Должны быть все три.

## 4. Почему RLS / FORCE RLS убираем

На Supabase RLS играл двойную роль:

1. **Закрыть PostgREST** от анонимного публичного REST-API: RLS + `REVOKE FROM anon` гарантировали, что без service-role-ключа не достучаться до строк.
2. **Иногда** реальные политики на чтение/запись для frontend, который ходит напрямую к PostgREST.

В нашей системе (см. `00_inventory_v2.md`):

- Бэкенд всегда ходил из service-role коннекта — RLS для него был отключён.
- Фронт **никогда** не ходил в Supabase напрямую (нет `@supabase/supabase-js` в `fot-app/package.json`).

На Yandex:

- PostgREST не запускается → причина #1 (закрыть anon) отпадает.
- Бэкенд продолжит ходить из одного выделенного пользователя `fot_app` с полным доступом на `public` → причина #2 неприменима.

Поэтому `ENABLE/FORCE RLS` и связанные `CREATE POLICY` — это бесполезный шум на новом кластере, который только усложняет диагностику (`SELECT ... FROM users` неожиданно возвращает 0 строк). Скрипт явно эмитит `ALTER TABLE … DISABLE ROW LEVEL SECURITY` для всех таблиц, у которых был RLS — это безопасный idempotent NO-OP, если RLS и так был выключен, и явно отключает его иначе.

> Если позже понадобится мульти-tenancy — RLS можно включить точечно для конкретных таблиц/политик, уже под наш конкретный контекст (`current_setting('app.user_id')` и т. п.), а не копировать Supabase-наследие.

## 5. Применить `yandex_schema.sql`

```bash
psql \
  "$YANDEX_DB_URL" \
  --variable=ON_ERROR_STOP=1 \
  --file=.migration/yandex_schema.sql
```

`ON_ERROR_STOP=1` — критично: PostgreSQL по умолчанию продолжает выполнять следующие statements после ошибки. С этим флагом первая же неудача обрывает применение, и вы видите её сразу.

После успешного применения:

1. Прогнать `087_recover_runtime_functions.sql` ([01_recover_runtime_functions.md](01_recover_runtime_functions.md)).
2. Прогнать `088_yandex_app_auth.sql` ([03_auth_users.md](03_auth_users.md)) — создаст `app_auth.users`.
3. Прогнать `migrate-auth-users.ts` — заполнит `app_auth.users` из Supabase.
4. Только потом — заливать данные (`pg_dump --data-only` из Supabase → `psql` в Yandex). Это уже за рамками этого документа.

## 6. WebSQL / SQL-Console — только для ручной проверки

Yandex Cloud → Managed PostgreSQL → ваш кластер → **«Веб-консоль SQL»** удобна, чтобы быстро проверить состояние:

```sql
-- Таблицы public
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1;

-- Расширения
SELECT extname FROM pg_extension ORDER BY 1;

-- Функции public
SELECT proname FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
ORDER BY 1;

-- RLS-статус
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND rowsecurity = true;
```

**НЕ** применяйте через web-консоль большие схемные изменения и не вставляйте туда `yandex_schema.sql` целиком — она:

1. Не показывает построчные ошибки удобно (одно общее сообщение).
2. Иногда таймаутится на длинных DDL.
3. Не даёт `ON_ERROR_STOP=1` — применит частично, оставит схему в полуразобранном состоянии.

Для применения dump'а используйте `psql` (см. §5).
