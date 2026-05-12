# 07 — `skud_event_failures`: production parity + optional repartition

## Source-side факт (2026-05-12)

Производственная Supabase (`gxbtsnhevhlvmlvvqqqp`, PG 17.6) на момент
source-side диагностики содержит:

| Поле | Значение |
|---|---|
| `public.skud_event_failures.relkind` | `r` (обычная таблица) |
| Партиций attached | **0** (это не partitioned-таблица) |
| Размер | **50,422 rows** |

Это **расходится** с двумя другими source-of-truth:

- [`00_inventory_v2.md`](00_inventory_v2.md) §1.1 описывает таблицу как
  «`skud_event_failures` — партиции по `event_date`».
- [`docs/migrations/085_skud_event_failures.sql`](../migrations/085_skud_event_failures.sql)
  судя по namingу, создаёт партиционированную таблицу.

Скорее всего одна из миграционных правок «откатила» партиционирование,
или 085 в исполнении был адаптирован вручную. Восстановить ретроспективно
точную причину разойдения — отдельная задача (`git log` + `pg_dump`
production со сравнением); здесь зафиксирован **текущий факт**.

## Решение во время cutover: production-parity

Во время миграции на Yandex мы **сохраняем shape source**:
плоская таблица копируется как плоская таблица. Это даёт:

- Schema-only dump из source отрабатывает штатно (нет `PARTITION BY`,
  нет `ATTACH PARTITION`).
- `prepare-yandex-schema.mjs` не нужно ничего особенного делать —
  таблица проходит как обычный CREATE TABLE в pre-data.
- Restore данных в одну плоскую таблицу проходит быстрее, чем в N
  партиций (нет partition-routing на каждой строке).
- На POST-стадии нет `ATTACH PARTITION` для этой таблицы — это
  ожидаемо.
- Все 50,422 row'ов лежат в одной таблице с обычными индексами и FK
  (если есть) — поведение приложения не меняется.

Это безопасный путь cutover. Repartition при необходимости — отдельная,
изолированная задача после переключения.

## preflight policy

[`preflight-yandex-db.ts`](../../fot-server/scripts/yandex-migration/preflight-yandex-db.ts)
учитывает parity:

| Проверка | skud_events | skud_event_failures |
|---|---|---|
| `missing` | **critical fail** | **critical fail** |
| `plain` (relkind=r) | **critical fail** (теряем масштабирование) | **warning** (production-parity) |
| `partitioned` + 0 partitions | **critical fail** | **critical fail** |
| `partitioned` + ≥1 partition | **ok** | **ok** |

В JSON-отчёте каждая проверка отдаёт `sample` с полями
`skud_event_failures_shape` (`"plain"|"partitioned"|"missing"`) и
`skud_event_failures_partition_count`. Аналогично для `skud_events`
поля `shape` / `partition_count` в `sample`. В MD-отчёте они
рендерятся блоком «samples» под таблицей категории `data`.

## Optional post-cutover план: repartition

Когда захочется привести target к ожидаемому partitioned-state — это
делается **отдельно**, после стабилизации работы бэкенда на Yandex.
Ниже — план, без автоматизации (вмешательство в живые данные требует
ручного контроля).

### Pre-conditions

- Бэкенд работает на новом кластере ≥ 24 часа без critical-инцидентов.
- Свежий бэкап target (`pg_dump --format=custom --schema=public --table='skud_event_failures*'`).
- Согласован maintenance window: 5–30 минут зависит от размера. На 50k
  rows — минута; через год может быть 5M → 5 минут.
- Решён диапазон партиционирования: по `event_date` (как у `skud_events`)
  или по месяцам/кварталам. **Должен совпадать** с диапазоном
  `skud_events`, чтобы JOIN'ы были partition-wise.

### Шаги (не автоматизируем)

1. **Создать новую партиционированную таблицу** под другим именем
   ```sql
   CREATE TABLE public.skud_event_failures_new (
     -- те же колонки и типы, что в текущей skud_event_failures;
     -- посмотреть точные defaults/NOT NULL/CHECK через:
     --   \d+ public.skud_event_failures
   ) PARTITION BY RANGE (event_date);
   ```
2. **Создать партиции** под текущий диапазон данных + запас на 12-24
   месяца вперёд (по неделе/месяцу/кварталу — на ваше усмотрение).
   Каждая партиция:
   ```sql
   CREATE TABLE public.skud_event_failures_2026_01
     PARTITION OF public.skud_event_failures_new
     FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
   ```
3. **Копировать данные в батчах**. Не одним INSERT — он залочит таблицу
   на минуты:
   ```sql
   -- пакетами по дате, можно параллелить
   INSERT INTO public.skud_event_failures_new
   SELECT * FROM public.skud_event_failures
   WHERE event_date >= '2026-01-01' AND event_date < '2026-02-01';
   ```
   После каждого батча — `VACUUM ANALYZE` новой партиции.
4. **Сверить counts**:
   ```sql
   SELECT
     (SELECT count(*) FROM public.skud_event_failures)     AS old,
     (SELECT count(*) FROM public.skud_event_failures_new) AS new_;
   -- old должен быть == new_, иначе пересчитать недостающие батчи
   ```
5. **Перенести FK + indexes + triggers** на новую таблицу. Для каждого
   объекта в `\d+ public.skud_event_failures` создать аналог на
   `_new` (с теми же опциями).
6. **Maintenance window — swap names в одной транзакции**:
   ```sql
   BEGIN;
   ALTER TABLE public.skud_event_failures      RENAME TO skud_event_failures_old;
   ALTER TABLE public.skud_event_failures_new  RENAME TO skud_event_failures;
   COMMIT;
   ```
7. **Smoke test приложения** — несколько секунд для проверки, что
   `SELECT/INSERT` идут штатно.
8. **Drop old** (после убедительности):
   ```sql
   DROP TABLE public.skud_event_failures_old;
   ```
9. **Обновить preflight** — снять warning. Можно либо изменить policy в
   [`preflight-yandex-db.ts`](../../fot-server/scripts/yandex-migration/preflight-yandex-db.ts)
   (поднять `skud_event_failures plain shape` до critical), либо
   удалить эту страницу из `00_inventory_v2.md` как «расхождение».

### Rollback plan

Если на шаге 7 что-то пошло не так:
```sql
BEGIN;
ALTER TABLE public.skud_event_failures      RENAME TO skud_event_failures_failed;
ALTER TABLE public.skud_event_failures_old  RENAME TO skud_event_failures;
COMMIT;
DROP TABLE public.skud_event_failures_failed;
```

Старая плоская таблица возвращается в работу, новая откидывается.

## Не автоматизируем — почему

- **Live data**, INSERT'ы могут приходить во время repartition. Без
  application-level паузы или advisory lock'а есть риск потерять часть
  записей. Скрипт это безопасно не сделает.
- **Решение partition-range** зависит от ваших окон отчётности — нужно
  человеческое решение (неделя/месяц/квартал).
- **Версии PostgreSQL и Yandex-специфичные ограничения** на DDL могут
  блокировать одну из команд — лучше отлавливать в SQL Editor, чем
  автоматически.

Эта страница — **runbook**, не CI-задача. Запускается рукой по решению
команды.
