# 09 — Миграция `public.skud_events` (1.7M+ rows)

> Этот документ описывает план миграции **`public.skud_events`** и его 19 партиций (`skud_events_2026_01` ... `skud_events_2028_h2` + `skud_events_quarantine`) из source Supabase в target Yandex Managed PG.
>
> В Phase 11 staging rehearsal `skud_events*` были **исключены** из `pg_dump` через `--exclude-table='public.skud_events*'`, потому что AWS NLB перед Supabase pooler рвёт TCP-сессию после ~3-5 мин активного COPY (даже с TCP keepalive), а partitioned-таблица не может быть выгружена за такое окно single-file pg_dump'ом.
>
> Структура target уже подготовлена корректно: parent `skud_events` (partitioned), 19 child partitions ATTACH'нуты в шаге 10 (apply POST schema), индексы и FK на месте, sequences aligned. Нужны только данные.

---

## ✅ Selected option (final, locked 2026-05-13)

**Вариант C — Sigur API manual backfill.** Принят как production-путь.

- Chunked DB-migration (вариант B / [`migrate-skud-events-chunked.ts`](../../fot-server/scripts/yandex-migration/migrate-skud-events-chunked.ts)) остаётся **safety net**, а не основной путь — запускается только если Sigur API окажется недоступен или retention окажется меньше нужного диапазона.
- DB-route A (Supabase IPv4 add-on + per-partition pg_dump) не используется — расходы $4/мес ради разового мероприятия, добавление зависимости от Supabase live во время cutover, и pg_dump через pooler всё равно нестабилен для 1.7M rows.

### Причина выбора

- **1.7M+ строк не вмещаются в одну `COPY`-сессию** через Supabase pooler (AWS NLB рвёт TCP после 3-5 мин активной передачи; ни keepalive, ни parallel `--jobs=2` не помогли — проверено в Phase 11 шаге 8, см. STAGING_REHEARSAL_REPORT § Phase 11 § Шаг 8).
- Sigur API уже подключён к runtime через `presence-polling.service` и умеет вытягивать события за произвольный диапазон с тем же `computeDedupHash`, что и оригинальная запись.
- Структура target уже корректна — таблицы и партиции созданы и ATTACH'нуты в Phase 11 шаге 10. Нужны только данные, и Sigur — авторитетный источник.

### Accepted risks / assumptions

| # | Риск | Mitigation / accepted reason |
|---|---|---|
| 1 | **Не byte-for-byte migration**: `created_at` будет moment cutover (а не время первой записи в Supabase), `employee_id` резолвится через актуальный `sigur_linked_employees` map | Принято: для табелей это не критично (агрегация по employee_id+event_date). `created_at` исторически использовался только для дедупликации, а её обеспечивает `dedup_hash`. |
| 2 | **Sigur retention** обычно 1-3 года; события старше retention в backfill не попадут | Принято: основная польза от skud_events — последние 2-3 месяца (свежие табели). Старые табели уже подписаны и не пересчитываются. |
| 3 | **`skud_events_quarantine` партиция** (3 строки, события с неклассифицируемой direction) не покрывается backfill | Принято: 3 строки можно перенести вручную SQL'ом, если нужны; либо forfeit как малозначимые. |
| 4 | **Sigur API rate limits** + риск нагрузить prod Sigur во время cutover | Mitigation: backfill отдельным скриптом с rate-limit (1 запрос/сек), chunked по дням, исполняется в low-traffic окно (вечер/выходной). |
| 5 | **Возможна потеря событий** между snapshot Supabase и start backfill (≤ 1 час) | Mitigation: запускать backfill **после** того, как runtime fot-server на target начнёт свой presence-polling (он закроет gap). |
| 6 | **Дубликаты** при backfill (если Sigur вернёт уже существующий event) | Mitigation: UNIQUE constraint `(dedup_hash, event_date)` блокирует дубликаты на target. Backfill использует тот же `computeDedupHash`. |

### Verification после backfill (обязательно)

После прогона `backfill-skud-events-from-sigur.ts` оператор **обязан** выполнить:

```sql
-- 1. Count events по дням
SELECT event_date, count(*) AS events
  FROM public.skud_events
 WHERE event_date BETWEEN '<from>' AND '<to>'
 GROUP BY event_date
 ORDER BY event_date;

-- 2. Count UNIQUE dedup_hash по дням (должен равняться count(*) — дубликатов нет)
SELECT event_date,
       count(*) AS events,
       count(DISTINCT dedup_hash) AS distinct_hashes,
       count(*) - count(DISTINCT dedup_hash) AS dup_count
  FROM public.skud_events
 WHERE event_date BETWEEN '<from>' AND '<to>'
 GROUP BY event_date
 ORDER BY event_date;

-- 3. Sample check: 3-5 случайных дат × несколько сотрудников
SELECT employee_id, event_at, access_point, direction
  FROM public.skud_events
 WHERE event_date = '<random_date>'
   AND employee_id IN (<3-5 рандомных>)
 ORDER BY employee_id, event_at;

-- 4. Пересчёт skud_daily_summary для affected (employee_id, event_date) пар
SELECT public.batch_recalculate_skud_daily_summary(
  (SELECT jsonb_agg(jsonb_build_object('employee_id', employee_id, 'date', event_date))
     FROM (SELECT DISTINCT employee_id, event_date FROM public.skud_events
            WHERE event_date BETWEEN '<from>' AND '<to>'
              AND employee_id IS NOT NULL) t)
);

-- 5. Compare skud_daily_summary totals
SELECT date,
       count(*) AS rows,
       sum(total_hours) AS sum_hours,
       count(*) FILTER (WHERE first_entry IS NOT NULL) AS with_entry,
       count(*) FILTER (WHERE last_exit IS NOT NULL) AS with_exit
  FROM public.skud_daily_summary
 WHERE date BETWEEN '<from>' AND '<to>'
 GROUP BY date
 ORDER BY date;
```

Если в production Supabase ещё доступна — те же запросы прогнать на source и сравнить delta. Допустимый diff: ≤ 5% за счёт `created_at`-зависимой логики и retention-cutoff. Все остальные расхождения требуют расследования до подписи cutover.

### Owner/operator acceptance gate

**Перед production cutover** оператор должен явно подтвердить:

1. ✅ Sigur API доступен, креды действуют, retention покрывает целевой диапазон.
2. ✅ Понимает риски 1-6 выше и принимает их.
3. ✅ После backfill пройдены все 5 verification-запросов, результаты приложены к cutover-runbook.
4. ✅ `skud_daily_summary` пересчитан, табели за период проверены sample-методом.
5. ✅ Установлены оба env-флага в production-стенде:
   - `SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual`
   - `CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true`

Без этого `verify-public-data` exit 1 (см. Task 2 в Phase 11D), и preflight gate для прода не пройдёт.

---

## Текущее состояние (после Phase 11)

| Сторона | `skud_events` rows | Параметры |
|---|---:|---|
| Source (Supabase PG 17.6) | ~1 710 130 (растёт) | partitioned, 19 child partitions, 0 quarantine sample (3 в snapshot) |
| Target (Yandex PG 17.9, `FOT_Prod`) | **0** | partitioned, 19 child partitions attached, индексы созданы, FK на place |

Все остальные таблицы (`skud_daily_summary`, `skud_event_failures`, `attendance_adjustments`, etc.) уже мигрированы и валидируются.

---

## Варианты миграции

### A. Preferred — direct stable DB route

**Условие применимости**: возможно установить **долгое TCP-соединение** к source Supabase без NLB session timeout. Доступно либо через Supabase IPv4 add-on ($4/мес), либо при наличии IPv6 outbound на машине миграции.

**Последовательность:**
1. Включить **IPv4 add-on** в Supabase Dashboard → Settings → Add-ons → IPv4 ($4/мес временно). После активации `db.<projectref>.supabase.co` получит A-запись.
2. Перепрописать `SOURCE_DATABASE_URL` в `.migration/yandex.env`:
   ```
   SOURCE_DATABASE_URL="postgres://postgres:<password>@db.gxbtsnhevhlvmlvvqqqp.supabase.co:5432/postgres?sslmode=require&keepalives=1&keepalives_idle=30"
   ```
3. Запустить **per-partition `pg_dump`** в цикле (19 партиций → 19 dumps в `.migration/skud_events/<partition>.dump`):
   ```bash
   for part in $(psql "$SOURCE_DATABASE_URL" -tA -c \
       "SELECT inhrelid::regclass FROM pg_inherits WHERE inhparent='public.skud_events'::regclass ORDER BY inhrelid::regclass::text"); do
     pg_dump --data-only --format=custom --no-owner --no-acl \
       --table="$part" --file=".migration/skud_events/${part##*.}.dump" \
       "$SOURCE_DATABASE_URL"
   done
   ```
4. Для каждой партиции — `pg_restore --data-only` в target. Поскольку партиции уже ATTACH'нуты, INSERT через child идёт в parent автоматически.
5. После каждой партиции — `SELECT count(*)` обеих сторон, diff ≤ delta новых записей с момента snapshot.
6. После всех 19 партиций — пересчёт `skud_daily_summary` за overlap-период через RPC `batch_recalculate_skud_daily_summary($1::jsonb)`. Уже работает на runtime, в migration шаге достаточно вызвать для всех `(employee_id, event_date)` пар, чьи `event_date` попадают в `skud_events`.

**Время:** оценочно 30-90 мин на полный dump + 30-60 мин restore. Bottleneck — пропускная способность Supabase free-tier (≈10-20 MB/s даже на pooler/direct).

**Отмена IPv4 add-on** сразу после миграции — биллинг прорейтит до даты выключения.

### B. Fallback — chunked COPY by partition/date/id

**Условие применимости**: IPv4 add-on не включается, IPv6 недоступен, но pooler в принципе живой (всего лишь session timeout, реальная сеть работает).

Идея — **не держать одно длинное COPY**, а делить по диапазонам так, чтобы каждый chunk укладывался в 2-3 мин (запас от NLB).

**Скрипт:** [`fot-server/scripts/yandex-migration/migrate-skud-events-chunked.ts`](../../fot-server/scripts/yandex-migration/migrate-skud-events-chunked.ts).

**Режимы chunking:**

| `CHUNK_MODE` | Описание | Когда выбирать |
|---|---|---|
| `partition` | По одной chunk на каждую child-партицию | Если партиции маленькие (~50-100k rows) и pooler держит 3-5 мин |
| `date` | По `event_date`, шаг = `CHUNK_DAYS` (default 1) | Универсальный, гарантирует мелкость даже если внутри партиции 500k rows |
| `id` | По диапазонам `id` BIGINT, шаг = `CHUNK_BATCH_SIZE` (default 50000) | Максимально надёжный, не зависит от распределения данных |

**Что делает скрипт:**

1. Подключается к source через pg (Node), к target через pg (Node).
2. Для каждой chunk:
   - `SELECT count(*) FROM source WHERE <chunk_predicate>` — source_count
   - `SELECT count(*) FROM target WHERE <chunk_predicate>` — target_before
   - **DRY_RUN=true (default)**: только считает diff, не пишет.
   - **--apply**: SELECT строки chunk через cursor, batch INSERT в target по `BATCH_SIZE` (default 5000) с `ON CONFLICT (dedup_hash, event_date) DO NOTHING`.
3. После chunk — `target_after`, `inserted = after - before`, sanity: `inserted ≤ source_count`.
4. Checkpoint в `.migration/skud_events_chunks_report.{json,md}`: какой chunk удался, какой нет. При повторном запуске **пропускает удавшиеся**, retry только failed.

**Лимиты безопасности:**
- `BATCH_SIZE` не > 10000 строк (target write-amplification на pooler).
- ON CONFLICT обязателен — повторный запуск не вставит дублей.
- При SSL drop — текущий chunk помечается `failed`, скрипт продолжает следующий (не зависает).
- exit 0 только если **все chunks** имеют status `ok` или `skipped_no_rows`.

**Время:** для 1.7M rows при chunk=date 1d (~22 chunks): 22 × ~5 мин = ~2 часа. При chunk=partition (19 chunks): ~1-1.5 часа. При chunk=id 50k (~34 chunks): тоже ~2 часа.

### C. Last resort — Sigur API backfill (выбран для production)

**Условие применимости**: source skud_events уже потерян или недоступен, но Sigur API ещё хранит события за нужный период.

**Чем это отличается от вариантов A/B:**
- skud_events генерируются на target из Sigur API через **существующий `presence-polling.service`** (см. `fot-server/src/services/presence-polling.service.ts`). Тот же код, что в проде сейчас на Supabase.
- Историю можно вытянуть **разовым backfill-скриптом** или просто запустив presence-polling с большим `lastId=0` (с осторожностью — нагрузит Sigur API).

**Что мы получаем:**
- ✓ `dedup_hash` — рассчитывается заново в `presence-polling`, формат идентичен (`computeDedupHash` в `fot-server/src/utils/dedup.utils.ts`).
- ✓ `event_at`, `event_date`, `event_time` — берутся из Sigur, идентичны source.
- ✓ Партиционирование работает прозрачно (parent table).
- ✓ `skud_daily_summary` пересчитывается через `batch_recalculate_skud_daily_summary` после загрузки событий.

**Что мы НЕ получаем 1:1:**
- ⚠ `created_at` — будет moment cutover, не moment первого появления (source имел created_at = время записи в БД, которое было ~equal event_at + 1мин у presence-polling).
- ⚠ `employee_id` — резолвится через `sigur_linked_employees` map на момент backfill. Если за прошедшее время кого-то перепривязали, history будет с актуальной привязкой, а не исторической. Для табелей это **не критично** (employee_id используется для агрегации hours за день).
- ⚠ Sigur retention — обычно настроен на 1-3 года. События старше выпадают.
- ⚠ Backfill из Sigur не покрывает `quarantine` партицию (3 строки на момент phase 11). Если они важны — переносить руками (мало строк).

**Required reconciliation после backfill:**

```sql
-- 1. Пересчёт skud_daily_summary для всего диапазона backfill:
SELECT public.batch_recalculate_skud_daily_summary(
  jsonb_agg(jsonb_build_object('employee_id', employee_id, 'date', event_date))
)
FROM (SELECT DISTINCT employee_id, event_date FROM public.skud_events
      WHERE event_date BETWEEN '2026-04-01' AND CURRENT_DATE) t;

-- 2. Сверка count по дням:
SELECT event_date, count(*) AS skud_events_after_backfill
FROM public.skud_events
WHERE event_date >= '2026-04-01'
GROUP BY event_date ORDER BY event_date;

-- 3. Compare с production (если Supabase ещё доступен):
-- запустить тот же SELECT на source, diff по датам.
```

**Риски:**
- Sigur API rate limits → лимит по чанку (например, 1 день за раз, sleep 1 сек).
- Если у presence-polling уже есть `lastId` > какой-то → надо явно сбросить или гонять отдельным скриптом, чтобы не положить runtime.
- HR-screen-side инвариант "первый вход / последний выход" может слегка смениться, если Sigur показывает дополнительные события (например, failed access), которые prod-обработчик пропускал из-за классификации до фикса.

---

## Решение для production cutover

**Выбран вариант C — Sigur API backfill.**

Аргументы:
- 1.7M строк, основная польза для табелей — за **последние 2-3 месяца**. Старее (2026-01..2026-03) рабочие графики уже подписаны, использовать не будем.
- Включать $4/мес add-on ради разового мероприятия — лишнее. Сэкономим минимум на пайплайне (поднимаемся быстрее, без зависимости от Supabase live).
- Структурно target уже совместим — таблицы и партиции ATTACH'нуты в Phase 11 шаге 10. Никаких schema-changes не нужно.

**План backfill после cutover:**

1. **t0** — переключение runtime fot-server на target `FOT_Prod`. presence-polling start работает с `lastId=0` или с пустого state на target (`sigur_runtime_state` уже скопирован из source через restore).
2. **t0+1 час** — мониторим, что новый стек собирает события нормально. Sentry/`skud_daily_summary` обновляется. UI dashboards показывают свежие данные.
3. **t0+1 день** — запускаем backfill за **последние 90 дней** через отдельный скрипт `scripts/yandex-migration/backfill-skud-events-from-sigur.ts` (TODO — написать на этапе подготовки cutover; повторяет логику `presence-polling.service` но с custom-range, без rate-limit на real-time poll). Параметры:
   - `--from=2026-02-12 --to=2026-05-12`
   - `--rate-limit=1` (1 запрос/сек к Sigur API)
   - `--dry-run` сначала.
4. **t0+1 день после backfill** — пересчёт `skud_daily_summary` за тот же диапазон (SQL выше).
5. **t0+2 дня** — sanity: открыть случайные табели за прошлый месяц, проверить hours соответствуют ожиданиям.

Backfill-скрипт будет написан **в Phase 12** (cutover-preparation). На этой фазе достаточно:
- Подтвердить, что таблицы и партиции на target — корректные ✓ (Phase 11 шаг 10).
- Сохранить fallback B (chunked) на случай, если Sigur API окажется недоступен или retention короче, чем рассчитывали.

---

## Скрипт `migrate-skud-events-chunked.ts` (fallback B)

Хранится: [`fot-server/scripts/yandex-migration/migrate-skud-events-chunked.ts`](../../fot-server/scripts/yandex-migration/migrate-skud-events-chunked.ts).

### Запуск

```bash
# Загрузить env
set -a; source .migration/yandex.env; set +a

# Dry-run по дням (показывает chunks и diff без записи)
cd fot-server
npm run migrate:yandex:skud-events -- --dry-run --mode=date --days=1

# Apply (записывает; ON CONFLICT DO NOTHING)
npm run migrate:yandex:skud-events -- --apply --mode=date --days=1
```

### Опции (CLI флаги имеют приоритет над env)

| Флаг | ENV | Default | Описание |
|---|---|---|---|
| `--dry-run` | `DRY_RUN=true` | `true` | Не пишет в target |
| `--apply` | `DRY_RUN=false` | — | Пишет в target |
| `--mode=partition\|date\|id` | `CHUNK_MODE` | `date` | Тип разбиения |
| `--days=N` | `CHUNK_DAYS` | `1` | Шаг в днях (mode=date) |
| `--batch=N` | `CHUNK_BATCH_SIZE` | `50000` | Шаг по id (mode=id) |
| `--insert-batch=N` | `BATCH_SIZE` | `5000` | Размер INSERT в target |
| `--from=YYYY-MM-DD` | — | min(event_date) | Начало диапазона |
| `--to=YYYY-MM-DD` | — | max(event_date) | Конец диапазона |
| `--resume` | — | `false` | Использовать checkpoint (`.migration/skud_events_chunks_report.json`) |

### Артефакты

```
.migration/skud_events_chunks_report.json   — машиночитаемый
.migration/skud_events_chunks_report.md     — человекочитаемый
```

JSON-формат:

```json
{
  "started": "2026-05-12T...",
  "finished": "2026-05-12T...",
  "mode": "date",
  "chunks": [
    {
      "chunk_id": "2026-04-15",
      "predicate": "event_date = '2026-04-15'",
      "source_count": 12450,
      "target_before": 0,
      "inserted": 12450,
      "target_after": 12450,
      "duration_ms": 8421,
      "status": "ok"
    },
    {
      "chunk_id": "2026-04-16",
      "status": "failed",
      "error": "SSL connection unexpectedly closed during SELECT ... LIMIT 5000 OFFSET 0",
      "retries": 2
    }
  ],
  "totals": {
    "source_total": 1710130,
    "target_total": 1583220,
    "diff": -126910,
    "chunks_ok": 87,
    "chunks_failed": 4
  }
}
```

### Exit codes

- `0` — все chunks `ok` или `skipped_no_rows`.
- `1` — есть `failed` chunks (см. `error` в JSON).
- `2` — fatal: ENV / коннект / нештатное падение.

---

## Что НЕ делает этот документ

- Не описывает Phase 12 cutover-runbook (порядок отключения Supabase, переключение DSN в проде).
- Не описывает rollback из target → Supabase (в Phase 12 будет отдельный документ если потребуется).
- Не предоставляет готовый Sigur backfill-скрипт (будет в Phase 12).
