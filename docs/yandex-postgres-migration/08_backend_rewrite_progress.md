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

## Phase 10C — completed (2026-05-12)

Timesheet runtime + schedules + attendance + approvals. ~25 файлов.

### Контроллеры
| Файл | Notes |
|---|---|
| `controllers/timesheet.controller.ts` | ~2080 строк. Helper-функции (`findApprovalLockForDate`, `loadApprovalLockedDatesForDepartment`, `countAcceptedMandatorySaturdays`, `resolvePlannedHoursByItems`, `resolveShiftDurationByItems`, `resolveAdjustmentApprovalStatus`) + `getAll`/`refresh` переписаны на параметризованные `query/queryOne`. Динамический WHERE с `empWhere/empParams`. |
| `controllers/timesheet-approval.controller.ts` | ~1250 строк. Динамический WHERE для статусов/scope; `count(*)::int` precheck; `getReviewList` adjustments через `= ANY($1::int[])` (employees) и `= ANY($2::date[])` (skud dates). 23P01 → 409 сохранён. |
| `controllers/timesheet-weekend-memo.controller.ts` | один UPDATE-RETURNING. |
| `controllers/timesheet-team-management.controller.ts` | scope-resolution + ILIKE-search; bulk fetch через `= ANY($n::uuid[])`. |
| `controllers/timesheet-assigned-export.controller.ts` | Export по scope, без изменений в API/CSV-формате. |
| `controllers/schedule.controller.ts` | ~22 supabase calls → 0. Введён локальный `SCHEDULE_ASSIGNMENT_JOIN` helper, который собирает `LEFT JOIN work_schedules ws ON ws.id = a.schedule_id` + `to_jsonb(ws.*) AS work_schedules` — потребитель `extractWorkSchedule` без изменений. Dynamic INSERT/UPDATE для `work_schedules` (`day_overrides`/`cycle_days` — `JSON.stringify` + `$n::jsonb`). |
| `controllers/correction-approval.controller.ts` | Approval workflow + state-machine; multi-step операции в `withTransaction`. |

### Сервисы
| Файл | Notes |
|---|---|
| `services/timesheet-period.service.ts` | Pure date/period math. |
| `services/timesheet-range.service.ts` | Pure SQL builder. |
| `services/timesheet-responsibles.service.ts` | UPSERT через `INSERT ... ON CONFLICT DO UPDATE` (row-by-row для простоты). |
| `services/timesheet-department-assignments.service.ts` | SELECT/UPDATE с allowlist. |
| `services/timesheet-workflow-recipients.service.ts` | SELECT scope-filter. |
| `services/timesheet-object.service.ts` | `fetchRawEvents`/`fetchObjectMappings`: missing-table guard через PG `'42P01'` (вместо `PGRST205`). |
| `services/timesheet-export.service.ts` | Read-only: departments/employees/positions через `= ANY($1::uuid[])` / `::int[]`. |
| `services/timesheet-transfers.service.ts` | `updateTransfer`/`tryDeleteTransfer` (4-step) / `updateExclusionDate`/`deleteExclusion` — все обёрнуты в `withTransaction`. Удалён manual rollback (TX делает то же atomically). |
| `services/timesheet-reminder.service.ts` | Cron-логика сохранена; `INSERT ... ON CONFLICT DO UPDATE` row-by-row. |
| `services/timesheet-weekend-memo.service.ts` | UPDATE+INSERT через `execute`. |
| `services/timesheet-approval-attachments.service.ts` | `documents` + `document_links` INSERT в одной `withTransaction`; DELETE — тоже атомарно. `r2Service` для blob-хранилища без изменений. |
| `services/timesheet-approval-history.service.ts` | INSERT с `$n::jsonb` для events. |
| `services/timesheet-approval-correction-validation.service.ts` | Pure SELECT validations. |
| `services/timesheet-approval-weekend-check.service.ts` | SELECT-проверки на выходные. |
| `services/attendance.service.ts` | `upsertAttendanceAdjustment` — `INSERT ... ON CONFLICT (employee_id, work_date, source_type, source_id) DO UPDATE SET ...` с dynamic SET. BATCH_SIZE сохранён. |
| `services/schedule.service.ts` | Локальный `SCHEDULE_JOIN_SELECT` (`LEFT JOIN work_schedules` + `to_jsonb`). `assignEmployee/ObjectSchedule` разделено на `execute` + `queryOne` JOIN-fetch (имитация `.update(...).select(...).single()`). |

### Notes / decisions
- `count: 'exact'` → `count(*) OVER ()::int AS total_count` window (как в Phase 10A audit.service).
- `.upsert(rows, { onConflict })` → row-by-row `INSERT ... ON CONFLICT DO UPDATE` (проще, чем multi-row VALUES для маленьких N).
- `not('col', 'is', null)` → `col IS NOT NULL`.
- `.or('a.is.null,a.gte.X')` → `(a IS NULL OR a >= $N)` (тот же param повторно).
- Array params: `::int[]` employee ids, `::uuid[]` department/object ids, `::date[]` для date arrays, `::text[]` для строк.

---

## Phase 10D — completed (2026-05-12)

SKUD + Sigur + presence-polling. ~21 файл.

### SKUD services
| Файл | Notes |
|---|---|
| `services/skud-shared.service.ts` | Pure DB helpers (`collectDeptIds`, `getEmployeeIdsForDeptScope`). Все на `query/queryOne`. |
| `services/skud-backfill.service.ts` | Batch backfill `skud_daily_summary` через `INSERT ... ON CONFLICT`. |
| `services/skud-summary-reconcile.service.ts` | RPC `batch_recalculate_skud_daily_summary($1::jsonb)` через `queryOne` + `withSupabaseSlot`. |
| `services/skud-import.service.ts` | Bulk-insert `skud_events` в партиционированную таблицу; dedup по UNIQUE `(dedup_hash, event_date)`. |
| `services/skud-presence.service.ts` | Сводки + кэш TTL сохранены. |
| `services/skud-discipline.service.ts` | Pure SELECT + aggregation. |
| `services/skud-dashboard.service.ts` | KPI-агрегации. |
| `services/skud-travel.service.ts` | Travel-сегменты, маппинги объектов; `r2Service` для скриншотов карт. |
| `services/skud-travel-routes.service.ts` | Маршруты + travel-объекты. |

### SKUD controllers
| Файл | Notes |
|---|---|
| `controllers/skud.controller.ts` | Endpoints для dashboard/discipline/import. |
| `controllers/skud-write.controller.ts` | Mutations: `withTransaction` для `markPresence`/`addCard`. |
| `controllers/skud-travel.controller.ts` | Travel CRUD + map upload. |

### Sigur
| Файл | Notes |
|---|---|
| `services/sigur-runtime-state.service.ts` | Lease functions (try_acquire/heartbeat/merge/release) — `SELECT public.fn(...)`. |
| `services/sigur-monitor.service.ts` | Health-checks + incidents (`sigur_health_checks`, `sigur_incidents`); missing-table guard `'42P01'`. |
| `services/sigur-linked-employees.service.ts` | UPSERT привязок sigur_employee_id ↔ employee_id. |
| `services/sigur-sync-shared.service.ts` | Общие helpers (id resolution, batching). |
| `services/sigur-sync-structure.service.ts` | Departments/positions из Sigur API → BD; partial-response handling сохранён. |
| `services/sigur-sync-employees.service.ts` | Employees diff + apply. |
| `services/sigur-sync-events.service.ts` | События за день — incremental import. |
| `services/sigur-access-point-meta.service.ts` | Access point metadata cache. |
| `controllers/sigur.controller.ts`, `controllers/sigur-sync.controller.ts`, `controllers/sigur-card-reader.controller.ts`, `controllers/sigur-filter.controller.ts` | Admin endpoints. |

### Presence polling
| Файл | Notes |
|---|---|
| `services/presence-polling.service.ts` | Incremental polling по `lastId` (cursor seek). `withSupabaseSlot` оставлен как semaphore (имя файла `supabase-instrumentation.ts` оставлен под переименование). |

### Notes
- Все RPC, специфичные для SKUD/Sigur (lease, batch_recalculate, get_descendant), обёрнуты в `withSupabaseSlot` — semaphore не позволяет presence-polling перегружать pool.
- `sigur_incidents`/`sigur_health_checks` — таблицы из миграции 015. Missing-table guard `'42P01'` (вместо `PGRST205`).
- Партиции `skud_events_YYYYMM` — на чтении/записи никаких отдельных проверок не делаем (как и раньше). Missing-partition даст PG error при INSERT, ловим через `try/catch` в импорт-флоу.

---

## Phase 10E — completed (2026-05-12)

Финальная очистка + миграция оставшихся доменов.

### Доделанные домены (46 файлов, ~303 supabase calls → 0)

**Auth / users (волна 1):**
- `controllers/admin-users.controller.ts` (~1780 строк): `getAllUsers`/`getPendingUsers` через `localAuthService.getUsersByIds`. `replaceUserCompanies` — `withTransaction`. Bulk UPSERT через `INSERT … SELECT FROM unnest($N::uuid[]) … ON CONFLICT DO UPDATE` (один round-trip). `searchUnlinkedEmployees` — `<> ALL($N)`.
- `controllers/auth.controller.ts`: `localAuthService.verifyPassword` вместо `supabaseAuth.signInWithPassword`. JWT/2FA semantics сохранены. `forgotPassword` — case-insensitive lookup через functional UNIQUE index.

**Timesheet (волна 1, 6 файлов):**
- `controllers/timesheet.controller.ts`, `timesheet-approval.controller.ts`.
- `services/timesheet-transfers.service.ts` — все multi-step ops в `withTransaction`.
- `services/timesheet-export.service.ts`, `timesheet-approval-attachments.service.ts`, `attendance.service.ts`.

**Salary raise + lifecycle (волна 1, 2 файла):**
- `controllers/salary-raise.controller.ts`: v2/legacy fallback через PG `'42703'`.
- `controllers/employee-lifecycle.controller.ts`.

**Auth/admin/access (волна 2 group 1, 10 файлов):**
- `controllers/auth-2fa.controller.ts`, `direct-reports.controller.ts`, `employee-import.controller.ts`, 4× `employee-enrich-*.controller.ts`.
- `services/access-control.service.ts`, `roles-cache.service.ts`, `audit-context.helpers.ts`.

**Employee + structure (волна 2 group 2, 8 файлов):**
- `controllers/employees.controller.ts` (~1090 строк), `structure.controller.ts`.
- `services/employee-changes.service.ts` (~27 calls!) — все методы в `withTransaction` через `*Tx` helper-варианты с `PoolClient`.
- `services/employee-archive-department.service.ts`, `employee-direct-reports.service.ts`, `employee-department-access.service.ts`, `department-access.service.ts`, `manager-department-import.service.ts`.

**Schedule + timesheet остатки (волна 2 group 3, 13 файлов):**
- `controllers/schedule.controller.ts`.
- `services/schedule.service.ts` + 12 timesheet-* сервисов (отчасти доделка Phase 10C).

**Chat + leave + payslip + misc (волна 2 group 4, 15 файлов):**
- `services/chat.service.ts` (~24 calls): RPC `find_direct_conversation` → `SELECT FROM find_direct_conversation($1::uuid, $2::uuid)`. `getOrCreateConversationRecord`, `sendMessage`, `approveContactRequest` — все в `withTransaction`. Шифрование через `encryptionService` без изменений.
- `services/chat-policy.service.ts`.
- `controllers/leave-requests.controller.ts` (~18 calls): `create` — `INSERT request + document_links + UPDATE documents.leave_request_id` в одной транзакции.
- `controllers/official-memos.controller.ts`, `correction-approval.controller.ts`.
- `controllers/payments.controller.ts`, `payslips.controller.ts`, `services/payslip-generation.service.ts`.
- `controllers/patent-receipts.controller.ts` (10 calls): `r2Service` для чеков, encryption (`decryptReceiptRow`, `encryptReceiptFields`, `decryptRawResponse`) сохранены. Nested Supabase relation selects → `LEFT JOIN` с `to_jsonb(...)`/`jsonb_build_object(...)` — клиентский response shape идентичен.
- `services/patent-expiry-reminder.service.ts`.
- `controllers/production-calendar.controller.ts`, `daily-tasks.controller.ts`.
- `services/daily-tasks-reminder.service.ts`: `INSERT … ON CONFLICT … DO NOTHING RETURNING employee_id` сохраняет `ignoreDuplicates:true` semantics.
- `services/notification.service.ts`: bulk INSERT через `unnest($N::*[])`.
- `services/data-api-key.service.ts`: SHA-256 key_hash сохранён, `replaceKeyTables` — `withTransaction`.

### Удаление SDK
- `@supabase/supabase-js` удалён из `fot-server/package.json` (`npm uninstall`).
- `fot-server/src/config/database.ts` (Supabase client) удалён.
- `fot-server/src/services/supabase-storage.service.ts` удалён (заменён на `object-map-storage.service.ts` ещё в Phase 10D). Тестовые mock-блоки в `skud-travel-maps.service.test.ts` и `skud-travel-schema-errors.service.test.ts` перенацелены на новый сервис.
- В `package.json` добавлены явные зависимости: `pg ^8.20.0`, `@types/pg ^8.20.0`, `bcryptjs ^3.0.3`.

### Что осталось как есть
- `fot-server/src/config/supabase-instrumentation.ts` (с экспортом `withSupabaseSlot`) — это semaphore-обёртка, НЕ supabase-зависимая. Переименование в `withDbSlot` — отдельная задача (не блокирующая Yandex-переезд).
- Упоминание "supabase" в комментариях: `db/sql.ts`, `config/postgres.ts`, `local-auth.service.ts`, `object-map-storage.service.ts`, `data-scope.service.ts`, `sigur-sync-employees.service.ts`, `presence-polling.service.ts` — это исторические пояснения, не runtime-зависимости.
- ~~`fot-data-api/` (Python) — всё ещё на Supabase Python SDK~~ — закрыто в **Phase 10G** (см. ниже).

### Финальные метрики после Phase 10E
- **`Grep "await supabase|supabase\\.from|supabase\\.rpc|supabase\\.auth|supabase\\.storage"`** в `fot-server/src/**` (без тестов) → **0 совпадений**.
- `cd fot-server; npm run build` → exit 0, без ошибок.
- `npm run test` после 10E: 80 тестов из 388 падали из-за устаревших моков `vi.mock('../config/database.js')`. Блокировало Phase 11, исправлено в 10F.

### Известные риски / follow-ups (закрыты в 10F)
1. ~~17 файлов с устаревшими моками~~ — закрыто в 10F: 21 test-файл переключён на `vi.mock('../config/postgres.js')` с `query/queryOne/execute/withTransaction` mock-факториями. Все 388 тестов проходят.
2. ~~`config/supabase-instrumentation.ts` переименовать в `config/db-instrumentation.ts`~~ — закрыто в 10F.
3. **`bcryptjs` vs `bcrypt`**: используется чистая JS-реализация (нет нативных бинарей). Если требуется производительность — подменить на `bcrypt` с пересборкой нативной части на Yandex VM.

---

## Phase 10F — completed (2026-05-12)

Post-rewrite stabilization после Phase 10E.

### Test-моки переключены на pg-Pool (21 файл, 388/388 тестов)

**Группа 1 (7 файлов, 22/22):** `settings.service.test.ts`, `sigur-linked-employees.service.test.ts`, `sigur-live-admin.service.test.ts`, `timesheet-approval-weekend-check.service.test.ts`, `timesheet-department-assignments.service.test.ts`, `timesheet-reminder.service.test.ts`, `manager-department-import.service.test.ts`.

**Группа 2 (7 файлов, 85/85):** `data-scope.service.test.ts` (плюс mock `withDbSlot`), `department-access.service.test.ts`, `skud-dashboard.service.test.ts`, `skud.controller.test.ts`, `compensation-access.controller.test.ts`, `attendance.service.test.ts`, `schedule.service.test.ts` (44 теста на JOIN).

**Группа 3 (7 файлов, 49/49):** `presence-polling.service.test.ts` (17 тестов, полная in-memory симуляция pg), `sigur-monitor.service.test.ts` (8 тестов с парсингом UPDATE SET WHERE id = $N RETURNING *), `schedule.controller.test.ts`, `timesheet-object.service.test.ts`, `skud-travel.service.test.ts`, `skud-travel-maps.service.test.ts`, `skud-travel-schema-errors.service.test.ts`.

**Точечный фикс:** `data-api-key.service.test.ts` — параметр `revokeKey` теперь `params[0]` (was `params[1]`); `now()` идёт inline в SQL, не как параметр.

**Подход к моку:**
```ts
const { pgQuery, pgQueryOne, pgExecute, pgTx } = vi.hoisted(() => ({ ... }));
vi.mock('../config/postgres.js', () => ({ query: pgQuery, queryOne: pgQueryOne, execute: pgExecute, withTransaction: pgTx }));
```
Builder-chain assertions (`.from().select().eq()`) переписаны на SQL-regex + positional params. Сложные сервисы (presence-polling, sigur-monitor) получили SQL-router через `pgQuery.mockImplementation(async (sql, params) => ...)`.

### Active scripts мигрированы (6 файлов)

1. `scripts/create-test-code.ts` — `query`/`queryOne` вместо Supabase chain; `organizations`/`user_profiles`/`employee_link_codes` через прямые SQL.
2. `scripts/cleanup-misclassified-pass-deny.ts` — `LIMIT/OFFSET` пагинация, `DELETE WHERE id = ANY($1::bigint[])`, RPC `batch_recalculate_skud_daily_summary` → `SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)`.
3. `scripts/backfill-orphan-skud-summaries.ts` — то же; RPC аналогично.
4. `scripts/backfill-failure-type-names.ts` — `LIKE 'TYPE\_%' ESCAPE '\'` для скан старых имён; `UPDATE` через `execute`.
5. `scripts/migrate-patent-receipts-to-encrypted.ts` — dynamic SET-builder с allowlist по `ENCRYPTED_FIELDS`, шифрование через `patent-receipt-encryption.helper.ts` без изменений.
6. `scripts/yandex-migration/migrate-skud-object-maps-storage.ts` — **option B (REST-based)**: вместо `createClient` из `@supabase/supabase-js` теперь `fetch()` против `${SOURCE_SUPABASE_URL}/storage/v1/object/{bucket}/{path}` с `Authorization: Bearer SOURCE_SUPABASE_SERVICE_ROLE_KEY` + `apikey` header. Path encoded segment-by-segment. 404 → mapped to `failed` (preserves prior SDK semantics where missing object was an error, not a skip).

`docs/yandex-postgres-migration/06_storage.md` обновлён абзацем про переход на REST.

### Instrumentation renamed

`fot-server/src/config/supabase-instrumentation.ts` → `db-instrumentation.ts`.
- Экспорты: `withSupabaseSlot` → `withDbSlot`, `getSupabaseInflight` → `getDbInflight`.
- Семантика семафора и счётчик inflight не менялись.
- Все импорты в `data-scope.service.ts`, `presence-polling.service.ts` и соответствующих тестах обновлены.

### Env cleanup

- Из `env.ts` удалены обязательные `SUPABASE_URL` и `SUPABASE_SERVICE_ROLE_KEY` — runtime их больше не использует.
- Из `src/__tests__/setup.ts` удалены соответствующие test-fixture env-переменные.

### Финальные grep-метрики после 10F

```
fot-server/src   await supabase | supabase.from | supabase.rpc | supabase.auth | supabase.storage  → 0
fot-server/src   @supabase/supabase-js | SUPABASE_URL | SUPABASE_SERVICE_ROLE_KEY                    → 0
fot-server/scripts (без archive/)                                                                    → 0
```

Допустимые остатки (комментарии/исторические упоминания):
- `src/db/sql.ts:1` — комментарий "Замена supabase.from/supabase.rpc"
- `src/services/data-scope.service.ts:24` — комментарий-пояснение
- `src/services/object-map-storage.service.ts:4,91` — историческая замена `supabase-storage.service.ts`
- `src/config/db-instrumentation.ts:9` — Phase 10F note
- `src/config/postgres.ts:4` — Phase 10 история
- `src/services/sigur-sync-employees.service.ts:73` — комментарий про моки
- `src/services/local-auth.service.ts:4` — комментарий "supabase-js здесь больше нет"
- `src/services/local-auth.service.test.ts:45` — строковый литерал `migrated_from: 'supabase_auth'` (data marker, остаётся в БД)
- `scripts/yandex-migration/*` — source-side migration tooling (явно документировано)

### Финальная проверка

- `cd fot-server; npm install` — clean.
- `cd fot-server; npm run build` → exit 0.
- `cd fot-server; npm run test` → **388 passed / 0 failed (41 test files)**.
- `cd fot-data-api; python -m compileall app` — clean (Python-подпроект независим от 10F).

### Готовность к Phase 11 (после 10F)
- ✅ Runtime fot-server без Supabase SDK
- ✅ Все active scripts на pg
- ✅ Migration tool (`migrate-skud-object-maps-storage`) самодостаточен (fetch + S3 SDK)
- ✅ Instrumentation семантически нейтрален
- ✅ Build + tests зелёные
- ✅ Env без устаревших переменных

---

## Phase 10G — completed (2026-05-12)

Очистка Python-подпроекта `fot-data-api` от runtime-зависимости на Supabase SDK.

### Изменения

**`fot-data-api/requirements.txt`:**
- Удалён `supabase==2.10.0`.
- Добавлен `psycopg[binary,pool]==3.2.3` (AsyncConnectionPool + async cursor).

**`fot-data-api/app/config.py`:**
- Удалены `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
- Добавлены `DATABASE_URL`, `DATABASE_SSL` (default `true`), `DATABASE_SSL_CA_PATH` (опционально для `verify-full`), `DATABASE_POOL_MAX` (default `10`).

**`fot-data-api/app/lib/`:**
- `app/lib/supabase.py` удалён.
- Используется существующий `app/lib/postgres.py` (он уже был подготовлен заранее) — AsyncConnectionPool psycopg 3.x, `fetch_one`, `fetch_all`, `execute`, `get_pool`, `close_pool`. SSL: `sslmode=disable|require|verify-full` в зависимости от `DATABASE_SSL` + `DATABASE_SSL_CA_PATH`. Пул открывается лениво через `get_pool()` (asyncio.Lock защищает от race).

**`fot-data-api/app/services/auth.py`:**
- `authenticate()` остаётся async; `get_supabase().table().select()...` → `await fetch_one('SELECT … FROM data_api_keys WHERE key_prefix = %s LIMIT 1', (prefix,))`.
- Last-used update: `await execute('UPDATE data_api_keys SET last_used_at = now() WHERE id = %s', (id,))` в `try/except` (best-effort).
- `_parse_iso` удалён — psycopg сразу возвращает `datetime` для timestamp-колонок.

**`fot-data-api/app/services/query.py`:**
- `get_table_access` / `list_accessible_tables` — async `fetch_one`/`fetch_all` к `data_api_key_tables`.
- `execute_select`: SQL собирается через `psycopg.sql` API:
  - `psycopg.sql.Identifier` для `table_name` и каждой колонки в `SELECT … FROM …`.
  - `psycopg.sql.SQL("{col} = %s")` + `Identifier(col)` для каждого WHERE-предиката.
  - `psycopg.sql.SQL("{col} = ANY(%s)").format(...)` + `[values]` для `in.<col>=v1,v2,v3`.
  - `ORDER BY {col} ASC|DESC` через `Identifier(col)` + `SQL('ASC'|'DESC')`.
  - `LIMIT %s OFFSET %s` — позиционные параметры.
  - **Никакого f-string SQL.**
- Whitelist через `data_api_key_tables.allowed_fields` сохранён; неразрешённое поле → 400 (`_ensure_allowed`).

**`fot-data-api/app/services/logging.py`:**
- `write_log` async; `INSERT INTO data_api_request_logs (…) VALUES (…, %s::jsonb, %s)` с `json.dumps(query_params)`. Обёрнуто `try/except` — best-effort, никогда не валит основной запрос.

**`fot-data-api/app/main.py`:**
- Добавлен `lifespan(async)`: `await get_pool()` на startup, `await close_pool()` на shutdown.
- Middleware `access_log_and_limit` теперь `await write_log(...)` (раньше был sync вызов).

**`fot-data-api/app/routers/tables.py`:**
- `list_accessible_tables`, `get_table_access`, `execute_select` теперь awaited.

### README + DEPLOY
- `fot-data-api/README.md`: `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` → `DATABASE_URL`/`DATABASE_SSL`/`DATABASE_SSL_CA_PATH`. Раздел "Безопасность" обновлён: вместо "цепочка builder-методов supabase-py" — `psycopg.sql.Identifier` + параметры; добавлен раздел "Архитектура runtime (Phase 10G)".
- `DEPLOY.md` уже содержит `DATABASE_URL/DATABASE_SSL/DATABASE_SSL_CA_PATH` для `fot-data-api/.env` (обновлено в Phase 10E).

### Финальные grep + проверки

```
rg "supabase|SUPABASE|create_client|SUPABASE_URL|SUPABASE_SERVICE_ROLE_KEY" fot-data-api --glob '!**/__pycache__/**'
  → 3 совпадения в README.md, секция "Архитектура runtime — миграционная история".
  → 0 совпадений в коде (app/**) и конфиге.

cd fot-data-api; python -m compileall -q app → exit 0
```

### Готовность к Phase 11 (после 10G)
- ✅ Runtime fot-server без Supabase SDK (10E + 10F)
- ✅ Runtime fot-data-api без Supabase SDK (10G)
- ✅ Все active scripts на pg
- ✅ Build + tests + Python compile зелёные
- ✅ Env во всех подпроектах унифицирован: `DATABASE_URL`/`DATABASE_SSL`/`DATABASE_SSL_CA_PATH`

---

## Что переехало по RPC

| RPC | SQL | Phase |
|---|---|---|
| `replace_role_access_profile` | `SELECT public.replace_role_access_profile($1, $2::jsonb, $3::jsonb)` | 10A |
| `get_descendant_department_ids` | `SELECT id FROM public.get_descendant_department_ids($1::uuid[])` | 10A |
| `data_api_list_public_schema` | `SELECT … FROM public.data_api_list_public_schema()` | 10A |
| `batch_recalculate_skud_daily_summary` | `SELECT public.batch_recalculate_skud_daily_summary($1::jsonb)` | 10D |
| `find_direct_conversation` | `SELECT … FROM public.find_direct_conversation($1::uuid, $2::uuid)` | 10E |
| Sigur lease (`try_acquire`/`heartbeat`/`merge`/`release`) | `SELECT public.sigur_runtime_*($1, $2, …)` | 10D |


