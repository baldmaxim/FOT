# RUNBOOK — Production cutover Supabase → Yandex Managed PG

> Финальный runbook для production cutover. Замораживается в Phase 12;
> любые изменения после freeze документируются отдельным diff'ом.
>
> Baseline:
> - Все фазы 10A–11E завершены, STAGING_REHEARSAL_REPORT.md = `READY_FOR_PHASE_12`.
> - Target Yandex Managed PG (`FOT_Prod`, PG 17.9, primary `rc1d-...`) уже наполнен данными ⩾ за rehearsal:
>   - 87 public.* base tables + 19 партиций skud_events + app_auth (46 users).
>   - skud_event_failures, skud_daily_summary, sigur_runtime_state и др. мигрированы.
>   - skud-object-maps зеркалирован в Cloud.ru S3 (`fot.app/travel-objects/*`).
>   - **`skud_events` (parent + партиции) намеренно ПУСТЫ** — backfill ниже.
> - Production source Supabase ещё активен. Cutover = переключение `DATABASE_URL`
>   в `fot-server/.env` и `fot-data-api/.env`, рестарт через PM2.

---

## Decision matrix

| Сценарий | Решение |
|---|---|
| Все pre-cutover gates ✅ | Идём по runbook'у |
| `verify-public-data` exit != 0 на pre-cutover sanity | **STOP**, не cutover'имся, разбираемся |
| Sigur API недоступен в окно cutover'а | **STOP**, переносим на другое окно (нужен для backfill сразу после cutover) |
| Backfill даёт > 1% diff vs ожидание | Не блокируем — оставляем как known noise, расследуем post-cutover |
| Smoke test критичного домена FAIL после cutover | **ROLLBACK** (см. ROLLBACK.md) |
| Smoke test не-критичного домена FAIL | Не блокируем — фиксируем как incident, починим post-cutover |

**Критичные домены для cutover-gate:** auth (login/2FA), employees CRUD, timesheet open, documents upload/download.
**Не-критичные:** patent receipts (мало используется), salary raise (раз в год), chat (есть Slack как fallback).

---

## Производственные параметры (заполнить за день до cutover)

| Параметр | Значение |
|---|---|
| Cutover дата/время | `<FILL_YYYY-MM-DD HH:MM МСК>` (рекомендую вечер выходного, 18:00-22:00) |
| Окно downtime | оценка 30-60 мин |
| Operator (Maxim) | онлайн всё окно + 2 часа после |
| Sigur API доступен | подтверждено (запустить `migrate:yandex:sigur-retention` за 24ч до) |
| TARGET_DATABASE_URL | `<FILL>` (из `.migration/yandex.env`) |
| Backup `fot-server/.env` на vds | `cp /var/www/fot/fot-server/.env /var/www/fot/fot-server/.env.bak.cutover-YYYYMMDD` |

---

## Cutover timeline (T-0 == момент переключения DSN)

### T-24h — pre-flight

```bash
# 1. На vds — забэкапить prod .env (backup на случай rollback)
ssh vds 'cp /var/www/fot/fot-server/.env /var/www/fot/fot-server/.env.bak.pre-cutover-$(date +%Y%m%d-%H%M)'
ssh vds 'cp /var/www/fot/fot-data-api/.env /var/www/fot/fot-data-api/.env.bak.pre-cutover-$(date +%Y%m%d-%H%M)'

# 2. Локально подтвердить Sigur retention (Sigur может потерять данные если retention shrunken)
cd fot-server
SIGUR_RUNTIME_ALLOWED_HOSTS='*' DATABASE_URL=$TARGET_DATABASE_URL DATABASE_SSL=true \
  npm run migrate:yandex:sigur-retention -- --probes=7,30,60,90

# 3. Подтвердить target ready через verify-public (accepted mode)
SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual \
CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true \
  npm run migrate:yandex:verify-public
# ожидание: exit 0, skud_events_status=accepted_manual_backfill

# 4. Подтвердить preflight
npm run migrate:yandex:preflight
# ожидание: 0 critical, 1 warn (skud_event_failures non-partitioned — known)
```

### T-2h — приготовиться

```bash
# Smoke prod (Supabase) — снять baseline counts для последующего diff
ssh vds 'cd /var/www/fot/fot-server && \
  psql "$DATABASE_URL_FROM_PROD_ENV" -tA -c "
    SELECT '\''timesheet_approvals: '\'' || count(*) FROM timesheet_approvals
    UNION ALL SELECT '\''audit_logs(today): '\'' || count(*) FROM audit_logs WHERE created_at::date = CURRENT_DATE
    UNION ALL SELECT '\''app_auth-equiv: '\'' || count(*) FROM auth.users
    UNION ALL SELECT '\''user_profiles: '\'' || count(*) FROM user_profiles;
  "' > /tmp/pre-cutover-source-baseline.txt
cat /tmp/pre-cutover-source-baseline.txt
```

Сообщить пользователям заранее (за 24ч и за 2ч): "Запланирован technical downtime <дата> <время>, ожидаемая длительность 30-60 мин, новые логины невозможны."

### T-15min — final stop-writes preparation

```bash
# На vds — приготовиться остановить fot-server и fot-data-api
ssh vds 'pm2 list | grep -E "fot-server|fot-data-api"'
# должны видеть оба процесса в статусе "online"
```

### T-0 — CUTOVER START (момент остановки прод-stack'а)

```bash
# Шаг 1. Останавливаем fot-server (тормозит все writes на Supabase)
ssh vds 'pm2 stop fot-server'
# Background-сервисы (presence-polling, sigur-monitor, skud-summary-reconcile,
# timesheet-reminder, daily-tasks-reminder, patent-expiry, ai-receipt-recognition)
# остановятся вместе с процессом.

# Шаг 2. Останавливаем fot-data-api (read-only Data API для 1С)
ssh vds 'pm2 stop fot-data-api'

# В этот момент:
# - UI пользователей даёт 502/connection refused — это OK, окно cutover'а.
# - Sigur приложение не получает events запросов от polling — события копятся
#   в Sigur, при первом start fot-server новый polling вытянет их с lastId=last.
# - 1C-интеграция через Data API даёт 503 — клиента предупредить заранее.
```

### T+0 — delta-sync свежих данных (опционально, если нужна совпадение)

Между Phase 11 dump (2026-05-12) и моментом cutover на source могли появиться новые строки в:
- `user_profiles` (новые регистрации)
- `employees` (новые сотрудники)
- `employee_assignments` (новые/закрытые назначения)
- `timesheet_approvals`, `audit_logs`, `attendance_adjustments`
- `documents`, `patent_payment_receipts`

Если delta существенная (>10 строк per critical table), выполнить **delta-dump**:

```bash
# Локально
cd /c/Users/Usrr/VSCode/Odintsov/FOT
export PATH="/c/Users/Usrr/scoop/apps/postgresql/current/bin:$PATH"
set -a; source .migration/yandex.env; set +a

# Точечный re-dump критичных таблиц БЕЗ skud_events*
pg_dump --data-only --schema=public --format=directory --jobs=2 \
  --no-owner --no-acl \
  --table=user_profiles \
  --table=employees \
  --table=employee_assignments \
  --table=timesheet_approvals \
  --table=audit_logs \
  --table=attendance_adjustments \
  --table=documents \
  --table=document_links \
  --table=patent_payment_receipts \
  --file=.migration/cutover_delta.dir \
  "$SOURCE_DATABASE_URL"

# На target — сначала TRUNCATE затронутых таблиц (FK снимаются с CASCADE безопасно
# в downtime-окне), потом restore. Альтернатива: запустить
# migrate-skud-events-chunked в DIFF-mode (если решим расширить скрипт).
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
TRUNCATE
  public.user_profiles, public.employees, public.employee_assignments,
  public.timesheet_approvals, public.audit_logs, public.attendance_adjustments,
  public.documents, public.document_links, public.patent_payment_receipts
CASCADE;
SQL

pg_restore --data-only --no-owner --no-acl --exit-on-error --jobs=4 \
  --dbname="$TARGET_DATABASE_URL" .migration/cutover_delta.dir

# Re-fix sequences для затронутых таблиц
cd fot-server
npm run migrate:yandex:fix-sequences
```

⚠ Если delta-sync даёт ошибки — **НЕ упорствуем**. Принимаем delta как known noise
(несколько новых строк user_profiles / audit_logs за 2 дня rehearsal'а), идём дальше.

### T+5min — переключение DSN на vds

```bash
ssh vds bash <<'REMOTE'
set -euo pipefail
ENV=/var/www/fot/fot-server/.env

# Сохранить ещё одну копию на всякий случай
cp $ENV ${ENV}.cutover-$(date +%Y%m%d-%H%M)

# Заменить DATABASE_URL + добавить SSL params
# (либо вручную через nano, либо скриптом ниже)
python3 - <<PY
import os
import re
path = "/var/www/fot/fot-server/.env"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

TARGET = "postgres://Odintsov:<PROD_PASSWORD>@rc1d-<rest>.mdb.yandexcloud.net:6432/FOT_Prod?sslmode=verify-full&sslrootcert=/var/www/fot/.migration/yandex-ca.pem"
CA_PATH = "/var/www/fot/.migration/yandex-ca.pem"

content = re.sub(r"^DATABASE_URL=.*$", f"DATABASE_URL={TARGET}", content, flags=re.M)
# Добавить недостающие
for k, v in [("DATABASE_SSL", "true"),
             ("DATABASE_SSL_CA_PATH", CA_PATH),
             ("DATABASE_POOL_MAX", "10"),
             ("DATABASE_STATEMENT_TIMEOUT_MS", "30000")]:
    if re.search(rf"^{k}=", content, flags=re.M):
        content = re.sub(rf"^{k}=.*$", f"{k}={v}", content, flags=re.M)
    else:
        content += f"\n{k}={v}"

# Убрать SUPABASE_* (не используются больше)
content = re.sub(r"^SUPABASE_(URL|SERVICE_ROLE_KEY)=.*\n", "", content, flags=re.M)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
print("fot-server/.env обновлён")
PY

# Аналогично для fot-data-api
ENV2=/var/www/fot/fot-data-api/.env
cp $ENV2 ${ENV2}.cutover-$(date +%Y%m%d-%H%M)

python3 - <<PY
import re
path = "/var/www/fot/fot-data-api/.env"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()
TARGET = "postgres://Odintsov:<PROD_PASSWORD>@rc1d-<rest>.mdb.yandexcloud.net:6432/FOT_Prod?sslmode=verify-full&sslrootcert=/var/www/fot/.migration/yandex-ca.pem"
CA_PATH = "/var/www/fot/.migration/yandex-ca.pem"
# Полностью переписать
new_content = f"""DATABASE_URL={TARGET}
DATABASE_SSL=true
DATABASE_SSL_CA_PATH={CA_PATH}
DATABASE_POOL_MAX=5
PORT=4001
DEFAULT_RATE_LIMIT_PER_MINUTE=60
"""
with open(path, "w", encoding="utf-8") as f:
    f.write(new_content)
print("fot-data-api/.env переписан")
PY

# Скопировать Yandex CA если ещё не на vds
test -f /var/www/fot/.migration/yandex-ca.pem || \
  curl -fsSL https://storage.yandexcloud.net/cloud-certs/CA.pem -o /var/www/fot/.migration/yandex-ca.pem
REMOTE
```

### T+10min — старт обоих сервисов

```bash
# fot-server (Sigur ВКЛЮЧЁН в проде — host odintsov1.live.fvds.ru в whitelist)
ssh vds 'pm2 start fot-server'
ssh vds 'pm2 logs fot-server --lines 30 --nostream'
# Ожидание: "FOT Server running on 127.0.0.1:3001"
# presence-polling должен начать тики (allowed host = текущий).

# fot-data-api
# На vds Linux uvicorn запускается обычным CLI (не нужен Windows-launcher):
ssh vds 'pm2 start fot-data-api'
ssh vds 'pm2 logs fot-data-api --lines 30 --nostream'
# Ожидание: "Uvicorn running on http://127.0.0.1:4001"

# Если psycopg выдаёт prepare_threshold ошибку (Yandex pooler) — проверить, что
# fix-pool применён (app/lib/postgres.py содержит configure=_configure_connection).
```

### T+15min — auth/login smoke

```bash
# Self-test: запрос на health и login
curl -s http://localhost:3001/health  # via SSH tunnel или nginx
# Через nginx (доступно снаружи):
curl -s -i https://fotsu10.fvds.ru/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"<known_password>"}' | head -20
# Ожидание: 200 с JWT в body
```

### T+30min — manual Sigur API backfill (skud_events)

⚠ **Это критический шаг production cutover'а.** На target `skud_events` пуст после
rehearsal-cleanup'а (если делали TRUNCATE) ИЛИ имеет только rehearsal-данные
2026-03..05. Перед production cutover'ом → решение про охват backfill'а.

```bash
ssh vds bash <<'REMOTE'
cd /var/www/fot/fot-server
# Backfill за последние 3 месяца от cutover-даты (или нужный охват).
# В проде SIGUR_RUNTIME_ALLOWED_HOSTS=odintsov1.live.fvds.ru (наш хост) — guard
# проходит без override.
FROM=$(date -d "90 days ago" +%Y-%m-%d)
TO=$(date +%Y-%m-%d)
echo "backfill range: $FROM .. $TO"

# Dry-run сначала — оценить нагрузку Sigur API.
npm run migrate:yandex:backfill-skud-events -- --dry-run --from=$FROM --to=$TO --rate-limit-ms=1000

# Apply (~35-60 мин для 90 дней)
npm run migrate:yandex:backfill-skud-events -- --apply --from=$FROM --to=$TO --rate-limit-ms=1000
REMOTE
```

### T+1.5h — post-backfill recalculate + verify

```bash
# Recalculate skud_daily_summary за backfill-диапазон
ssh vds 'psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 <<SQL
DO \$\$
DECLARE
  total_pairs int;
  chunk_size int := 5000;
  off int := 0;
  pairs_chunk jsonb;
  d_from date := CURRENT_DATE - 90;
  d_to date := CURRENT_DATE;
BEGIN
  SELECT count(*) INTO total_pairs FROM (
    SELECT DISTINCT employee_id, event_date FROM public.skud_events
     WHERE event_date BETWEEN d_from AND d_to AND employee_id IS NOT NULL
  ) t;
  RAISE NOTICE \"total pairs: %\", total_pairs;
  WHILE off < total_pairs LOOP
    SELECT jsonb_agg(jsonb_build_object(\"emp_id\", employee_id, \"date\", event_date))
      INTO pairs_chunk FROM (
        SELECT DISTINCT employee_id, event_date FROM public.skud_events
         WHERE event_date BETWEEN d_from AND d_to AND employee_id IS NOT NULL
         ORDER BY employee_id, event_date OFFSET off LIMIT chunk_size
      ) t;
    PERFORM public.batch_recalculate_skud_daily_summary(pairs_chunk);
    off := off + chunk_size;
    RAISE NOTICE \"processed % / %\", LEAST(off, total_pairs), total_pairs;
  END LOOP;
END \$\$;
SQL'

# Verify SK-BF1..BF9 (см. CHECKLIST.md)
```

### T+2h — UI smoke tests на проде

Зайти браузером в `https://fotsu10.fvds.ru/`:

1. Login существующим пользователем — должен работать (JWT_SECRET не менялся → старые куки тоже).
2. Login с 2FA — TOTP secret расшифровывается (ENCRYPTION_KEY не менялся).
3. `/employees` страница — список загружается, search работает.
4. `/timesheet` — открыть табель за прошлый месяц, hours корректны.
5. `/skud` dashboard — KPI ненулевые (backfill сработал).
6. Загрузить документ → скачать — должно открыться (Cloud.ru S3).
7. Открыть карту объекта СКУД — должна загрузиться.

Каждый ОК pass — отметить в CHECKLIST.md. **Любой FAIL критичного домена → ROLLBACK.**

### T+3h — нормальная работа, мониторинг

```bash
# Логи fot-server и fot-data-api живут
ssh vds 'pm2 logs fot-server --lines 100 --nostream | grep -iE "error|fatal|warn" | tail -30'
ssh vds 'pm2 logs fot-data-api --lines 100 --nostream | grep -iE "error|fatal" | tail -30'

# DB connection pool — не превышает лимит
ssh vds 'psql "$TARGET_DATABASE_URL" -tA -c "SELECT count(*) FROM pg_stat_activity WHERE state IN ('\''active'\'', '\''idle in transaction'\'')"'
# Yandex pooler max usually = 10; должны видеть < 10.

# Presence-polling работает
ssh vds 'psql "$TARGET_DATABASE_URL" -tA -c "
  SELECT key, lease_owner, heartbeat_at, now() - heartbeat_at as lag
  FROM sigur_runtime_state
  WHERE key = '\''presence_polling'\''
"'
# heartbeat_at должен быть < 2 min ago.
```

### T+24h — post-cutover smoke (контроль)

- Проверить Sentry — нет всплеска новых ошибок (>10x baseline).
- Открыть HR-табель за вчера — данные на месте.
- Просмотреть `audit_logs` за последние 24h — нет аномалий.
- Проверить, что Supabase больше **не получает запросов** от prod fot-server (Supabase Dashboard → Logs → API/Database — должна быть пустота начиная с cutover'а).

### T+7d — finalize

- Supabase project можно перевести в pause-режим (но не удалять до T+30d):
  Dashboard → Settings → Pause project.
- Удалить `.env.bak.cutover-*` файлы на vds.
- Закрыть IPv4 add-on если включали.
- Закрыть Phase 12 — обновить STAGING_REHEARSAL_REPORT.md статус: cutover completed.

---

## Список post-cutover tasks (нельзя забыть)

| Задача | Срок | Owner |
|---|---|---|
| **skud_event_failures repartition** (миграция 085 не применена корректно на source) | T+7d..T+30d | Maxim |
| Удалить Supabase project | T+30d (после подтверждения, что rollback не нужен) | Maxim |
| Закрыть Cloud.ru S3 staging-доступ (если был отдельный) | T+1d | Maxim |
| Mass-обновление `eventTypeId=36` справочника (warning при backfill) | T+1d | Maxim |
| Rename `supabase-instrumentation.ts` → `db-instrumentation.ts` | T+7d (опционально) | Maxim |

---

## Связанные документы

- [CHECKLIST.md](CHECKLIST.md) — pre/during/post-cutover tickable checklist.
- [ROLLBACK.md](ROLLBACK.md) — failure scenarios + recovery procedures.
- [09_skud_events_migration.md](09_skud_events_migration.md) — Sigur backfill details.
- [10_staging_runtime_smoke_tests.md](10_staging_runtime_smoke_tests.md) — smoke tests UI/API.
- [STAGING_REHEARSAL_REPORT.md](STAGING_REHEARSAL_REPORT.md) — финальный отчёт rehearsal'а.

---

## Freeze stamp

- Phase: **12**
- Frozen: **2026-05-13**
- Author: Claude (drafted) → Maxim (approved before T-1d)
- Frozen artifact: эти 3 документа (RUNBOOK / CHECKLIST / ROLLBACK) — после freeze
  изменения только через явный diff с пометкой "post-freeze amendment".
