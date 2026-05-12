# 01 — Восстановление runtime-функций

## Status: реализовано

Тела **4 runtime-функций + 1 helper-зависимости** (итого 5 функций)
**выгружены из боевой Supabase** (project `gxbtsnhevhlvmlvvqqqp` "FOT",
PG 17.6) через `pg_get_functiondef(oid)` и вставлены в
[`docs/migrations/087_recover_runtime_functions.sql`](../migrations/087_recover_runtime_functions.sql).

Дата выгрузки: **2026-05-12** через MCP-инструмент `mcp__claude_ai_Supabase__execute_sql`.

## Терминология: runtime vs helper

Preflight (`preflight-yandex-db.ts`) и transform (`prepare-yandex-schema.mjs`)
проверяют **12 функций** в `public`, обязательных для работы кластера:

- **11 runtime-функций** — вызываются непосредственно из бэкенда (Node.js
  через `service-role` клиент или RPC). Сигнатуры зафиксированы в коде.
- **1 helper-зависимость** — `recalculate_skud_daily_summary(uuid, bigint, date)`:
  бэкенд её **не вызывает напрямую**, но она используется внутри тела
  `batch_recalculate_skud_daily_summary(jsonb)`. Без неё runtime-функция №2
  упадёт при первом вызове.

Из 12 проверяемых функций — **7 уже есть в `docs/migrations/001-086`**
(`get_descendant_department_ids`, `is_admin`, etc.), а **5 жили только
в production** и собраны в 087.

## Зачем

Source-side диагностика (см.
[`STAGING_REHEARSAL_REPORT.md`](STAGING_REHEARSAL_REPORT.md) Finding 1)
подтвердила: 4 runtime-функции + 1 helper, которые активно используются
бэкендом (напрямую или транзитивно), никогда не были закоммичены в
`docs/migrations/001-086`. Они жили только в production. На свежем
чистом target без 087 кластер не сможет работать.

| Функция | Категория | Используется в | Что упадёт без неё |
|---|---|---|---|
| `recalculate_skud_daily_summary(uuid, bigint, date)` | **helper** | вызов из тела `batch_recalculate_skud_daily_summary` | runtime-функция №2 упадёт при первом тике |
| `batch_recalculate_skud_daily_summary(jsonb)` | runtime | presence-polling каждые 30-60 сек; импорт СКУД (4 точки); sigur-sync-events; scripts | пересчёт `skud_daily_summary` |
| `bulk_update_employee_ids(bigint[], bigint[])` | runtime | skud-backfill, skud-shared | backfill `employee_id` в `skud_events` |
| `find_skud_duplicate_ids()` | runtime | skud-import | дедупликация СКУД-событий по `dedup_hash` |
| `find_direct_conversation(uuid, uuid)` | runtime | chat.service.ts | поиск/создание 1:1-беседы |

## Структура 087

Файл [`docs/migrations/087_recover_runtime_functions.sql`](../migrations/087_recover_runtime_functions.sql)
содержит:

1. **5 `CREATE OR REPLACE FUNCTION` блоков** с реальными телами из production
   — никаких TODO/placeholder. Порядок: helper первый, batch вторым, далее
   остальные. Все объявления внутри `BEGIN; ... COMMIT;`.
2. **Active preflight `DO $$ ... $$`** в конце файла, который падает с
   `RAISE EXCEPTION`, если:
   - хоть одна из 5 функций отсутствует;
   - тело содержит `TODO_REAL_BODY_NOT_INSERTED` sentinel;
   - тело содержит `RAISE EXCEPTION 'not implemented'`;
   - SECURITY DEFINER функция не имеет `SET search_path` в `proconfig`.

## Свойства функций из production

| Function | LANGUAGE | SECURITY DEFINER | SET search_path | Сигнатура |
|---|---|---|---|---|
| `recalculate_skud_daily_summary` | plpgsql | ✓ | `public, pg_catalog` | `(p_organization_id uuid, p_employee_id bigint, p_date date) RETURNS void` |
| `batch_recalculate_skud_daily_summary` | plpgsql | ✓ | `public, pg_catalog` | `(p_pairs jsonb) RETURNS void` |
| `bulk_update_employee_ids` | plpgsql | ✓ | `public, pg_catalog` | `(p_event_ids bigint[], p_employee_ids bigint[]) RETURNS void` |
| `find_skud_duplicate_ids` | sql STABLE | invoker | `public, pg_catalog` | `() RETURNS TABLE(id bigint)` |
| `find_direct_conversation` | sql STABLE | invoker | `public, pg_catalog` | `(user1 uuid, user2 uuid) RETURNS TABLE(conversation_id uuid)` |

Все 5 имеют `SET search_path` — preflight `convalidated`.

## Known production quirk

`batch_recalculate_skud_daily_summary(p_pairs jsonb)` ожидает в каждом
объекте 3 поля: `org_id` (uuid), `emp_id` (bigint), `date` (date).
Бэкенд (`fot-server/src/services/presence-polling.service.ts:844` и др.)
передаёт `{ emp_id, date }` БЕЗ `org_id`. В итоге
`p_organization_id` поступает в `recalculate_skud_daily_summary` как `NULL`.

В теле `recalculate_skud_daily_summary` (см. 087, блок 1) `p_organization_id`
**не используется** ни в `WHERE`, ни в `INSERT`. Параметр фактически
dead. Поведение унаследовано из production «как есть»; рефакторинг
сигнатуры — отдельная задача, **не миграционный шаг**.

## Воспроизводство выгрузки (для следующих итераций)

Если потребуется заново снять тела или сверить состояние:

```sql
-- Запрос на боевой Supabase / staging:
SELECT
  p.proname,
  pg_get_functiondef(p.oid) AS def,
  p.prosecdef AS security_definer,
  p.proconfig AS proconfig
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN (
    'recalculate_skud_daily_summary',
    'batch_recalculate_skud_daily_summary',
    'bulk_update_employee_ids',
    'find_skud_duplicate_ids',
    'find_direct_conversation'
  )
ORDER BY p.proname, p.oid::regprocedure::text;
```

Сравнить полученные `def` с теми, что в 087. Если код в production
изменился — обновить 087, прогнать `npm run build`, прокатить через
staging.

## Применение

```bash
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/migrations/087_recover_runtime_functions.sql
```

При штатном пути миграции (через `pg_dump --schema-only` Supabase →
`prepare-yandex-schema.mjs` → apply), 087 **уже фактически не нужен**:
все 5 функций есть в source dump'е и попадут в `yandex_schema.sql`.
087 ценен в двух случаях:

1. Свежий Yandex кластер из version-controlled миграций (без dump'а)
   — 087 обязателен.
2. Schema drift recovery: одна из 5 функций изменилась в production
   и отстала от version-controlled определения — 087 переустанавливает
   каноническую версию.

## Verification

После применения 087 запустить:

```bash
cd fot-server
npm run migrate:yandex:preflight
```

`preflight-yandex-db.ts` группа `functions` проверит все 12 функций
(11 runtime + 1 helper), включая эти 5 из 087. Все должны быть `✓`.
В detail-строке helper-функции preflight выведет пометку
«helper — DB-internal dependency of `batch_recalculate_skud_daily_summary`».

## Связанные документы

- [`STAGING_REHEARSAL_REPORT.md`](STAGING_REHEARSAL_REPORT.md) Finding 1 —
  подтверждение источника тел из production.
- [`00_inventory_v2.md`](00_inventory_v2.md) §7 — историческая запись
  про missing functions (теперь устаревший раздел, поскольку решено
  через 087).
