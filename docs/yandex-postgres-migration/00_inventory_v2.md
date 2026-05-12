# 00 — Supabase → Yandex Managed PostgreSQL: Inventory v2

Дата ревизии: 2026-05-11. Версия миграций: `docs/migrations/001-086`.

Цель документа — зафиксировать ВСЕ зависимости от Supabase, существующие в коде монорепо FOT на момент ревизии, и собрать список SQL-конструкций, требующих адаптации под Yandex Managed PostgreSQL.

---

## 1. Файлы и тип зависимости

### 1.1. `fot-server/src` — runtime Supabase usage

| Файл | Тип зависимости | Заметки |
|---|---|---|
| `src/config/database.ts` | SDK init: `createClient` × 2 (`supabase`, `supabaseAuth`) | service-role + anon-key для signIn |
| `src/controllers/auth.controller.ts` | `supabaseAuth.auth.signInWithPassword`, `supabase.auth.admin.{createUser,deleteUser,listUsers,updateUserById}` | плюс `from('user_profiles')`, `from('user_company_access')` |
| `src/controllers/admin-users.controller.ts` | `supabase.auth.admin.{listUsers,getUserById,deleteUser,updateUserById}` | 5 вызовов |
| `src/controllers/admin-2fa.controller.ts` | `supabase.auth.admin.getUserById` | 1 вызов |
| `src/controllers/auth-2fa-self.controller.ts` | `supabase.auth.admin.getUserById` | 1 вызов |
| `src/controllers/auth-2fa.controller.ts` | `from('user_profiles')` | без auth API |
| `src/controllers/timesheet-assigned-export.controller.ts` | `supabase.auth.admin.listUsers` × 2 | 2 точки |
| `src/controllers/roles.controller.ts` | `from(...)`, `rpc('replace_role_access_profile')` | |
| `src/controllers/correction-approval.controller.ts` | `from(...)` | attendance_adjustments, audit_logs и т.п. |
| `src/controllers/daily-tasks.controller.ts` | `from('daily_tasks')` | |
| `src/controllers/direct-reports.controller.ts` | `from('employee_direct_reports')` | новый домен |
| `src/controllers/documents.controller.ts` | `from(...)` | document_categories, document_links, documents, leave_requests |
| `src/controllers/employee-*.controller.ts` (lifecycle/enrich/import) | `from(...)` | employees, employee_history, employee_assignments |
| `src/controllers/employees.controller.ts` | `from(...)` | основной CRUD сотрудников + org_sites + work_schedules |
| `src/controllers/leave-requests.controller.ts` | `from(...)` | |
| `src/controllers/official-memos.controller.ts` | `from('official_memos')` | |
| `src/controllers/patent-receipts.controller.ts` | `from(...)` | patent_payment_receipts + связанные |
| `src/controllers/payments.controller.ts` | `from('payments')` | |
| `src/controllers/payslips.controller.ts` | `from('payslips')` | |
| `src/controllers/production-calendar.controller.ts` | `from('production_calendar')` | |
| `src/controllers/salary-raise.controller.ts` | `from(...)` | salary_raise_requests, attachments |
| `src/controllers/schedule.controller.ts` | `from(...)` | object_schedule_assignments, work_schedules |
| `src/controllers/sigur-*.controller.ts` | `from(...)` | sigur_*, employees |
| `src/controllers/skud-*.controller.ts` | `from(...)` | skud_events, skud_event_failures, skud_daily_summary, skud_objects |
| `src/controllers/structure.controller.ts` | `from(...)` | org_departments, positions, employee_assignments |
| `src/controllers/timesheet-*.controller.ts` | `from(...)` | timesheet_approvals, _events, _responsibles, attendance_adjustments |
| `src/controllers/audit.controller.ts` | `from(...)` | audit_logs, salary_history |
| `src/services/access-control.service.ts` | `from('access_pages')` | |
| `src/services/ai-receipt-recognition.service.ts` | `from(...)` | очередь распознавания |
| `src/services/attendance.service.ts` | `from(...)` | |
| `src/services/audit-context.helpers.ts` | `from(...)` | |
| `src/services/chat.service.ts` | `from(...)`, `rpc('find_direct_conversation')` | chat_conversations / _messages / _participants |
| `src/services/chat-policy.service.ts` | `from(...)` | chat_contact_grants/_requests |
| `src/services/critical-admin-access.service.ts` | `from('system_roles')` | |
| `src/services/daily-tasks-reminder.service.ts` | `from('daily_tasks_reminder_log')` | |
| `src/services/data-api-key.service.ts` | `from('data_api_keys')`, `from('data_api_key_tables')`, `from('data_api_request_logs')` | админ CRUD ключей |
| `src/services/data-api-schema.service.ts` | `rpc('data_api_list_public_schema')` | используется UI |
| `src/services/data-scope.service.ts` | `rpc('get_descendant_department_ids')` | scope админа |
| `src/services/employee-mapper.service.ts` | `from(...)` | кэш структуры |
| `src/services/manager-department-import.service.ts` | `from('manager_department_import_brigade_aliases'/'_employee_aliases')` | |
| `src/services/notification.service.ts` | `from('notifications')` | |
| `src/services/patent-expiry-reminder.service.ts` | `from('patent_expiry_reminder_log')` | |
| `src/services/payslip-generation.service.ts` | `from(...)` | |
| `src/services/presence-polling.service.ts` | `from('skud_events')`, `rpc('batch_recalculate_skud_daily_summary')` | incremental cursor по lastId |
| `src/services/push.service.ts` | `from('push_subscriptions')` | |
| `src/services/roles-cache.service.ts` | `from(...)` | |
| `src/services/settings.service.ts` | `from('system_settings')` | |
| `src/services/sigur-access-point-meta.service.ts` | `from(...)` | skud_objects, skud_object_access_points, skud_object_map_points |
| `src/services/sigur-monitor.service.ts` | `from('sigur_health_checks'/'sigur_incidents')` | |
| `src/services/sigur-runtime-state.service.ts` | `rpc('try_acquire_sigur_runtime_lease')`, `rpc('heartbeat_sigur_runtime_lease')`, `rpc('merge_sigur_runtime_state')`, `rpc('release_sigur_runtime_lease')`, `from('sigur_runtime_state')` | leasing |
| `src/services/sigur-sync-*.service.ts` (employees/events/structure/shared) | `from(...)`, `rpc('batch_recalculate_skud_daily_summary')` | |
| `src/services/skud-backfill.service.ts` | `rpc('bulk_update_employee_ids')`, `rpc('batch_recalculate_skud_daily_summary')` | |
| `src/services/skud-shared.service.ts` | `rpc('bulk_update_employee_ids')` | |
| `src/services/skud-import.service.ts` | `rpc('batch_recalculate_skud_daily_summary')` × 4, `rpc('find_skud_duplicate_ids')` | |
| `src/services/skud-summary-reconcile.service.ts` | `rpc('batch_recalculate_skud_daily_summary')` | |
| `src/services/skud-*.service.ts` (dashboard/discipline/presence/travel/travel-routes) | `from(...)` | |
| `src/services/supabase-storage.service.ts` | **`supabase.storage.from('skud-object-maps').{createSignedUploadUrl,createSignedUrl,exists,remove}`** | единственный Storage-сервис |
| `src/services/timesheet-*.service.ts` (approval-attachments, approval-history, transfers, …) | `from(...)` | |
| `src/__tests__/setup.ts` | заглушки `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` | env-фикстура |

Всего файлов в `src/`, импортирующих из `config/database.ts`: **96**; из них:
- `{ supabase, supabaseAuth }` — 1 (`auth.controller.ts`)
- `{ supabase }` — 95

### 1.2. `fot-server/scripts`

| Файл | Тип зависимости |
|---|---|
| `scripts/backfill-dedup-hash.ts` | `from('skud_events')` |
| `scripts/backfill-employee-ids.ts` | `from('employees')`, `from('skud_events')` |
| `scripts/backfill-failure-type-names.ts` | `from('skud_event_failures')` |
| `scripts/backfill-orphan-skud-summaries.ts` | `from('skud_events')`, `from('skud_daily_summary')`, `rpc('batch_recalculate_skud_daily_summary')` |
| `scripts/cleanup-misclassified-pass-deny.ts` | `from('skud_event_failures'/'skud_events')`, `rpc('batch_recalculate_skud_daily_summary')` |
| `scripts/create-test-code.ts` | `from('user_profiles'/'organizations'/'employee_link_codes')` |
| `scripts/migrate-patent-receipts-to-encrypted.ts` | `from('patent_payment_receipts')` |
| `scripts/archive/backfill-dedup-hash.ts` | `from(...)`, `rpc('find_skud_duplicate_ids')` |
| `scripts/archive/backfill-employee-ids.ts` | `from(...)`, `rpc('batch_recalculate_skud_daily_summary')` |
| `scripts/archive/freeze-transfer-history.ts` | `from('employee_assignments'/'employees')` |
| `scripts/archive/import-manager-department-access.ts` | `from('employees'/'org_departments'/'user_department_access'/'user_profiles')` |
| `scripts/archive/recalc-daily-summaries.ts` | `from('skud_events')`, `rpc('batch_recalculate_skud_daily_summary')` |
| `scripts/archive/restore-mass-fired.ts` | `from('employees'/'org_departments')` |

Все скрипты используют только `supabase` (service-role); ни один не вызывает `supabase.auth` или `supabase.storage`.

Уникальные таблицы из scripts, которых нет в src: `employee_link_codes`, `organizations`, `user_department_access`.

### 1.3. `fot-data-api` (Python / FastAPI)

| Файл | Тип зависимости |
|---|---|
| `app/lib/supabase.py` | `from supabase import Client, create_client` — singleton `get_supabase()` |
| `app/config.py` | env-поля `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| `app/services/auth.py` | `supabase.table('data_api_keys').select(...)`, `.update({'last_used_at': ...})` |
| `app/services/query.py` | `supabase.table('data_api_key_tables').select(...)`, динамический `supabase.table(<allowed>).select(...).eq()/.in()/.gt()/.ilike()/.order().range()` |
| `app/services/logging.py` | `supabase.table('data_api_request_logs').insert(...)` |
| `requirements.txt` | `supabase==2.10.0` |

Зависимостей `psycopg`/`asyncpg`/`sqlalchemy` нет — весь доступ к БД идёт через `supabase-py` PostgREST-builder. Никаких raw-SQL вызовов. Авторизация — Bearer-токен `fot_<16hex>_<48hex>`, валидация в `auth.py` через sha256-сравнение `key_hash`.

### 1.4. `fot-app` (фронт)

Реальных Supabase SDK-импортов **нет**. Подтверждено:
- `package.json` не содержит ни одного `@supabase/*`.
- В `src/**` нет `import { createClient } from '@supabase/supabase-js'`, `supabase.auth`, `supabase.from`.
- Найденные совпадения по слову `supabase`:
  - `src/hooks/useSkudOpsData.ts` — query-key строки `'skud-supabase'` для React Query (не SDK).
  - `src/styles/SigurSettingsPage.css` — CSS-класс `.sigur-btn-supabase` (стилевое наследие, не использует SDK).
- В `.env` присутствуют `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`, но в `src/**` они нигде не читаются — мёртвый код в env (рекомендация: удалить из локального `.env`).
- Доступ к данным — только через `apiClient` (`src/api/client.ts`) на `VITE_API_URL`.

Вывод: фронт от Supabase отвязан полностью. Миграция фронта не требует кодовых правок; достаточно зачистить `VITE_SUPABASE_*` из локальных `.env` после миграции бэкенда.

---

## 2. Все таблицы, к которым обращается backend

Сводный список (`fot-server/src` + `fot-server/scripts` + `fot-data-api`), отсортирован по алфавиту:

1. `access_pages`
2. `attendance_adjustments`
3. `audit_logs`
4. `chat_contact_grants`
5. `chat_contact_requests`
6. `chat_conversations`
7. `chat_messages`
8. `chat_participants`
9. `daily_tasks`
10. `daily_tasks_reminder_log`
11. `data_api_key_tables`
12. `data_api_keys`
13. `data_api_request_logs`
14. `document_categories`
15. `document_links`
16. `documents`
17. `employee_assignments`
18. `employee_department_access`
19. `employee_direct_reports`
20. `employee_history`
21. `employee_link_codes` *(только scripts)*
22. `employee_schedule_assignments`
23. `employees`
24. `leave_requests`
25. `manager_department_import_brigade_aliases`
26. `manager_department_import_employee_aliases`
27. `notifications`
28. `object_schedule_assignments`
29. `official_memos`
30. `org_departments`
31. `org_sites`
32. `organizations` *(только scripts; в текущем src НЕ используется)*
33. `patent_expiry_reminder_log`
34. `patent_payment_receipts`
35. `payments`
36. `payslips`
37. `positions`
38. `production_calendar`
39. `push_subscriptions`
40. `role_page_access`
41. `salary_history`
42. `salary_raise_attachments`
43. `salary_raise_requests`
44. `sigur_health_checks`
45. `sigur_incidents`
46. `sigur_runtime_state`
47. `skud_access_point_settings`
48. `skud_daily_summary`
49. `skud_event_failures`
50. `skud_events`
51. `skud_object_access_points`
52. `skud_object_map_points`
53. `skud_object_routes`
54. `skud_objects`
55. `skud_sync_department_filter`
56. `skud_travel_segments`
57. `system_roles`
58. `system_settings`
59. `timesheet_approval_attachments`
60. `timesheet_approval_events`
61. `timesheet_approvals`
62. `timesheet_reminder_log`
63. `timesheet_responsibles`
64. `user_company_access`
65. `user_department_access` *(только scripts/archive)*
66. `user_profiles`
67. `work_schedules`

Партиционированные таблицы (требуют переноса всех партиций):
- `skud_events` — партиции `skud_events_2026_01 … skud_events_2028_h2` (миграция 034 ограничивает доступ к ним).
- `skud_event_failures` — партиции по `event_date` (миграция 085).

---

## 3. Все RPC, которые вызывает backend

| RPC | Где вызывается | Создаётся в миграциях 001-086? |
|---|---|---|
| `batch_recalculate_skud_daily_summary(p_pairs jsonb)` | `presence-polling.service.ts`, `skud-backfill.service.ts`, `skud-import.service.ts` ×4, `skud-summary-reconcile.service.ts`, `sigur-sync-events.service.ts`, plus 4 скрипта | **НЕТ** — отсутствует |
| `bulk_update_employee_ids(...)` | `skud-backfill.service.ts`, `skud-shared.service.ts` | **НЕТ** — отсутствует |
| `data_api_list_public_schema()` | `data-api-schema.service.ts` | да, 060_data_api.sql (SECURITY DEFINER) |
| `find_direct_conversation(user1, user2)` | `chat.service.ts` | **НЕТ** — отсутствует |
| `find_skud_duplicate_ids()` | `skud-import.service.ts`, `scripts/archive/backfill-dedup-hash.ts` | **НЕТ** — отсутствует |
| `get_descendant_department_ids(p_root_ids uuid[])` | `data-scope.service.ts` | да, 083_user_company_access.sql (SECURITY DEFINER, RECURSIVE CTE) |
| `heartbeat_sigur_runtime_lease(...)` | `sigur-runtime-state.service.ts` | да, 024_sigur_runtime_state.sql |
| `merge_sigur_runtime_state(...)` | `sigur-runtime-state.service.ts` | да, 024_sigur_runtime_state.sql |
| `release_sigur_runtime_lease(...)` | `sigur-runtime-state.service.ts` | да, 024_sigur_runtime_state.sql |
| `replace_role_access_profile(p_role_code, p_permissions, p_page_access)` | `roles.controller.ts` | да, 025_access_catalog.sql + 036_functions_search_path.sql |
| `try_acquire_sigur_runtime_lease(...)` | `sigur-runtime-state.service.ts` | да, 024_sigur_runtime_state.sql |

⚠️ Четыре RPC реально используются кодом, но **никогда не оказались под версионным контролем** — их нужно реверс-инжинирить из текущей Supabase Cloud перед миграцией (см. §7).

---

## 4. Auth-зависимости

Все Auth-операции — на бэке (`fot-server/src`), фронт не использует `supabase.auth`.

| Метод | Использования (файл:строка) |
|---|---|
| `supabaseAuth.auth.signInWithPassword({ email, password })` | `auth.controller.ts:180` — единственный логин-поток |
| `supabase.auth.admin.createUser({ ... })` | `auth.controller.ts:124` |
| `supabase.auth.admin.deleteUser(id)` | `auth.controller.ts:142, 157`; `admin-users.controller.ts:1042, 1091` |
| `supabase.auth.admin.updateUserById(id, { ... })` | `auth.controller.ts:346`; `admin-users.controller.ts:1118` |
| `supabase.auth.admin.getUserById(id)` | `admin-users.controller.ts:499`; `admin-2fa.controller.ts:23`; `auth-2fa-self.controller.ts:35` |
| `supabase.auth.admin.listUsers({ page?, perPage? })` | `admin-users.controller.ts:336`; `auth.controller.ts:263`; `timesheet-assigned-export.controller.ts:269, 487` |

Под Yandex Managed PostgreSQL Supabase Auth (`auth.users`, JWT-эмиссия, MFA-крючки) недоступен. Требуется собственная реализация:
- таблица `auth_users` в `public` (или отдельной схеме) с полями `id uuid pk`, `email`, `encrypted_password`, `created_at`, `last_sign_in_at`, `banned_until`, `user_metadata jsonb`;
- эмиссия JWT собственным кодом (`jsonwebtoken`/`jose`) — уже частично используется; нужен только новый `signInWithPassword`-аналог;
- middleware верификации JWT — уже есть, останется.

Замечание: упоминаний `auth.users` (Supabase-схема) в коде НЕ найдено — все обращения идут только через SDK API. Это упрощает замену клиента.

---

## 5. Storage-зависимости

Единственный файл-обёртка: `fot-server/src/services/supabase-storage.service.ts`.

- Бакет: `skud-object-maps` (создаётся в `docs/migrations/026_skud_object_maps.sql` через `INSERT INTO storage.buckets`).
- Операции:
  - `supabase.storage.from(bucket).createSignedUploadUrl(path)` — line 33
  - `supabase.storage.from(bucket).createSignedUrl(path, ttlSec)` — line 46 (TTL = 3600)
  - `supabase.storage.from(bucket).exists(path)` (через probe) — line 59
  - `supabase.storage.from(bucket).remove([paths])` — line 76
- Потребитель: `skud-travel.service.ts` (карты объектов СКУД).

Под Yandex план: перенос бакета в **Yandex Object Storage** (S3-совместимый). В коде уже используется `@aws-sdk/client-s3` для Cloudflare R2 — нужно либо унифицировать всё на S3 SDK, либо отдельный helper для YOS. `INSERT INTO storage.buckets` в миграции 026 удалить — на Yandex `storage`-схемы PostgREST нет; бакет создаётся через YC Console / Terraform.

---

## 6. SQL-несовместимости с Yandex Managed PostgreSQL

### 6.1. Расширения

| Расширение | Где | Yandex Managed PG |
|---|---|---|
| `btree_gist` | 020, 039 (`ALTER ... SET SCHEMA extensions`), 048 (`CREATE EXTENSION ... WITH SCHEMA extensions`) | Доступно через `CREATE EXTENSION` (white-list YC). Но **схема `extensions`** — Supabase-специфичная; перенесите в `public` или создайте схему вручную. |
| `pg_trgm` | 080 (`employees` GIN-индекс на full_name) | Доступно. |

Других `CREATE EXTENSION` / `ALTER EXTENSION` в 001-086 нет (нет `pg_net`, `pgvector`, `pgcrypto`, `uuid-ossp` явно).

### 6.2. RLS / FORCE RLS

| Файл | Действие |
|---|---|
| 034_lock_skud_events_from_postgrest.sql | `ENABLE` + `FORCE ROW LEVEL SECURITY` на `public.skud_events` и всех его партициях; `REVOKE ALL ... FROM anon, authenticated` |
| 038_force_rls_deny_anon.sql | Массовое `ENABLE` + `FORCE RLS` на 50+ таблицах `public.*`; `REVOKE ALL ... FROM anon, authenticated` |
| 083_user_company_access.sql | `ENABLE RLS` на `user_company_access` |
| 085_skud_event_failures.sql | `ENABLE` + `FORCE RLS` на `skud_event_failures` + партиции; `REVOKE` от anon/authenticated |

Семантика, которую несёт RLS-обвязка под Supabase — «закрыть PostgREST»; нашему бэкенду она не нужна, т.к. он ходит через service-role (RLS отключён для коннекта). Под Yandex:
- Бэкенд продолжает использовать одного выделенного пользователя (`fot_app` или аналог) с полными правами на `public`.
- Все `REVOKE ... FROM anon, authenticated` теряют смысл (этих ролей нет) — миграции переписать без них.
- Все `ENABLE/FORCE RLS` можно **снять**, либо переписать политики под нового пользователя (но если PostgREST-аналог не подключаем, проще снять).

### 6.3. Supabase-специфичные роли

| Роль | Где используется |
|---|---|
| `anon` | 034, 038, 085 (REVOKE) |
| `authenticated` | 034, 038, 085 (REVOKE) |
| `service_role` | 060 (`GRANT EXECUTE ON FUNCTION data_api_list_public_schema() TO service_role`) |

Под Yandex ни одна из ролей не существует. Все `GRANT/REVOKE` относительно них нужно либо удалить, либо переписать на нового владельца (`fot_app`).

### 6.4. `storage.*`

- 026_skud_object_maps.sql: `INSERT INTO storage.buckets (...)`.

Под Yandex схемы `storage` нет — удалить блок. Бакет создаётся вне PG (YOS).

### 6.5. `auth.*`

В миграциях 001-086 **прямых** обращений к схеме `auth` (например, `auth.users`, `auth.uid()`, `auth.jwt()`) нет. Auth-связи живут только в SDK-вызовах из бэкенда.

### 6.6. `NOTIFY pgrst`

`NOTIFY pgrst, 'reload schema'` встречается в:
- 051_timesheet_approval_attachments.sql
- 054_correction_approval.sql
- 058_correction_approval_worked_only.sql
- 059_correction_approval_drop_manual.sql
- 060_data_api.sql
- 061_patent_payment_receipts.sql
- 062_daily_tasks.sql
- 084_manager_obj_role.sql

PostgREST на Yandex не запускается — все `NOTIFY pgrst` удалить (безвредны, но шумят в логах).

### 6.7. `SECURITY DEFINER` функции

| Функция | Файл | Назначение | Особенность |
|---|---|---|---|
| `sync_user_profile_role_fields()` | 020 | trigger | синхронизирует `system_role_id` ↔ `position_type` |
| `sync_role_page_access_role_fields()` | 020 | trigger | |
| `ensure_no_overlapping_employee_assignments()` | 020 | trigger | использует `gist`-exclusion |
| `ensure_no_overlapping_employee_schedule_assignments()` | 020 | trigger | |
| `ensure_no_overlapping_category_schedules()` | 020 | trigger | |
| `ensure_no_overlapping_object_schedule_assignments()` | 030 | trigger | |
| `try_acquire_sigur_runtime_lease(...)` | 024 | RPC | leasing |
| `heartbeat_sigur_runtime_lease(...)` | 024 | RPC | |
| `merge_sigur_runtime_state(...)` | 024 | RPC | |
| `release_sigur_runtime_lease(...)` | 024 | RPC | |
| `replace_role_access_profile(text, jsonb, jsonb)` | 025 (+ 036 search_path) | RPC | |
| `data_api_list_public_schema()` | 060 | RPC | `SET search_path = pg_catalog, public`; читает `pg_attribute` |
| `user_company_access_validate_root()` | 083 | trigger | |
| `get_descendant_department_ids(uuid[])` | 083 | RPC | RECURSIVE CTE по `org_departments` |

Все совместимы с Yandex Managed PG как есть, если оставить владельцем — нового пользователя `fot_app`. Проверить только: владелец функции должен иметь SELECT на читаемых таблицах.

### 6.8. Партиционирование

`skud_events` и `skud_event_failures` — range-партиции по `event_date`. На Yandex Managed PG нативное партиционирование поддерживается. План миграции данных: создать партиции **до** `INSERT`, иначе строки уйдут в default-партицию (или упадут).

### 6.9. Прочее

- `gen_random_uuid()` — встречается во многих миграциях. Под Yandex без `pgcrypto` не работает; нужно либо `CREATE EXTENSION pgcrypto`, либо переключиться на `uuid_generate_v4()` (`uuid-ossp`). Оба расширения в YC доступны.
- Использование `INTERVAL`, `EXCLUSION CONSTRAINT WITH btree_gist` — стандартный PG, ок.

---

## 7. Функции, которые используются кодом, но не создаются в `docs/migrations/001-086`

Эти функции присутствуют в production Supabase, но НЕ зафиксированы в миграциях — перед миграцией обязательно выгрузить их `pg_get_functiondef(...)` из боевой БД и завести как новую миграцию (`087_…_recover_runtime_functions.sql`).

1. **`batch_recalculate_skud_daily_summary(p_pairs jsonb)`** — критичная. Используется в реальном времени (`presence-polling`) и при backfill. Принимает массив пар `(employee_id, event_date)`, пересчитывает агрегаты в `skud_daily_summary`.
2. **`bulk_update_employee_ids(...)`** — массовый ремап `skud_events.employee_id` при изменении маппинга.
3. **`find_skud_duplicate_ids()`** — поиск дубликатов в `skud_events` по `dedup_hash` / `event_date`.
4. **`find_direct_conversation(user1 uuid, user2 uuid)`** — поиск 1:1 беседы между двумя пользователями в `chat_conversations`.

Дополнительно проверить (на всякий — могут оказаться неявные функции из 020-х рефакторингов): `recalculate_skud_daily_summary`, любые `*_v2`-варианты RPC.

---

## 8. Updated migration order (фактический порядок в `docs/migrations/`)

Файлы 001-086 в алфавитном порядке имени:

1. 001_role_portal.sql
2. 002_work_schedules.sql
3. 003_remove_organizations.sql
4. 004_dynamic_roles.sql
5. 005_salary_raise_requests.sql
6. 006_system_settings.sql
7. 007_day_overrides.sql
8. 008_schedules_v2.sql
9. 009_work_categories.sql
10. 010_drop_legacy_schedule_tables.sql
11. 011_schedule_day_thresholds.sql
12. 012_employee_schedule_assignments.sql
13. 013_skud_travel_segments.sql
14. 014_chat_access_policy.sql
15. 015_sigur_monitoring.sql
16. 016_worker_split_access_control.sql
17. 017_skud_travel_access_control.sql
18. *(018 — отсутствует в репо)*
19. 019_rename_tender_page_to_employees.sql
20. 020_attendance_access_refactor_preflight.sql
21. 020_attendance_access_refactor_preflight_summary.sql
22. 020_backfill_event_at_nulls.sql
23. 020_employee_assignments_overlap_debug.sql
24. 020_resolve_adjacent_employee_assignment_overlap.sql
25. 020_attendance_access_refactor.sql
26. 021_timesheet_half_month_reminders.sql
27. 022_timesheet_approval_history.sql
28. 023_skud_travel_route_multiplier_to_one.sql
29. 024_sigur_runtime_state.sql
30. 025_access_catalog.sql
31. 026_skud_object_maps.sql ⚠ содержит `storage.buckets`
32. 027_salary_raise_v2_manager_flow.sql
33. 028_timesheet_workflow_access_backfill.sql
34. 029_employees_structure_manage_access.sql
35. 030_object_schedule_assignments.sql
36. 031_manager_department_access.sql
37. 032_employee_department_access.sql
38. 033_manager_department_import_aliases.sql
39. 034_lock_skud_events_from_postgrest.sql ⚠ RLS + REVOKE anon/authenticated
40. 035_employee_history_security_invoker.sql
41. 036_functions_search_path.sql
42. 037_fk_indexes_missing.sql
43. 038_force_rls_deny_anon.sql ⚠ массовый RLS + REVOKE
44. 039_btree_gist_to_extensions_schema.sql ⚠ схема `extensions`
45. 040_drop_duplicate_indexes.sql
46. 041_role_page_access_drop_system_role_id.sql
47. 042_worker_cabinet.sql
48. 043_hr_perf_indexes.sql
49. 044_simplify_roles.sql
50. 045_deactivate_legacy_skud_pages.sql
51. 046_remove_legacy_skud_monitor_travel.sql
52. 047_excluded_from_timesheet.sql
53. 048_timesheet_approvals_date_range.sql ⚠ `btree_gist WITH SCHEMA extensions`
54. 049_flatten_department_access.sql
55. 050_department_kind.sql
56. 051_timesheet_approval_attachments.sql ⚠ `NOTIFY pgrst`
57. 052_skud_object_access_points_per_object_unique.sql
58. 053_documents_category_extend.sql
59. 054_correction_approval.sql ⚠ `NOTIFY pgrst`
60. 055_excluded_from_timesheet_date.sql
61. 056_remove_business_trip.sql
62. 057_add_educational_leave_status.sql
63. 058_correction_approval_worked_only.sql ⚠ `NOTIFY pgrst`
64. 059_correction_approval_drop_manual.sql ⚠ `NOTIFY pgrst`
65. 060_data_api.sql ⚠ `service_role` + `NOTIFY pgrst`
66. 061_patent_payment_receipts.sql ⚠ `NOTIFY pgrst`
67. 062_daily_tasks.sql ⚠ `NOTIFY pgrst`
68. 063_revoke_object_worker_pages.sql
69. 064_seed_patent_receipts_page_access.sql
70. 065_role_page_access_view_implies_edit.sql
71. 066_drop_work_categories.sql ⚠ дубль номера
72. 066_merge_employees_into_staff_control.sql ⚠ дубль номера
73. 067_patent_receipts_raw_response_text.sql
74. 068_rebase_bulk_transfer_date.sql
75. 069_production_calendar_pre_holidays.sql
76. 070_manager_schedule_templates_access.sql
77. 071_drop_legacy_access_keys.sql
78. 072_skud_travel_approval.sql
79. 073_documents_recognition_error.sql
80. 074_drop_manager_schedules_default_access.sql
81. 075_patent_payment_period.sql
82. 076_employees_name_lock.sql
83. 077_role_show_actual_hours.sql
84. 078_skud_realtime_timesheet_perf_indexes.sql
85. 079_skud_card_reader_page_access.sql
86. 080_employees_trigram_search.sql ⚠ `pg_trgm`
87. 081_schedule_cycles.sql
88. 082_employee_direct_reports.sql
89. 083_user_company_access.sql ⚠ RLS + SECURITY DEFINER
90. 084_manager_obj_role.sql ⚠ `NOTIFY pgrst`
91. 085_skud_event_failures.sql ⚠ RLS + REVOKE
92. 086_drop_skud_raw_page.sql

Замечания по порядку:
- В репо отсутствует 018.
- Группа `020_*` содержит шесть файлов; основной — `020_attendance_access_refactor.sql`, остальные — preflight / backfill / debug-помощники, применяются перед основным или после него. При воссоздании БД с нуля их можно либо пропустить (если их эффект уже включён в основной 020), либо применить строго в порядке: preflight → preflight_summary → backfill_event_at_nulls → employee_assignments_overlap_debug → resolve_adjacent_employee_assignment_overlap → attendance_access_refactor.
- Номер `066` использован дважды — при автозапуске миграционного раннера это создаёт неопределённость порядка; перед миграцией переименовать один из файлов в `066a_…` / `066b_…` или сложить в новый номер.

---

## 9. Покрытие новых доменов миграциями

| Домен / объект | Создаётся в | Заметки |
|---|---|---|
| `data_api_keys`, `data_api_key_tables`, `data_api_request_logs` | 060_data_api.sql | + RPC `data_api_list_public_schema()` |
| `employee_direct_reports` | 082_employee_direct_reports.sql | частичный UNIQUE на активные записи |
| `user_company_access` | 083_user_company_access.sql | + RPC `get_descendant_department_ids` + RLS |
| `get_descendant_department_ids(uuid[])` | 083_user_company_access.sql | RECURSIVE CTE |
| Schedule cycles | 081_schedule_cycles.sql | расширение `work_schedules` (циклы 2/2, сутки/трое, ночные); отдельной таблицы `schedule_cycles` нет |
| `manager_obj` (роль) | 084_manager_obj_role.sql | запись в `system_roles`, не отдельная таблица |
| `skud_event_failures` | 085_skud_event_failures.sql | партиции по `event_date` |
| Sigur runtime state (`sigur_runtime_state` + RPC лизов) | 024_sigur_runtime_state.sql | 4 SECURITY DEFINER RPC: `try_acquire`, `heartbeat`, `merge`, `release` |
| `sigur_health_checks`, `sigur_incidents` | 015_sigur_monitoring.sql | |

Все перечисленные домены покрыты version-controlled миграциями — отдельных работ по их реверс-инжинирингу не требуется (в отличие от runtime-функций §7).

---

## 10. План работ для миграции (высокоуровневые шаги)

1. **Сбор недостающих RPC** из боевого Supabase: `batch_recalculate_skud_daily_summary`, `bulk_update_employee_ids`, `find_skud_duplicate_ids`, `find_direct_conversation`. Завести как `087_recover_runtime_functions.sql`.
2. **Подготовить адаптированный пакет миграций** для Yandex: убрать `NOTIFY pgrst`, убрать `REVOKE ... FROM anon, authenticated`, убрать `INSERT INTO storage.buckets`, заменить `WITH SCHEMA extensions` на `WITH SCHEMA public` (или создать `extensions` вручную), снять/переписать `ENABLE/FORCE RLS`.
3. **Расширения**: `CREATE EXTENSION btree_gist`, `pg_trgm`, `pgcrypto` (для `gen_random_uuid`).
4. **Auth**: заменить `supabase.auth.*` на собственный модуль (таблица `auth_users`, JWT-эмиссия, bcrypt-хеширование). Точки замены — §4.
5. **Storage**: перевести `supabase-storage.service.ts` на S3 SDK против Yandex Object Storage. Создать бакет `skud-object-maps` в YOS.
6. **Data API**: переписать `fot-data-api` (Python) с `supabase-py` на `asyncpg`/`psycopg`/`sqlalchemy`. Схема таблиц `data_api_*` остаётся.
7. **Очистить фронт**: убрать `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` из локальных `.env` (в коде они не используются).
8. **Тесты бэкенда**: `__tests__/setup.ts` — заменить заглушки на env нового PG.
