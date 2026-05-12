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
