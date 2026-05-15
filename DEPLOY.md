# Деплой FOT

Рабочая инструкция по деплою проекта FOT на production-сервер
`fot.su10.ru`.

Главная идея простая: в production попадает код из `origin/main`. Перед
деплоем нужные изменения должны быть закоммичены и запушены в GitHub.

## Production

| Что | Значение |
|---|---|
| Домен | `https://fot.su10.ru` |
| Сервер | `45.80.128.254` |
| SSH | `ssh root@45.80.128.254` |
| Hostname | `hub` |
| Корень проекта | `/srv/sites/fot.su10.ru` |
| Frontend | `/srv/sites/fot.su10.ru/fot-app/dist` |
| Backend | PM2 `fot-server`, `127.0.0.1:3001` |
| Public Data API | PM2 `fot-data-api`, `127.0.0.1:4001` |
| Nginx vhost | `/etc/nginx/sites-available/fot.su10.ru` |
| Совместимый symlink | `/var/www/fot` -> `/srv/sites/fot.su10.ru` |

Runtime использует Yandex Managed PostgreSQL и Cloud.ru S3. Production runtime
не использует Supabase Cloud.

## Самый Частый Деплой

Если ты уже подключаешься к серверу по SSH, используй серверный скрипт:

```bash
ssh root@45.80.128.254
cd /srv/sites/fot.su10.ru

git pull --ff-only origin main
bash scripts/deploy-server.sh --check
bash scripts/deploy-server.sh both
```

`--check` ничего не деплоит. Он проверяет сервер, nginx, PM2, env-файлы и
health endpoints.

`both` деплоит backend и frontend. Для полного деплоя вместе с Public Data API:

```bash
bash scripts/deploy-server.sh all
```

Доступные scope:

```bash
bash scripts/deploy-server.sh frontend
bash scripts/deploy-server.sh backend
bash scripts/deploy-server.sh data-api
bash scripts/deploy-server.sh both
bash scripts/deploy-server.sh all
```

Что делает `scripts/deploy-server.sh`:

- проверяет, что скрипт запущен на hostname `hub`;
- проверяет чистый git tree на сервере;
- проверяет наличие `.env` файлов и `.migration/yandex-ca.pem`;
- выполняет `git fetch` и `git pull --ff-only origin main`;
- собирает нужные части проекта прямо на сервере;
- атомарно заменяет `dist`;
- перезапускает PM2-процессы;
- выполняет `pm2 save`;
- прогоняет проверки через `curl`.

## Деплой С Локального Компьютера

Есть отдельный сценарий, когда сборка делается локально, а на сервер
копируются готовые артефакты:

```bash
git fetch origin main
git status --short
git rev-parse --short HEAD
git rev-parse --short origin/main

bash scripts/deploy-production.sh --check
bash scripts/deploy-production.sh both
```

Для frontend локально нужен файл `fot-app/.env.production.local`. Он не
коммитится.

Минимум:

```env
VITE_API_URL=https://fot.su10.ru/api
VITE_SENTRY_DSN=...
SENTRY_AUTH_TOKEN=...
SENTRY_ORG=odintsovorg
SENTRY_PROJECT=fot-app
```

Доступные scope локального скрипта:

```bash
bash scripts/deploy-production.sh frontend
bash scripts/deploy-production.sh backend
bash scripts/deploy-production.sh data-api
bash scripts/deploy-production.sh both
bash scripts/deploy-production.sh all
```

Короткие команды оставлены как удобные обертки:

```bash
bash scripts/deploy-frontend.sh
bash scripts/deploy-backend.sh
bash scripts/deploy-both.sh
```

## Полезные Флаги

Для серверного скрипта:

```bash
BACKEND_NPM_CI=1 bash scripts/deploy-server.sh backend
FRONTEND_NPM_CI=1 bash scripts/deploy-server.sh frontend
DATA_API_PIP_INSTALL=1 bash scripts/deploy-server.sh data-api
BACKEND_SOURCEMAPS=1 bash scripts/deploy-server.sh backend
SKIP_VERIFY=1 bash scripts/deploy-server.sh both
```

Для локального скрипта:

```bash
BACKEND_NPM_CI=1 bash scripts/deploy-production.sh backend
FRONTEND_NPM_CI=1 bash scripts/deploy-production.sh frontend
DATA_API_PIP_INSTALL=1 bash scripts/deploy-production.sh data-api
BACKEND_SOURCEMAPS=1 bash scripts/deploy-production.sh backend
SKIP_VERIFY=1 bash scripts/deploy-production.sh both
```

`BACKEND_NPM_CI=1`, `FRONTEND_NPM_CI=1` и `DATA_API_PIP_INSTALL=1` полезны,
если менялись зависимости или есть сомнение в состоянии `node_modules`/`.venv`.

## Ручной Деплой Backend

Обычно ручной деплой не нужен, но порядок такой.

Локально:

```bash
export FOT_SSH=root@45.80.128.254
export FOT_ROOT=/srv/sites/fot.su10.ru

git fetch origin main
git status --short

cd fot-server
npm ci
npm run build
```

На сервере подтянуть код:

```bash
ssh "$FOT_SSH" "cd $FOT_ROOT && git pull --ff-only origin main"
```

Залить backend build:

```bash
tar czf - -C dist . | ssh "$FOT_SSH" '
set -e
TARGET=/srv/sites/fot.su10.ru/fot-server
rm -rf "$TARGET/dist.new"
mkdir -p "$TARGET/dist.new"
tar xzf - -C "$TARGET/dist.new"
'
```

Активировать backend:

```bash
ssh "$FOT_SSH" '
set -e
cd /srv/sites/fot.su10.ru/fot-server

if [ ! -d node_modules ]; then
  npm ci --omit=dev
fi

rm -rf dist.old
[ -d dist ] && mv dist dist.old
mv dist.new dist
rm -rf dist.old

pm2 restart fot-server --update-env
pm2 save
pm2 status fot-server
'
```

Если менялись `fot-server/package.json` или `fot-server/package-lock.json`,
перед restart обязательно обнови зависимости на сервере:

```bash
ssh "$FOT_SSH" "cd $FOT_ROOT/fot-server && npm ci --omit=dev"
```

## Ручной Деплой Frontend

Локально:

```bash
export FOT_SSH=root@45.80.128.254
export FOT_ROOT=/srv/sites/fot.su10.ru
export RELEASE=$(git rev-parse --short HEAD)

cd fot-app
npm ci

set -a
source .env.production.local
set +a

export VITE_SENTRY_RELEASE="$RELEASE"
export SENTRY_RELEASE="$RELEASE"
NODE_OPTIONS='--max-old-space-size=2048' npm run build
```

Залить и активировать frontend:

```bash
tar czf - -C dist . | ssh "$FOT_SSH" '
set -e
TARGET=/srv/sites/fot.su10.ru/fot-app
rm -rf "$TARGET/dist.new"
mkdir -p "$TARGET/dist.new"
tar xzf - -C "$TARGET/dist.new"

rm -rf "$TARGET/dist.old"
[ -d "$TARGET/dist" ] && mv "$TARGET/dist" "$TARGET/dist.old"
mv "$TARGET/dist.new" "$TARGET/dist"
rm -rf "$TARGET/dist.old"

find "$TARGET/dist" -type d -exec chmod 755 {} \;
find "$TARGET/dist" -type f -exec chmod 644 {} \;
'
```

Frontend не требует PM2 restart.

## Public Data API

У `fot-data-api` нет отдельной сборки. После `git pull` нужно обновить venv при
изменении зависимостей и перезапустить PM2:

```bash
ssh root@45.80.128.254
cd /srv/sites/fot.su10.ru/fot-data-api

if [ ! -d .venv ]; then
  python3.12 -m venv .venv
fi

.venv/bin/pip install -r requirements.txt
.venv/bin/python -m compileall -q app
pm2 restart fot-data-api --update-env
pm2 save
pm2 status fot-data-api
```

Через скрипт это короче:

```bash
cd /srv/sites/fot.su10.ru
bash scripts/deploy-server.sh data-api
```

## Env И Секреты

Секреты живут только на сервере и не коммитятся:

```text
/srv/sites/fot.su10.ru/fot-server/.env
/srv/sites/fot.su10.ru/fot-data-api/.env
/srv/sites/fot.su10.ru/fot-app/.env
/srv/sites/fot.su10.ru/.migration/yandex-ca.pem
```

Перед ручным изменением env сделай backup:

```bash
ssh root@45.80.128.254
cd /srv/sites/fot.su10.ru

TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/fot-env-backups/$TS
cp fot-server/.env /root/fot-env-backups/$TS/fot-server.env
cp fot-data-api/.env /root/fot-env-backups/$TS/fot-data-api.env
cp fot-app/.env /root/fot-env-backups/$TS/fot-app.env
cp .migration/yandex-ca.pem /root/fot-env-backups/$TS/yandex-ca.pem
```

Ключевые backend-переменные:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
CORS_ORIGIN=https://fot.su10.ru

DATABASE_URL=postgres://...
DATABASE_SSL=true
DATABASE_SSL_CA_PATH=/srv/sites/fot.su10.ru/.migration/yandex-ca.pem

JWT_SECRET=...
JWT_REFRESH_SECRET=...
ENCRYPTION_KEY=...

SIGUR_RUNTIME_ALLOWED_HOSTS=hub
SIGUR_EXTERNAL_URL=...
SIGUR_EXTERNAL_USERNAME=...
SIGUR_EXTERNAL_PASSWORD=...

SENTRY_DSN=...
SENTRY_AUTH_TOKEN=...
SENTRY_ORG=odintsovorg
SENTRY_PROJECT=fot-server
```

Ключевые frontend-переменные:

```env
VITE_API_URL=https://fot.su10.ru/api
VITE_SENTRY_DSN=...
SENTRY_AUTH_TOKEN=...
SENTRY_ORG=odintsovorg
SENTRY_PROJECT=fot-app
```

Ключевые Public Data API-переменные:

```env
DATABASE_URL=postgres://...
DATABASE_SSL=true
DATABASE_SSL_CA_PATH=/srv/sites/fot.su10.ru/.migration/yandex-ca.pem
DATABASE_POOL_MAX=5
PORT=4001
DEFAULT_RATE_LIMIT_PER_MINUTE=60
```

В `fot-data-api/.env` не добавляй `SUPABASE_URL` и
`SUPABASE_SERVICE_ROLE_KEY`.

## Миграции БД

SQL-миграции из `docs/migrations/` применяются вручную через `psql`.
Автоматического запуска миграций в деплой-скриптах нет.

```bash
ssh root@45.80.128.254
cd /srv/sites/fot.su10.ru
git pull --ff-only origin main

cd /srv/sites/fot.su10.ru/fot-server
export DATABASE_URL="$(node -e "require('dotenv').config({override:true}); process.stdout.write(process.env.DATABASE_URL || '')")"
export PGSSLROOTCERT=/srv/sites/fot.su10.ru/.migration/yandex-ca.pem
test -n "$DATABASE_URL"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f /srv/sites/fot.su10.ru/docs/migrations/<NNN>_<name>.sql

pm2 restart fot-server --update-env
pm2 save
```

Пример:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f /srv/sites/fot.su10.ru/docs/migrations/096_timesheet_team_mgmt_access.sql
```

## Проверки После Деплоя

На сервере:

```bash
pm2 status
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:4001/external/v1/health
ss -tulpn | grep -E ':(3001|4001)\b'
nginx -t
```

Снаружи:

```bash
curl -I https://fot.su10.ru/
curl -fsS https://fot.su10.ru/external/v1/health
curl -i https://fot.su10.ru/api/auth/login \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{}'
```

Для `/api/auth/login` с пустым `{}` нормальный результат — `400` или `422`.
`502` означает, что nginx не достучался до backend.

В браузере после крупного деплоя проверь:

- логин;
- сотрудников;
- табель;
- СКУД live/presence;
- чат и realtime-уведомления;
- загрузку документов;
- админские доступы.

## PM2

Обычные команды:

```bash
pm2 status
pm2 logs fot-server --lines 100 --nostream
pm2 logs fot-data-api --lines 100 --nostream
pm2 restart fot-server --update-env
pm2 restart fot-data-api --update-env
pm2 save
```

После изменения списка процессов всегда выполняй `pm2 save`.

Первичный запуск, если процесса нет:

```bash
pm2 start /srv/sites/fot.su10.ru/fot-server/dist/index.js \
  --name fot-server \
  --cwd /srv/sites/fot.su10.ru/fot-server

pm2 start ".venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4001" \
  --name fot-data-api \
  --cwd /srv/sites/fot.su10.ru/fot-data-api \
  --interpreter none

pm2 save
```

## Nginx И SSL

Обычно nginx трогать не нужно. Проверка конфига:

```bash
ssh root@45.80.128.254 "nginx -t"
```

Reload после осознанного изменения nginx:

```bash
ssh root@45.80.128.254 "nginx -t && systemctl reload nginx"
```

Проверка продления сертификата:

```bash
ssh root@45.80.128.254 "certbot renew --dry-run"
```

## Sigur

Sigur polling работает внутри `fot-server`. На production важно:

```env
SIGUR_RUNTIME_ALLOWED_HOSTS=hub
```

Проверить heartbeat:

```bash
ssh root@45.80.128.254
cd /srv/sites/fot.su10.ru/fot-server
export DATABASE_URL="$(node -e "require('dotenv').config({override:true}); process.stdout.write(process.env.DATABASE_URL || '')")"

psql "$DATABASE_URL" -tA -c "
  SELECT key, heartbeat_at, NOW() - heartbeat_at AS lag
  FROM sigur_runtime_state
  WHERE key = 'sigur_presence_polling';
"
```

Если в логах есть `SIGUR_RUNTIME_NOT_ALLOWED`, проверь hostname:

```bash
hostname
```

## Rollback

Самый надежный rollback — сделать revert/fix в `main`, запушить его и снова
запустить обычный деплой. Серверный скрипт ожидает ветку `main`, поэтому не
используй его из detached checkout.

Локально:

```bash
git fetch origin main
git switch main
git pull --ff-only origin main
git revert <bad_commit>
git push origin main
```

На сервере:

```bash
ssh root@45.80.128.254
cd /srv/sites/fot.su10.ru
git pull --ff-only origin main
bash scripts/deploy-server.sh both
```

Если нужно срочно откатить только frontend или backend без revert, используй
ручной деплой предыдущего локально собранного `dist`.

## Частые Проблемы

`502` на `/api/*`:

```bash
pm2 status
pm2 logs fot-server --lines 100 --nostream
curl -fsS http://127.0.0.1:3001/health
```

`502` на `/external/v1/*`:

```bash
pm2 status
pm2 logs fot-data-api --lines 100 --nostream
curl -fsS http://127.0.0.1:4001/external/v1/health
```

Frontend открылся, но API ходит не туда:

```bash
grep '^VITE_API_URL=' /srv/sites/fot.su10.ru/fot-app/.env
```

После изменения `VITE_API_URL` нужно пересобрать frontend.

Backend не стартует из-за env:

```bash
cd /srv/sites/fot.su10.ru/fot-server
node -e "require('dotenv').config({override:true}); console.log({
  NODE_ENV: process.env.NODE_ENV,
  HOST: process.env.HOST,
  PORT: process.env.PORT,
  DATABASE_URL: process.env.DATABASE_URL ? 'set' : 'missing',
  JWT_SECRET: process.env.JWT_SECRET ? 'set' : 'missing',
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ? 'set' : 'missing'
})"
```

Python venv не создается:

```bash
apt install -y python3.12-venv
cd /srv/sites/fot.su10.ru/fot-data-api
python3.12 -m venv .venv
```
