# CHECKLIST — Production cutover Supabase → Yandex Managed PG

> Tickable чек-лист. Печатать (или открыть в IDE) **перед** запуском cutover'а,
> отмечать каждый пункт по факту.
>
> Полный сценарий — [RUNBOOK.md](RUNBOOK.md). Решение при сбое — [ROLLBACK.md](ROLLBACK.md).

---

## T-7d — за неделю

- [ ] STAGING_REHEARSAL_REPORT.md показывает `READY_FOR_PHASE_12: YES`.
- [ ] Phase 11E owner-acceptance подписан (6 пунктов в STAGING_REHEARSAL_REPORT.md § Task 5).
- [ ] UI smoke tests на staging пройдены (см. 10_staging_runtime_smoke_tests.md).
- [ ] Дата/время cutover'а согласованы (рекомендую: вечер выходного, 18:00–22:00 МСК).
- [ ] Yandex Cluster `FOT_Prod` оплачен на ближайший месяц + есть запас по диску ⩾ 50%.
- [ ] Cloud.ru S3 bucket `fot.app` оплачен, IAM-юзер не истекает.
- [ ] Sigur API доступен с прод-хоста, retention ⩾ 90 дней (запустить `migrate:yandex:sigur-retention`).

## T-24h — за день

- [ ] `pg_dump --schema-only` source свежий (на случай если что-то поменялось в схеме за rehearsal).
- [ ] `npm run migrate:yandex:preflight` локально (TARGET) → **0 critical**, ⩽ 1 warn (skud_event_failures plain).
- [ ] `SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true npm run migrate:yandex:verify-public` → **exit 0**, `skud_events_status: accepted_manual_backfill`.
- [ ] Sigur retention probe: `npm run migrate:yandex:sigur-retention -- --probes=7,30,60,90,180` → ⩾ 90 дней OK.
- [ ] Backup на vds: `/var/www/fot/fot-server/.env` и `/var/www/fot/fot-data-api/.env` скопированы как `*.bak.pre-cutover-YYYYMMDD-HHMM`.
- [ ] Yandex CA на vds: `/var/www/fot/.migration/yandex-ca.pem` существует (CRC-check / size > 3KB).
- [ ] Уведомление пользователям отправлено (за 24ч).
- [ ] Sentry alerts включены на vds + локально на phone (для оператора).

## T-2h — за два часа

- [ ] Pre-cutover counts (source baseline) сняты → `/tmp/pre-cutover-source-baseline.txt`.
- [ ] PM2 status: `fot-server` и `fot-data-api` — оба `online`.
- [ ] Активные подключения на Supabase < 10 (нет долгих запросов).
- [ ] Уведомление пользователям (за 2ч).
- [ ] Browser-сессия открыта на `https://fotsu10.fvds.ru/` (admin user готов для post-cutover smoke).

## T-15min — последняя подготовка

- [ ] SSH-сессия на vds активна.
- [ ] Локальный shell готов: `cd ~/VSCode/Odintsov/FOT`, `source .migration/yandex.env`.
- [ ] Phone не на бесшумном (вдруг что — нужны Sentry alerts).
- [ ] Уведомление "Начинаем" (если в чате).

---

## 🔻 T-0 — CUTOVER START

### Шаг 1. Stop writes

- [ ] `ssh vds 'pm2 stop fot-server'`
- [ ] `ssh vds 'pm2 stop fot-data-api'`
- [ ] Подтвердить: оба `stopped` в `pm2 list`.
- [ ] **Зафиксировать время:** `<FILL_T0_HH:MM>` _____

### Шаг 2. Delta-sync (опционально, если есть свежие записи на source)

- [ ] Снять delta-counts source vs target. Если ⩾ 10 новых строк в критичных таблицах:
  - [ ] `pg_dump --data-only --table=...` критичных таблиц.
  - [ ] `TRUNCATE` тех же на target.
  - [ ] `pg_restore` delta в target.
  - [ ] `npm run migrate:yandex:fix-sequences`.
- [ ] Если delta < 10 строк — **skip** этот шаг, принимаем как known noise.

### Шаг 3. Переключить DSN на vds

- [ ] `fot-server/.env`: `DATABASE_URL` указывает на target Yandex.
- [ ] `fot-server/.env`: `DATABASE_SSL=true`, `DATABASE_SSL_CA_PATH=/var/www/fot/.migration/yandex-ca.pem`.
- [ ] `fot-server/.env`: `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` удалены (или пусто — env.ts больше не требует).
- [ ] `fot-data-api/.env`: `DATABASE_URL` указывает на target, без `SUPABASE_*`.
- [ ] Двойной check: `grep DATABASE_URL fot-server/.env` показывает `rc1d-...mdb.yandexcloud.net`.

### Шаг 4. Start services

- [ ] `ssh vds 'pm2 start fot-server'` — лог "FOT Server running on 127.0.0.1:3001" в течение 30 сек.
- [ ] `ssh vds 'pm2 start fot-data-api'` — лог "Uvicorn running on http://127.0.0.1:4001" в течение 15 сек.
- [ ] Никаких `error connecting`, `ECONNREFUSED`, `SSL error`, `prepared statement` ошибок в первой минуте.
- [ ] **Зафиксировать время:** `<FILL_T+START_HH:MM>` _____

### Шаг 5. Self-check (без юзеров)

- [ ] `curl http://localhost:3001/health` → 200 `{status:ok}`.
- [ ] `curl http://localhost:4001/external/v1/health` → 200 `{ok:true}`.
- [ ] `pg_stat_activity` на target показывает соединения от Yandex pooler.
- [ ] Background-сервисы стартовали в логах:
  - [ ] `[skud-summary-reconcile] started`
  - [ ] `[timesheet-reminder] started`
  - [ ] `[daily-tasks-reminder] started`
  - [ ] `[patent-expiry] started`
  - [ ] presence-polling — пишет первый тик (heartbeat обновится через несколько секунд).

### Шаг 6. Manual Sigur API backfill

- [ ] Dry-run: `npm run migrate:yandex:backfill-skud-events -- --dry-run --from=<T-90d> --to=<T> --rate-limit-ms=1000`.
- [ ] Dry-run выдал ожидаемое количество событий (на основе rehearsal: ~20K/день, итого ~1.8M для 90 дней).
- [ ] Apply: `npm run migrate:yandex:backfill-skud-events -- --apply --from=<T-90d> --to=<T> --rate-limit-ms=1000`.
- [ ] Apply завершён `errors: 0`.
- [ ] **Зафиксировать время завершения:** `<FILL_BACKFILL_DONE_HH:MM>` _____

### Шаг 7. Recalculate skud_daily_summary

- [ ] DO-block за backfill-диапазон выполнен (см. RUNBOOK.md T+1.5h секцию).
- [ ] `RAISE NOTICE 'processed N / N'` показывает завершение всех chunk'ов.

### Шаг 8. SK-BF1..SK-BF9 verification

- [ ] SK-BF1: `SELECT event_date, count(*) FROM skud_events GROUP BY 1 ORDER BY 1 DESC LIMIT 10` → ожидаемые числа за каждый день.
- [ ] SK-BF2: `/api/skud/events?date=<вчера>` через UI → список не пустой.
- [ ] SK-BF3: `/api/skud/dashboard` → discipline/presence KPI ненулевые.
- [ ] SK-BF4: `SELECT * FROM sigur_runtime_state WHERE key='presence_polling'` → `heartbeat_at` < 2 мин назад.
- [ ] SK-BF5: `batch_recalculate_skud_daily_summary` отработал без ошибок.
- [ ] SK-BF6: `count(*) - count(DISTINCT dedup_hash) > 0` GROUP BY event_date → **пустой** (нет дублей).
- [ ] SK-BF7: Sample 3-5 случайных employee_id × дат — события реалистичны (часы 6-22, переходы entry/exit).
- [ ] SK-BF8: HR-табель за прошлый месяц для одного сотрудника — hours отображаются корректно.
- [ ] SK-BF9: `verify-public-data` с accepted-флагами → exit 0.

### Шаг 9. UI smoke tests (живой production)

#### Auth domain (CRITICAL)

- [ ] Login существующим пользователем без 2FA → JWT получен.
- [ ] Login с 2FA → TOTP-код принят (ENCRYPTION_KEY корректно расшифровал секрет).
- [ ] Logout → токен инвалидирован.
- [ ] Forgot password flow → email отправлен (или enumeration-safe ответ).

#### Admin (CRITICAL)

- [ ] `/admin/users` — список загружается, email колонка не пустая.
- [ ] Approve pending user → user.is_approved=true, audit row создан.

#### Employees / structure (CRITICAL)

- [ ] `/employees` — пагинация работает, search возвращает результаты.
- [ ] Открыть карточку сотрудника — все поля заполнены.
- [ ] Department tree (`/admin/structure`) — все 328 отделов на месте.

#### Timesheet (CRITICAL)

- [ ] `/timesheet?date=<прошлая неделя>` — табель открывается, hours = ожидаемые.
- [ ] Сохранить корректировку → запись в `attendance_adjustments`.
- [ ] Export Excel → файл скачивается, корректное содержимое.
- [ ] Submit approval → status='submitted', appears в `/approvals`.

#### SKUD/Sigur (CRITICAL после backfill)

- [ ] `/skud` события за вчера — список не пустой, события реальные.
- [ ] `/skud/dashboard` — KPI ненулевые.
- [ ] `sigur_runtime_state` heartbeat обновляется (presence-polling работает).

#### Files / storage (CRITICAL)

- [ ] Загрузить тест-документ → файл в `documents` + Cloud.ru S3.
- [ ] Скачать тот же файл — открывается, MIME правильный.
- [ ] Открыть карту объекта СКУД → изображение загружается (signed URL живой).

#### Data API (1С integration, NOT-CRITICAL — может подождать пост-cutover)

- [ ] `GET /external/v1/health` → 200.
- [ ] `GET /external/v1/tables` с production API-key → список tables.
- [ ] `GET /external/v1/tables/employees?limit=5` → данные.

#### Non-critical (можно после)

- [ ] Patent receipts — открыть существующий чек, расшифровать содержимое.
- [ ] Chat — открыть существующий разговор, прочитать сообщения.
- [ ] Salary raise — открыть открытую заявку (если есть).

### Шаг 10. Финальный verify-public-data

- [ ] Запустить `SKUD_EVENTS_MIGRATION_MODE=sigur_api_manual CONFIRM_SKUD_EVENTS_MANUAL_BACKFILL=true npm run migrate:yandex:verify-public` против live target.
- [ ] Exit 0, `skud_events_status: accepted_manual_backfill`.
- [ ] Diff'ы только в reasonable таблицах (audit_logs, sigur_health_checks от живого роста).

---

## T+24h — контроль через сутки

- [ ] Sentry: нет новых типов ошибок > baseline × 3.
- [ ] HR-табель за сегодня — hours корректны (presence-polling собирает свежие skud_events).
- [ ] `audit_logs` за сутки имеет normal-pattern (LOGIN_SUCCESS, ENTITY_UPDATED).
- [ ] Supabase Dashboard → не видит запросов с prod-хоста с T-0.
- [ ] PM2 uptime fot-server / fot-data-api: оба ⩾ 24h без перезапусков.

## T+7d — закрытие cutover

- [ ] STAGING_REHEARSAL_REPORT.md обновлён: cutover completed YYYY-MM-DD.
- [ ] Supabase project → Pause (не удалять до T+30d).
- [ ] Все `.env.bak.cutover-*` на vds удалены.
- [ ] IPv4 add-on на Supabase (если включали) — выключен.
- [ ] Post-cutover task list (см. RUNBOOK.md § Список post-cutover tasks) в трекере.

---

## 🚨 Если что-то пошло не так

См. [ROLLBACK.md](ROLLBACK.md). Главное правило:

- **Любой FAIL CRITICAL домена** в первые 2 часа после T-0 → **ROLLBACK** (быстрее починить
  возвратом на Supabase, чем расследовать на проде).
- **FAIL non-critical** (patent, chat, salary-raise) → **continue**, фиксируем как
  post-cutover incident.
- **FAIL backfill** (skud_events: events page пустая, dashboard 0) → **continue**,
  скриптом backfill можно повторить (ON CONFLICT защищает). UI с пустым SKUD за 1-2
  часа — приемлемо.
