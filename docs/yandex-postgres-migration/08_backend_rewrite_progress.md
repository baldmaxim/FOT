# 08 — Backend rewrite progress (Supabase → pg Pool)

История переезда runtime-кода `fot-server/src/**` с `@supabase/supabase-js`
на прямой PostgreSQL через `pg`-Pool (см. `fot-server/src/config/postgres.ts`).

Цель — устранить runtime-зависимость от Supabase SDK перед переключением
БД на Yandex Managed PostgreSQL (нет PostgREST, нет `service_role`).

---

## Phase 10A — completed (2026-05-12)

Низкорисковая группа из 15 файлов (13 целевых сервисов/контроллеров + 2
вспомогательных). Содержимое: каталог доступа, аудит, роли, настройки,
Data-API admin, scope и назначения отделов, direct-reports.

| Файл | Notes |
|---|---|
| `services/access-control.service.ts` | `SELECT`-кэш для `role_page_access` и `access_pages`; TTL 5 мин сохранён |
| `services/roles-cache.service.ts` | `SELECT FROM system_roles WHERE is_active = true`; Map<id\|code> + TTL 5 мин |
| `services/audit.service.ts` | INSERT `audit_logs` через `execute`; `getAll` — один запрос с `count(*) OVER ()::int` |
| `controllers/audit.controller.ts` | `getActionLogs` — dynamic WHERE allowlist + count window; `runFullAudit` 3 параллельных `query<>` |
| `controllers/roles.controller.ts` | CRUD `system_roles`; `persistAccessProfile` → RPC `replace_role_access_profile` с fallback DELETE+INSERT внутри `withTransaction`; `cloneRole` — атомарная транзакция |
| `services/settings.service.ts` | `INSERT ... ON CONFLICT (key) DO UPDATE` для `set`/`setMultiple`; кеш 60 с сохранён |
| `services/data-api-key.service.ts` | SHA-256 `key_hash` (НЕ bcrypt); `replaceKeyTables` — `withTransaction` (DELETE+INSERT атомарно) |
| `services/data-api-schema.service.ts` | RPC `data_api_list_public_schema()`; deny-list + кеш 60 с сохранены |
| `services/data-scope.service.ts` | RPC `get_descendant_department_ids($1::uuid[])` через `withSupabaseSlot` semaphore; race+timeout+stale-cache fallback сохранены |
| `services/department-access.service.ts` | `WHERE ... = ANY($1::int[])` для batch; threshold 300 сохранён; missing-table → '42P01' |
| `services/employee-department-access.service.ts` | `upsertTechnicalDepartmentAccess` — атомарная транзакция (deactivate prev → select → activate/insert) |
| `services/employee-direct-reports.service.ts` | `listDirectReports` — динамический WHERE; `assignDirectReport` — INSERT RETURNING + 23505 refetch |
| `controllers/direct-reports.controller.ts` | scope-check через `queryOne` вместо `supabase.from(...).maybeSingle()` |
| `services/critical-admin-access.service.ts` | 3 параллельных `query<>` для snapshot |
| `services/manager-department-import.service.ts` | `INSERT ... ON CONFLICT` для alias-таблиц; missing-table → '42P01' |

### Тесты
Обновлены existing test mocks на `vi.mock('../config/postgres.js', { query, queryOne, execute, withTransaction })`:
- `services/data-scope.service.test.ts`
- `services/department-access.service.test.ts`
- `services/manager-department-import.service.test.ts`
- `services/settings.service.test.ts`

Новый smoke-test:
- `services/data-api-key.service.test.ts` — проверяет SHA-256 (не bcrypt), формат токена `fot_<16hex>_<48hex>`, обёртку `replaceKeyTables` в `withTransaction`.

Результат: **41 test file, 389 tests passed.**

---

## RPC converted

| RPC | SQL |
|---|---|
| `replace_role_access_profile(text, jsonb, jsonb) RETURNS void` | `SELECT public.replace_role_access_profile($1, $2::jsonb, $3::jsonb)` |
| `get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)` | `SELECT id FROM public.get_descendant_department_ids($1::uuid[])` |
| `data_api_list_public_schema() RETURNS TABLE(...)` | `SELECT table_name, column_name, data_type, is_nullable FROM public.data_api_list_public_schema()` |

---

## Remaining Supabase runtime files

После Phase 10A в `fot-server/src/**` остаются вызовы `supabase.from` / `supabase.rpc`
в **27 файлах** (60 occurrences). Подсчёт:

```
Grep pattern: "supabase\.from|supabase\.rpc"
path: fot-server/src
```

Группы (ориентир для следующих фаз):
- **employees**: `employee-mapper.service.ts`, `employee-lifecycle.controller.ts`
- **timesheet**: `timesheet.controller.ts`, `timesheet-approval.controller.ts`, `timesheet-approval-attachments.service.ts`, `timesheet-export.service.ts`, `timesheet-transfers.service.ts`
- **skud**: `skud-import.service.ts`, `skud-backfill.service.ts`, `skud-discipline.service.ts`, `skud-presence.service.ts`, `skud-shared.service.ts`, `skud-summary-reconcile.service.ts`
- **sigur**: `sigur-sync.controller.ts`, `sigur-access-point-meta.service.ts`, `sigur-runtime-state.service.ts`, `sigur-sync-events.service.ts`, `sigur-sync-employees.service.ts`, `presence-polling.service.ts`
- **auth**: `auth.controller.ts`, `admin-users.controller.ts` (остался `supabase.auth.admin.*`)
- **misc**: `documents.controller.ts`, `salary-raise.controller.ts`, `ai-receipt-recognition.service.ts`, `attendance.service.ts`, `push.service.ts`
- **db helper**: `db/sql.ts` (одно упоминание в комментарии toolkit'а — не runtime)

---

## Known risks

1. **Атомарность улучшена** в трёх местах. Раньше многошаговая последовательность шла без TX —
   между шагами было окно для race condition. Новый код обёрнут в `withTransaction`:
   - `roles.controller.persistAccessProfileFallback` (DELETE + bulk INSERT для `role_page_access`)
   - `data-api-key.replaceKeyTables` (DELETE + bulk INSERT для whitelist)
   - `employee-department-access.upsertTechnicalDepartmentAccess` (deactivate prev → select → activate/insert)

2. **Missing-table guard переключён** с Supabase-кода `PGRST205` на PG-код `42P01` (undefined_table).
   Graceful-fallback `[] + warning один раз` сохранён. На свежих БД (миграции 033, 086 применены)
   ничего не меняется; на старых клонах warning отрабатывает аналогично.

3. **`withSupabaseSlot` instrumentation оставлен как есть.** Это semaphore/timer-обёртка
   (`fot-server/src/config/supabase-instrumentation.ts`), не зависит от Supabase SDK —
   переименование в `withDbSlot` запланировано в отдельной фазе.

4. **`audit.service.getAll` использует `count(*) OVER ()::int`** — один round-trip вместо двух.
   На пустой выборке (offset за пределами) делаем дополнительный count.
   Response shape `{ data, count }` сохраняется.

5. **`@supabase/supabase-js` НЕ удалён** — остальные 27 файлов всё ещё используют SDK
   через `config/database.ts`. Удаление пакета — Phase 10E.

---

## Phase 10B — completed (2026-05-12)

Домены admin/users/employees/structure/salary-raise. 17 файлов, ~6800 строк.

### Admin / Auth (4 файла)
| Файл | Notes |
|---|---|
| `controllers/admin-users.controller.ts` | Большой файл (~1770 строк). `getAllUsers`/`getPendingUsers` подгружают email batch через `localAuthService.getUsersByIds`. `approve/reject/delete` сохранили best-effort `localAuthService.deleteUser`. `replaceUserCompanies` обёрнут в `withTransaction` (INSERT/DELETE дельты в одной TX). `replaceExplicitDepartmentAccess` — атомарный SELECT+UPSERT+UPDATE через transaction. `searchUnlinkedEmployees` использует `id <> ALL($n::int[])` вместо `not('id', 'in', '(...)')`. |
| `controllers/admin-2fa.controller.ts` | TOTP через `execute` UPDATE `user_profiles`; email — через `localAuthService.getUserById`. |
| `controllers/auth-2fa-self.controller.ts` | Self-setup TOTP. Те же UPDATE через `execute`. |
| `controllers/auth-2fa.controller.ts` | `verify2FA`/`useRecoveryCode` через `queryOne` + `execute`. JWT/cookies не изменились. |

### Employees + lifecycle (10 файлов)
| Файл | Notes |
|---|---|
| `services/employee-mapper.service.ts` | 2 параллельных `query` для departments/positions. Кэш TTL 60с сохранён. |
| `services/employee-cache.service.ts` | Pure in-memory, без БД — без изменений. |
| `services/employee-archive-department.service.ts` | `moveEmployeesIntoArchiveDepartment` — два `execute`-UPDATE с `= ANY($1::int[])`. ENSURE-INSERT через `queryOne`. |
| `services/employee-changes.service.ts` | Single source of truth для history. Все методы (`changeSalary`/`changePosition`/`changeDepartment`/`update/delete*`) через прямые SQL. `applyFrozenAssignment` — несколько шагов без отдельной TX (поведение совпадает с прежним Supabase-кодом). `deleteAssignment` сохранил `tryDeleteTransfer` fallback. |
| `controllers/employees.controller.ts` | Большой файл (~1090 строк): динамический WHERE для `getAll` paginated/legacy, count window для пагинации, schedule-filter с `(effective_to IS NULL OR effective_to >= $1)`, `id <> ALL($n::int[])` для excluded. `update` — централизованный allowlist через `buildEmployeeUpdate`. `create` — RETURNING-INSERT с rollback Sigur при DB-failure. |
| `controllers/employee-lifecycle.controller.ts` | ~1045 строк: archive/restore/fire/rehire/moveDepartment/batchMove + history CRUD. UPDATE с RETURNING для всех мутаций. `fire`/`rehire` сохранили частичный Sigur-rollback. |
| `controllers/employee-import.controller.ts` | `deleteAll` — `count` через `SELECT count(*)::int`, затем `execute DELETE WHERE id <> 0`. |
| `controllers/employee-enrich.controller.ts` | Bulk INSERT новых позиций через `ON CONFLICT (name) DO NOTHING RETURNING id, name` + reload-fallback для существующих. |
| `controllers/employee-enrich-salary.controller.ts` | Аналогичный паттерн для salary. Salary-changes идут через `employeeChangesService.changeSalary` (пишет `salary_history`). |
| `controllers/employee-enrich-contacts.controller.ts` | Простой `UPDATE employees SET email`. |
| `controllers/employee-enrich-salary-history.controller.ts` | Bulk-insert `salary_history` (история окладов) одним INSERT с `VALUES (...), (...)...`. |

### Structure (1 файл)
| Файл | Notes |
|---|---|
| `controllers/structure.controller.ts` | `loadAllActiveDepartments`/`buildDepartmentTree` — кэш на 60 с не изменён. `createDepartment` — `INSERT ... RETURNING *`. `updateDepartment` — динамический allowlist (`name/parent_id/kind`). `deleteDepartmentRecursive` — два `execute`-UPDATE (`employees`, `employee_assignments`) + DELETE отделов в порядке убывания глубины. `clearStructure` — `execute DELETE` с возвратом `rowCount` напрямую (вместо Supabase `count: 'exact'`). |

### Salary raise (1 файл)
| Файл | Notes |
|---|---|
| `controllers/salary-raise.controller.ts` | ~1450 строк: v2/legacy schema detection теперь через PG '42703' (undefined_column) вместо парсинга Supabase-ошибки. `create`/`update` — динамический INSERT/UPDATE c явным `$n::jsonb` для snapshot/achievements. `getMy/getPending/getAll` — параметризованные SQL. `getCandidates` — `id = ANY($1::int[])` + ILIKE через `escapeLike`. `submit/cancel/adminReview` — RETURNING-UPDATE. `getSalaryRaiseReviewerIds` сохранил повторный `Promise.all` (`system_roles` + `role_page_access`). |

### localAuthService usage
- `admin-users.controller.getAllUsers/getPendingUsers` — batch lookup через `localAuthService.getUsersByIds` (без N+1).
- `admin-users.confirmUserEmail` — `localAuthService.updateUserById({ emailConfirm: true })`.
- `admin-users.rejectUser/deleteUser` — `localAuthService.deleteUser(id)` (best-effort, не блокирует основную операцию).
- `admin-2fa.generate2FA` / `auth-2fa-self.setup2FA` — `localAuthService.getUserById(id)` для получения email.

---

## RPC converted

| RPC | SQL | Phase |
|---|---|---|
| `replace_role_access_profile` | `SELECT public.replace_role_access_profile($1, $2::jsonb, $3::jsonb)` | 10A |
| `get_descendant_department_ids` | `SELECT id FROM public.get_descendant_department_ids($1::uuid[])` | 10A |
| `data_api_list_public_schema` | `SELECT ... FROM public.data_api_list_public_schema()` | 10A |

(Phase 10B без RPC — все запросы простые SELECT/INSERT/UPDATE/DELETE.)

---

## Remaining Supabase runtime files

После Phase 10B в `fot-server/src/**` остаются вызовы `supabase.from`/`supabase.rpc`
в **23 файлах** (50 occurrences):

```
Grep pattern: "supabase\\.from|supabase\\.rpc|supabase\\.auth|auth\\.admin"
path: fot-server/src
```

Группы для следующих фаз:
- **SKUD/Sigur**: `skud-*` (7), `sigur-*` (5), `presence-polling.service.ts`
- **Timesheet**: `timesheet.controller.ts`, `timesheet-approval.*`, `timesheet-export.service.ts`, `timesheet-transfers.service.ts`, `timesheet-approval-attachments.service.ts`
- **Misc**: `documents.controller.ts`, `attendance.service.ts`, `ai-receipt-recognition.service.ts`, `push.service.ts`
- **Auth**: `auth.controller.ts` (остался только `supabaseAuth.signInWithPassword` — legacy login flow для миграционного периода до отключения SDK)
- **db helper**: `db/sql.ts` (одно упоминание в комментарии).

Не runtime-критические остатки в импорте `config/database` (без вызовов `supabase.*`):
~40 файлов, импортирующих `supabase` для дописанной runtime-логики (chat, notifications, schedule, payslips, leave-requests, daily-tasks, patent-receipts и т.п.) — это будут целевые файлы Phase 10C/10D.

---

## Known risks for Phase 10C

1. **Sigur sync — самая тяжёлая часть оставшегося кода.** Большинство файлов sigur-* содержат batch-операции (cards, access points, employees, departments). Их атомарность — проверять отдельно: Sigur API может возвращать частичные ответы.

2. **SKUD presence-polling & batch RPC.** `presence-polling.service.ts` использует RPC `batch_recalculate_skud_daily_summary(jsonb)` — критичный путь. Дополнительно — incremental cursor по `lastId` через `skud_events`. Партиции `skud_events_YYYYMM` потребуют проверки на missing-partition errors.

3. **Timesheet-approval — JSONB-агрегаты + transitions.** `timesheet_approvals.events` хранит JSONB. Все UPDATE-history операции писать через `array_append(events, $n::jsonb)`.

4. **`chat.service.ts` — RPC `find_direct_conversation`.** Это бизнес-логика на стороне БД; не упрощать в client-side join.

5. **`auth.controller.ts`** ещё использует `supabaseAuth.auth.signInWithPassword`. Переключение на bcrypt-compare через `localAuthService.verifyPassword` — отдельная фаза (10D), требует синхронизации хешей при миграции.

---

## Next: Phase 10C

Sigur runtime + SKUD ingestion. Файлы:
- `sigur-*.service.ts` (5 файлов), `sigur-sync.controller.ts`
- `presence-polling.service.ts`
- `skud-*.service.ts` (skud-import, skud-discipline, skud-presence, skud-backfill, skud-summary-reconcile, skud-shared)
- `attendance.service.ts`
- `push.service.ts`, `notification.service.ts`

Approach: те же паттерны (`vi.hoisted` + `vi.mock('../config/postgres.js')`, `withTransaction`,
allowlist SQL, JSONB через `$n::jsonb`).

## Next: Phase 10D

Timesheet domain + chat + payslips + leave-requests + auth flow.

