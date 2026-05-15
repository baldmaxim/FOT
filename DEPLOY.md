# Деплой FOT

Этот документ — рабочая инструкция по деплою FOT на production-сервер
`fot.su10.ru`. Основной сценарий: собрать артефакты локально, передать их на
сервер, атомарно заменить текущую версию и перезапустить нужные PM2-процессы.

## Production

| Что | Значение |
|---|---|
| Домен | `https://fot.su10.ru` |
| Сервер | `45.80.128.254` |
| SSH | `ssh root@45.80.128.254` |
| ОС | Ubuntu 24.04 |
| Node.js | 22.x |
| Python | 3.12 |
| Корень проекта | `/srv/sites/fot.su10.ru` |
| Совместимый путь | `/var/www/fot` -> `/srv/sites/fot.su10.ru` |
| Frontend | `/srv/sites/fot.su10.ru/fot-app/dist`, отдаётся nginx |
| Backend | PM2 `fot-server`, Node, `127.0.0.1:3001` |
| Public Data API | PM2 `fot-data-api`, uvicorn, `127.0.0.1:4001` |
| Nginx vhost | `/etc/nginx/sites-available/fot.su10.ru` |

Runtime использует Yandex Managed PostgreSQL через pooler `:6432` и Cloud.ru S3.
Supabase Cloud не используется в production runtime.

## Короткая Схема

1. Локально убедиться, что нужный код закоммичен и запушен.
2. На сервере подтянуть код: `git pull --ff-only origin main`.
3. Локально собрать backend `fot-server/dist` и frontend `fot-app/dist`.
4. Передать `dist/` на сервер в `dist.new`.
5. На сервере атомарно заменить `dist` и перезапустить PM2.
6. Проверить health endpoints и публичный домен.

Для команд ниже удобно задать переменные в локальной shell:

```bash
export FOT_SSH=root@45.80.128.254
export FOT_ROOT=/srv/sites/fot.su10.ru
export RELEASE=$(git rev-parse --short HEAD)
```

## Автодеплой Скриптом

Основной способ деплоя с локального компьютера:

```bash
bash scripts/deploy-production.sh --check
bash scripts/deploy-production.sh both
```

Что делает скрипт:

- проверяет, что локальная ветка `main` совпадает с `origin/main`;
- проверяет, что в деплойной области нет незакоммиченных изменений;
- проверяет сервер, env-файлы и чистоту git tree на сервере;
- выполняет `git pull --ff-only origin main` на сервере;
- собирает локально `fot-server/dist` и/или `fot-app/dist`;
- загружает `dist` на сервер через SSH и атомарно заменяет текущую версию;
- перезапускает PM2-процессы и выполняет health-checks.

Доступные варианты:

```bash
bash scripts/deploy-production.sh frontend
bash scripts/deploy-production.sh backend
bash scripts/deploy-production.sh data-api
bash scripts/deploy-production.sh both
bash scripts/deploy-production.sh all
```

Старые короткие команды тоже работают и ведут на новый сервер:

```bash
bash scripts/deploy-frontend.sh
bash scripts/deploy-backend.sh
bash scripts/deploy-both.sh
```

Для frontend перед первым запуском нужен локальный
`fot-app/.env.production.local` с production-переменными. Он не коммитится.

Полезные флаги окружения:

```bash
FRONTEND_NPM_CI=1 bash scripts/deploy-production.sh frontend
BACKEND_NPM_CI=1 bash scripts/deploy-production.sh backend
BACKEND_SOURCEMAPS=1 bash scripts/deploy-production.sh backend
DATA_API_PIP_INSTALL=1 bash scripts/deploy-production.sh data-api
ALLOW_DIRTY=1 bash scripts/deploy-production.sh both
SKIP_VERIFY=1 bash scripts/deploy-production.sh both
```

`ALLOW_DIRTY=1` используй только осознанно: скрипт всё равно деплоит код,
который уже запушен в `origin/main`, а локальные незакоммиченные изменения в
сборочной области могут попасть в локально собранный `dist`.

Если удобнее работать прямо на сервере, есть отдельный серверный сценарий:

```bash
ssh root@45.80.128.254
cd /srv/sites/fot.su10.ru
bash scripts/deploy-server.sh --check
bash scripts/deploy-server.sh both
```

Он делает тот же production-путь, но всё выполняет на сервере: проверяет, что
это hostname `hub`, подтягивает `origin/main`, собирает backend/frontend,
перезапускает PM2, делает `pm2 save` и прогоняет health-checks.

Доступны те же scope:

```bash
bash scripts/deploy-server.sh frontend
bash scripts/deploy-server.sh backend
bash scripts/deploy-server.sh data-api
bash scripts/deploy-server.sh both
bash scripts/deploy-server.sh all
```

## Перед Деплоем

Проверь локальное состояние:

```bash
git fetch origin main
git status --short
git rev-parse --short HEAD
git rev-parse --short origin/main
```

Если production должен получить текущий локальный код, сначала commit + push.
Не деплой незакоммиченные изменения.

На сервере перед деплоем:

```bash
ssh "$FOT_SSH" "cd $FOT_ROOT && git status --short && git pull --ff-only origin main"
```

Если `git status --short` на сервере показывает неожиданные изменения в коде,
сначала разберись с ними. `.env`, `.venv`, `node_modules` и `dist` в git не
участвуют.

## `.env` Файлы

Секреты лежат только на сервере и не синхронизируются через git:

```text
/srv/sites/fot.su10.ru/fot-server/.env
/srv/sites/fot.su10.ru/fot-data-api/.env
/srv/sites/fot.su10.ru/fot-app/.env
/srv/sites/fot.su10.ru/.migration/yandex-ca.pem
```

Перед изменением env сделай backup:

```bash
ssh "$FOT_SSH"
cd /srv/sites/fot.su10.ru
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p /root/fot-env-backups/$TS
cp fot-server/.env /root/fot-env-backups/$TS/fot-server.env
cp fot-data-api/.env /root/fot-env-backups/$TS/fot-data-api.env
cp fot-app/.env /root/fot-env-backups/$TS/fot-app.env
cp .migration/yandex-ca.pem /root/fot-env-backups/$TS/yandex-ca.pem
```

Минимально важные значения backend:

```env
NODE_ENV=production
HOST=127.0.0.1
PORT=3001
CORS_ORIGIN=https://fot.su10.ru

DATABASE_URL=postgres://...
DATABASE_SSL=true
DATABASE_SSL_CA_PATH=/srv/sites/fot.su10.ru/.migration/yandex-ca.pem
DATABASE_POOL_MAX=10
DATABASE_STATEMENT_TIMEOUT_MS=30000

JWT_SECRET=...
JWT_REFRESH_SECRET=...
ENCRYPTION_KEY=...
TOTP_ISSUER=FOT-App

OBJECT_STORAGE_ENDPOINT=https://s3.cloud.ru
OBJECT_STORAGE_REGION=ru-central-1
OBJECT_STORAGE_ACCESS_KEY_ID=...
OBJECT_STORAGE_SECRET_ACCESS_KEY=...
OBJECT_STORAGE_FORCE_PATH_STYLE=true

SIGUR_RUNTIME_ALLOWED_HOSTS=hub
SIGUR_EXTERNAL_URL=...
SIGUR_EXTERNAL_USERNAME=...
SIGUR_EXTERNAL_PASSWORD=...

VAPID_PUBLIC_KEY=...
VAPID_PRIVATE_KEY=...
VAPID_SUBJECT=...

SENTRY_DSN=...
SENTRY_AUTH_TOKEN=...
SENTRY_ORG=odintsovorg
SENTRY_PROJECT=fot-server
```

Минимально важные значения frontend:

```env
VITE_API_URL=https://fot.su10.ru/api
VITE_SENTRY_DSN=...
SENTRY_AUTH_TOKEN=...
SENTRY_ORG=odintsovorg
SENTRY_PROJECT=fot-app
```

Минимально важные значения Public Data API:

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

## Деплой Backend

Локально:

```bash
cd fot-server
npm ci
npm run build
```

Если надо загрузить backend sourcemaps в Sentry:

```bash
set -a
source .env.production.local 2>/dev/null || source .env
set +a
export SENTRY_RELEASE="$RELEASE"
npm run sentry:sourcemaps
```

Залить build на сервер:

```bash
tar czf - -C dist . | ssh "$FOT_SSH" '
set -e
TARGET=/srv/sites/fot.su10.ru/fot-server
rm -rf "$TARGET/dist.new"
mkdir -p "$TARGET/dist.new"
tar xzf - -C "$TARGET/dist.new"
'
```

Активировать backend на сервере:

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
pm2 status fot-server
'
```

Если менялись `fot-server/package.json` или `fot-server/package-lock.json`, на
сервере обязательно обнови production-зависимости:

```bash
ssh "$FOT_SSH" "cd $FOT_ROOT/fot-server && npm ci --omit=dev && pm2 restart fot-server --update-env"
```

## Деплой Frontend

Для локальной сборки нужен локальный файл `fot-app/.env.production.local`
с production-значениями. Он не коммитится.

```env
VITE_API_URL=https://fot.su10.ru/api
VITE_SENTRY_DSN=...
SENTRY_AUTH_TOKEN=...
SENTRY_ORG=odintsovorg
SENTRY_PROJECT=fot-app
```

Локально:

```bash
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

## Деплой Public Data API

У `fot-data-api` нет build-артефакта. После `git pull` на сервере достаточно
обновить зависимости при необходимости и перезапустить PM2:

```bash
ssh "$FOT_SSH" '
set -e
cd /srv/sites/fot.su10.ru/fot-data-api
if [ ! -d .venv ]; then
  python3.12 -m venv .venv
fi
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m compileall -q app
pm2 restart fot-data-api --update-env
pm2 status fot-data-api
'
```

## Полный Деплой

1. `git pull --ff-only origin main` на сервере.
2. Собрать и залить backend.
3. Собрать и залить frontend.
4. Если менялся `fot-data-api`, обновить `.venv` и перезапустить
   `fot-data-api`.
5. Выполнить проверки.

Команда для обновления кода на сервере:

```bash
ssh "$FOT_SSH" "cd $FOT_ROOT && git pull --ff-only origin main"
```

## PM2

Первичный запуск процессов:

```bash
ssh "$FOT_SSH"

pm2 start /srv/sites/fot.su10.ru/fot-server/dist/index.js \
  --name fot-server \
  --cwd /srv/sites/fot.su10.ru/fot-server

pm2 start ".venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4001" \
  --name fot-data-api \
  --cwd /srv/sites/fot.su10.ru/fot-data-api \
  --interpreter none

pm2 save
```

Обычные команды:

```bash
pm2 status
pm2 logs fot-server --lines 100 --nostream
pm2 logs fot-data-api --lines 100 --nostream
pm2 restart fot-server --update-env
pm2 restart fot-data-api --update-env
pm2 save
```

После изменения списка процессов всегда выполняй `pm2 save`, иначе после
перезагрузки сервера PM2 восстановит старое состояние.

## Nginx

Production vhost:

```nginx
server {
    listen 80;
    listen [::]:80;
    server_name fot.su10.ru;

    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    location / {
        return 301 https://fot.su10.ru$request_uri;
    }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name fot.su10.ru;

    ssl_certificate /etc/letsencrypt/live/fot.su10.ru/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/fot.su10.ru/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    root /srv/sites/fot.su10.ru/fot-app/dist;
    index index.html;
    client_max_body_size 50m;

    access_log /var/log/nginx/fot.su10.ru.access.log;
    error_log /var/log/nginx/fot.su10.ru.error.log;

    location ~* ^/assets/ {
        try_files $uri =404;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /socket.io/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /external/v1/ {
        proxy_pass http://127.0.0.1:4001;
        proxy_set_header Authorization $http_authorization;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 30s;
    }

    location / {
        try_files $uri /index.html;
    }
}
```

Проверка и reload:

```bash
ssh "$FOT_SSH" "nginx -t && systemctl reload nginx"
```

SSL:

```bash
ssh "$FOT_SSH" "certbot renew --dry-run"
```

Первичный выпуск сертификата:

```bash
ssh "$FOT_SSH" "certbot --nginx -d fot.su10.ru --redirect --agree-tos --no-eff-email -m admin@su10.ru"
```

## Проверки После Деплоя

На сервере:

```bash
ssh "$FOT_SSH"

pm2 status
curl -fsS http://127.0.0.1:3001/health
curl -fsS http://127.0.0.1:4001/external/v1/health
ss -tulpn | grep -E ':(3001|4001)\b'
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

Для `/api/auth/login` с пустым `{}` нормальный результат — `400` с ошибкой
валидации. `502` означает, что nginx не достучался до `fot-server`.

Дополнительно проверь в браузере:

- логин;
- список сотрудников;
- табель;
- СКУД live/presence;
- чат и realtime-уведомления;
- загрузку документов;
- админ-раздел API-доступа.

## Sigur

Sigur-фоновые задачи запускаются внутри `fot-server`. На production должен быть:

```env
SIGUR_RUNTIME_ALLOWED_HOSTS=hub
```

После рестарта backend проверь, что polling реально работает:

```bash
ssh "$FOT_SSH"
cd /srv/sites/fot.su10.ru/fot-server
set -a
source .env
set +a
psql "$DATABASE_URL" -tA -c "
  SELECT key, heartbeat_at, NOW() - heartbeat_at AS lag
  FROM sigur_runtime_state
  WHERE key = 'sigur_presence_polling';
"
```

`lag` обычно должен быть меньше пары минут в рабочее время. Если в логах есть
`SIGUR_RUNTIME_NOT_ALLOWED`, проверь hostname сервера:

```bash
hostname
```

## Миграции БД

Автоматических миграций нет. SQL-файлы из `docs/migrations/` применяются вручную
и только после review.

```bash
ssh "$FOT_SSH"
cd /srv/sites/fot.su10.ru/fot-server
set -a
source .env
set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f /srv/sites/fot.su10.ru/docs/migrations/<NNN>_<name>.sql
```

После миграции обычно нужен restart backend:

```bash
pm2 restart fot-server --update-env
```

## Быстрый Rollback

Самый понятный rollback — redeploy предыдущего commit:

```bash
git fetch origin main
git checkout <previous_commit>
```

После этого повтори сборку и загрузку backend/frontend. Когда rollback
подтверждён, верни локальный checkout на `main`.

Если проблема только во frontend, достаточно заново залить предыдущий
`fot-app/dist`. Если проблема в backend, заново залей предыдущий
`fot-server/dist` и перезапусти `fot-server`.

## Частые Проблемы

`502` на `/api/*`:

```bash
ssh "$FOT_SSH"
pm2 status
pm2 logs fot-server --lines 100 --nostream
curl -fsS http://127.0.0.1:3001/health
```

`502` на `/external/v1/*`:

```bash
ssh "$FOT_SSH"
pm2 status
pm2 logs fot-data-api --lines 100 --nostream
curl -fsS http://127.0.0.1:4001/external/v1/health
```

Frontend открылся, но API ходит не туда:

```bash
grep '^VITE_API_URL=' /srv/sites/fot.su10.ru/fot-app/.env
```

После изменения `VITE_API_URL` нужно пересобрать frontend локально и залить
новый `dist`.

Backend не стартует из-за env:

```bash
ssh "$FOT_SSH"
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

Python venv не создаётся:

```bash
apt install -y python3.12-venv
cd /srv/sites/fot.su10.ru/fot-data-api
python3.12 -m venv .venv
```
