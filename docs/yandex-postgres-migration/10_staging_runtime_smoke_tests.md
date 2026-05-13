# 10 — Staging runtime smoke tests (fot-server + fot-data-api)

После завершения Phase 11 (data + schema + auth + storage на target Yandex
Managed PG) нужно прогнать **runtime smoke tests** — поднять `fot-server` и
`fot-data-api` с target DSN, и проверить, что все 7 функциональных доменов
работают через новый стек.

Этот документ — checklist. Цель Phase 11B: получить заполненную таблицу
PASS/FAIL до перехода в Phase 12 (cutover).

## Подготовка окружения

### Прерывание production

⚠ **Эти smoke tests запускаются ПАРАЛЛЕЛЬНО с прод-Supabase**, не подменяя
её. Запускаем staging-стек на отдельной машине / отдельном порту, с target
DSN указанным на FOT_Prod. Это не cutover — это валидация.

### fot-server staging

`/path/to/staging/fot-server/.env`:

```dotenv
NODE_ENV=staging
PORT=3001

# ─── Database (Yandex Managed PG target) ────────────────────────────
DATABASE_URL=postgres://<user>:<password>@rc1d-<rest>.mdb.yandexcloud.net:6432/FOT_Prod?sslmode=verify-full&sslrootcert=/path/to/yandex-ca.pem
DATABASE_SSL=true
DATABASE_SSL_CA_PATH=/path/to/yandex-ca.pem
DATABASE_POOL_MAX=10
DATABASE_STATEMENT_TIMEOUT_MS=30000

# ─── Auth — preserve production values ──────────────────────────────
JWT_SECRET=<COPY FROM PROD .env — same value>
JWT_REFRESH_SECRET=<COPY FROM PROD .env — same value>
ENCRYPTION_KEY=<COPY FROM PROD .env — same value>
# Если изменить ENCRYPTION_KEY, существующие зашифрованные данные (TOTP,
# чат) расшифровать будет невозможно. JWT-аналогично — выпиленные на
# проде токены не пройдут.

# ─── Sigur — staging-safe ────────────────────────────────────────────
# В staging НЕ ходим на live Sigur по умолчанию: presence-polling может
# писать в target и захардкорить дубликаты SKUD-событий, которые потом
# поедут и в prod через тот же Sigur. Лочим hosts whitelist.
SIGUR_RUNTIME_ALLOWED_HOSTS=  # пусто = выключено
SIGUR_INTERNAL_URL=  # пусто
SIGUR_EXTERNAL_URL=  # пусто
# Если ДЕЙСТВИТЕЛЬНО хотим прогнать Sigur sync в staging — поднимаем
# отдельный read-only mirror Sigur API, и кладём sigur_runtime_state
# на target с уникальным lease_owner='staging-<machine>'.

# ─── Object storage (Yandex YOS или Cloud.ru — staging bucket) ──────
OBJECT_STORAGE_ENDPOINT=https://s3.cloud.ru
OBJECT_STORAGE_REGION=ru-central-1
OBJECT_STORAGE_ACCESS_KEY_ID=<staging key>
OBJECT_STORAGE_SECRET_ACCESS_KEY=<staging secret>
OBJECT_STORAGE_FORCE_PATH_STYLE=true
# ⚠ ОТДЕЛЬНЫЙ staging-бакет, не prod. Иначе uploads пойдут в prod-bucket.
# Если staging-бакет — копия prod, документы и карты будут доступны.

# CORS, Sentry, прочее — копировать с prod
CORS_ORIGIN=http://localhost:5173
SENTRY_DSN=  # пусто на staging (или отдельный staging DSN)
```

### fot-data-api staging

`/path/to/staging/fot-data-api/.env`:

```dotenv
DATABASE_URL=postgres://<user>:<password>@rc1d-<rest>.mdb.yandexcloud.net:6432/FOT_Prod?sslmode=verify-full&sslrootcert=/path/to/yandex-ca.pem
DATABASE_SSL=true
DATABASE_SSL_CA_PATH=/path/to/yandex-ca.pem
DATABASE_POOL_MAX=5
PORT=4001
DEFAULT_RATE_LIMIT_PER_MINUTE=60
```

### Запуск

```bash
# fot-server
cd /path/to/staging/fot-server
npm ci
npm run build
node dist/index.js   # или: npx tsx watch src/index.ts для dev-режима

# fot-data-api (отдельная shell)
cd /path/to/staging/fot-data-api
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4001
```

После старта проверить логи:

- `fot-server`: должен сообщить `listening on :3001`, без Sentry/DB errors.
- `fot-data-api`: должен сообщить `Uvicorn running on http://127.0.0.1:4001`.

## Smoke tests checklist

Заполнять по факту прогона. PASS / FAIL / SKIP / NOTES.

### Auth domain

| # | Тест | Шаги | Ожидание | Результат |
|---|---|---|---|---|
| A1 | Login существующим юзером без 2FA | POST `/api/auth/login` с email/password юзера, у которого 2FA выключен | 200, JWT в ответе, profile валиден | `<FILL>` |
| A2 | Login с 2FA | A1 → должен вернуть `requires_2fa=true`; затем POST `/api/auth/login-2fa` с TOTP-кодом | 200, JWT после второго шага | `<FILL>` |
| A3 | Login невалидным паролем | POST `/api/auth/login` с неправильным password | 401, audit_log с LOGIN_FAILED | `<FILL>` |
| A4 | Reset password (forgot flow) | POST `/api/auth/forgot-password` → проверить email → POST `/api/auth/reset-password` с токеном | password обновлён в `app_auth.users`; следующий login успешен | `<FILL>` |
| A5 | Register new user | POST `/api/auth/register` с `link_code` валидным | 200, new row в `app_auth.users`, `user_profiles` (pending=false для autoprovision) | `<FILL>` |

### Admin users / 2FA

| # | Тест | Ожидание | Результат |
|---|---|---|---|
| AU1 | GET `/api/admin/users` от system_admin | список users с email, position_type, is_approved | `<FILL>` |
| AU2 | Approve pending user | POST `/api/admin/users/:id/approve` | user.is_approved=true, audit_log USER_APPROVED | `<FILL>` |
| AU3 | Reject pending user | DELETE из app_auth.users + audit_log USER_REJECTED | `<FILL>` |
| AU4 | Admin setup TOTP for user | POST `/api/admin/users/:id/2fa/setup` → returns secret + QR | totp_secret в `user_profiles` зашифрован | `<FILL>` |
| AU5 | User self-setup 2FA | POST `/api/auth/2fa/setup` → enable | two_factor_enabled=true в user_profiles | `<FILL>` |

### Access / scope

| # | Тест | Ожидание | Результат |
|---|---|---|---|
| AC1 | Company-scoped admin видит только свои отделы | GET `/api/structure/departments` от admin с `user_company_access` | только subtree выбранной компании | `<FILL>` |
| AC2 | Direct reports | GET `/api/direct-reports?manager_employee_id=X` | список подчинённых | `<FILL>` |
| AC3 | Employee department access (HR) | GET `/api/admin/users/:id/department-access` | список department_id с source | `<FILL>` |
| AC4 | Role access pages | GET `/api/admin/roles` + `/api/admin/roles/:code/access` | system_roles + page_access | `<FILL>` |
| AC5 | RPC `get_descendant_department_ids` | через UI прогон или прямой SQL `SELECT id FROM public.get_descendant_department_ids(ARRAY['<root_uuid>']::uuid[])` | возвращает все потомки | `<FILL>` |

### Employees / structure

| # | Тест | Ожидание | Результат |
|---|---|---|---|
| E1 | GET `/api/employees?search=<name>&limit=20` | список с pagination, count window | `<FILL>` |
| E2 | GET `/api/employees/:id` | full employee + nested department | `<FILL>` |
| E3 | POST `/api/employees` (create) | new row + Sigur sync (если включён — в staging выключаем) | `<FILL>` |
| E4 | PUT `/api/employees/:id` | update + salary_history запись если salary поменялся | `<FILL>` |
| E5 | POST `/api/employees/:id/fire` (lifecycle) | employment_status=fired, employee_assignments closed | `<FILL>` |
| E6 | POST `/api/employees/:id/rehire` | employment_status=active, new assignment | `<FILL>` |
| E7 | GET `/api/structure/tree` | full department tree | `<FILL>` |

### Schedule / timesheet

| # | Тест | Ожидание | Результат |
|---|---|---|---|
| S1 | GET `/api/schedules/cycles` | список cycles, work_schedules nested | `<FILL>` |
| S2 | POST `/api/schedules/assignments/employee` | new employee_schedule_assignment + JSONB day_overrides | `<FILL>` |
| T1 | GET `/api/timesheet/:dept_id?from=&to=` | табель сотрудников с днями, hours | `<FILL>` |
| T2 | PUT `/api/timesheet/items/:id` (correction) | attendance_adjustments row + audit_logs | `<FILL>` |
| T3 | POST `/api/timesheet/export` | Excel-файл с timesheet | `<FILL>` |
| T4 | POST `/api/timesheet-approvals` (submit) | timesheet_approvals row, status='submitted' | `<FILL>` |
| T5 | POST `/api/correction-approvals/:id/approve` | status=approved, audit | `<FILL>` |
| T6 | POST `/api/timesheet/weekend-memo` | weekend_memo row, status updates | `<FILL>` |

### SKUD / Sigur

⚠ **Production-путь миграции `skud_events`: manual Sigur API backfill** (см. [09_skud_events_migration.md](09_skud_events_migration.md) § Selected option). DB-restore намеренно skipped — на target `public.skud_events` (parent + 19 партиций + quarantine) **пусто до backfill**.

| # | Тест | Ожидание (до Sigur backfill) | Результат |
|---|---|---|---|
| SK1 | GET `/api/skud/events?date=YYYY-MM-DD` | **LIMITED**: target.skud_events=0 → пустой список или 404 на дату | `<FILL>` |
| SK2 | GET `/api/skud/event-failures?date=` | populated (skud_event_failures мигрирован через pg_restore) | `<FILL>` |
| SK3 | GET `/api/skud/dashboard` | **LIMITED**: KPI основаны на skud_events → нулевые/пустые до backfill | `<FILL>` |
| SK4 | Presence-polling статус | `SELECT * FROM sigur_runtime_state` | в staging Sigur OFF → 5 lease-stubs без heartbeat (норма) | `<FILL>` |
| SK5 | Sigur sync guarded | POST `/api/sigur/sync` от admin | guard блокирует с явным сообщением | `<FILL>` |
| SK6 | Sigur runtime lease | `SELECT public.try_acquire_sigur_runtime_lease('test', 'me', 60, '{}'::jsonb)` | `true` (функция работает на target) | `<FILL>` |

#### После manual Sigur API backfill (mandatory verification)

Эти проверки **обязательны** перед production cutover, выполняются ПОСЛЕ запуска backfill-скрипта (`scripts/yandex-migration/backfill-skud-events-from-sigur.ts` — будет написан в Phase 12).

| # | Тест | Ожидание | Результат |
|---|---|---|---|
| SK-BF1 | `SELECT count(*) FROM public.skud_events WHERE event_date >= '<from>'` | >0, близко к source за тот же диапазон | `<FILL>` |
| SK-BF2 | События страница populated | GET `/api/skud/events?date=<вчера>` — список не пустой | `<FILL>` |
| SK-BF3 | Dashboard populated | GET `/api/skud/dashboard` — discipline/presence KPI ненулевые | `<FILL>` |
| SK-BF4 | Presence polling не падает | `sigur_runtime_state.heartbeat_at` обновляется (Sigur ON на prod) | `<FILL>` |
| SK-BF5 | Summary recalculation | `SELECT public.batch_recalculate_skud_daily_summary(...)` для backfill-диапазона, потом `SELECT count(*) FROM skud_daily_summary WHERE date BETWEEN ...` — >0, > zero до recalc | `<FILL>` |
| SK-BF6 | No duplicates | `SELECT event_date, count(*) - count(DISTINCT dedup_hash) AS dups FROM skud_events WHERE event_date >= '<from>' GROUP BY 1 HAVING count(*) - count(DISTINCT dedup_hash) > 0` — пусто | `<FILL>` |
| SK-BF7 | Sample by date+employee | 3-5 рандомных пар vs source (если ещё доступен) | `<FILL>` |
| SK-BF8 | Табель за период | Открыть HR-табель за период backfill, hours корректны | `<FILL>` |
| SK-BF9 | `verify-public-data` с acceptance | `SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true npm run migrate:yandex:verify-public` → exit 0, `skud_events_status=accepted_manual_backfill` | `<FILL>` |

### Files / storage

| # | Тест | Ожидание | Результат |
|---|---|---|---|
| F1 | Document upload | POST `/api/documents/upload` (file) | row в `documents`, файл в S3 | `<FILL>` |
| F2 | Document download | GET signed URL → fetch | OK, корректный MIME | `<FILL>` |
| F3 | Patent receipt upload | POST `/api/patent-receipts/upload` | encrypted fields в patent_payment_receipts | `<FILL>` |
| F4 | Patent receipt download | signed URL → fetch | расшифровка через encryptionService работает | `<FILL>` |
| F5 | Object map upload | POST `/api/skud-objects/:id/map/upload-url` → PUT file | row в `skud_objects.map_storage_path` + файл в bucket | `<FILL>` |
| F6 | Object map download | GET signed URL → fetch | картинка карты | `<FILL>` |

### Data API (fot-data-api)

| # | Тест | Команда | Ожидание | Результат |
|---|---|---|---|---|
| D1 | Health | `curl http://localhost:4001/external/v1/health` | `{"ok":true}` | `<FILL>` |
| D2 | Auth missing | `curl http://localhost:4001/external/v1/tables` (без Bearer) | 401 Missing Authorization | `<FILL>` |
| D3 | Auth invalid | `curl -H 'Authorization: Bearer foo' http://localhost:4001/external/v1/tables` | 401 Invalid token format | `<FILL>` |
| D4 | Tables list | `curl -H 'Authorization: Bearer fot_<prefix>_<secret>' http://localhost:4001/external/v1/tables` | list of `{table_name, allowed_fields[]}` | `<FILL>` |
| D5 | Schema | `... /external/v1/tables/<name>/schema` | список fields | `<FILL>` |
| D6 | Read with filter | `... /external/v1/tables/employees?eq.id=1&limit=5` | строки только с разрешёнными полями | `<FILL>` |
| D7 | Forbidden field | `... /external/v1/tables/employees?eq.encrypted_field=X` | 400 "Field not allowed" | `<FILL>` |
| D8 | Forbidden table | `... /external/v1/tables/employees_secret` | 404 | `<FILL>` |
| D9 | Rate limit | 100 запросов за минуту | 429 после превышения per-key лимита | `<FILL>` |
| D10 | Request log | `SELECT * FROM data_api_request_logs ORDER BY created_at DESC LIMIT 5` | строки логов с key_id, status_code, latency_ms | `<FILL>` |

## Финальная сводка

После прохождения всех smoke tests:

| Домен | PASS | FAIL | SKIP | Decision |
|---|---:|---:|---:|---|
| Auth | / | / | / | `<FILL>` |
| Admin users / 2FA | / | / | / | `<FILL>` |
| Access / scope | / | / | / | `<FILL>` |
| Employees / structure | / | / | / | `<FILL>` |
| Schedule / timesheet | / | / | / | `<FILL>` |
| SKUD / Sigur | / | / | / | `<FILL>` |
| Files / storage | / | / | / | `<FILL>` |
| Data API | / | / | / | `<FILL>` |

**Условие готовности к Phase 12:**
- Auth: все 5 тестов PASS.
- Admin users / 2FA: AU1–AU5 PASS.
- Access / scope: AC1–AC5 PASS.
- Employees / structure: E1–E7 PASS (E3 может SKIP если Sigur выключен).
- Schedule / timesheet: T1–T6 PASS.
- SKUD / Sigur: SK1–SK6 — допустим SKIP на SK4–SK6, если Sigur off в staging.
- Files / storage: F1–F6 PASS.
- Data API: D1–D10 PASS.

Если хоть один critical-домен FAIL — фиксим, перезапускаем, не идём
в Phase 12 (cutover).

## Финальная подпись

Оператор: `<FILL_name>`
Дата прогона: `<FILL_YYYY-MM-DD>`
Версия fot-server: `<FILL_git_sha>`
Версия fot-data-api: `<FILL_git_sha>`
Окружение: staging machine `<FILL_host>`
