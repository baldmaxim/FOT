# Деплой FOT

Рабочая инструкция по деплою проекта FOT на production-сервер
`fot.su10.ru`.

Главная идея простая: в production попадает код из `personal/main`
(remote `personal` = `baldmaxim/FOT`). Перед деплоем нужные изменения
должны быть закоммичены и запушены в `personal`.

Схема деплоя: git/исходники живут в **одноразовом build-контексте**
`/opt/fot-build`, сборка идёт там, в папку сайта `/srv/sites/fot.su10.ru`
копируются **только собранные артефакты**. Рантайм-конфиг (`.env`-файлы,
`.migration/yandex-ca.pem`) лежит в папке сайта и деплоем не трогается.
`/opt/fot-build` можно удалить и пересоздать в любой момент.

## Production

| Что | Значение |
|---|---|
| Домен | `https://fot.su10.ru` |
| Сервер | `45.80.128.254` |
| SSH | `ssh root@45.80.128.254` |
| Hostname | `hub` |
| Git remote (источник деплоя) | `personal` (`baldmaxim/FOT`), ветка `main` |
| Build-контекст (git/исходники) | `/opt/fot-build` |
| Корень сайта (только артефакты + конфиг) | `/srv/sites/fot.su10.ru` |
| Frontend | `/srv/sites/fot.su10.ru/fot-app/dist` |
| Backend | PM2 `fot-server`, `127.0.0.1:3001` |
| Public Data API | PM2 `fot-data-api`, `127.0.0.1:4001` |
| Nginx vhost | `/etc/nginx/sites-available/fot.su10.ru` |
| Совместимый symlink | `/var/www/fot` -> `/srv/sites/fot.su10.ru` |

Runtime использует Yandex Managed PostgreSQL и Cloud.ru S3. Production runtime
не использует Supabase Cloud.

## Самый Частый Деплой

Если ты уже подключаешься к серверу по SSH, используй серверный скрипт.
Запускается он из build-контекста, git подтягивается скриптом автоматически:

```bash
ssh root@45.80.128.254
cd /opt/fot-build

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
- проверяет наличие `.env`-файлов и `.migration/yandex-ca.pem` в папке сайта;
- синхронизирует `/opt/fot-build` с `personal/main`
  (`git fetch` + `git checkout -f -B main` + `git reset --hard` + `git clean -fd`) —
  расхождение веток и грязное дерево больше деплой не ломают;
- собирает нужные части проекта в `/opt/fot-build`;
- копирует артефакты в `/srv/sites/fot.su10.ru` и атомарно заменяет `dist`/`app`;
- обновляет prod-зависимости в папке сайта только при изменении lock-файлов;
- перезапускает PM2-процессы (cwd остаётся в папке сайта);
- выполняет `pm2 save`;
- прогоняет проверки через `curl`.

Локальные правки прямо в `/opt/fot-build` затираются `git reset --hard` —
любые изменения только через `personal/main`. Полная пересборка с чистого
листа: `BUILD_CLEAN_HARD=1 bash scripts/deploy-server.sh both`.

Если сервер нужно временно переключить на другой remote/ветку:
`FOT_REMOTE=origin FOT_BRANCH=hotfix bash scripts/deploy-server.sh both`.

## Первичная Миграция На `/opt/fot-build`

Одноразово, при переходе со старой схемы (git-репо в папке сайта). Порядок
такой, чтобы живой сайт не сломался: git/исходники из папки сайта убираются
**последним шагом**, только после успешного прогона нового скрипта.

```bash
ssh root@45.80.128.254
hostname    # должно быть: hub

# 1. Бэкап рантайм-конфига
TS=$(date +%Y%m%d-%H%M%S); mkdir -p /root/fot-env-backups/$TS
cp /srv/sites/fot.su10.ru/fot-server/.env    /root/fot-env-backups/$TS/fot-server.env
cp /srv/sites/fot.su10.ru/fot-data-api/.env  /root/fot-env-backups/$TS/fot-data-api.env
cp /srv/sites/fot.su10.ru/fot-app/.env       /root/fot-env-backups/$TS/fot-app.env
cp /srv/sites/fot.su10.ru/.migration/yandex-ca.pem /root/fot-env-backups/$TS/yandex-ca.pem

# 2. Клон build-контекста из personal (папку сайта не трогает)
mkdir -p /opt/fot-build
git clone https://github.com/baldmaxim/FOT.git /opt/fot-build
cd /opt/fot-build
git remote rename origin personal      # клон создаёт remote 'origin' → переименовать
git fetch personal main --prune
git checkout -f -B main personal/main
git reset --hard personal/main
git clean -fd

# 3. Прогрев тулчейна
( cd /opt/fot-build/fot-server && npm ci )
( cd /opt/fot-build/fot-app    && npm ci )

# 4. Засеять package-файлы backend в папку сайта (нужны для npm ci --omit=dev)
cp /opt/fot-build/fot-server/package.json      /srv/sites/fot.su10.ru/fot-server/package.json
cp /opt/fot-build/fot-server/package-lock.json /srv/sites/fot.su10.ru/fot-server/package-lock.json
# Существующие fot-server/node_modules и fot-data-api/.venv в папке сайта сохранить.

# 5. Прогон новой схемы рядом со старой (сайт всё ещё на старом dist/PM2)
cd /opt/fot-build
bash scripts/deploy-server.sh --check
bash scripts/deploy-server.sh both
bash scripts/deploy-server.sh all

# 6. ТОЛЬКО после зелёного прогона — убрать git/исходники из папки сайта
cd /srv/sites/fot.su10.ru
rm -rf .git scripts docs
rm -rf fot-server/src fot-server/tsconfig.json
rm -rf fot-app/src fot-app/vite.config.ts fot-app/tsconfig*.json fot-app/index.html
# СОХРАНИТЬ: */.env, .migration/, */dist, fot-server/node_modules,
#            fot-server/package*.json, fot-data-api/app, fot-data-api/.venv,
#            fot-data-api/requirements.txt
pm2 save
```

Подпроект целиком (`rm -rf fot-server` и т.п.) удалять нельзя — только
известные файлы исходников.

## Деплой С Локального Компьютера

Локальная команда теперь только запускает серверный деплой по SSH.
Она **не собирает проект локально** и **не копирует локальные файлы** на
сервер. Код всё равно берётся из git на production-сервере:

1. сервер создаёт/обновляет `/opt/fot-build`;
2. `/opt/fot-build` синхронизируется с `personal/main`;
3. сборка выполняется в `/opt/fot-build`;
4. в `/srv/sites/fot.su10.ru` копируются только артефакты.

Перед запуском убедись, что нужные изменения закоммичены и запушены:

```bash
git fetch origin main
git status --short
git rev-parse --short HEAD
git rev-parse --short origin/main

bash scripts/deploy-production.sh --check
bash scripts/deploy-production.sh both
```

`scripts/deploy-production.sh` сам подключается к `root@45.80.128.254`,
проверяет build-контекст и запускает на сервере `scripts/deploy-server.sh`.
Если `/opt/fot-build` отсутствует, wrapper создаст его через `git clone`.

Доступные scope:

```bash
bash scripts/deploy-production.sh frontend
bash scripts/deploy-production.sh backend
bash scripts/deploy-production.sh data-api
bash scripts/deploy-production.sh both
bash scripts/deploy-production.sh all
```

Короткие команды — это такие же SSH-wrapper'ы:

```bash
bash scripts/deploy-frontend.sh
bash scripts/deploy-backend.sh
bash scripts/deploy-both.sh
```

Переменные для локального запуска:

```bash
FOT_SSH=root@45.80.128.254
BUILD_DIR=/opt/fot-build
FOT_REPO_URL=https://github.com/baldmaxim/FOT.git
FOT_REMOTE=personal
FOT_BRANCH=main
```

Старый сценарий "собрать локально и залить артефакты на сервер" больше не
используется. Production не должен зависеть от состояния локального рабочего
дерева.

## Полезные Флаги

Флаги одинаковые для серверного скрипта и локального SSH-wrapper'а.
Локальный `scripts/deploy-production.sh` просто передаёт их в
`scripts/deploy-server.sh` на сервере.

```bash
BACKEND_NPM_CI=1 bash scripts/deploy-server.sh backend
FRONTEND_NPM_CI=1 bash scripts/deploy-server.sh frontend
DATA_API_PIP_INSTALL=1 bash scripts/deploy-server.sh data-api
BACKEND_SOURCEMAPS=1 bash scripts/deploy-server.sh backend
SKIP_VERIFY=1 bash scripts/deploy-server.sh both
```

То же самое с локального компьютера:

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

Обычно ручной деплой не нужен (используй `scripts/deploy-server.sh backend`),
но порядок такой. Всё делается на сервере: сборка в `/opt/fot-build`, в папку
сайта копируется только `dist` + `package*.json`.

Подтянуть код в build-контекст:

```bash
ssh root@45.80.128.254
cd /opt/fot-build
git fetch personal main --prune
git checkout -f -B main personal/main
git reset --hard personal/main
git clean -fd
```

Собрать backend в build-контексте:

```bash
cd /opt/fot-build/fot-server
npm ci
npm run build -- --outDir dist.new
test -f dist.new/index.js
rm -rf dist.old; [ -d dist ] && mv dist dist.old; mv dist.new dist; rm -rf dist.old
```

Опубликовать в папку сайта (`node_modules` остаётся в папке сайта, обновляется
только при смене lock-файла):

```bash
BUILD=/opt/fot-build/fot-server
SITE=/srv/sites/fot.su10.ru/fot-server

cp "$BUILD/package.json" "$SITE/package.json"
cp "$BUILD/package-lock.json" "$SITE/package-lock.json"
# Если менялся fot-server/package-lock.json — обнови prod-зависимости:
( cd "$SITE" && npm ci --omit=dev )

rm -rf "$SITE/dist.new"
cp -a "$BUILD/dist" "$SITE/dist.new"
rm -rf "$SITE/dist.old"
[ -d "$SITE/dist" ] && mv "$SITE/dist" "$SITE/dist.old"
mv "$SITE/dist.new" "$SITE/dist"
rm -rf "$SITE/dist.old"

pm2 restart fot-server --update-env
pm2 save
pm2 status fot-server
```

PM2-процесс `fot-server` имеет cwd `/srv/sites/fot.su10.ru/fot-server`, поэтому
dotenv грузит `.env` из папки сайта. Cwd при ручном деплое не менять.

## Ручной Деплой Frontend

Всё на сервере. `VITE_*` зашиваются в бандл при сборке, поэтому env берётся
из `.env` папки сайта (production-значения), а не из build-контекста.

Подтянуть код и собрать в build-контексте:

```bash
ssh root@45.80.128.254
cd /opt/fot-build
git fetch personal main --prune
git checkout -f -B main personal/main
git reset --hard personal/main
git clean -fd

cd /opt/fot-build/fot-app
npm ci

set -a
. /srv/sites/fot.su10.ru/fot-app/.env
set +a
export RELEASE=$(git -C /opt/fot-build rev-parse --short HEAD)
export VITE_SENTRY_RELEASE="$RELEASE"
export SENTRY_RELEASE="$RELEASE"

rm -rf dist.new
./node_modules/.bin/tsc -b
NODE_OPTIONS='--max-old-space-size=2048' ./node_modules/.bin/vite build --outDir dist.new
test -f dist.new/index.html
find dist.new -name '*.map' -type f -delete
rm -rf dist.old; [ -d dist ] && mv dist dist.old; mv dist.new dist; rm -rf dist.old
```

Опубликовать в папку сайта:

```bash
BUILD=/opt/fot-build/fot-app
SITE=/srv/sites/fot.su10.ru/fot-app

rm -rf "$SITE/dist.new"
cp -a "$BUILD/dist" "$SITE/dist.new"
rm -rf "$SITE/dist.old"
[ -d "$SITE/dist" ] && mv "$SITE/dist" "$SITE/dist.old"
mv "$SITE/dist.new" "$SITE/dist"
rm -rf "$SITE/dist.old"

find "$SITE/dist" -type d -exec chmod 755 {} \;
find "$SITE/dist" -type f -exec chmod 644 {} \;
```

Frontend не требует PM2 restart.

## Public Data API

У `fot-data-api` нет отдельной сборки. Код (`app/` + `requirements.txt`)
копируется из build-контекста в папку сайта; `.venv` живёт в папке сайта и
обновляется только при изменении `requirements.txt`:

```bash
ssh root@45.80.128.254
cd /opt/fot-build
git fetch personal main --prune
git checkout -f -B main personal/main
git reset --hard personal/main
git clean -fd

BUILD=/opt/fot-build/fot-data-api
SITE=/srv/sites/fot.su10.ru/fot-data-api

rm -rf "$SITE/app.new"
cp -a "$BUILD/app" "$SITE/app.new"
cp "$BUILD/requirements.txt" "$SITE/requirements.txt"
rm -rf "$SITE/app.old"
[ -d "$SITE/app" ] && mv "$SITE/app" "$SITE/app.old"
mv "$SITE/app.new" "$SITE/app"
rm -rf "$SITE/app.old"

[ -d "$SITE/.venv" ] || python3.12 -m venv "$SITE/.venv"
# Если менялся requirements.txt:
"$SITE/.venv/bin/pip" install -r "$SITE/requirements.txt"

( cd "$SITE" && .venv/bin/python -m compileall -q app )
pm2 restart fot-data-api --update-env
pm2 save
pm2 status fot-data-api
```

Через скрипт это короче:

```bash
cd /opt/fot-build
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

SQL-файлы лежат в build-контексте (`/opt/fot-build/docs/migrations/`).
`DATABASE_URL` берётся из `.env` папки сайта.

```bash
ssh root@45.80.128.254
cd /opt/fot-build
git fetch personal main --prune
git checkout -f -B main personal/main
git reset --hard personal/main

cd /srv/sites/fot.su10.ru/fot-server
export DATABASE_URL="$(node -e "require('dotenv').config({override:true}); process.stdout.write(process.env.DATABASE_URL || '')")"
export PGSSLROOTCERT=/srv/sites/fot.su10.ru/.migration/yandex-ca.pem
test -n "$DATABASE_URL"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f /opt/fot-build/docs/migrations/<NNN>_<name>.sql

pm2 restart fot-server --update-env
pm2 save
```

Пример:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f /opt/fot-build/docs/migrations/096_timesheet_team_mgmt_access.sql
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
git fetch personal main
git switch main
git pull --ff-only personal main
git revert <bad_commit>
git push personal main
```

На сервере (скрипт сам синхронизирует `/opt/fot-build` с `personal/main`):

```bash
ssh root@45.80.128.254
cd /opt/fot-build
bash scripts/deploy-server.sh both
```

Правки прямо в `/opt/fot-build` для rollback бесполезны — `git reset --hard`
их затрёт. Откат только через revert/fix в `main` и обычный деплой.

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
