# Деплой FOT

## Инфраструктура (актуально после Phase 12 cutover, 2026-05-12)

- **Сервер:** `vds` (80.74.28.233, Ubuntu 24.04, Node 22.x, Python 3.12).
- **БД:** Yandex Managed PostgreSQL 17 (кластер `c-bhf80lg9gcvcpvlh`, БД `FOT_Prod`).
  Подключение только через pooler `rc1d-...mdb.yandexcloud.net:6432` (port 5432
  закрыт firewall'ом). Root CA в `/var/www/fot/.migration/yandex-ca.pem`.
- **Object Storage:** Cloud.ru S3 (endpoint `s3.cloud.ru`, регион `ru-central-1`,
  bucket `fot.app`). `OBJECT_STORAGE_FORCE_PATH_STYLE=true` обязателен — bucket
  с точкой не работает в virtual-hosted style из-за SSL cert.
- **PM2 процессы:** `fot-server` (Node, port 3001), `fot-data-api` (Python uvicorn, port 4001).
- **Supabase Cloud:** более не используется в runtime (Phase 10E удалил
  `@supabase/supabase-js`). Project оставлен paused минимум до T+30d после
  cutover как страховка для ROLLBACK (см. [docs/yandex-postgres-migration/ROLLBACK.md](docs/yandex-postgres-migration/ROLLBACK.md)).

Локальный SSH alias `vds` в `~/.ssh/config`:

```sshconfig
Host vds
  HostName 80.74.28.233
  User root
  Port 22
  IdentityFile ~/.ssh/id_ed25519_nas_deploy
  IdentitiesOnly yes
```

## Структура на сервере

```
/var/www/fot/
  fot-app/        # фронтенд (собранный dist/ отдаётся nginx)
  fot-server/     # бэкенд (PM2, Node, port 3001)
  fot-data-api/   # read-only API для 1С (PM2, Python+uvicorn, port 4001)
  .migration/     # yandex-ca.pem и одноразовые миграционные артефакты
```

## Домены

| Домен | Назначение |
|---|---|
| `http://fotsu10.fvds.ru` | HTTP fallback |
| `https://fotsu10.fvds.ru:4443` | HTTPS production endpoint |
| `http://odintsov1.live.fvds.ru` | Odintsov Live |

---

## Быстрый деплой фронта (локальная сборка)

Билдим локально, заливаем `dist/` на vds tar-pipe'ом, atomic swap, без даунтайма.

**Подготовка (один раз):**

1. Скопировать прод-значения из `/var/www/fot/fot-app/.env` (на vds) в `fot-app/.env.production.local`:
   ```
   VITE_API_URL=https://fotsu10.fvds.ru/api
   VITE_SENTRY_DSN=...
   SENTRY_AUTH_TOKEN=...
   SENTRY_ORG=odintsovorg
   SENTRY_PROJECT=fot-app
   ```
   Файл уже в `.gitignore` (паттерн `*.local`).
2. Убедиться что `~/.ssh/config` содержит alias `vds`.
3. `cd fot-app && npm ci` (один раз на dev-машине).

**Деплой:**

```bash
bash scripts/deploy-frontend.sh
```

Если после `git pull` обновился `fot-app/package-lock.json`:

```bash
FRONTEND_NPM_CI=1 bash scripts/deploy-frontend.sh
```

Скрипт: `git fetch origin main` → проверка `HEAD == origin/main` → отказ при
незакоммиченных изменениях в `fot-app/` → подгрузка `.env.production.local` →
`npm ci` если нужно → Vite build → tar-pipe загрузка `dist.new/` на vds → atomic
swap `dist.new` ↔ `dist` → upload sourcemaps в Sentry.

## Фронт fallback на vds (медленный)

```bash
ssh vds
cd /var/www/fot && git pull
cd fot-app && set -a; source .env; set +a
export VITE_SENTRY_RELEASE=$(cd /var/www/fot && git rev-parse --short HEAD)
NODE_OPTIONS='--max-old-space-size=1024' npm run build
```

---

## Деплой бэкенда (`fot-server`)

```bash
bash scripts/deploy-backend.sh
```

С `npm ci` если менялись зависимости:

```bash
BACKEND_NPM_CI=1 bash scripts/deploy-backend.sh
```

Без backend sourcemaps:

```bash
BACKEND_SOURCEMAPS=0 bash scripts/deploy-backend.sh
```

Скрипт: `git fetch origin main` → проверка `HEAD == origin/main` → отказ при
грязных файлах в `fot-server/` → `npm ci` локально если нужно → local Vite-style
TypeScript build → upload sourcemaps Sentry → на vds: `git pull --ff-only` →
`npm ci --omit=dev` если `package-lock.json` изменился → tar-pipe загрузка
`dist.new/` → atomic swap → `set -a; source .env; set +a` → `pm2 restart fot-server --update-env`.

> Для backend sourcemaps читается `fot-server/.env.production.local` если есть,
> иначе `fot-server/.env`. Не коммитить эти файлы.

## Полный деплой (фронт + бэк)

```bash
bash scripts/deploy-both.sh
```

С `npm ci` на обеих сторонах:

```bash
FRONTEND_NPM_CI=1 BACKEND_NPM_CI=1 bash scripts/deploy-both.sh
```

Preflight (`deploy-frontend.sh --check` + `deploy-backend.sh --check`) запускается
автоматически до деплоя.

> **`set -a; source .env; set +a`** перед `pm2 restart` обязателен. `@sentry/vite-plugin`,
> `sentry-cli sourcemaps upload` и `instrument.ts` читают переменные из shell env,
> а не из `.env` напрямую.
>
> **`.env` через `git pull` НЕ синхронизируется** (`.gitignore`). При добавлении
> новых ключей нужно вручную править `/var/www/fot/{fot-server,fot-data-api,fot-app}/.env`.

---

## `.env` файлы

Расположены на сервере, не в git. Структура после Phase 12 cutover:

### `/var/www/fot/fot-server/.env`

Обязательные:

```env
NODE_ENV=production
PORT=3001
CORS_ORIGIN=https://fotsu10.fvds.ru,https://fotsu10.fvds.ru:4443

# БД (Yandex Managed PG)
DATABASE_URL=postgres://Odintsov:<password>@rc1d-m4ubd0uem0j9gqqc.mdb.yandexcloud.net:6432/FOT_Prod?sslmode=verify-full&sslrootcert=/var/www/fot/.migration/yandex-ca.pem
DATABASE_SSL=true
DATABASE_SSL_CA_PATH=/var/www/fot/.migration/yandex-ca.pem
DATABASE_POOL_MAX=10
DATABASE_STATEMENT_TIMEOUT_MS=30000

# Auth (не менять — иначе сломается decrypt существующих 2FA/chat/patent)
JWT_SECRET=...
JWT_REFRESH_SECRET=...
ENCRYPTION_KEY=...   # 64 hex chars (32 bytes AES-256)
TOTP_ISSUER=FOT-App

# Object Storage (Cloud.ru S3)
OBJECT_STORAGE_ENDPOINT=https://s3.cloud.ru
OBJECT_STORAGE_REGION=ru-central-1
OBJECT_STORAGE_ACCESS_KEY_ID=<tenant_uuid>:<key_id>   # склейка через ':'
OBJECT_STORAGE_SECRET_ACCESS_KEY=...
OBJECT_STORAGE_FORCE_PATH_STYLE=true   # bucket с точкой требует path-style

# Sigur
SIGUR_RUNTIME_ALLOWED_HOSTS=odintsov1.live.fvds.ru
SIGUR_INTERNAL_URL=...
SIGUR_INTERNAL_USERNAME=...
SIGUR_INTERNAL_PASSWORD=...

# Web Push
VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=mailto:admin@example.com

# Sentry
SENTRY_DSN=https://...@sentry.io/...
SENTRY_AUTH_TOKEN=...   # для upload sourcemaps
SENTRY_ORG=odintsovorg
SENTRY_PROJECT=fot-server
```

### `/var/www/fot/fot-data-api/.env`

```env
DATABASE_URL=postgres://Odintsov:<password>@rc1d-m4ubd0uem0j9gqqc.mdb.yandexcloud.net:6432/FOT_Prod?sslmode=verify-full&sslrootcert=/var/www/fot/.migration/yandex-ca.pem
DATABASE_SSL=true
DATABASE_SSL_CA_PATH=/var/www/fot/.migration/yandex-ca.pem
DATABASE_POOL_MAX=5
PORT=4001
DEFAULT_RATE_LIMIT_PER_MINUTE=60
```

⚠ В `fot-data-api/.env` **НЕ ставить** `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`
— pydantic-settings приоритезирует shell env над `.env`, и оставшиеся переменные
могут переопределить новый DSN.

### `/var/www/fot/fot-app/.env`

```env
VITE_API_URL=https://fotsu10.fvds.ru/api
VITE_SENTRY_DSN=https://...@sentry.io/...
SENTRY_AUTH_TOKEN=...
SENTRY_ORG=odintsovorg
SENTRY_PROJECT=fot-app
```

### Backup перед deploy

Перед существенным деплоем (изменения в DB-структуре, env-переменных, runtime
поведении) делать backup:

```bash
ssh vds
TS=$(date +%Y%m%d-%H%M%S)
cp /var/www/fot/fot-server/.env /var/www/fot/fot-server/.env.bak.$TS
cp /var/www/fot/fot-data-api/.env /var/www/fot/fot-data-api/.env.bak.$TS
cp /var/www/fot/fot-app/.env /var/www/fot/fot-app/.env.bak.$TS
```

Чистка старых backup'ов: раз в месяц `find /var/www/fot -name ".env.bak.*" -mtime +30 -delete`.

---

## Yandex Managed PG — operational notes

### Подключение

```bash
# На vds — должен быть в pre-loaded shell env
export PSQL_CONN='postgres://Odintsov:<password>@rc1d-m4ubd0uem0j9gqqc.mdb.yandexcloud.net:6432/FOT_Prod?sslmode=verify-full&sslrootcert=/var/www/fot/.migration/yandex-ca.pem'
psql "$PSQL_CONN" -c "SELECT version();"
```

`psql` 17+ обязателен (на vds должен стоять Ubuntu `postgresql-client-17`).

### Yandex CA

Скачать заново, если потерян:

```bash
mkdir -p /var/www/fot/.migration
curl -fsSL https://storage.yandexcloud.net/cloud-certs/CA.pem \
  -o /var/www/fot/.migration/yandex-ca.pem
ls -la /var/www/fot/.migration/yandex-ca.pem   # ~3.5KB ожидается
```

### Extensions

В БД `FOT_Prod` должны быть установлены: `plpgsql`, `pgcrypto`, `btree_gist`,
`pg_trgm`. Управляются через **Yandex Cloud Console** (CLI `yc managed-postgresql
database update --extension ...` или toggle через UI: Cluster → Databases →
FOT_Prod → Изменить → раздел "Расширения").

⚠ Если после `DROP SCHEMA public CASCADE` extensions исчезают, **обычный пользователь
(Odintsov) не может их CREATE EXTENSION** — нужна console-операция от Yandex
admin'a. См. [RUNBOOK.md](docs/yandex-postgres-migration/RUNBOOK.md) и историю Phase 11+12.

### Проверка соединения

```bash
ssh vds
cd /var/www/fot/fot-server
set -a; source .env; set +a
psql "$DATABASE_URL" -c "SELECT current_database(), current_user, pg_is_in_recovery();"
```

Ожидаемое: `FOT_Prod | Odintsov | f` (false = primary, не replica).

### Бэкапы

Yandex Managed PG делает автоматические бэкапы (7 дней retention по default).
Восстановление через Yandex Console или `yc` CLI. **Дополнительно** перед
большими изменениями (Phase 12-style cutover): использовать pg_dump на dev-машину:

```bash
pg_dump --format=custom --no-owner --no-acl --jobs=2 \
  --file=/local/backup_FOT_Prod_$(date +%Y%m%d).dump \
  "$DATABASE_URL"
```

---

## Sigur runtime guard

После Phase 10D allowlist жёстко привязан к прод-хосту. По умолчанию:

```env
SIGUR_RUNTIME_ALLOWED_HOSTS=odintsov1.live.fvds.ru
```

На dev / вне allowlist backend стартует, но **не** поднимает:
- `presence-polling`
- `sigur-monitor`
- `structure-scheduler`
- `events-daily-scheduler`

Ручные Sigur sync с не-allowed хоста возвращают `403 SIGUR_RUNTIME_NOT_ALLOWED`.
Для bypass на dev: `SIGUR_RUNTIME_ALLOWED_HOSTS='*'`.

### После каждого deploy `fot-server` — 5 проверок

#### 1. PM2 здоров

```bash
ssh vds
pm2 status fot-server
```

Ожидание: `online`, без restart-loop.

#### 2. Lease у prod-процесса, не у dev

Через psql к target Yandex (см. § "Подключение" выше):

```sql
SELECT
  checkpoint_at,
  lease_owner,
  lease_expires_at,
  meta->'lastCycle'->>'leaseOwner' AS last_cycle_owner,
  meta->>'leaderOwner' AS leader_owner
FROM sigur_runtime_state
WHERE key = 'sigur_presence_polling';
```

Ожидание:
- `leader_owner` / `last_cycle_owner` принадлежат prod-хосту (например, `sigur_presence_polling:odintsov1.live.fvds.ru:<pid>`).
- `lease_owner` между циклами polling может быть `NULL` — норма.
- НЕ должно быть владельцев вида `WIN:` / `PC-...` / `dev-...`.

#### 3. Sentry чист по clock skew

```bash
ssh vds
cd /var/www/fot/fot-server
set -a; source .env; set +a
./node_modules/@sentry/cli/bin/sentry-cli issues list \
  --org "$SENTRY_ORG" --project "$SENTRY_PROJECT" \
  --query "clock_skew_lease_refused is:unresolved" \
  --max-rows 20
```

Ожидание: пусто. Если `sentry-cli` отвечает 403 — токен из `.env` не имеет прав
на Issues, проверять через Sentry UI.

#### 4. События реально идут

```sql
SELECT MAX(created_at) AS last_created_at FROM skud_events;
```

Ожидание: `last_created_at` близко к `NOW()` в часы реальной активности.

#### 5. Daily sync отработал после 05:00 MSK

```sql
SELECT
  meta->>'lastRunYmdMsk' AS last_run_ymd_msk,
  meta->>'lastSuccessAt' AS last_success_at,
  meta->'lastResult'->>'errors' AS errors,
  meta->'lastResult'->>'imported' AS imported,
  meta->>'lastError' AS last_error
FROM sigur_runtime_state
WHERE key = 'sigur_events_daily';
```

Ожидание: `errors = 0`, `lastError` пустой, `lastRunYmdMsk` = текущая дата по
Москве (если уже после 05:00 MSK).

### Снять залипший lease

```sql
SELECT key, lease_owner, lease_expires_at, heartbeat_at
FROM sigur_runtime_state
WHERE key IN ('sigur_presence_polling', 'sigur_exclusive_sync');

-- Если lease_owner точно мёртвый процесс:
SELECT release_sigur_runtime_lease('sigur_presence_polling', '<lease_owner_string>');
SELECT release_sigur_runtime_lease('sigur_exclusive_sync', '<lease_owner_string>');
```

После release — `pm2 restart fot-server --update-env`, потом 5 проверок выше.

---

## Public Data API (`fot-data-api`, FastAPI/Python)

Отдельный read-only сервис для 1С. Внешние программисты ходят на
`https://fotsu10.fvds.ru/external/v1/*` с заголовком `Authorization: Bearer
fot_<prefix>_<secret>`. Ключи и whitelist таблиц/полей — через админ-вкладку
«API-доступ» в FOT.

### Установка (первый раз)

```bash
ssh vds
apt install -y python3.12 python3.12-venv
cd /var/www/fot/fot-data-api
python3.12 -m venv .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements.txt

# .env (см. § ".env файлы" выше)
nano /var/www/fot/fot-data-api/.env
chmod 600 /var/www/fot/fot-data-api/.env

# проверка
.venv/bin/python -m compileall -q app && echo "py ok"
```

### Запуск через PM2 — правильная команда

⚠ **`pm2 start "<command>"` без `--interpreter none` пытается запустить uvicorn-скрипт
через Node.js** → `SyntaxError: Unexpected identifier 'uvicorn'`. Обязательно
`--interpreter none`:

```bash
cd /var/www/fot/fot-data-api
pm2 start ".venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4001" \
  --name fot-data-api \
  --cwd /var/www/fot/fot-data-api \
  --interpreter none
pm2 save
```

### Альтернатива: явный путь к Python interpreter

```bash
pm2 start /var/www/fot/fot-data-api/.venv/bin/uvicorn \
  --name fot-data-api \
  --cwd /var/www/fot/fot-data-api \
  --interpreter none \
  -- app.main:app --host 127.0.0.1 --port 4001
pm2 save
```

### Обновление зависимостей после deploy

```bash
ssh vds
cd /var/www/fot/fot-data-api
.venv/bin/pip install -q -r requirements.txt
pm2 restart fot-data-api
```

### Применение миграций (одноразово, при первой установке)

```bash
psql "$DATABASE_URL" -f /var/www/fot/docs/migrations/060_data_api.sql
```

(После Phase 12 cutover все миграции уже применены на target Yandex.)

### Проверка

```bash
# На vds
curl -fsS http://127.0.0.1:4001/external/v1/health
# {"ok":true}

# Через nginx наружу
curl -fsS https://fotsu10.fvds.ru/external/v1/health
# {"ok":true}
```

Swagger UI (debug): `https://fotsu10.fvds.ru/external/v1/docs`.

### PM2 команды

```bash
pm2 logs fot-data-api --lines 50 --nostream
pm2 restart fot-data-api
pm2 describe fot-data-api   # текущая команда запуска + cwd
```

---

## Nginx

Конфиги:

```
/etc/nginx/sites-enabled/fotsu10
/etc/nginx/sites-enabled/odintsov1live
```

Проверка:

```bash
nginx -t
```

### Reload (на этом сервере)

`nginx.service` иногда показывает `failed/inactive`, при этом запущены
несколько master-процессов. Перед reload:

```bash
systemctl status nginx --no-pager
ps -C nginx -o pid,ppid,cmd
```

Если меняется FOT-конфиг — определить, какой master обслуживает
`/etc/nginx/sites-enabled/fotsu10`, и сделать **точечный reload** этого master:

```bash
kill -HUP <pid_of_FOT_master>
```

### Backup-конфиги вне sites-enabled

Не хранить `fotsu10.bak.*` в `sites-enabled/` — это засоряет `nginx -t` и путает
правки. Лучше в `/etc/nginx/sites-disabled/` или `/root/nginx-backups/`.

### Статика и SPA-fallback

Чанки Vite именуются по content-hash. После деплоя старые имена пропадают. Если
SPA-fallback ловит `/assets/*.js`, браузер получит HTML и упадёт на module
script MIME check. Обязательно отдельный location для статики **до** общего
`try_files`:

```nginx
location ~* ^/assets/ {
    root /var/www/fot/fot-app/dist;
    try_files $uri =404;
    expires 1y;
    add_header Cache-Control "public, immutable";
}

location / {
    root /var/www/fot/fot-app/dist;
    try_files $uri /index.html;
}
```

Фронт автоматически перезагружается при stale-chunk через `utils/staleChunkReload.ts`.

### Маршрут для `/external/v1` (Public Data API)

```nginx
location /external/v1/ {
    proxy_pass http://127.0.0.1:4001/external/v1/;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 30s;
}
```

Перечитать: `nginx -t && kill -HUP <FOT_master_pid>`.

---

## SSL

`fotsu10.fvds.ru` использует Let's Encrypt:

```
/etc/letsencrypt/live/fotsu10.fvds.ru/fullchain.pem
/etc/letsencrypt/live/fotsu10.fvds.ru/privkey.pem
```

Текущий HTTPS endpoint:

```
https://fotsu10.fvds.ru:4443
```

⚠ Порты 80 и 4443 живут параллельно, **редиректа HTTP→HTTPS нет**.

Продление:

```bash
certbot renew --dry-run
```

Ручной перевыпуск:

```bash
certbot certonly --webroot -w /var/www/certbot -d fotsu10.fvds.ru
```

---

## Swap (для Vite local build)

2GB swap на vds:

```bash
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

---

## PM2 команды (общие)

```bash
pm2 status                       # все процессы
pm2 logs fot-server --lines 100 --nostream
pm2 logs fot-data-api --lines 100 --nostream
pm2 restart fot-server --update-env
pm2 restart fot-data-api
pm2 save                         # сохранить текущий список процессов для resurrection
pm2 startup                      # настроить autostart после reboot
```

---

## Миграции БД (Phase 10+11+12 наследие)

Полный pipeline миграции Supabase → Yandex описан в:

- **[docs/yandex-postgres-migration/RUNBOOK.md](docs/yandex-postgres-migration/RUNBOOK.md)** — chronological cutover order.
- **[docs/yandex-postgres-migration/CHECKLIST.md](docs/yandex-postgres-migration/CHECKLIST.md)** — tickable checklist для cutover-окна.
- **[docs/yandex-postgres-migration/ROLLBACK.md](docs/yandex-postgres-migration/ROLLBACK.md)** — failure scenarios.
- **[docs/yandex-postgres-migration/09_skud_events_migration.md](docs/yandex-postgres-migration/09_skud_events_migration.md)** — Sigur API backfill для skud_events.
- **[docs/yandex-postgres-migration/STAGING_REHEARSAL_REPORT.md](docs/yandex-postgres-migration/STAGING_REHEARSAL_REPORT.md)** — final rehearsal results.

Будущие migration scripts применяются вручную через psql от vds к target:

```bash
ssh vds
cd /var/www/fot
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/migrations/<NNN>_*.sql
```

Авто-миграций (Flyway/Sequelize/Knex) нет — все changes через нумерованные SQL
в `docs/migrations/`.

---

## Smoke-проверки после deploy

После любого деплоя `fot-server` / `fot-data-api`:

```bash
# 1. fot-server health
curl -fsS http://127.0.0.1:3001/health
# {"status":"ok","timestamp":"..."}

# 2. fot-data-api health
curl -fsS http://127.0.0.1:4001/external/v1/health
# {"ok":true}

# 3. Через nginx
curl -fsS https://fotsu10.fvds.ru/api/auth/login -X POST \
  -H "Content-Type: application/json" -d '{}'
# 400 "Required" — auth-validator работает

curl -fsS https://fotsu10.fvds.ru/external/v1/health
# {"ok":true}

# 4. Sigur presence-polling — heartbeat должен обновляться
psql "$DATABASE_URL" -tA -c "
  SELECT key, heartbeat_at, NOW() - heartbeat_at AS lag
  FROM sigur_runtime_state
  WHERE key = 'sigur_presence_polling';
"
# lag < 2 минуты (между тиками polling 60-90 сек)
```

---

## История ключевых изменений

### Phase 10 (Supabase SDK → pg.Pool, 2026-05)
- 10A-10F: миграция runtime fot-server (services + controllers) с `@supabase/supabase-js` на прямой `pg.Pool`. Удалён SDK из package.json.
- 10G: миграция fot-data-api (Python) с supabase Python SDK на psycopg async.
- Полный отчёт: [docs/yandex-postgres-migration/08_backend_rewrite_progress.md](docs/yandex-postgres-migration/08_backend_rewrite_progress.md).

### Phase 11+12 (Supabase Cloud → Yandex Managed PG cutover, 2026-05-12)
- Target: Yandex Managed PG `FOT_Prod` (PG 17.9, primary `rc1d-...`).
- Storage: Cloud.ru S3 (`fot.app` bucket).
- skud_events DB migration намеренно skipped — production-путь = manual Sigur
  API backfill через `presence-polling.service`.
- Pre-cutover rehearsal: [STAGING_REHEARSAL_REPORT.md](docs/yandex-postgres-migration/STAGING_REHEARSAL_REPORT.md).
- Cutover hotfix `f9139d7`: pg-node возвращал `date`-колонки как Date object
  вместо ISO-строки — pg.types.setTypeParser(1082, val=>val) восстановил Supabase-
  compatible behavior. Без этого `schedule.service.getCycleSlot` падал на каждом
  обращении к timesheet/skud/dashboard.

### Чат, документы — недавние
- Чат: socket.io-client, AES-256-GCM encryption (`encryptionService`), плавающая
  боковая панель, toast-уведомления, поиск пользователей с `is_approved`.
- Документы: upload через `POST /api/documents/upload` (multipart), бэкенд сам
  кладёт в S3 (без presigned URL — обход CORS Cloud.ru). SSE-KMS сохранён через
  `r2.uploadObject(key, body, contentType)`.
