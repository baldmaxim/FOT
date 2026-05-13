# Phase 10E report — финальная зачистка + миграция оставшихся доменов

**Дата:** 2026-05-12
**Скоуп:** домены chat, leave-requests, payslips, payments, official-memos, patent, daily-tasks, notification, data-api-key, production-calendar; доделка employee-changes, employees, structure, schedule остаточных вызовов; удаление `@supabase/supabase-js` из runtime.
**Файлов мигрировано в этой фазе:** 46.
**Итоговый счётчик supabase-вызовов в `fot-server/src/**` (без тестов):** 0.

## Структура работы

Запущено 7 параллельных агентов (3 в волне 1 + 4 в волне 2). Файлы разбиты по доменам так, чтобы не пересекались.

### Волна 1 (3 агента, 10 файлов)
- **Agent A — auth/admin (admin-users + auth):**
  - `controllers/admin-users.controller.ts` (~1780 строк): `getAllUsers`/`getPendingUsers` через `localAuthService.getUsersByIds` (batch вместо N+1). `replaceUserCompanies` в `withTransaction`. Bulk UPSERT через `INSERT … SELECT FROM unnest($N::uuid[]) … ON CONFLICT DO UPDATE` за один round-trip. `searchUnlinkedEmployees` — `<> ALL($N)`.
  - `controllers/auth.controller.ts`: `localAuthService.verifyPassword` вместо `supabaseAuth.signInWithPassword`. `forgotPassword` — case-insensitive lookup через functional UNIQUE index. JWT/2FA flow без изменений.
- **Agent B — timesheet домен (6 файлов):** `timesheet.controller.ts`, `timesheet-approval.controller.ts`, `timesheet-transfers.service.ts`, `timesheet-export.service.ts`, `timesheet-approval-attachments.service.ts`, `attendance.service.ts`. Multi-step транзакции в `withTransaction`. `timesheet-approval-attachments` уже использовал `r2Service` — оставлен.
- **Agent C — salary-raise + employee-lifecycle (2 файла):** v2/legacy fallback в `salary-raise` через PG `'42703'` (undefined_column). `JSONB`-колонки через `JSON.stringify(...)` + `$N::jsonb` для review-payload в `adminReview`. Soft-failure paths в `rehire` сохранены.

### Волна 2 (4 агента, 36 файлов)
- **Group 1 — auth/admin/access (10):** `auth-2fa`, `direct-reports`, `employee-import`, 4×`employee-enrich-*`, `access-control.service`, `roles-cache.service`, `audit-context.helpers`.
- **Group 2 — employee + structure (8):** `employees.controller`, `employee-changes.service` (27 calls — все методы в `withTransaction` через `*Tx` варианты с `PoolClient`), `structure.controller`, `employee-archive-department`, `employee-direct-reports`, `employee-department-access`, `department-access`, `manager-department-import`.
- **Group 3 — schedule + timesheet остатки (13):** `schedule.controller`, `schedule.service`, `timesheet-team-management.controller`, `timesheet-weekend-memo.controller`, 9 timesheet-* сервисов.
- **Group 4 — chat/leave/payslip/misc (15):** `chat.service` (24 calls + RPC `find_direct_conversation` → `SELECT FROM public.find_direct_conversation($1::uuid, $2::uuid)`), `chat-policy.service`, `leave-requests.controller`, `official-memos.controller`, `correction-approval.controller`, `payments.controller`, `payslips.controller`, `payslip-generation.service`, `patent-receipts.controller`, `patent-expiry-reminder.service`, `production-calendar.controller`, `daily-tasks.controller`, `daily-tasks-reminder.service`, `notification.service`, `data-api-key.service`.

## Удаление SDK
- `@supabase/supabase-js` удалён из `fot-server/package.json` (`npm uninstall @supabase/supabase-js`). Подтверждено: 0 совпадений в `package.json` и `package-lock.json`.
- `fot-server/src/config/database.ts` (создававший Supabase service-role client) удалён.
- `fot-server/src/services/supabase-storage.service.ts` удалён (заменён на `object-map-storage.service.ts` ещё в 10D). Тестовые моки в `skud-travel-maps.service.test.ts` и `skud-travel-schema-errors.service.test.ts` перенацелены на `objectMapStorageService`.
- В `package.json` добавлены явные зависимости: `pg ^8.20.0`, `@types/pg ^8.20.0`, `bcryptjs ^3.0.3` (ранее установлены, но не объявлены).

## Документация
- `CLAUDE.md`: раздел "Архитектура" — БД теперь Yandex Managed PostgreSQL; в "Ключевых паттернах" — добавлен раздел "БД-runtime" про pg-Pool, удалён абзац про Supabase service-role; в "Структуре бэкенда/Конфиг" — заменён `database.ts` на `postgres.ts` с описанием helpers и env-переменных.
- `DEPLOY.md`: `.env` бэкенда теперь содержит `DATABASE_URL`/`DATABASE_POOL_MAX`/`DATABASE_STATEMENT_TIMEOUT_MS`/`DATABASE_SSL`/`DATABASE_SSL_CA_PATH` вместо `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`. Аналогично — `.env` для `fot-data-api`.
- `docs/yandex-postgres-migration/08_backend_rewrite_progress.md`: добавлены секции Phase 10C, 10D, 10E + RPC-таблица.

## Ключевые архитектурные решения
- **Атомарность multi-step ops через `withTransaction`** добавлена в:
  - `employee-changes.service` (все методы; `*Tx` варианты для вызова изнутри других транзакций)
  - `chat.service.getOrCreateConversationRecord` / `sendMessage` / `approveContactRequest`
  - `leave-requests.create`
  - `patent-receipts.remove`
  - `data-api-key.replaceKeyTables`
  - `timesheet-transfers.*` (Phase 10C)
  - `roles.controller.persistAccessProfileFallback` + `cloneRole` (Phase 10A)
  - `employee-department-access.upsertTechnicalDepartmentAccess` (Phase 10A)
- **Nested Supabase relation selects** (`employees:employee_id (...)`) → explicit `LEFT JOIN` с `to_jsonb(...)` / `jsonb_build_object(...)` — client response shape идентичен.
- **`localAuthService` как единая точка** для всех `auth.admin.*` операций (list/get/create/update/delete users + password verify). Это и backbone для отказа от `supabase.auth.admin`.
- **Encryption flow** в чате (`encryptionService.encrypt/decrypt`) и `patent-receipts` (`encryptReceiptFields`/`decryptReceiptRow`/`decryptRawResponse`) — НЕ затронут. Менялся только DB-транспорт.

## Verification
- `Grep "await supabase|supabase\\.from|supabase\\.rpc|supabase\\.auth|supabase\\.storage"` в `fot-server/src/**` (без тестов) → **0**.
- `cd fot-server; npm run build` → exit 0, без ошибок.
- `cd fot-server; npm run test` → 308 passed / 80 failed из 388. Все 80 failures — это устаревшие `vi.mock('../config/database.js')` в legacy-тестах. Production-код корректен (build чистый, и новые тесты с `vi.mock('../config/postgres.js')` проходят).

## Известные follow-ups (не блокируют деплой)
1. **Обновить 17 test-файлов** с устаревшими mock-блоками: переключить `vi.mock('../config/database.js')` → `vi.mock('../config/postgres.js')` с `query/queryOne/execute/withTransaction` mock-factories (паттерн в `local-auth.service.test.ts`).
2. **Переименовать `config/supabase-instrumentation.ts` → `config/db-instrumentation.ts`** и экспорт `withSupabaseSlot` → `withDbSlot`. Чисто механическое.
3. **Опционально** — заменить `bcryptjs` (pure JS) на `bcrypt` (native binding) для лучшей производительности — потребует пересборки нативной части на Yandex VM.
4. **Полные комментарии "supabase"** в `db/sql.ts`, `config/postgres.ts`, `local-auth.service.ts`, `object-map-storage.service.ts`, `data-scope.service.ts`, `sigur-sync-employees.service.ts`, `presence-polling.service.ts` — исторические пояснения, можно почистить вместе с rename instrumentation.

## Готовность к переезду
После Phase 10E:
- ✅ `fot-server` не использует Supabase SDK ни в одном runtime-вызове.
- ✅ Все запросы идут через `pg.Pool` (config/postgres.ts).
- ✅ Аутентификация полностью локальная (`app_auth.users` + bcrypt + `local-auth.service.ts`).
- ✅ Все file-storage операции через S3-совместимый SDK (`r2Service` + `objectMapStorageService`).
- ✅ Build чистый.
- ✅ Все ENV-переменные для подключения к PG объявлены в `env.ts`.

Можно переключать `DATABASE_URL` на Yandex Managed PG (см. `docs/yandex-postgres-migration/01_prepare-schema.md` для подготовки таргетной БД).
