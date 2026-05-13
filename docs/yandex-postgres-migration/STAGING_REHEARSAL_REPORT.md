# Staging rehearsal report — Supabase → Yandex Managed PG

> Дата source-side прогона: **2026-05-12**.
>
> Этот отчёт имеет **две части**:
>
> 1. **Source-side findings** — снято с реальной боевой Supabase
>    (project `gxbtsnhevhlvmlvvqqqp` "FOT", PG 17.6) через
>    MCP-инструмент `mcp__claude_ai_Supabase__execute_sql`.
>    Никакие данные не модифицировались (только SELECT). Конкретные
>    PII (email, id) НЕ записаны — только счётчики, статусы, имена
>    объектов схемы.
>
> 2. **Target-side rehearsal** — НЕ выполнен в этой итерации:
>    операционно требует staging Yandex Managed PG, `pg_dump`/
>    `pg_restore`/`psql` от PG17, а также реальной выгрузки данных.
>    Все поля помечены `<FILL>` — заполняются оператором по факту
>    прогона на staging.
>
> Цель документа — дать оператору максимум информации до того, как
> он начнёт реальный rehearsal: что ожидать, какие критические
> точки заранее известны, где будут warnings/critical в transform.

## Метаданные

| Поле | Значение |
|---|---|
| Source project (Supabase) | `gxbtsnhevhlvmlvvqqqp` (DocStroy/FOT, region `us-east-1`) |
| Source PostgreSQL | **17.6** on aarch64-linux, gcc 15.2.0 |
| Source DB | `postgres`, user `postgres` (service-role) |
| Target staging (Yandex) | `<FILL_cluster_id>` |
| Target PostgreSQL | `<FILL_pg_version>` |
| Git SHA migration scripts | `<FILL_short_sha>` |
| Operator | `<FILL_name>` |
| Source-side проверки выполнены | **2026-05-12** (через MCP) |
| Target-side rehearsal начат | `<FILL_YYYY-MM-DD HH:MM>` |
| Target-side rehearsal завершён | `<FILL_YYYY-MM-DD HH:MM>` |

## Sизе production source

| Метрика | Значение |
|---|---|
| `auth.users` (total) | **41** |
| `auth.users` с email | 41 (100%) |
| `auth.users` с encrypted_password | 41 (100%) |
| `auth.users` с bcrypt-prefix `$2[aby]$` | 41 (100%) |
| `auth.users` с unsupported hash | **0** |
| `auth.users` duplicates на `lower(email)` | **0** |
| `public.user_profiles` | **40** |
| `auth.users` без `user_profiles` | **1** (нормально — будет создан в app_auth.users без profile) |
| `public.user_profiles` без `auth.users` (orphan) | **0** |
| Approved admin (is_admin + is_approved) | **есть** ✓ |
| Всего таблиц в `public` | **87** base tables |
| `public.skud_events` (partitioned) | 19 child partitions, 1,696,387 rows |
| `public.skud_event_failures` | **обычная таблица** (не partitioned), 50,422 rows |
| Sequences в public, привязанные к колонкам | **20** |
| FORCE RLS public tables | **72** |
| FK `public.*` → `auth.users` | **6** (см. ниже) |
| FK `public.*` → `storage.objects` | **0** |
| `data_api_keys` с bad key_hash (не 64-hex) | **0** |
| Bcrypt-хеши в production | **не выгружались** (только prefix-counts) |

### Размер ключевых public-таблиц

| Таблица | Rows |
|---|---:|
| access_pages | 30 |
| attendance_adjustments | 1,979 |
| daily_tasks | 2 |
| data_api_key_tables | 1 |
| data_api_keys | 1 |
| data_api_request_logs | 7 |
| document_links | 3 |
| documents | 3 |
| employee_assignments | 3,520 |
| employee_direct_reports | **0** |
| employees | 2,517 |
| org_departments | 328 |
| patent_payment_receipts | 3 |
| role_page_access | 62 |
| sigur_runtime_state | 7 |
| skud_daily_summary | 197,270 |
| skud_event_failures | 50,422 |
| skud_events | 1,696,387 |
| system_roles | 5 |
| timesheet_approvals | 11 |
| user_company_access | **0** |
| user_profiles | 40 |

## Pre-flight findings (известные риски до старта rehearsal)

### Finding 1 — все 12 функций (11 runtime + 1 helper) существуют, тела recovered-функций вынесены в 087

> Update 2026-05-12: 087 переписан реальными `pg_get_functiondef` телами
> из production. Backend напрямую вызывает **11 runtime-функций**; одна
> дополнительная — `recalculate_skud_daily_summary(uuid, bigint, date)` —
> является **DB-internal helper'ом**, который вызывается транзитивно
> изнутри тела `batch_recalculate_skud_daily_summary`. Преflight и
> transform проверяют все **12 функций**; 087 содержит **5 из них**
> (4 missing runtime + 1 missing helper). Детали — в
> [01_recover_runtime_functions.md](01_recover_runtime_functions.md).


| Function | Категория | exists | SECURITY DEFINER | SET search_path | Signature |
|---|---|---|---|---|---|
| `batch_recalculate_skud_daily_summary` | runtime | ✓ | ✓ | ✓ | `(p_pairs jsonb)` |
| `recalculate_skud_daily_summary` | **helper** | ✓ | ✓ | ✓ | `(p_organization_id uuid, p_employee_id bigint, p_date date)` |
| `bulk_update_employee_ids` | runtime | ✓ | ✓ | ✓ | **`(p_event_ids bigint[], p_employee_ids bigint[])`** |
| `find_skud_duplicate_ids` | runtime | ✓ | invoker | ✓ | `()` |
| `find_direct_conversation` | runtime | ✓ | invoker | ✓ | `(user1 uuid, user2 uuid)` |
| `replace_role_access_profile` | runtime | ✓ | invoker | ✓ | `(p_role_code text, p_permissions jsonb, p_page_access jsonb)` |
| `data_api_list_public_schema` | runtime | ✓ | ✓ | ✓ | `()` |
| `get_descendant_department_ids` | runtime | ✓ | ✓ | ✓ | `(p_root_ids uuid[])` |
| `try_acquire_sigur_runtime_lease` | runtime | ✓ | ✓ | ✓ | `(p_key text, p_owner text, p_ttl_seconds integer, p_meta jsonb)` |
| `heartbeat_sigur_runtime_lease` | runtime | ✓ | ✓ | ✓ | `(p_key text, p_owner text, p_ttl_seconds integer, p_meta jsonb)` |
| `merge_sigur_runtime_state` | runtime | ✓ | ✓ | ✓ | `(p_key text, p_checkpoint_at timestamptz, p_meta jsonb, p_owner text)` |
| `release_sigur_runtime_lease` | runtime | ✓ | ✓ | ✓ | `(p_key text, p_owner text)` |

**Импликации:**

1. **Все 4 missing runtime + 1 helper в production есть и попадут в schema-dump.** Это значит, что после `pg_dump --schema-only` они будут в `supabase_schema.sql`, и `prepare-yandex-schema.mjs` не отметит их как `MISSING`. **Шаг 4 ран-бука (запуск 087) фактически не нужен**, если только мы не хотим иметь их под version control. Можно прогнать `prepare-yandex-schema.mjs` БЕЗ `--recovered-functions-migration` — exit 0 ожидается (functions присутствуют).

2. **Реальная сигнатура `bulk_update_employee_ids`** — `bigint[]` для обоих массивов. Если оператор перед staging хочет финализировать 087 — может теперь смело вписать эту сигнатуру в шаблон (раньше она была "не выводится из call-sites" → не было шаблона).

3. **Helper `recalculate_skud_daily_summary`** теперь явно учитывается в preflight (detail-строка: "helper — DB-internal dependency of `batch_recalculate_skud_daily_summary`"). Если её нет в target — runtime-функция №`batch_recalculate_skud_daily_summary` упадёт при первом тике, но preflight это поймает заранее.

4. Все 7 VC-функций (024/025/060/083) на месте — critical-категория «version_controlled_function_missing» не сработает.

### Finding 2 — 6 FK на `auth.users`, **решение реализовано**

| FK constraint name | from table | column | ON DELETE | ON UPDATE | Восстанавливается через |
|---|---|---|---|---|---|
| `user_profiles_id_fkey` | `public.user_profiles` | `id` | NO ACTION | NO ACTION | `validate-auth-fk.ts` (главный) |
| `user_profiles_approved_by_fkey` | `public.user_profiles` | `approved_by` | NO ACTION | NO ACTION | 089 + `validate-auth-fks.ts` |
| `audit_logs_user_id_fkey` | `public.audit_logs` | `user_id` | NO ACTION | NO ACTION | 089 + `validate-auth-fks.ts` |
| `employee_assignments_created_by_fkey` | `public.employee_assignments` | `created_by` | NO ACTION | NO ACTION | 089 + `validate-auth-fks.ts` |
| `fk_push_subscriptions_user` | `public.push_subscriptions` | `user_id` | **CASCADE** | NO ACTION | 089 + `validate-auth-fks.ts` |
| `tender_salary_history_created_by_fkey` | `public.salary_history` | `created_by` | NO ACTION | NO ACTION | 089 + `validate-auth-fks.ts` |

Атрибуты `ON DELETE`/`ON UPDATE`/`DEFERRABLE`/`MATCH` сняты с боевой Supabase
через `pg_get_constraintdef` + `pg_constraint` метаданные (не угаданы).
Все 5 secondary FK — single-column, MATCH SIMPLE, NOT DEFERRABLE.

`prepare-yandex-schema.mjs` стрипает все 6 как `ALTER TABLE … REFERENCES auth.users`
→ critical `fk_auth_users_alter`. Они не попадут в `yandex_schema_post_data.sql`.

**Восстановление после restore + backfill:**

```bash
# 1. главный FK — через TS-скрипт (полный lifecycle)
npm run migrate:yandex:validate-auth-fk

# 2. 5 secondary FK — через миграцию 089 + TS-скрипт
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/migrations/089_yandex_auth_user_fks.sql
npm run migrate:yandex:validate-auth-fks
```

Подробно — [03_auth_users.md](03_auth_users.md) и
[05_public_data.md](05_public_data.md) шаги 10-11.

### Finding 3 — `skud_event_failures` НЕ partitioned в production

Документация (`00_inventory_v2.md` §1.1, миграция 085) описывает таблицу как partitioned по `event_date`. **В production это обычная таблица** (`pg_class.relkind = 'r'`, не `'p'`), с 50,422 строками.

**Impact на rehearsal:**
- `preflight-yandex-db.ts` будет ожидать партиции и **выдаст fail** на проверке `partitions_public_skud_event_failures`. Это технически правильный результат (доку не выполнена), но не блокирует runtime.
- pre-data dump будет содержать обычный `CREATE TABLE skud_event_failures (...)`, без `PARTITION BY`. Restore ляжет нормально.

**Action item оператора**: либо
- (a) патчить `preflight-yandex-db.ts` чтобы `skud_event_failures` проверять как regular table, либо
- (b) принять fail в preflight как known-warn и записать в exclusions, либо
- (c) применить миграцию 085 правильно с partitioning на новом target (нужен бэкап + recreate).

Рекомендация — **(b) для staging**, **(c) до prod**: 50k строк — много для пары лет; будущие годы хочется иметь partition strategy.

### Finding 4 — FORCE RLS на 72 таблицах будет полностью стрипнут

72 public-таблицы (включая 19 партиций `skud_events`, parent + 18 listed children) имеют `relrowsecurity AND relforcerowsecurity`. `prepare-yandex-schema.mjs` стрипает все RLS-команды и эмитит `ALTER TABLE … DISABLE ROW LEVEL SECURITY` в `post_data.sql`. На Yandex (без anon/authenticated/service_role) это правильное поведение.

### Finding 5 — 1 auth.user без user_profile

Один из 41 пользователей `auth.users` не имеет соответствующего профиля в `public.user_profiles`. После backfill через `migrate-auth-users --apply` в `app_auth.users` будет 41 запись. FK `user_profiles → app_auth.users` corretto работает (40 user_profiles все находят свою запись), а лишний `app_auth.user` останется без профиля. **Это не блокирует выкатку** — пользователь может зарегистрировать профиль штатным register-флоу после deploy.

---

## Шаги (исполнение оператором)

> ⚠ Поля `<FILL>` — заполняет оператор по факту прогона. Поля,
> уже заполненные числами выше, — source-side findings, известные ДО
> запуска ран-бука.

### Шаг 1 — `export-public-schema.sh`

```bash
bash scripts/yandex-migration/export-public-schema.sh
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| Длительность | ~1-3 мин | `<FILL>` |
| Output file | `.migration/supabase_schema.sql` | `<FILL_size_kb>` |
| Время | — | `<FILL_HH:MM>` |

---

### Шаг 2 — `prepare-yandex-schema.mjs`

**Без `--recovered-functions-migration`** — все 4 recovered функции уже в production (см. Finding 1), они попадут в дамп.

```bash
node scripts/yandex-migration/prepare-yandex-schema.mjs \
  --input  .migration/supabase_schema.sql \
  --output .migration/yandex_schema.sql \
  --report .migration/schema_transform_report.md
```

| Метрика | Ожидаемое (из source-side) | Фактическое |
|---|---|---|
| Exit code | `0` (все 12 functions present: 11 runtime + 1 helper) | `<FILL>` |
| Total statements | — | `<FILL>` |
| Kept / Stripped | — | `<FILL>` / `<FILL>` |
| Sections pre / post | — | `<FILL>` / `<FILL>` |
| Critical findings | **6** (FK на auth.users, см. Finding 2) | `<FILL>` |
| Warnings | — | `<FILL>` |
| `version_controlled_function_missing` | 0 | `<FILL>` |
| `recovered_function_missing` (runtime) | 0 | `<FILL>` |
| `recovered_helper_function_missing` | 0 | `<FILL>` |
| `security_definer_missing_search_path` | 0 (все 11 имеют) | `<FILL>` |
| `fk_auth_users_alter` (critical) | 6 | `<FILL>` |
| `fk_storage_objects_alter` | 0 | `<FILL>` |
| `inline_fk_in_create_table` (warning) | — | `<FILL>` |

**Sanity на split-файлах:**

```bash
grep -cE "^(CREATE INDEX|CREATE TRIGGER|ALTER TABLE.+(ADD CONSTRAINT|ATTACH PARTITION))" \
  .migration/yandex_schema_pre_data.sql   # ожидаем 0
grep -cE "^(CREATE TABLE|CREATE FUNCTION|CREATE SEQUENCE|CREATE SCHEMA)" \
  .migration/yandex_schema_post_data.sql  # ожидаем 0
grep -c "ATTACH PARTITION" .migration/yandex_schema_post_data.sql   # ожидаем 19 (skud_events)
```

| Sanity | Ожидаемое | Фактическое |
|---|---|---|
| post-DDL в pre | 0 | `<FILL>` |
| pre-DDL в post | 0 | `<FILL>` |
| ATTACH PARTITION count | **19** | `<FILL>` |

> **Важно**: 6 critical FK на auth.users — это нормально, transform их стрипает. Файл `yandex_schema.sql` применять напрямую, не игнорируя critical. После применения `validate-auth-fk.ts` пересоздаст `user_profiles_id_fkey_app_auth`. Остальные 5 FK НЕ восстанавливаются автоматически (см. Finding 2, action item).

---

### Шаг 3 — `apply-yandex-schema.sh PRE`

```bash
bash scripts/yandex-migration/apply-yandex-schema.sh \
  .migration/yandex_schema_pre_data.sql
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| `SELECT version()` target | PG 17 | `<FILL>` |
| Длительность | ~30 сек - 2 мин | `<FILL>` |
| psql ошибки | — | `<FILL>` |

После шага:
- [ ] схема `public` создана
- [ ] 87 base tables созданы (включая parent `skud_events`, 19 children, regular `skud_event_failures`)
- [ ] 12 functions созданы (4 recovered runtime + 1 helper + 7 VC + другие из dump)
- [ ] FK / INDEX / TRIGGER **отсутствуют**

---

### Шаг 4 — `087_recover_runtime_functions.sql` (опционально)

> Можно **пропустить**: все 4 recovered функции уже накатились в шаге 3 (они есть в production dump).
>
> Если всё-таки запускать — preflight 087 проверит, что функции существуют + не содержат `TODO_REAL_BODY_NOT_INSERTED`. Должен пройти без ошибки.

```bash
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/migrations/087_recover_runtime_functions.sql
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` (preflight пройдёт) | `<FILL>` |
| Skipped (как излишний) | — | `<FILL>` |

---

### Шаг 5 — `088_yandex_app_auth.sql`

```bash
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/migrations/088_yandex_app_auth.sql
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| `app_auth.users` создан (rows=0) | да | `<FILL>` |
| FK `user_profiles → app_auth.users` | **НЕ создан** (это работа шага 13) | `<FILL>` |

---

### Шаг 6 — `migrate-auth-users --dry-run`

```bash
cd fot-server
npm run migrate:yandex:auth-users -- --dry-run
```

| Метрика | Ожидаемое (из source) | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| Source rows | **41** | `<FILL>` |
| Would-be inserted | **41** | `<FILL>` |
| Skipped: noEmail | **0** | `<FILL>` |
| Skipped: passwordless | **0** | `<FILL>` |
| Skipped: unsupportedHash | **0** | `<FILL>` |
| Conflicts lower(email) | **0** | `<FILL>` |
| Verification samples (5) | все ✓ | `<FILL>` |

---

### Шаг 7 — `migrate-auth-users --apply`

```bash
npm run migrate:yandex:auth-users -- --apply
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| Inserted | **41** | `<FILL>` |
| `app_auth.users` count после | **41** | `<FILL>` |
| Bcrypt-хеши в stdout/reports | **0** упоминаний | `<FILL>` |

---

### Шаг 8 — `export-public-data.sh`

```bash
bash scripts/yandex-migration/export-public-data.sh
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| Длительность | зависит от skud_events (~1.7M rows) | `<FILL>` |
| Output size | ~`<estimate>` GB | `<FILL>` |

---

### Шаг 9 — `restore-public-data.sh`

```bash
bash scripts/yandex-migration/restore-public-data.sh
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| `--disable-triggers` | **НЕ передан** | проверено `<FILL>` |
| Constraint violations | 0 (FK ещё нет) | `<FILL>` |
| Длительность | основная — `skud_events` | `<FILL>` |

После шага — все 87 таблиц наполнены (исключая `employee_direct_reports` и `user_company_access`, которые в source пусты).

---

### Шаг 10 — `apply-yandex-schema.sh POST`

```bash
bash scripts/yandex-migration/apply-yandex-schema.sh \
  .migration/yandex_schema_post_data.sql
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| `ATTACH PARTITION` (skud_events) | **19** | `<FILL>` |
| `ATTACH PARTITION` (skud_event_failures) | **0** (не partitioned в source) | `<FILL>` |
| `DISABLE ROW LEVEL SECURITY` (всего) | **72** | `<FILL>` |
| Failed constraints | 0 | `<FILL>` |
| Failed indexes | 0 | `<FILL>` |

---

### Шаг 11 — `fix-sequences`

```bash
npm run migrate:yandex:fix-sequences -- --dry-run
npm run migrate:yandex:fix-sequences
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code (apply) | `0` | `<FILL>` |
| Total sequences | **20** | `<FILL>` |
| OK | 20 | `<FILL>` |
| Errors | 0 | `<FILL>` |

---

### Шаг 12 — `verify-public-data`

```bash
npm run migrate:yandex:verify-public
```

| Метрика | Ожидаемое (source counts) | Target Фактическое |
|---|---:|---|
| Exit code | `0` | `<FILL>` |
| Tables checked | **87** | `<FILL>` |
| Diff | 0 | `<FILL>` |
| user_profiles | **40** | `<FILL>` |
| employees | **2,517** | `<FILL>` |
| employee_assignments | **3,520** | `<FILL>` |
| skud_events | **1,696,387** | `<FILL>` |
| skud_event_failures | **50,422** | `<FILL>` |
| skud_daily_summary | **197,270** | `<FILL>` |
| attendance_adjustments | **1,979** | `<FILL>` |
| org_departments | **328** | `<FILL>` |
| (focus tables — все из 27) | match | `<FILL>` |

---

### Шаг 13 — `validate-auth-fk`

```bash
npm run migrate:yandex:validate-auth-fk
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| `app_auth.users` exists | ✓ | `<FILL>` |
| `public.user_profiles` exists | ✓ | `<FILL>` |
| Orphans `user_profiles → app_auth.users` | **0** (по source-side) | `<FILL>` |
| Legacy FK на `auth.users` (drop) | **6 на source**, но **0 на target** после transform | `<FILL>` |
| `user_profiles_id_fkey_app_auth` создан | да | `<FILL>` |
| `pg_constraint.convalidated` после VALIDATE | `true` | `<FILL>` |

---

### Шаг 13a — apply 089 (5 secondary FK NOT VALID)

```bash
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/migrations/089_yandex_auth_user_fks.sql
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| Dropped legacy FK | `0` (transform уже стрипнул) | `<FILL>` |
| Created NOT VALID FK | **5** | `<FILL>` |

### Шаг 13b — `validate-auth-fks` (5 secondary)

```bash
npm run migrate:yandex:validate-auth-fks
```

| Метрика | Ожидаемое | Фактическое |
|---|---|---|
| Exit code | `0` | `<FILL>` |
| `user_profiles_approved_by_fkey` | validated, orphans=0 | `<FILL>` |
| `audit_logs_user_id_fkey` | validated, orphans=0 | `<FILL>` |
| `employee_assignments_created_by_fkey` | validated, orphans=0 | `<FILL>` |
| `fk_push_subscriptions_user` | validated, orphans=0 | `<FILL>` |
| `tender_salary_history_created_by_fkey` | validated, orphans=0 | `<FILL>` |
| Все FK `convalidated=true` | да | `<FILL>` |

Если orphans > 0 хотя бы по одному column — печатается список первых
20 значений и FK не валидируется. Решение: ручной cleanup orphan-строк
ИЛИ оставить FK как NOT VALID (приложение всё равно блокирует
запись новых orphan-ов).

> После шага 13b в preflight (шаг 14) группа `app_auth_foreign_keys`
> должна показать все 6 FK в статусе `ok` (1 primary + 5 secondary).
> Любой `missing` / `wrong_target` / `not_validated` → critical fail
> и блокирует переключение бэкенда.

---

### Шаг 14 — `preflight-yandex-db`

```bash
npm run migrate:yandex:preflight
```

| Группа | Ожидаемое | Фактическое |
|---|---|---|
| version_info | PG 17 | `<FILL>` |
| schemas (public, app_auth) | ✓ | `<FILL>` |
| tables (13 ключевых) | ✓ | `<FILL>` |
| functions (12: 11 runtime + 1 helper) | ✓ (все есть в source, прилетят в dump) | `<FILL>` |
| extensions (btree_gist/pg_trgm/pgcrypto) | ✓ (на source все 3 есть) | `<FILL>` |
| `no_fk_to_supabase_only` | ✓ (transform убрал 6 FK на auth.users) | `<FILL>` |
| `no_force_rls` | ✓ (transform DISABLE-ил 72 таблицы) | `<FILL>` |
| `no_supabase_roles` | ✓ (Yandex их и так не имеет) | `<FILL>` |
| auth: orphans | 0 | `<FILL>` |
| auth: password_hash format | 0 bad | `<FILL>` |
| auth: duplicate emails | 0 | `<FILL>` |
| auth: approved admin | exists | `<FILL>` |
| data: sequences aligned | 20 OK | `<FILL>` |
| data: data_api_keys hash | 0 bad | `<FILL>` |
| data: partitions skud_events | **19 attached** | `<FILL>` |
| data: partitions skud_event_failures | **warn expected** (regular table, production-parity, см. Finding 3) | `<FILL>` |
| app_auth_foreign_keys: `primary:user_profiles_id_fkey_app_auth` | `ok` | `<FILL>` |
| app_auth_foreign_keys: `secondary:user_profiles_approved_by_fkey` | `ok` | `<FILL>` |
| app_auth_foreign_keys: `secondary:audit_logs_user_id_fkey` | `ok` | `<FILL>` |
| app_auth_foreign_keys: `secondary:employee_assignments_created_by_fkey` | `ok` | `<FILL>` |
| app_auth_foreign_keys: `secondary:fk_push_subscriptions_user` | `ok` | `<FILL>` |
| app_auth_foreign_keys: `secondary:tender_salary_history_created_by_fkey` | `ok` | `<FILL>` |
| env_reminders | info-only | `<FILL>` |
| **Critical fails** | **0** ожидается (skud_event_failures plain — warning, не critical) | `<FILL>` |

---

## Итоговое решение

### Source-side оценка (выполнено 2026-05-12, до staging-прогона)

| Проверка | Результат |
|---|---|
| Все 12 функций существуют (11 runtime + 1 helper `recalculate_skud_daily_summary`) + правильно настроены | ✓ |
| Bcrypt-формат хешей `auth.users` корректный во всех 41 записи | ✓ |
| Дубликатов `lower(email)` нет | ✓ |
| Approved admin existsist | ✓ |
| Orphans `user_profiles → auth.users` = 0 | ✓ |
| Все 3 нужных extensions на source присутствуют (на Yandex нужно создать вручную) | ✓ |
| FK на storage.objects | 0 (storage не используется в FK) ✓ |
| Inline FK в CREATE TABLE | проверится на шаге 2 (вероятно есть warnings) |

### Source-side findings, требующие решения ДО prod-rollout

| # | Finding | Severity | Action |
|---|---|---|---|
| 1 | `skud_event_failures` НЕ partitioned, хотя doc говорит о партициях | medium | До prod — patch preflight OR re-partition (нужен бэкап) |
| 2 | 5 FK на `auth.users` (кроме `user_profiles_id`) теряются после transform | **РЕШЕНО** | Миграция [089_yandex_auth_user_fks.sql](../migrations/089_yandex_auth_user_fks.sql) + [validate-auth-fks.ts](../../fot-server/scripts/yandex-migration/validate-auth-fks.ts). Атрибуты сняты с production через pg_get_constraintdef. |
| 3 | 1 auth.user без user_profile | low | После rollout — backfill вручную или register flow |
| 4 | `bulk_update_employee_ids` сигнатура `(bigint[], bigint[])` теперь известна | **РЕШЕНО** | 087 переписан реальными телами 4 функций + 1 helper (`recalculate_skud_daily_summary`) из production через `pg_get_functiondef` — см. [01_recover_runtime_functions.md](01_recover_runtime_functions.md). |

### Решение для staging rehearsal

**`READY for staging rehearsal`** — source-side проверки чисты,
ожидаемое поведение transform/restore/validate известно с
конкретными числами.

Оператор может запускать staging end-to-end по этой инструкции и
заполнять колонки `<FILL>`. После того, как все 14 шагов прошли
без неожиданных critical, и пункты findings разрулены (skud_event_failures
partition decision, FK 089-миграция), документ можно подписать как
`READY for prod`.

### Решение для prod

**`NOT READY for prod`** — нужен:
1. Полный staging-прогон (этот документ заполнен `<FILL>` всеми числами).
2. Решение по `skud_event_failures` partition (Finding 1).
3. ✅ ~~Миграция 089 для не-user_profiles FK (Finding 2)~~ — реализовано
   (089 + validate-auth-fks).
4. Прогон под нагрузкой: бэкенд + 1-2 пользователя на staging хотя бы 24h без явных ошибок Sentry.

### Артефакты (приложить по факту staging-прогона)

- [ ] `.migration/schema_transform_report.md`
- [ ] `.migration/auth_users_report.{json,md}` (для dry-run и apply)
- [ ] `.migration/sequences_report.md`
- [ ] `.migration/verify_public_data_report.{json,md}`
- [ ] `.migration/yandex_preflight_report.{json,md}`
- [ ] Логи `pg_restore` (шаг 9) и `psql -f` (шаги 3/10)
- [ ] `pg_dump --schema=app_auth` снимок **до** validate-auth-fk

Подпись (source-side review): **2026-05-12** (Claude, via MCP)

Подпись (staging rehearsal): `<FILL_name, дата>`

---

## ✅ Phase 11 — фактический прогон staging rehearsal (2026-05-12)

**Target:** Yandex Managed PG `FOT_Prod` — PG 17.9, primary `rc1d-m4ubd0uem0j9gqqc.mdb.yandexcloud.net:6432`, replica `rc1b-bhf80lg9gcvcpvlh...`, sslmode=verify-full через Yandex CA (`.migration/yandex-ca.pem`), conn через Odyssey pooler port 6432 (port 5432 закрыт firewall'ом).

**Source:** Supabase project `gxbtsnhevhlvmlvvqqqp` (`postgres.gxbtsnhevhlvmlvvqqqp@aws-1-us-east-1.pooler.supabase.com:5432`, PG 17.6, Supabase Pro plan, IPv6-only direct → используется session pooler).

**Среда оператора:** Windows 11 + Git Bash, psql/pg_dump/pg_restore 18.3 (scoop), Node 24.

### Шаги (executed)

| # | Шаг | Результат | Время |
|---|---|---|---|
| 1 | `export-public-schema.sh` | 271 KB dump, 1048 statements (87 CREATE TABLE, 31 CREATE FUNCTION, 6 FK→auth.users, 190 ATTACH PARTITION, 72 FORCE RLS) | ~30 сек |
| 2 | `prepare-yandex-schema.mjs` | **0 critical, 6 warnings** (все 6 — secondary FK на auth.users, acknowledged через 089). Split: pre=89 KB, post=170 KB. Sanity OK: 0 post-DDL в pre, 0 pre-DDL в post, 190 ATTACH PARTITION в post, 74 DISABLE RLS, 93 FK ADD CONSTRAINT | <1 сек |
| 3 | `apply-yandex-schema.sh PRE` | 87 tables + 20 user functions + 26 sequences. Скрипт пропатчен: добавлен `--single-transaction` по умолчанию (Yandex pooler сбрасывает session-level SET между statements, без TX-обёртки SQL-функции с forward references падают). `CREATE SCHEMA public` заменён на `IF NOT EXISTS` (Yandex pre-creates schema) | ~1 мин |
| 4 | `087_recover_runtime_functions.sql` | 5 функций обновлены (4 runtime + 1 helper) | <5 сек |
| 5 | `088_yandex_app_auth.sql` | schema `app_auth` + table `users` создан | <5 сек |
| 6 | `migrate-auth-users --dry-run` | **46** users в source (вырос с 41 на момент source-side review), 0 conflicts | ~10 сек |
| 7 | `migrate-auth-users --apply` | **46/46** inserted в `app_auth.users` | ~5 сек |
| 8 | **`export-public-data` (directory format)** | **22 MB / 67 файлов / 7 мин**. ⚠ Critical incident: одна-к-одной single-file и directory-format pg_dump падали на `skud_events_*` партициях из-за **AWS NLB ~3-5 мин session timeout** (не idle — keepalives не помогли). По решению оператора `skud_events*` (parent + 19 партиций + quarantine) **исключены через `--exclude-table='public.skud_events*'`** — будут backfill'нуты из Sigur API после deploy. Создан вспомогательный `scripts/yandex-migration/export-public-data-dir.sh` с `--jobs=2` | 7 мин |
| 9 | `restore-public-data.sh` | 67 таблиц restored. Скрипт пропатчен: проверка `[[ -f $IN ]]` → `[[ -e $IN ]]` для поддержки directory dump | 3 мин |
| 10 | `apply-yandex-schema.sh POST` | 19 партиций skud_events attached, 396 индексов, 11 триггеров, **112 FK**, 0 RLS-enabled таблиц | ~55 сек |
| 11 | `089_yandex_auth_user_fks.sql` | 5 secondary FK NOT VALID созданы | <5 сек |
| 12 | `fix-sequences` | ⚠ TS-скрипт упал из-за Windows `spawnSync` escaping bug (только 1/20 sequence обновлён). Обошёл через inline `DO $$ ... $$` SQL-блок прямо в psql — **все 20 sequences** обновлены за <1 сек | <1 сек |
| 13 | `verify-public-data` | **76/87 match, 0 errors, 11 diff** — 6 из 11 это `skud_events*` (skipped, ожидаемо), 5 микро-diff'ов (1-60 строк на live-таблицах: `audit_logs -4`, `sigur_health_checks -60`, `skud_daily_summary -1`, `skud_event_failures -13`, `skud_events_quarantine -3`) — новые записи в source между snapshot-моментами параллельных pg_dump worker'ов. Норм. | ~15 сек |
| 14 | `validate-auth-fk` (primary) | `user_profiles_id_fkey_app_auth`: 0 orphans, validated=true ✓ | ~5 сек |
| 15 | `validate-auth-fks` (5 secondary) | все 5 FK validated, 0 orphans на каждом ✓ | ~10 сек |
| 16 | `preflight-yandex-db` (final) | **57 ok, 1 warn, 0 critical** ✅ | ~10 сек |
| 17 | `migrate-skud-object-maps --dry-run` | ⚠ Сначала 19/20 fail с `UnknownError` — `targetHasObject` ловил только 404 как "не существует", а **Cloud.ru S3 на HEAD отсутствующего объекта возвращает 403**. Пропатчил `targetHasObject` чтобы трактовать 403/AccessDenied/NoSuchKey как "не существует". После — 20/20 готовы к миграции, 0 fail | ~10 сек |
| 18 | `migrate-skud-object-maps --apply` | **20/20 maps мигрировано** Supabase Storage → Cloud.ru S3 (`fot.app/travel-objects/*`) за **8 сек** | 8 сек |

### Финальные счётчики на target

| Объект | Count | Source ref | Diff |
|---|---:|---:|---:|
| `app_auth.users` | **46** | 46 | ✓ |
| `user_profiles` | 45 | 45 | ✓ |
| `employees` | 2 519 | 2 519 | ✓ |
| `employee_assignments` | 3 536 | 3 536 | ✓ |
| `org_departments` | 328 | 328 | ✓ |
| `attendance_adjustments` | 2 018 | 2 018 | ✓ |
| `skud_daily_summary` | 199 052 | 199 053 | -1 (snapshot delta) |
| `skud_event_failures` | 51 152 | 51 165 | -13 (snapshot delta) |
| `audit_logs` | 7 950 | 7 954 | -4 (snapshot delta) |
| `sigur_health_checks` | 209 597 | 209 657 | -60 (snapshot delta) |
| `skud_events` (parent + 19 partitions) | **0** | 1 710 130 | **-1.7M (skipped, см. ниже)** |
| `system_roles` | 5 | 5 | ✓ |
| `role_page_access` | 62 | 62 | ✓ |
| `data_api_keys` | 1 | 1 | ✓ |
| `sigur_runtime_state` | 7 | 7 | ✓ |
| Public sequences (20) | все ≥ MAX(col) | — | ✓ |
| Skud-object-maps в Cloud.ru S3 | 20/20 | 20 | ✓ |

### Open items до production cutover

1. **`skud_events*` (1.7M rows) — НЕ перенесены.** Pooler рвёт COPY > 3-5 мин (AWS NLB), даже directory-format с jobs=2 не вытащил. Варианты:
   - **A. Включить Supabase IPv4 add-on** ($4/мес) — `db.<ref>.supabase.co` получит A-запись, direct connect без NLB timeout, тогда single-file pg_dump пройдёт за 30-60 мин.
   - **B. Backfill через Sigur API** после cutover — `presence-polling` уже умеет пересобирать historical events; точное окно надо договорить (текущий ретенцион Sigur — настройка кластера).
   - **C. IPv6 direct** — если на сервере деплоя есть IPv6 outbound. На текущей Windows dev-машине IPv6 outbound не работает.
2. **`skud_event_failures` plain table** (Finding 3 из source-side) — repartition отдельной post-cutover миграцией согласно [07_skud_event_failures_partitioning.md](07_skud_event_failures_partitioning.md).
3. **`fix-sequences.ts` Windows escape bug** — TS-скрипт `spawnSync` неверно эскейпит `"` в `psql -c '...'` на Windows. На Linux/macOS работает. Workaround — inline `DO`-блок в psql (в этом отчёте сделан вручную, в скрипт пока не зашит). Issue: `fot-server/.../scripts/yandex-migration/fix-sequences.ts:162`.
4. **Smoke tests НЕ выполнены.** Шаги 20-22 ран-бука (запустить fot-server и fot-data-api с TARGET_DATABASE_URL, прогнать smoke-тесты UI/API через 7 доменов) требуют живого staging-стека с уникальными JWT/ENCRYPTION_KEY и SSH-доступ к prod-машине. Отложено до следующей сессии.
5. **`migrate-skud-object-maps-storage.ts`**: добавлена обработка 403/NoSuchKey/AccessDenied как "не существует" для S3-providers, которые маскируют existence (Cloud.ru). Изменение полезно и для других нестандартных провайдеров.

### Внесённые правки в скриптах пайплайна (committed-quality)

| Файл | Изменение |
|---|---|
| `scripts/yandex-migration/apply-yandex-schema.sh` | Добавлен `--single-transaction` по умолчанию (env: `NO_SINGLE_TRANSACTION=true` отключает) |
| `scripts/yandex-migration/restore-public-data.sh` | `[[ -f $IN ]]` → `[[ -e $IN ]]` + проверка `f \|\| d` для directory-format |
| `scripts/yandex-migration/verify-public-data.ts` | Использует только `SOURCE_DATABASE_URL` (psql/libpq — `uselibpqcompat` не понимает) |
| `scripts/yandex-migration/export-public-data-dir.sh` | **Новый** — directory-format dump + `--jobs=2` для обхода NLB timeout |
| `fot-server/scripts/yandex-migration/migrate-auth-users.ts` | `SOURCE_DATABASE_URL_NODE` → fallback `SOURCE_DATABASE_URL` (Node pg требует `uselibpqcompat=true` для encryption-only TLS) |
| `fot-server/scripts/yandex-migration/migrate-skud-object-maps-storage.ts` | Та же `SOURCE_DATABASE_URL_NODE` логика + расширение `targetHasObject`: 403/NoSuchKey/AccessDenied трактуются как "не существует" |
| `fot-server/package.json` | 7 новых `migrate:yandex:*` npm-скриптов |
| `.gitignore` | `.migration/`, `yandex.env` |
| (Yandex schema dump artifact) `.migration/yandex_schema_pre_data.sql` | Ручной патч `CREATE SCHEMA public;` → `CREATE SCHEMA IF NOT EXISTS public;` (Yandex pre-creates) |

### Локальная sanity после rehearsal

- `cd fot-server && npm run build` → exit 0
- `cd fot-server && npm run test` → **388 passed / 0 failed** (41 files)
- `cd fot-data-api && python -m compileall app` → exit 0

### Итоговое решение

**`READY for next phase: smoke tests + cutover preparation`** при условии решения по `skud_events*` (см. open item #1). Структурно target полностью соответствует source, все FK validated, все sequences aligned. Storage 20/20 объектов на Cloud.ru. Никаких блокеров на стороне схемы/данных не остаётся для домена БЕЗ skud_events history.

**`NOT READY for prod cutover`** — требуются:
- Smoke tests на staging fot-server + fot-data-api с target DSN (~24h soak).
- Решение по skud_events backfill (Supabase IPv4 add-on либо Sigur API replay).
- Cutover-план с порядком отключения Supabase / включения Yandex DSN в проде.

Подпись (Phase 11 staging rehearsal): **2026-05-12 23:48** (Claude, executed end-to-end pipeline)

---

## 🛠 Phase 11B — Close open items before Phase 12 (2026-05-12)

Эта фаза посвящена устранению **open items** из Phase 11 без новых запусков
пайплайна на проде. Никаких записей в target/source — только код, скрипты,
документация.

### Task 1 — план миграции skud_events (decision)

**Выбран вариант C (Sigur API backfill) для production**. См.
[09_skud_events_migration.md](09_skud_events_migration.md).

Аргументы:
- 1.7M+ строк, основная польза — за последние 2-3 месяца (свежие табели).
- Старые подписаны и в дальнейшем не пересчитываются.
- Не зависит от Supabase живого после cutover, $4/мес IPv4 add-on не нужен.
- Структура target уже корректна (19 партиций ATTACH'нуты в шаге 10 Phase 11).

**Backfill-скрипт** напишем в Phase 12 (`scripts/yandex-migration/backfill-skud-events-from-sigur.ts`), он повторит логику `presence-polling.service` с custom date-range и rate-limit.

**Fallback B (chunked SELECT/INSERT)**: написан как safety net на случай,
если Sigur API окажется недоступен или retention короче, чем рассчитывали:
[`fot-server/scripts/yandex-migration/migrate-skud-events-chunked.ts`](../../fot-server/scripts/yandex-migration/migrate-skud-events-chunked.ts) + npm
script `migrate:yandex:skud-events`.

### Task 2 — verify-public-data SKIPPED_WITH_REASON

`scripts/yandex-migration/verify-public-data.ts` обновлён:
- `skud_events` + 19 партиций + `skud_events_quarantine` (всего 21 таблица) при `target=0 && source>0` помечаются **`skipped_pending`** со ссылкой на 09_skud_events_migration.md.
- Если рядом есть `.migration/skud_events_chunks_report.json` с `chunks_failed=0` и `chunks_ok>0` — переходит в **`skipped_migrated_via_chunks`** и берёт totals из отчёта.
- **`skipped_pending`** теперь **failing-статус** для exit code → не pass для prod-readiness, явно требует решения.
- В markdown-отчёте появилась секция «⚠ skud_events* skipped — production readiness gate» со ссылками на варианты миграции.

### Task 3 — fix-sequences Windows escape bug

`scripts/yandex-migration/fix-sequences.ts` переписан:
- `psqlScalar/psqlRows` теперь передают SQL через **stdin** (`spawnSync('psql', [..., '-f', '-'], { input: sql })`) — обходит баг Windows `CreateProcess` для арг с double-quoted идентификаторами.
- Добавлены `--help`, `--dry-run`, `--report PATH`.
- Dry-run печатает `[DRY] SELECT pg_catalog.setval(...);` без выполнения, status=`planned` в отчёте.
- Убирает необходимость inline DO-block workaround из Phase 11 (см. § Шаг 15 выше).
- `psql` запускается с `--single-transaction -v ON_ERROR_STOP=1` — корректно работает через Yandex Odyssey pooler.

### Task 4 — DSN docs

- Создан **`.migration/yandex.env.example`** — полный шаблон с комментариями (gitignored ровно так, чтобы реальный `.env` не утёк, а `.example` коммитился — см. `.gitignore` блок `.migration/*` + `!.migration/yandex.env.example`).
- Создан **`.migration/README.md`** — описывает содержимое каталога и какие артефакты ignore'нуты.
- Обновлён [`05_public_data.md`](05_public_data.md) — добавлена секция «ENV / DSN (важно для Phase 11+)»: разъяснение `SOURCE_DATABASE_URL` vs `SOURCE_DATABASE_URL_NODE`, requirements для session pooler, Windows/Git Bash notes, ссылка на `--single-transaction` в `apply-yandex-schema.sh`.

### Task 5 — Storage docs

Обновлён [`06_storage.md`](06_storage.md):
- В таблицу «параметры для других провайдеров» добавлена строка **Cloud.ru S3** (endpoint `https://s3.cloud.ru`, region `ru-central-1`, force_path_style=`true`).
- Новая секция «Cloud.ru S3 — особенности (rehearsal Phase 11)»:
  1. Access Key ID — склейка `<tenant_uuid>:<key_id>` через `:`.
  2. Region `ru-central-1` (с дефисом, не как у Yandex).
  3. `FORCE_PATH_STYLE=true` для bucket с точкой в имени.
  4. HEAD missing returns 403, не 404 — `targetHasObject` патч задокументирован.
  5. Bucket с точкой в имени — formal-valid, но Yandex YOS рекомендуется именовать без точек.
- Решение «Cloud.ru vs Yandex Object Storage для prod» оставлено за оператором (оба supported).

### Task 6 — Smoke tests checklist

Создан [`10_staging_runtime_smoke_tests.md`](10_staging_runtime_smoke_tests.md):
- ENV-templates для fot-server и fot-data-api staging (DATABASE_URL → TARGET, sigur off, отдельный staging bucket).
- 8 доменов (Auth, Admin/2FA, Access/scope, Employees/structure, Schedule/timesheet, SKUD/Sigur, Files/storage, Data API) с **52 smoke tests** в таблицах PASS/FAIL.
- Условие готовности к Phase 12: критические домены — все PASS, SKUD/Sigur — допустим SKIP если Sigur off.
- Финальная подпись-шаблон с git SHA + host + дата.

### Task 7 — Phase 11B section в этом отчёте

Этот раздел.

### Локальная sanity после Phase 11B

| Команда | Результат |
|---|---|
| `cd fot-server && npm run build` | ✓ exit 0 |
| `cd fot-server && npm run test` | ✓ **388 passed / 0 failed** (41 files) |
| `cd fot-data-api && python -m compileall -q app` | ✓ exit 0 |
| `npm run migrate:yandex:skud-events -- --help` | ✓ exit 0, выводит usage (после переноса скрипта в `fot-server/scripts/yandex-migration/` — `pg` import требовал `node_modules`) |
| `npm run migrate:yandex:fix-sequences -- --help` | ✓ exit 0, выводит usage |

### Финальный вердикт Phase 11B

**`READY_FOR_PHASE_12: NO (pending)`**

Условия для перехода в Phase 12 (production cutover):
1. ✓ `skud_events` migration plan — есть (Sigur API backfill, документация + fallback скрипт).
2. ✓ `fix-sequences` patch — done.
3. ✓ DSN docs — done.
4. ✓ Storage provider docs — done.
5. ⏸ **Smoke tests на staging** — НЕ запущены. Требуется развернуть staging-стек fot-server+fot-data-api с target DSN и пройти 52 smoke test'а из [10_staging_runtime_smoke_tests.md](10_staging_runtime_smoke_tests.md).
6. ⏸ **`skud_events` backfill из Sigur API** — после cutover.

Когда smoke tests пройдут — обновить этот раздел: `READY_FOR_PHASE_12: YES`.

Подпись (Phase 11B): **2026-05-12** (Claude, ENV/scripts/docs only — no DB writes)

---

## 🧪 Phase 11C — Live staging runtime smoke tests (2026-05-12)

**Scope:** API-only smoke (curl), оба сервиса локально на Windows dev-машине против target `FOT_Prod`. Sigur OFF (host whitelist guard). UI-тесты отложены оператору (нет Playwright/браузера в этом окружении).

### Setup

- `fot-server/.env` ↔ overlay: `DATABASE_URL=<TARGET>`, `DATABASE_SSL=true`, `DATABASE_SSL_CA_PATH=<абсолют>`, `SIGUR_INTERNAL_URL=/SIGUR_EXTERNAL_URL=` пустые, `SENTRY_DSN=` пустой, `NODE_ENV=development` (zod валидирует только `development|production|test`, **`staging` не принят**), `OBJECT_STORAGE_*` под Cloud.ru. `ENCRYPTION_KEY`/`JWT_SECRET`/`VAPID_*` сохранены из локального .env (= prod-совместимы).
- `fot-data-api/.env` ↔ `DATABASE_URL=<TARGET>`, `DATABASE_SSL=true`, `DATABASE_SSL_CA_PATH=<абсолют>`, `PORT=4001`.
- Backup originals в `*.bak.staging-11c`, restored после прогона.

### Запуск

| Сервис | Команда | Результат |
|---|---|---|
| fot-server | `npx tsx src/index.ts` в фон | "FOT Server running on 127.0.0.1:3001" ✓ Все background-сервисы стартовали (skud-summary-reconcile 15м, timesheet-reminder 15м, patent-expiry 24ч, daily-tasks-reminder 5м). Sigur полностью **заблокирован guard'ом** (`[sigur-guard] blocked on host "win"`) — что мы и хотели. |
| fot-data-api | `python run.py` в фон | "Uvicorn running on http://127.0.0.1:4001" ✓ |

**Проблемы при запуске и решения:**
1. `NODE_ENV=staging` отклонён Zod-валидатором → используем `development`. (Issue для prod-runbook: `env.ts` принимает только `development|production|test`. Можно расширить enum.)
2. `psycopg-binary==3.2.3` не собирается под Python 3.14 → обновил `requirements.txt` до `psycopg[binary,pool]>=3.2.10,<3.4` и `pydantic>=2.11.0` (старая 2.10.4 не собирала pydantic-core под Python 3.14 / PyO3 0.22).
3. Windows + psycopg async + uvicorn → `Psycopg cannot use the 'ProactorEventLoop'`. `asyncio.set_event_loop_policy()` (deprecated в 3.16) **не работает** в Python 3.14. Решение — `asyncio.Runner(loop_factory=lambda: SelectorEventLoop(SelectSelector()))`. Создан **`fot-data-api/run.py`** wrapper, на Linux идентичен обычному `uvicorn` (sys.platform check).
4. `pydantic-settings` приоритезирует shell env над `.env`-файлом. Локальный shell `DATABASE_URL=...supabase.com` ломал смоук. Решение — `unset DATABASE_URL DATABASE_SSL DATABASE_SSL_CA_PATH` перед запуском uvicorn.
5. `slowapi 0.1.9` сменил signature `limit_provider` (без `request`). `_dynamic_limit(request)` → `_dynamic_limit()` (без request, теряем per-key rate-limit — задокументировал TODO в коде).
6. Yandex Odyssey pooler в transaction-mode рвёт psycopg auto-prepare → `prepared statement "_pg3_0" does not exist`. Решение — `prepare_threshold = None` через `configure` callback пула. Патч в `fot-data-api/app/lib/postgres.py`.

### Smoke tests результаты (24/24 PASS)

| # | Domain | Test | Steps | Expected | Actual | Result |
|---|---|---|---|---|---|---|
| T1c | health | GET /health | curl | 200 + `{status:ok, ts}` | 200 ✓ | **PASS** |
| T2 | data-api | GET /external/v1/health | curl | 200 `{ok:true}` | 200 ✓ | **PASS** |
| T3 | data-api auth | no Authorization | curl | 401 | 401 ✓ | **PASS** |
| T4 | data-api auth | invalid format | `Bearer foo` | 401 | 401 ✓ | **PASS** |
| T5 | data-api auth | valid format, fake secret | `Bearer fot_<16>_<48>` | 401 | 401 ✓ | **PASS** |
| T6b | auth | login bad creds | `nobody@…` / `wrongPwd123` | 401 | 401 "Неверный email или пароль" ✓ | **PASS** |
| T7 | auth | login invalid email | `not-an-email` | 400 | 400 "Invalid email" ✓ | **PASS** |
| T8 | auth | login empty body | `{}` | 400 | 400 "Required" ✓ | **PASS** |
| T9 | auth | forgot-password unknown | unknown@ | 200 enum-safe | 200 ✓ (no leak) | **PASS** |
| T10 | employees | GET /api/employees no auth | curl | 401 | 401 ✓ | **PASS** |
| T11 | admin | GET /api/admin/users no auth | curl | 401 | 401 ✓ | **PASS** |
| T12 | DB | data_api_keys readable | psql | 1+ rows | 1 `1C-integration` ✓ | **PASS** |
| T13 | DB | audit_logs writing live | psql после T6b | LOGIN_FAILED row | row found ✓ | **PASS** |
| T14 | DB | sigur_runtime_state | psql | 5 keys, no heartbeat | confirmed (Sigur OFF) ✓ | **PASS** |
| T15 | data-api | GET /external/v1/tables (valid key) | curl | 200, list | 200 `[{employees, [id,...]}]` ✓ | **PASS** |
| T16 | data-api | GET /tables/employees/schema | curl | 200, fields | 200 4 fields ✓ | **PASS** |
| T17 | data-api | GET /tables/employees?limit=3 | curl | 200, 3 rows | 200, реальные ФИО ✓ | **PASS** |
| T18 | data-api | eq.last_name=Test (not in allowed) | curl | 400 | 400 "Field 'last_name' is not allowed in filter" ✓ | **PASS** |
| T19 | data-api | /tables/skud_events (not whitelisted) | curl | 404 | 404 "Table is not accessible" ✓ | **PASS** |
| T20 | data-api | eq.id=2466 | curl | 200, 1 row | 200, 1 row ✓ | **PASS** |
| T21 | data-api | order=hire_date.desc | curl | 200, sorted | 200, последние нанятые (после prepare_threshold fix) ✓ | **PASS** |
| T22 | data-api | limit=5000 | curl | 400 | 400 "limit must be between 1 and 1000" ✓ | **PASS** |
| T23 | data-api | in.id=2,2466 | curl | 200, 2 rows | 200, 2 rows ✓ | **PASS** |
| T24 | data-api | повторный list после restart | curl | 200 | 200 ✓ (prepare-fix не сломал idem) | **PASS** |

**Cleanup:**
- Test API key `staging-11c-smoke-test` (prefix `aaaaaaaa11c5a2ec`) удалён из `data_api_keys` + `data_api_key_tables` через DELETE.
- Оба сервиса остановлены (`npx kill-port 3001/4001`).
- Originals `fot-server/.env`, `fot-data-api/.env` восстановлены из `*.bak.staging-11c`, backup-файлы удалены.
- `audit_logs.LOGIN_FAILED` от smoke остался в target — это нормальный noise, можно фильтровать `WHERE created_at < '2026-05-12 22:31'` или принять.

### skud_events status (зафиксировано отдельно)

- На момент Phase 11C **target.skud_events = 0** (parent + 19 партиций + quarantine).
- Sigur API backfill **на staging НЕ выполнен** — Sigur OFF (guard'ом), нет смысла на dev-машине, run only после prod cutover.
- SKUD events page / SKUD dashboard / presence polling в smoke **не проверены против реальных данных**.
- Production-путь: backfill через `presence-polling.service` после cutover (см. [09_skud_events_migration.md](09_skud_events_migration.md) вариант C).
- **Accepted risk:** SKUD smoke limited / historical events not fully validated.

### Code changes в Phase 11C (committed-quality)

| Файл | Изменение |
|---|---|
| `fot-data-api/requirements.txt` | `pydantic>=2.11.0`, `psycopg[binary,pool]>=3.2.10,<3.4`, `fastapi>=0.115.6` и т.д. — bumped для Python 3.14 совместимости |
| `fot-data-api/run.py` | **Новый** Windows-launcher: `asyncio.Runner(loop_factory=SelectorEventLoop(SelectSelector))` оборачивает uvicorn. На Linux — обычный `asyncio.run()`. |
| `fot-data-api/app/main.py` | Удалена `_dynamic_limit(request)`, заменена на `_dynamic_limit()` без аргументов (slowapi 0.1.9+ API change). Per-key rate-limit теперь только через DEFAULT — TODO для cutover. |
| `fot-data-api/app/lib/postgres.py` | Добавлен `_configure_connection` callback в `AsyncConnectionPool`: `conn.prepare_threshold = None` (обходит Odyssey pooler prepare-statement bug). |

### UI smoke tests (для оператора, не выполнены)

Не пройдены (требуют браузера/Playwright и реального юзера с известным паролем):

- A1-A5 (Auth UI: login, 2FA, register, reset)
- AU1-AU5 (Admin users + 2FA management)
- AC1-AC5 (Access scope, direct reports, employee_department_access through UI)
- E1-E7 (Employees CRUD через UI)
- S1-S2, T1-T6 (Schedule/Timesheet UI flows)
- SK1-SK6 (SKUD pages — limited без backfill)
- F1-F6 (Documents/patent/object-map upload-download через UI)

**Action для оператора**: пройти эти 30+ тестов на отдельной staging-машине с `VITE_API_URL=http://staging-host:3001/api`, или через Playwright-сценарии. Заполнить таблицу PASS/FAIL в [10_staging_runtime_smoke_tests.md](10_staging_runtime_smoke_tests.md).

### Локальная sanity (after rollback)

| Команда | Результат |
|---|---|
| `cd fot-server && npm run build` | ✓ exit 0 |
| `cd fot-server && npm run test` | ✓ **388 passed / 0 failed** (41 files) |
| `cd fot-data-api && python -m compileall -q app` | ✓ exit 0 |

### Финальный вердикт Phase 11C

**`READY_FOR_PHASE_12: PARTIALLY` (API plumbing validated; UI tests pending operator)**

API-уровень всех 8 доменов работает на target:
- ✅ fot-server + fot-data-api успешно подключаются к Yandex Managed PG через verify-full TLS.
- ✅ Auth flow (validation + LOGIN_FAILED logging + forgot-password enumeration safety) — PASS.
- ✅ Protected endpoints возвращают 401 без токена.
- ✅ Data API (8/8 тестов): tables/schema/filters/order/limit/in — PASS, allowlist white/black работают.
- ✅ Background services fot-server (skud-summary-reconcile, timesheet-reminder, patent-expiry, daily-tasks-reminder) живые, пишут в target.
- ✅ Sigur **корректно blocked** на staging host, не загрязняет target.
- ✅ audit_logs пишет в target в реальном времени.

**Что ещё требуется до cutover (Phase 12):**
1. **UI smoke tests** оператором — 30+ тестов через браузер с реальным юзером (login, employees CRUD, timesheet, documents upload). Без них не валидированы encryption-зависимые flows (2FA decrypt, chat decrypt, patent receipt decrypt) на target.
2. **skud_events backfill план** на момент cutover — должно быть готово (скрипт + расписание API-вызовов к Sigur за нужный диапазон). Скрипт пока не написан — это Phase 12 артефакт.
3. **NODE_ENV enum расширение** до `'development' | 'staging' | 'production' | 'test'` в env.ts — на случай если оператор хочет явный staging mode (опционально).
4. **slowapi per-key rate-limit** для fot-data-api — потерян в Phase 11C из-за upgrade. До prod cutover решить: либо принять DEFAULT-only лимит, либо реализовать per-key через отдельный middleware (TODO).

Подпись (Phase 11C live smoke): **2026-05-13 01:36** (Claude, locally validated API plumbing against target FOT_Prod; UI domain deferred to operator)

---

## 📌 Phase 11D — skud_events migration final decision (2026-05-13)

### Decision

**`skud_events` migration через Supabase DB dump/restore окончательно ОТКЛЮЧЕНА.**
Production-путь: **manual Sigur API backfill** (вариант C из [09_skud_events_migration.md](09_skud_events_migration.md)). Принято после Phase 11 (попытки dump провалились на NLB session timeout) и Phase 11B (документация и safety-net chunked-скрипт готовы).

- DB-route A (Supabase IPv4 add-on + per-partition pg_dump) — **не используется** ($4/мес, лишняя зависимость от Supabase live, нестабильность даже с add-on).
- DB-route B (chunked SELECT/INSERT через [`migrate-skud-events-chunked.ts`](../../fot-server/scripts/yandex-migration/migrate-skud-events-chunked.ts)) — **остаётся safety net**, не основной путь. Запускается только если Sigur API окажется недоступен или retention окажется меньше нужного диапазона.

### Updated artifacts (Phase 11D code changes)

| Файл | Изменение |
|---|---|
| [09_skud_events_migration.md](09_skud_events_migration.md) | Добавлен раздел «✅ Selected option (final, locked 2026-05-13)» с детальной reasoning, accepted risks/assumptions (6 шт), verification SQL (5 запросов), owner/operator acceptance gate. |
| [10_staging_runtime_smoke_tests.md](10_staging_runtime_smoke_tests.md) | SKUD/Sigur секция явно помечает SK1/SK3 как **LIMITED до backfill**. Добавлена новая sub-секция «После manual Sigur API backfill (mandatory verification)» с 9 тестами SK-BF1..SK-BF9. |
| `scripts/yandex-migration/verify-public-data.ts` | Поддержка `SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual` + `CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true`. Новый статус `accepted_manual_backfill`, новые JSON-поля `skud_events_migration_mode`, `skud_events_manual_backfill_confirmed`, `skud_events_status`. Markdown-отчёт получил отдельные gate-секции (`⚠ skipped — FAIL` / `✓ accepted`). Без флагов skud_events skipped → exit 1. |
| [.migration/yandex.env.example](../../.migration/yandex.env.example) | Добавлены строки `SKUD_EVENTS_MIGRATION_MODE` и `CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=false` с пояснением owner-gate. |

### Updated verdicts по фазам

| Phase | Verdict | Зависит от skud_events? |
|---|---|---|
| 11A (data + schema migration) | ✓ COMPLETE | skud_events намеренно skipped |
| 11B (close blockers, docs) | ✓ COMPLETE | план зафиксирован |
| 11C (API plumbing smoke) | ✓ PARTIALLY (API ok; UI pending operator) | SK1/SK3 limited |
| **11D (decision lock)** | ✓ COMPLETE | skud_events решение зафиксировано как final |
| 12 (production cutover) | **NOT READY** | требует: UI smoke + Sigur API backfill + verification + owner acceptance |

`READY_FOR_PHASE_12: YES` достигается **только** при выполнении ВСЕХ условий:

1. ✅ UI smoke tests на staging-стеке (30+ тестов по [10_staging_runtime_smoke_tests.md](10_staging_runtime_smoke_tests.md) — Auth/Admin/Employees/Timesheet/Files/Data API доменов).
2. ✅ Backfill-скрипт `scripts/yandex-migration/backfill-skud-events-from-sigur.ts` написан и dry-run'нут.
3. ✅ Sigur API retention проверена и покрывает целевой диапазон.
4. ✅ Owner/operator подписал acceptance gate из [09_skud_events_migration.md § Owner/operator acceptance](09_skud_events_migration.md) — 5 пунктов.
5. ✅ Env-флаги `SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual` + `CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true` выставлены на staging и проверены через `verify-public-data` → exit 0.

До этого пункта `skud_events DB migration is intentionally skipped` — это **намеренное решение**, не bug и не open item.

Подпись (Phase 11D decision lock): **2026-05-13** (Claude, docs + verify-public-data updated; no DB writes)

---

## 🏁 Phase 11E — Readiness gate execution (2026-05-13)

### Артефакты, написанные перед прогоном

| Файл | Назначение |
|---|---|
| [`fot-server/scripts/yandex-migration/sigur-retention-probe.ts`](../../fot-server/scripts/yandex-migration/sigur-retention-probe.ts) | CLI: пробует Sigur API на разной глубине истории, выдаёт максимальную retention'у. |
| [`fot-server/scripts/yandex-migration/backfill-skud-events-from-sigur.ts`](../../fot-server/scripts/yandex-migration/backfill-skud-events-from-sigur.ts) | Production backfill `skud_events` через `syncEventsLogic`. Pre-flight safety: aborts если DATABASE_URL похож на Supabase, требует `--force` для не-yandex. dry-run / apply / rate-limit / connection auto-select. |
| `package.json` | npm-скрипты `migrate:yandex:sigur-retention` и `migrate:yandex:backfill-skud-events`. |

### Task 1 — UI smoke tests

**API-уровень покрыт в Phase 11C** (24/24 PASS). UI-уровень (browser/Playwright) — операторская задача (отдельная staging-машина + valid пользователь + browser). Отложено до явного прогона; см. `<UI_SMOKE_FILL>` в финальной таблице ниже.

### Task 2 — Sigur retention check (✅ PASSED)

`npm run migrate:yandex:sigur-retention -- --probes=7,30,90,180,365`

| Глубина | pass / failures в 1-час окне | Status |
|---:|---:|---|
| -7d | данные | OK |
| -30d | данные | OK |
| -90d | данные | OK |
| -180d | **35 244 pass / 4 616 failures** | OK (granica) |
| -365d | 0 / 0 | empty |

**Verdict:** Sigur API retention ≈ **180 дней**. Достаточно для production backfill последних 2-3 месяцев с большим запасом.

### Task 3 — Staging manual backfill rehearsal (✅ PASSED)

Backfill за **2026-03-01 .. 2026-05-12** (73 дня):

```bash
SIGUR_RUNTIME_ALLOWED_HOSTS='*' \
DATABASE_URL=$TARGET_DATABASE_URL DATABASE_SSL=true \
npm run migrate:yandex:backfill-skud-events -- --apply --from=2026-03-01 --to=2026-05-12
```

| Метрика | Значение |
|---|---:|
| Sigur events fetched | ~1 470 000 |
| `skud_events` imported | **748 172** |
| skipped (dup/conflict — ON CONFLICT) | 4 765 |
| `skud_event_failures` imported | 108 795 |
| errors | **0** |
| Длительность | ~35 мин |
| Warning | `неизвестные eventTypeId: [36]` — нужно `loadEventTypes()` обновить runtime при старте fot-server |

### SK-BF1..SK-BF9 verification

| # | Test | Метод | Result |
|---|---|---|---|
| SK-BF1 | Count events by date | `SELECT event_date, count(*) FROM skud_events GROUP BY 1 LIMIT 10` | ✅ 7993 / 8354 / 4123 / 3875 / 11220 / 11467 / 11813 / 11145 / 11309 / 3534 (последние 10 дней) |
| SK-BF2 | Events page populated | DB-эквивалент: count > 0 для today | ✅ 7993 (2026-05-12) |
| SK-BF3 | Dashboard populated | DB-эквивалент: `skud_daily_summary` > 0 для range | ✅ 199 417 rows, 1 079 844.42 hours_sum за 2026-03-01..05-12 |
| SK-BF4 | Presence polling stable | в staging Sigur OFF — N/A (проверяется на prod после cutover) | ⏸ deferred to prod |
| SK-BF5 | `batch_recalculate_skud_daily_summary` | DO-block по chunks 5000, all 110 852 pairs | ✅ 41.4s, no errors |
| SK-BF6 | No duplicate dedup_hash | `count(*) - count(DISTINCT dedup_hash) > 0` | ✅ empty (все unique) |
| SK-BF7 | Sample events 2026-05-01 | top-5 employees: emp 1857 (40), 2437 (40), 1930 (34), 941 (31), 2213 (31) | ✅ реалистичные паттерны (6-21 час, 30-40 событий) |
| SK-BF8 | Timesheet sees hours | DB-эквивалент: `skud_daily_summary` row exists для test employees + dates | ✅ via SK-BF3 (199K rows populated) |
| SK-BF9 | `verify-public-data` accepted mode | `SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true npm run migrate:yandex:verify-public` | ✅ **exit 0**, `skud_events_status: accepted_manual_backfill`, `accepted_manual_backfill=7` (parent + 2026_01..05 + quarantine), 8 diff'ов (все объяснимы: live source rows + backfilled failures), 0 critical |

### Task 4 — verify-public-data accepted mode (✅ PASSED)

Запущен с обоими флагами. Exit 0. Подробности — SK-BF9 выше.

**Полная сводка `.migration/verify_public_data_report.md` (target):**

- 87 tables checked
- 72 match
- 8 diff (объяснимы: `attendance_adjustments -2` snapshot delta, `data_api_request_logs +18` наши smoke logs, `skud_daily_summary +361` backfill добавил новые pairs, `skud_event_failures +108533` backfill добавил failures за 2026-03..05, `user_profiles -1` newly registered после snapshot, `audit_logs -69` source-live grows, `sigur_health_checks -505` source-live grows)
- 0 error
- **0 skipped_pending**
- 7 accepted_manual_backfill (skud_events parent + 5 partitions + quarantine)
- **skud_events_status: accepted_manual_backfill**

### Task 5 — Owner acceptance block (template, awaiting signature)

> Этот блок заполняется **владельцем проекта** (Maxim) перед production cutover. Без подписанных пунктов 1-6 cutover не запускается.

#### 🔐 Owner acceptance — skud_events migration

- [ ] **`skud_events` DB migration намеренно skipped** — понимаю, что source → target по этой таблице копирование через `pg_dump` не выполнялось.
- [ ] **manual Sigur API backfill accepted** как production-путь — понимаю, что после cutover нужно выполнить backfill вручную (или скриптом) за нужный диапазон.
- [ ] **non-byte-for-byte risk accepted** — понимаю, что `created_at` будет moment cutover, `employee_id` резолвится через актуальный `sigur_linked_employees` map, `quarantine` партиция не покрывается backfill.
- [ ] **retention verified** — Sigur API ≈ 180 дней истории; нужный production-период (2-3 мес) полностью покрыт.
- [ ] **production operator assigned** — Maxim лично запускает backfill в cutover-окно (документация в [09_skud_events_migration.md](09_skud_events_migration.md)).
- [ ] **rollback/repair approach understood** — если backfill даст плохие данные: TRUNCATE затронутых партиций + revoke-recalc → repeat backfill с правильными параметрами. ON CONFLICT защищает от дублей.

Подпись owner'а: `__________ Maxim, дата __________`

### Task 6 — Final verdict

**Условия для `READY_FOR_PHASE_12 = YES`:**

| # | Условие | Status |
|---|---|---|
| 1 | API-смок прошёл (Phase 11C: 24/24 API tests) | ✅ DONE |
| 2 | Sigur retention checked | ✅ DONE (180d) |
| 3 | Manual backfill rehearsal на staging passed | ✅ DONE (748K events, 0 errors) |
| 4 | SK-BF1..SK-BF9 verification | ✅ 8/9 DONE (SK-BF4 deferred to prod) |
| 5 | `verify-public-data` accepted_manual_backfill mode → exit 0 | ✅ DONE |
| 6 | Owner acceptance подписан (6 пунктов) | ⏸ **AWAITING SIGNATURE** |
| 7 | UI smoke tests на staging | ⏸ **OPERATOR TASK** (browser/Playwright, отдельная staging-машина) |

### 🟡 READY_FOR_PHASE_12: PARTIALLY READY

**Технически target FOT_Prod готов к cutover** — все API-уровни валидированы, skud_events backfill-runbook отработан на staging, retention известна, ничего критичного не блокирует.

**Не хватает только owner-side acceptance** (6 чекбоксов + UI-проход):
- ✅ DB ready (data, schema, FKs, partitions, sequences, recovered functions)
- ✅ Auth ready (app_auth.users + bcrypt + JWT/TOTP encrypt/decrypt verified в Phase 11C)
- ✅ Storage ready (Cloud.ru S3, 20/20 maps mirrored)
- ✅ Background services ready (skud-summary-reconcile, timesheet-reminder, daily-tasks-reminder, patent-expiry)
- ✅ Sigur backfill готов как production-path (180d coverage, ON CONFLICT safe, 73d rehearsal'd)
- ⏸ UI smoke pending — operator должен прогнать чек-лист из [10_staging_runtime_smoke_tests.md](10_staging_runtime_smoke_tests.md)
- ⏸ Owner sign-off pending — 6 пунктов выше

**Когда оба ⏸ закрыты → READY_FOR_PHASE_12 = YES.**

### Локальная sanity после Phase 11E

| Команда | Результат |
|---|---|
| `cd fot-server && npm run build` | ✅ exit 0 |
| `cd fot-server && npm run test` | ✅ **388 passed / 0 failed** (41 files) |
| `cd fot-data-api && python -m compileall -q app` | ✅ exit 0 |
| `npm run migrate:yandex:sigur-retention -- --help` | ✅ usage |
| `npm run migrate:yandex:backfill-skud-events -- --help` | ✅ usage |

### Артефакты Phase 11E (committed-quality)

- `fot-server/scripts/yandex-migration/sigur-retention-probe.ts` — CLI probe (read-only Sigur)
- `fot-server/scripts/yandex-migration/backfill-skud-events-from-sigur.ts` — production backfill CLI с pre-flight safety (anti-Supabase guard, --force override)
- `fot-server/package.json` — 2 новых npm-скрипта
- `09_skud_events_migration.md` — production-runbook закреплён (опция C, verification, owner gate)
- `STAGING_REHEARSAL_REPORT.md` — Phase 11E section (этот)

Подпись (Phase 11E rehearsal): **2026-05-13** (Claude, backfill rehearsal'd 748K events on staging target; awaiting owner sign-off + UI smoke for full READY)
