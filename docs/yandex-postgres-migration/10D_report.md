# Phase 10D report — SKUD + Sigur + presence-polling

**Дата:** 2026-05-12
**Скоуп:** ingestion СКУД-событий, Sigur runtime (sync структуры, мониторинг), кэш-карты, presence-polling.
**Файлов:** 21 (SKUD services 9 + SKUD controllers 3 + Sigur services 7 + Sigur controllers 4 + presence-polling 1, минус 3 за счёт совмещения).

## Что сделано

### SKUD services
- `services/skud-shared.service.ts`: pure DB helpers (`collectDeptIds`, `getEmployeeIdsForDeptScope`). Полностью `query/queryOne`.
- `services/skud-backfill.service.ts`: batch backfill `skud_daily_summary` через `INSERT ... ON CONFLICT`.
- `services/skud-summary-reconcile.service.ts`: RPC `batch_recalculate_skud_daily_summary($1::jsonb)` через `queryOne` + `withSupabaseSlot` semaphore.
- `services/skud-import.service.ts`: bulk-insert `skud_events` в партиционированную таблицу. Dedup по UNIQUE `(dedup_hash, event_date)`.
- `services/skud-presence.service.ts`: сводки + кэш-TTL сохранены.
- `services/skud-discipline.service.ts`: pure SELECT + aggregation.
- `services/skud-dashboard.service.ts`: KPI-агрегации.
- `services/skud-travel.service.ts`: travel-сегменты + маппинги объектов. `r2Service` для скриншотов карт.
- `services/skud-travel-routes.service.ts`: маршруты + travel-объекты.

### SKUD controllers
- `controllers/skud.controller.ts`: эндпоинты dashboard/discipline/import.
- `controllers/skud-write.controller.ts`: мутации `markPresence`/`addCard` в `withTransaction`.
- `controllers/skud-travel.controller.ts`: travel CRUD + map upload.

### Sigur services
- `services/sigur-runtime-state.service.ts`: lease функции (`try_acquire`/`heartbeat`/`merge`/`release`) через `SELECT public.sigur_runtime_*(...)`.
- `services/sigur-monitor.service.ts`: health-checks + incidents (`sigur_health_checks`, `sigur_incidents`); missing-table guard PG `'42P01'`.
- `services/sigur-linked-employees.service.ts`: UPSERT привязок sigur_employee_id ↔ employee_id.
- `services/sigur-sync-shared.service.ts`: общие helpers (id resolution, batching).
- `services/sigur-sync-structure.service.ts`: departments/positions из Sigur API → БД; partial-response handling сохранён.
- `services/sigur-sync-employees.service.ts`: employees diff + apply.
- `services/sigur-sync-events.service.ts`: события за день — incremental import.
- `services/sigur-access-point-meta.service.ts`: access point metadata cache.

### Sigur controllers
- `controllers/sigur.controller.ts`, `sigur-sync.controller.ts`, `sigur-card-reader.controller.ts`, `sigur-filter.controller.ts`: admin endpoints на `query/queryOne/execute`.

### Presence polling
- `services/presence-polling.service.ts`: incremental polling по `lastId` (cursor seek). `withSupabaseSlot` сохранён как semaphore (имя `supabase-instrumentation.ts` оставлено под отдельную задачу-переименование).

## Ключевые решения
- Все «горячие» RPC (lease, batch_recalculate, get_descendant) — через `withSupabaseSlot`: семафор не даёт presence-polling забить pool.
- Missing-table guard переключён с `'PGRST205'` (Supabase REST) на PG `'42P01'` (undefined_table). Поведение на свежих БД идентичное; на старых клонах без миграции 015 warning отрабатывает так же.
- Партиции `skud_events_YYYYMM` — отдельных проверок не вводим. Missing-partition → стандартный PG error, ловится в `try/catch` импорт-флоу.
- Sigur lease-функции вызываются строго `SELECT public.fn($1, $2, $3)` (см. `docs/yandex-postgres-migration/087-..-recover-runtime-functions.sql`).

## object-map-storage
В рамках 10D введён `services/object-map-storage.service.ts` (S3 SDK напрямую) как замена `supabase-storage.service.ts`. Все потребители (`skud-travel.service.ts`) переключены. Старый файл удалён в Phase 10E.

## Verification
- `Grep "await supabase|supabase\\."` в скоупе → 0 совпадений.
- `cd fot-server; npm run build` → exit 0.
- Sigur sync- и SKUD-импорт-логика покрыта существующими тестами (мокаются через `vi.mock('../config/postgres.js')` — паттерн отработан).
