# ROLLBACK — failure scenarios + recovery procedures

> Что делать если cutover пошёл не так. **Главное правило**: в первые 2 часа
> после T-0 при FAIL критичного домена — **возвращаемся на Supabase** (rollback),
> а не пытаемся починить на проде. Расследование делаем уже после возврата.
>
> Связанные документы: [RUNBOOK.md](RUNBOOK.md), [CHECKLIST.md](CHECKLIST.md).

---

## Когда инициировать rollback

### Безусловный rollback (любой из триггеров)

| # | Триггер | Что значит |
|---|---|---|
| R1 | login + 2FA не работает | TOTP/JWT/ENCRYPTION_KEY несовместимы → блокируем всех |
| R2 | `/api/employees` или `/timesheet` возвращают 500 | data corruption / FK broken |
| R3 | `verify-public-data` после переключения DSN exit ≠ 0 (без skud_events) | rows потеряны |
| R4 | psycopg / pg-node не подключается к target в течение 5 мин | network/SSL/firewall |
| R5 | `pg_stat_activity` показывает > 30 idle connections, pool exhausted | конкуренция / DDoS / runaway query |
| R6 | Sentry за первые 30 мин показывает > 50 новых ошибок типов, которых не было до cutover | broken runtime |
| R7 | UI не загружается совсем (white screen / 502) | nginx / static / process не запустился |
| R8 | Critical data missing для конкретных юзеров (employees, attendance) | restore инкомплитный |

### Условный rollback (по решению оператора)

| # | Триггер | Решение |
|---|---|---|
| C1 | Sigur API недоступен после T+30min | если ⩾ 1 час — rollback (нужен для backfill); иначе wait |
| C2 | Backfill даёт > 10% diff vs ожиданий | если объясняется retention — continue; иначе investigate |
| C3 | Один не-critical домен FAIL (patent, chat, salary-raise) | continue, фиксируем incident |
| C4 | Backfill failed mid-way, target имеет partial skud_events | continue — повторный backfill безопасен (ON CONFLICT) |

---

## Rollback Plan A — fast (в первые 2 часа после T-0)

**Цель**: вернуть production runtime на Supabase за ⩽ 15 мин.

**Предусловие**: Supabase Cloud project ещё активен, `.env.bak.pre-cutover-*` на vds сохранён, DNS не менялся (всё то же `fotsu10.fvds.ru`).

### Шаги

```bash
# 1. Останавливаем services на vds
ssh vds 'pm2 stop fot-server fot-data-api'

# 2. Возвращаем .env.bak.pre-cutover-* на место
ssh vds bash <<'REMOTE'
set -euo pipefail
LATEST_BACKUP=$(ls -t /var/www/fot/fot-server/.env.bak.pre-cutover-* | head -1)
echo "Restoring $LATEST_BACKUP → /var/www/fot/fot-server/.env"
cp "$LATEST_BACKUP" /var/www/fot/fot-server/.env

LATEST_BACKUP2=$(ls -t /var/www/fot/fot-data-api/.env.bak.pre-cutover-* | head -1)
echo "Restoring $LATEST_BACKUP2 → /var/www/fot/fot-data-api/.env"
cp "$LATEST_BACKUP2" /var/www/fot/fot-data-api/.env
REMOTE

# 3. Стартуем (по умолчанию указывают на Supabase в backed-up .env)
ssh vds 'pm2 start fot-server'
ssh vds 'pm2 start fot-data-api'

# 4. Sanity
ssh vds 'pm2 logs fot-server --lines 30 --nostream' | grep -iE "running|error|fatal"
curl -s -i https://fotsu10.fvds.ru/api/health | head -5
```

### Validation после rollback A

- [ ] `curl https://fotsu10.fvds.ru/health` → 200.
- [ ] Login админом — JWT (тот же `JWT_SECRET` → старые токены тоже работают).
- [ ] `/employees` показывает данные (как до cutover).
- [ ] Sentry — новые ошибки прекратились.
- [ ] Sigur presence-polling возобновился (heartbeat обновляется в Supabase `sigur_runtime_state`).

### Что с данными, попавшими в target за окно cutover'а

- Backfill записал `skud_events` в **Yandex target**, не в Supabase.
- Если rollback произошёл до того как пользователи писали что-то на target → потеряны
  только тест-события из smoke (audit_logs от login admin'а, может пара test-uploads).
- Если пользователи успели **создать новые строки** (новые табели, attendance, audit) на
  Yandex target за окно `[T0..rollback]` — эти данные **остаются на Yandex**, и их нужно
  **вручную мигрировать на Supabase** перед очередной попыткой cutover'а. Скрипт:
  ```sql
  -- Внутри окна (~30 мин - 2 часа) объёмы крошечные. Через psql вручную
  -- скопировать новые строки из Yandex в Supabase для:
  --   audit_logs WHERE created_at >= T0
  --   attendance_adjustments WHERE updated_at >= T0
  --   timesheet_approvals WHERE updated_at >= T0
  -- Использовать INSERT ... ON CONFLICT DO NOTHING на Supabase.
  ```

### Время выполнения

5-15 мин. После rollback А — **announce пользователям, что downtime закончилось**.

---

## Rollback Plan B — partial (если cutover частично работает)

Применяется если: fot-server работает на Yandex, **но один из доменов** (например, backfill завис на 60% / patent receipts decryption ломается / object maps возвращают 403).

### Опции

#### B1. Backfill незакрыт

Симптом: backfill упал на середине / Sigur API rate-limit / SSL drop.

```bash
# Backfill можно безопасно перезапустить — ON CONFLICT(dedup_hash, event_date) DO NOTHING
# не создаст дубликатов.
ssh vds 'cd /var/www/fot/fot-server && \
  npm run migrate:yandex:backfill-skud-events -- --apply \
    --from=<DATE_OF_PARTIAL_BACKFILL_FAILED_DAY> --to=<T> --rate-limit-ms=2000'
```

Если повторно падает — **continue без полного skud_events** (за пройденные дни данные уже есть).
SK-BF1 покажет что range частично заполнен. UI работает за заполненные дни, пустой за остаток.
В реальности это окно ≤ 24ч, и пользователи скоро увидят новые события от presence-polling.

#### B2. patent_payment_receipts ломается на decrypt

Симптом: открываешь patent_receipt в UI, видишь error / encrypted gibberish.

Причина: ENCRYPTION_KEY на проде НЕ совпадает с тем, который был при создании chunked-кода.

Решение: проверить `.env` на vds после cutover — `ENCRYPTION_KEY` должен быть **тот же**,
который был до cutover. Если случайно поменялся → rollback A.

#### B3. Cloud.ru S3 не выдаёт signed URL

Симптом: документ загрузился, но GET signed URL даёт 403 или 404.

Решение:
- Проверить `OBJECT_STORAGE_FORCE_PATH_STYLE=true` в `.env` (для bucket с точкой обязательно).
- Проверить, что `OBJECT_STORAGE_ACCESS_KEY_ID` — полная строка `<tenant_uuid>:<key_id>`.
- Не блокирует cutover — пользователи временно не могут открыть документы; чинится правкой
  `.env` + `pm2 reload fot-server`.

#### B4. Data API 1С интеграция падает

Симптом: 1С получает 500 / 503 от `/external/v1/tables/...`.

Решение:
- Чаще всего: psycopg `prepare_threshold` фикс не применился. Проверить, что в
  `fot-data-api/app/lib/postgres.py` есть `configure=_configure_connection` callback.
- Если фикс на месте, но ошибка повторяется — `pm2 restart fot-data-api`.
- 1С не критично — клиент может подождать 1-2 часа.

---

## Rollback Plan C — slow (T+24h..T+7d, обнаружена data corruption)

**Сценарий**: cutover прошёл штатно, но через сутки/два обнаружено, что данные расходятся
(например, табели одного отдела показывают неправильные часы; user_company_access потерял
строки).

### Что НЕЛЬЗЯ делать
- ❌ Возвращаться на Supabase напрямую — за сутки на Yandex накопились новые
  legitimate-данные (новые табели, audit, etc.). Простая возврат-в-старое потеряет их.
- ❌ Сбрасывать всю target БД из dump'а — теже данные потеряются.

### Что МОЖНО делать (по убыванию вероятности)

#### C1. Точечный re-migrate конкретной таблицы

Если ошибка изолирована (например, `org_departments` потерял parent_id у 10 строк):

```bash
# 1. Локально снять текущее состояние на Supabase (если ещё доступен)
pg_dump --data-only --table=org_departments --format=custom \
  --no-owner --no-acl --file=.migration/fix_org_departments.dump \
  "$SUPABASE_DATABASE_URL"

# 2. На vds через psql сделать UPSERT на нужные строки (не TRUNCATE — иначе потеряем
#    свежие записи, созданные на target за сутки).
# Если supabase has structure changes that differ from target — merge вручную через
# SELECT diff'ы.

# 3. После точечного fix — verify-public-data, повторить smoke.
```

#### C2. Replay events from Sigur (для skud_*)

Если обнаружились gaps в `skud_events` за конкретные дни:

```bash
ssh vds 'cd /var/www/fot/fot-server && \
  npm run migrate:yandex:backfill-skud-events -- --apply \
    --from=<GAP_FROM> --to=<GAP_TO>'
# затем recalculate skud_daily_summary для затронутого диапазона
```

#### C3. Полный rebuild target (последняя инстанция)

Если корruption массовая (>10% таблиц):

1. Поднять второй Yandex cluster (или drop + recreate FOT_Prod).
2. Снять fresh pg_dump с Supabase (если ещё активен) ИЛИ с текущего target.
3. Прогнать полный pipeline Phase 11A-D заново на новом cluster.
4. **При этом**: между T+24h и rebuild'ом collect все NEW writes на текущем (испорченном)
   target, чтобы потом re-apply на свежий. Это сложная операция — рассмотреть как абсолютную
   крайность.

⚠ Rollback plan C **никогда не запускался** на реальной cutover. План остаётся
теоретическим до первой настоящей ситуации.

---

## Что делать, если Supabase project уже удалён / payment failed

Если на момент rollback'а Supabase **недоступен** (paused beyond grace period, payment
failed, etc.):

- Plan A **не работает** — нет куда возвращаться.
- Plan B (partial) работает для большинства incident'ов.
- Plan C (slow rebuild) работает, но как source используем самый свежий backup из
  Supabase (Daily Backups можно скачать с Supabase Dashboard в течение 7 дней после
  pause).

**Поэтому**:
- НЕ удалять Supabase project **минимум 30 дней** после успешного cutover'а.
- НЕ выключать billing на Supabase раньше T+30d.
- Daily Backup на Supabase Dashboard → "Download" — скачать последний за день до cutover'а
  локально, держать на диске оператора.

---

## Декomposition по доменам

Для быстрой ориентации при partial rollback — какой домен на каких артефактах живёт.

| Домен | Где данные | Где код | Rollback |
|---|---|---|---|
| Auth | `app_auth.users` + `user_profiles` (target PG) | `local-auth.service.ts` | A (fast) |
| Employees / structure | public PG | controllers/services | A или C1 |
| Timesheet | `attendance_adjustments`, `timesheet_approvals` | timesheet/approval services | A или C1 |
| SKUD | `skud_events` (Sigur API backfill) | presence-polling, skud-* | B1 (re-backfill) |
| Sigur sync | `sigur_runtime_state`, `sigur_events_*` | sigur-sync-* | A или C2 |
| Documents | `documents` + Cloud.ru S3 | documents.controller | A или B3 |
| Patent receipts | `patent_payment_receipts` (encrypted JSONB) | patent-receipts.* | A (B2 не помогает — нужен правильный ENCRYPTION_KEY) |
| Chat | `chat_*` (encrypted message body) | chat.service | A |
| Data API | `data_api_keys`, `data_api_key_tables`, `data_api_request_logs` | fot-data-api Python | A или B4 |
| Object maps | `skud_objects` + Cloud.ru S3 | object-map-storage.service | A или B3 |

---

## Контакты эскалации

При неоднозначных ситуациях (когда непонятно, делать ли rollback):

- Оператор (Maxim) — single-source-of-truth, решает сам.
- Sentry alerts → разбираем по факту.
- Sigur API issues → support@sigur.com (или внутренний контакт).
- Yandex Cloud issues → Yandex Cloud support через console.
- Cloud.ru issues → support@cloud.ru.

---

## Acknowledgements / freeze

- Phase: **12**
- Frozen: **2026-05-13**
- Author: Claude (drafted) → Maxim (reviewed before T-1d)
- Post-freeze amendments: только через явный pull-request с пометкой `[post-freeze]`.

---

## Если cutover успешен → finalize

После T+30d без необходимости в rollback:

- [ ] Supabase project → Delete (или оставить paused indefinitely если cost = 0).
- [ ] Все `.env.bak.pre-cutover-*` на vds удалены.
- [ ] Локальные `.migration/` dumps архивированы (offline backup) и удалены с активного диска.
- [ ] RUNBOOK / CHECKLIST / ROLLBACK помечены как "historical artifacts" — будущие migration
      ссылаются на них как baseline.
