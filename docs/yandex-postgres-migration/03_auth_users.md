# 03 — Перенос пользователей `auth.users` → `app_auth.users`

## Зачем

После миграции 088 ([yandex_app_auth.sql](../migrations/088_yandex_app_auth.sql))
схема `app_auth` создана, но пуста. Чтобы пользователи могли логиниться в
новом кластере (Yandex Managed PG или чистый Supabase) тем же паролем, что
и в боевом Supabase, надо перенести записи из `auth.users` в `app_auth.users`
с сохранением `encrypted_password` (bcrypt-хеш — `bcryptjs.compare` понимает
форматы `$2a$`/`$2b$`/`$2y$`).

Скрипт:
[fot-server/scripts/yandex-migration/migrate-auth-users.ts](../../fot-server/scripts/yandex-migration/migrate-auth-users.ts)

## Использование

```bash
# Справка
cd fot-server
npm run migrate:yandex:auth-users -- --help

# Dry-run (по умолчанию — ничего не пишет в target)
SOURCE_DATABASE_URL=postgres://... \
TARGET_DATABASE_URL=postgres://... \
npm run migrate:yandex:auth-users -- --dry-run

# Реальная запись
SOURCE_DATABASE_URL=postgres://... \
TARGET_DATABASE_URL=postgres://... \
npm run migrate:yandex:auth-users -- --apply
```

## ENV

| Переменная | Default | Описание |
|---|---|---|
| `SOURCE_DATABASE_URL` | — | Supabase PG connection (источник `auth.users`) |
| `TARGET_DATABASE_URL` | — | Yandex Managed PG (цель `app_auth.users`) |
| `SOURCE_SSL` | `true` | Включить TLS для источника |
| `TARGET_SSL` | `true` | Включить TLS для цели |
| `SOURCE_SSL_CA_PATH` | — | PEM-CA для source (опционально; обычно не нужно для Supabase Cloud) |
| `TARGET_SSL_CA_PATH` | — | PEM-CA для target (обычно требуется для YC — `~/.yandex/ca.pem`) |
| `DRY_RUN` | `true` | Запись разрешена только если `DRY_RUN=false` ИЛИ `--apply` |
| `BATCH_SIZE` | `500` | Размер батча при чтении из source через server-side cursor |

CLI-флаги (`--dry-run` / `--apply`) имеют приоритет над `DRY_RUN`.

## Что делает скрипт

1. **Counts**: считает `source.auth.users` и `target.app_auth.users` (до).
2. **Email-index target**: загружает `id → lower(email)` из существующих
   записей цели — нужно для детектирования конфликтов.
3. **Stream source**: открывает серверный курсор по `auth.users`
   (`ORDER BY created_at, id`), читает по `BATCH_SIZE` строк.
4. **На каждой строке**:
   - skip, если `email IS NULL` или пустой → `skippedNoEmail++`;
   - skip, если `encrypted_password IS NULL` или пустой →
     `skippedPasswordless++`, попадает в `passwordlessSamples` (до 10);
   - skip, если хеш не `$2[aby]$NN$` → `skippedUnsupportedHash++`, в
     `unsupportedHashSamples` (полный хеш НЕ показывается, только prefix);
   - если `lower(email)` уже занят в target другим id → `conflicts[]`;
   - иначе `UPSERT INTO app_auth.users ... ON CONFLICT (id) DO UPDATE`
     (только при `--apply`).
5. **Verification**: 5 случайных id из обработанных — сверка `email`,
   `email_confirmed_at`, длины и prefix хеша. Полный bcrypt никогда не
   показывается.
6. **Отчёты**:
   - `.migration/auth_users_report.json` — полный машиночитаемый отчёт.
   - `.migration/auth_users_report.md` — человекочитаемый.

## Маппинг полей

| `source.auth.users` | `target.app_auth.users` |
|---|---|
| `id` | `id` |
| `email` (lower+trim) | `email` |
| `encrypted_password` | `password_hash` |
| `email_confirmed_at` | `email_confirmed_at` |
| `last_sign_in_at` | `last_sign_in_at` |
| `raw_app_meta_data` | `raw_app_meta_data` |
| `raw_user_meta_data` | `raw_user_meta_data` |
| `created_at` | `created_at` |
| `updated_at` (NULL → `created_at`) | `updated_at` |
| — | `migrated_from = 'supabase_auth'` |
| — | `migrated_at = now()` |

## Безопасность

- **DRY_RUN по умолчанию** — реальная запись только через `--apply` или
  `DRY_RUN=false`.
- **TLS обязателен** — `*_SSL` отключаются явно (`false`), не «забывается».
  `rejectUnauthorized: true` всегда; CA из `*_SSL_CA_PATH`, если задан.
- **Хеши не логируются** — ни в stdout, ни в JSON-отчёте полный
  `password_hash` не появляется. Только `$2a$10$… (60 chars)`.
- **UPSERT идемпотентен** — повторный прогон не дублирует и не теряет данные.
- **Конфликт `lower(email)` → exit 1** — миграция честно падает, чтобы
  оператор разобрался (обычно это «один и тот же человек завёлся дважды»).
- **Server-side cursor** — память не растёт линейно от размера `auth.users`.

## Exit-коды

| Код | Значение |
|---|---|
| `0` | Успех (DRY_RUN или APPLY без конфликтов) |
| `1` | Завершено, но есть конфликты `lower(email)` — см. `conflicts[]` |
| `2` | Fatal: упало подключение / непредвиденная PG-ошибка |

## Что делать с пропущенными

- **Passwordless users** (OAuth-only в Supabase Auth) — после миграции
  нужно: либо пометить их `is_disabled = true` и завести через сброс
  пароля, либо реализовать OAuth-логин отдельно.
- **Unsupported hash format** — крайне редко (Supabase использует bcrypt
  с `$2a$`); если встретился, проверьте, не сидит ли он в плагине
  Argon2 или другом формате.
- **Conflicts `lower(email)`** — нужно вручную смержить две записи
  (`UPDATE user_profiles SET id = ...` либо удалить дубликат) перед
  повторным запуском.

## Чек-лист перед `--apply`

1. Прогнать `--dry-run` — посмотреть итог и `conflicts.length`.
2. Открыть `.migration/auth_users_report.md` — проверить, что
   `processed = inserted + skipped*` и нет неожиданных skip'ов.
3. Убедиться, что миграция 088 уже применена на target:
   `SELECT 1 FROM information_schema.tables WHERE table_schema='app_auth' AND table_name='users';`
4. Бэкап target БД (`pg_dump --schema=app_auth ...`).
5. `--apply`.

## FK `user_profiles → app_auth.users` создаётся отдельно

Cross-schema FK **не** создаются миграцией 088 (она владеет только
схемой `app_auth`). FK имеют смысл только когда обе таблицы наполнены
— иначе VALIDATE упадёт на orphans.

На source-side production через `pg_get_constraintdef` (см.
[STAGING_REHEARSAL_REPORT.md](STAGING_REHEARSAL_REPORT.md) Finding 2)
обнаружены **6 FK на `auth.users`**, которые транформер стрипает:
один главный (`user_profiles_id_fkey`) и пять побочных. Они
восстанавливаются раздельно.

### Главный FK `user_profiles(id) → app_auth.users(id)`

Полный lifecycle (sanity → orphans → drop legacy → create NOT VALID →
VALIDATE → post-check `convalidated=true`) выполняет
[`validate-auth-fk.ts`](../../fot-server/scripts/yandex-migration/validate-auth-fk.ts):

```bash
cd fot-server
npm run migrate:yandex:validate-auth-fk
```

### 5 secondary FK на `app_auth.users(id)`

| FK | from table | column | ON DELETE |
|---|---|---|---|
| `user_profiles_approved_by_fkey` | `user_profiles` | `approved_by` | NO ACTION |
| `audit_logs_user_id_fkey` | `audit_logs` | `user_id` | NO ACTION |
| `employee_assignments_created_by_fkey` | `employee_assignments` | `created_by` | NO ACTION |
| `fk_push_subscriptions_user` | `push_subscriptions` | `user_id` | **CASCADE** |
| `tender_salary_history_created_by_fkey` | `salary_history` | `created_by` | NO ACTION |

Атрибуты сняты с боевой Supabase, не угаданы.

Применение в 2 шага:

```bash
# 1. (опционально) применить миграцию 089 — создаёт 5 FK как NOT VALID
psql "$TARGET_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f docs/migrations/089_yandex_auth_user_fks.sql

# 2. orphan-check + VALIDATE + post-check pg_constraint.convalidated
cd fot-server
npm run migrate:yandex:validate-auth-fks
```

Шаг 1 опционален — `validate-auth-fks` сам создаст недостающие FK
с правильными атрибутами после orphan-check.

Запускать **после**:
- restore данных в `public` (`restore-public-data.sh` →
  apply `yandex_schema_post_data.sql`);
- backfill `app_auth.users` через этот скрипт (`--apply`);
- (рекомендуется) валидации главного FK через `validate-auth-fk.ts`.

Подробно — [05_public_data.md](05_public_data.md) шаги 13-15.

### Финальная проверка через preflight

После того как `validate-auth-fk.ts` и `validate-auth-fks.ts` отработали,
запустите [preflight-yandex-db.ts](../../fot-server/scripts/yandex-migration/preflight-yandex-db.ts):

```bash
cd fot-server
npm run migrate:yandex:preflight
```

Группа `app_auth_foreign_keys` проверяет каждый из 6 ожидаемых FK
(1 primary + 5 secondary) и фиксирует в отчёте:

| Поле | Что показывает |
|---|---|
| `constraint_name` | Фактическое имя FK в `pg_constraint.conname` |
| `source_table` | `public.<table>` |
| `source_column` | Имя колонки |
| `referenced_schema` | Должно быть `app_auth` |
| `referenced_table` | Должно быть `users` |
| `convalidated` | Должно быть `true` |
| `status` | `ok` / `missing` / `wrong_target` / `not_validated` / `skipped_table_missing` |

**Critical fail** в этой группе означает:
- FK отсутствует (запустите соответствующий validate-скрипт);
- FK ссылается не на `app_auth.users` (legacy FK на `auth.users` не удалён, или 089 не применён);
- FK существует, но `convalidated=false` (`VALIDATE CONSTRAINT` не вызывался или провалился на orphans).

## Связанные документы

- [`00_inventory_v2.md`](00_inventory_v2.md) §4 — список всех Auth-точек.
- [`01_recover_runtime_functions.md`](01_recover_runtime_functions.md) — параллельная миграция SQL-функций.
- [`02_sql_helpers.md`](02_sql_helpers.md) — SQL toolkit (не используется
  миграционным скриптом напрямую: скрипт ходит через `pg`-driver, не через
  `BaseRepository`).
- [`../migrations/088_yandex_app_auth.sql`](../migrations/088_yandex_app_auth.sql) — DDL целевой схемы.
- [`../../fot-server/src/services/local-auth.service.ts`](../../fot-server/src/services/local-auth.service.ts) — runtime-сервис, читающий из этой таблицы.
