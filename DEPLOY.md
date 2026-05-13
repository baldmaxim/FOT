# Деплой FOT

## Сервер
- **IP:** 80.74.28.233
- **SSH:** `ssh vds`
- **OS:** Ubuntu 24.04
- **Node:** 22.x
- **PM2:** процесс `fot-server`

Локально используется SSH alias `vds` из `~/.ssh/config`:
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
  fot-server/     # бэкенд (запущен через PM2 на порту 4000)
```

## Домены
| Домен | Назначение |
|-------|-----------|
| `http://fotsu10.fvds.ru` | FOT приложение |
| `https://fotsu10.fvds.ru:4443` | FOT приложение (HTTPS, текущий рабочий endpoint) |
| `http://odintsov1.live.fvds.ru` | Odintsov Live |

## Быстрый деплой фронта (локально, при подготовленном окружении) ⚡

Билдим у себя на ноуте (быстрый CPU), на vds через tar-pipe заливаем уже готовый `dist/`. На vds ничего компилировать не нужно.

**Подготовка (один раз на машине):**

1. Скопировать прод-значения из `/var/www/fot/fot-app/.env` (на vds) в `fot-app/.env.production.local` локально. Минимум:
   ```
   VITE_API_URL=https://fotsu10.fvds.ru/api
   VITE_SENTRY_DSN=...
   SENTRY_AUTH_TOKEN=...
   SENTRY_ORG=odintsovorg
   SENTRY_PROJECT=fot-app
   ```
   Файл уже в `.gitignore` (паттерн `*.local`).

2. Убедиться, что в `~/.ssh/config` есть alias `vds` (см. в начале файла).

3. Один раз установить зависимости фронта локально:
   ```bash
   cd fot-app
   npm ci
   ```

**Когда это реально быстро:**

- `fot-app/.env.production.local` уже создан.
- Локальные `fot-app/node_modules` уже соответствуют текущему `fot-app/package-lock.json`.
- После `git pull`, затронувшего `fot-app/package-lock.json`, нужно один раз заново выполнить `cd fot-app && npm ci`. Именно этот шаг обычно съедает выигрыш по времени на первом прогоне.

**Деплой:**
```bash
bash scripts/deploy-frontend.sh
```

Если после `git pull` обновился `fot-app/package-lock.json`, первый прогон лучше сделать так:
```bash
FRONTEND_NPM_CI=1 bash scripts/deploy-frontend.sh
```

Скрипт сам: делает `git fetch origin main` → проверяет, что локальный `HEAD` совпадает с `origin/main` → отказывается деплоить, если внутри `fot-app/` есть незакоммиченные изменения → подгружает `.env.production.local` → при необходимости делает локальный `npm ci` → билдит фронт (Vite) → заливает `dist/` на vds атомарным swap'ом (`dist.new` → `dist`, без даунтайма) → загружает sourcemaps в Sentry.

> Выигрыш даёт именно сценарий "локальный build + upload готового `dist/`". Первый прогон после обновления зависимостей будет заметно дольше обычного.

## Быстрый деплой фронта (на vds, fallback)
Если локальный билд недоступен — старый путь, медленный (4–5 мин на vds CPU):
```bash
ssh vds
cd /var/www/fot && git pull
cd fot-app && set -a; source .env; set +a
export VITE_SENTRY_RELEASE=$(cd /var/www/fot && git rev-parse --short HEAD)
NODE_OPTIONS='--max-old-space-size=1024' npm run build
```

## Рекомендуемый деплой бэкенда (локальная сборка + запуск на vds)

Бэкенд по умолчанию собираем локально, а на vds заливаем уже готовый `dist/`.
На сервере остаются только `git pull --ff-only`, production-зависимости при
необходимости, атомарная замена `dist/` и `pm2 restart`.

```bash
bash scripts/deploy-backend.sh
```

Если нужно принудительно обновить зависимости локально и production-зависимости
на сервере:
```bash
BACKEND_NPM_CI=1 bash scripts/deploy-backend.sh
```

Если нужно пропустить backend sourcemaps:
```bash
BACKEND_SOURCEMAPS=0 bash scripts/deploy-backend.sh
```

Скрипт сам: делает `git fetch origin main` → проверяет, что локальный `HEAD` не опережает `origin/main` → отказывается деплоить при незакоммиченных изменениях внутри `fot-server/` → локально при необходимости запускает `npm ci` → локально билдит `dist/` → локально загружает sourcemaps в Sentry → на сервере делает `git pull --ff-only origin main` → автоматически запускает `npm ci --omit=dev`, если изменился `fot-server/package-lock.json` в деплоимом диапазоне или если на сервере отсутствует `node_modules/` → заливает `dist/` в `dist.new` → атомарно меняет `dist.new` на `dist` → подгружает env из `/var/www/fot/fot-server/.env` → делает `pm2 restart fot-server --update-env`.

> Для backend sourcemaps скрипт берёт переменные из `fot-server/.env.production.local`, если файл есть, иначе из локального `fot-server/.env`. Не коммить эти файлы.

## Рекомендуемый полный деплой (оба)

На практике сейчас основной путь такой:

1. Бэкенд: локальный build + upload `dist/` + restart на `vds`
2. Фронтенд: локальный build + upload `dist/`

```bash
bash scripts/deploy-both.sh
```

Если менялись зависимости на обеих сторонах, можно сразу запустить:
```bash
FRONTEND_NPM_CI=1 BACKEND_NPM_CI=1 bash scripts/deploy-both.sh
```

Скрипт `deploy-both.sh` сначала делает preflight (`deploy-frontend.sh --check` и `deploy-backend.sh --check`), и только потом запускает backend- и frontend-деплой по очереди. Это защищает от ситуации, когда бэкенд уже обновили, а фронт потом внезапно упёрся в `origin/main` mismatch или локальные грязные изменения.

> Если в этом релизе менялись зависимости фронта или бэка, первый прогон всё равно будет дольше из-за `npm ci`. После этого обе сборки выполняются локально, а vds занимается только получением артефактов и рестартом.

> **`set -a; source .env; set +a` обязателен** перед билдом и `pm2 restart` — экспортирует все
> переменные из `.env` в shell. Это нужно потому, что:
> - `@sentry/vite-plugin` и `sentry-cli sourcemaps upload` читают `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` /
>   `SENTRY_PROJECT` только из `process.env`, не из `.env`. Без них sourcemaps не загружаются и
>   release в Sentry не создаётся.
> - `fot-server/src/instrument.ts` импортируется первым (раньше `dotenv.config()` в `config/env.ts`),
>   поэтому `SENTRY_DSN` должен быть в shell к моменту старта процесса. PM2 `--update-env` подхватит
>   только то, что лежит в shell, не в `.env`.
>
> **`.env` через `git pull` не синхронизируется** (он в `.gitignore`). При добавлении новых ключей в
> локальный `.env` — нужно вручную добавить их и в `/var/www/fot/{fot-server,fot-app}/.env` через
> `nano` или `cat >> ... <<EOF`.

## Sigur: post-fix и проверки backend deploy

Фоновые Sigur-процессы и ручные Sigur sync теперь должны запускаться только на
разрешённых хостах. По умолчанию allowlist жёстко привязан к прод-хосту
`odintsov1.live.fvds.ru`. При необходимости override:

```bash
SIGUR_RUNTIME_ALLOWED_HOSTS=odintsov1.live.fvds.ru
```

На локальных/dev-машинах вне allowlist backend может стартовать, но:
- не поднимает `presence-polling`
- не поднимает `sigur-monitor`
- не поднимает `structure-scheduler`
- не поднимает `events-daily-scheduler`
- ручные Sigur sync возвращают `403 SIGUR_RUNTIME_NOT_ALLOWED`

### Однократно после фикса clock skew / future checkpoint

Если в `pm2 logs fot-server` есть предупреждения вида
`[presence-polling] runtime_state checkpoint ... is in the future, falling back`,
нужно выполнить разовый post-fix:

1. Поправить часы на Windows-машине, которая могла писать в prod-БД, или убедиться,
   что локальный dev-сервер больше не подключён к prod Supabase.
2. Сбросить "будущий" checkpoint в `sigur_runtime_state`:

```sql
UPDATE sigur_runtime_state
SET checkpoint_at = NOW() - INTERVAL '10 min',
    meta = meta - 'lastEventFlowAt'
WHERE key = 'sigur_presence_polling';
```

3. Перезапустить prod-бэкенд:

```bash
ssh vds
cd /var/www/fot
pm2 restart fot-server --update-env
```

### После каждого deploy бэкенда: 5 обязательных проверок

#### 1. PM2 здоров

```bash
ssh vds
pm2 status fot-server
```

Ожидаем: `fot-server` в статусе `online`, без restart-loop.

#### 2. Lease у прод-процесса, не у Windows/dev

Проверка через SQL Editor Supabase:

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

Ожидаем:
- `leader_owner` и `last_cycle_owner` принадлежат prod-хосту (`sigur_presence_polling:odintsov1.live.fvds.ru:...`)
- `lease_owner` во время запроса может быть `NULL` между циклами polling — это нормально
- нет владельца вида `WIN:` / `PC-...`

#### 3. Sentry чист по clock skew

```bash
ssh vds
cd /var/www/fot/fot-server
set -a; source .env; set +a
./node_modules/@sentry/cli/bin/sentry-cli issues list \
  --org "$SENTRY_ORG" \
  --project "$SENTRY_PROJECT" \
  --query "clock_skew_lease_refused is:unresolved" \
  --max-rows 20
```

Ожидаем: пустой результат или отсутствие новых unresolved issues по
`clock_skew_lease_refused`.

Если `sentry-cli` отвечает `403`, значит токен из `.env` не имеет прав на чтение
Issues. В этом случае проверку нужно делать либо в Sentry UI, либо токеном с
доступом на чтение Issues/Project.

#### 4. События реально идут

Проверка через SQL Editor Supabase:

```sql
SELECT MAX(created_at) AS last_created_at
FROM skud_events;
```

Ожидаем: `MAX(created_at)` близок к `NOW()` в часы реальной активности сотрудников.

#### 5. Daily sync отработал после 05:00 MSK и без ошибок

Проверка через SQL Editor Supabase:

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

Ожидаем:
- если уже после `05:00 MSK`, `lastRunYmdMsk` = текущая дата по Москве
- если ещё до `05:00 MSK`, достаточно видеть предыдущий успешный запуск без ошибок
- `errors = 0`
- `lastError` пустой

### Rollback: снять залипший lease у мёртвого процесса

Если lease завис на мёртвом процессе и новый polling не может его захватить:

1. Сначала посмотреть текущего владельца:

```sql
SELECT key, lease_owner, lease_expires_at, heartbeat_at
FROM sigur_runtime_state
WHERE key IN ('sigur_presence_polling', 'sigur_exclusive_sync');
```

2. Если `lease_owner` точно относится к мёртвому процессу, снять lease через RPC:

```sql
SELECT release_sigur_runtime_lease('sigur_presence_polling', '<lease_owner>');
```

Для stuck manual/exclusive sync аналогично:

```sql
SELECT release_sigur_runtime_lease('sigur_exclusive_sync', '<lease_owner>');
```

После release — перезапустить `fot-server` и снова пройти 5 проверок выше.

## Изменения: чат (боковая панель, реалтайм, шифрование)

**Деплой: полный (оба)** — изменения и на фронте, и на бэкенде, + новая зависимость `socket.io-client` на фронте.

### Что изменилось
- **Реалтайм**: фронтенд переведён с native WebSocket на `socket.io-client` (совместим с Socket.IO на бэкенде)
- **Боковая панель**: чат теперь открывается плавающей кнопкой (правый нижний угол) на всех страницах, а не отдельной страницей
- **Шифрование сообщений**: AES-256-GCM через `encryptionService`, старые сообщения отображаются как есть
- **Toast-уведомления**: при новом сообщении приходит toast, если панель закрыта
- **Поиск пользователей**: фильтр `is_approved`, увеличен лимит до 50

### Файлы (фронтенд)
- `fot-app/src/services/websocket.ts` — переписан на `socket.io-client`
- `fot-app/src/hooks/useChat.ts` — фикс событий, отправка через socket
- `fot-app/src/contexts/ChatContext.tsx` — новый (глобальный контекст чата)
- `fot-app/src/components/chat/ChatButton.tsx` — новый (плавающая кнопка)
- `fot-app/src/components/chat/ChatSidePanel.tsx` — новый (боковая панель)
- `fot-app/src/App.tsx` — ChatProvider + ChatButton + ChatSidePanel
- `fot-app/src/components/layout/EmployeeSidebar.tsx` — убран пункт "Сообщения"

### Файлы (бэкенд)
- `fot-server/src/services/chat.service.ts` — шифрование, searchUsers

## Изменения: загрузка документов через бэкенд (фикс CORS Cloud.ru S3)

**Деплой: полный (оба)** — изменения и на фронте, и на бэкенде.

### Что изменилось
- Фронт больше не делает `PUT` напрямую в S3 по presigned URL. Файл уходит `multipart/form-data` на новый роут `POST /api/documents/upload`, бэкенд сам кладёт объект в S3 через AWS SDK.
- SSE-KMS шифрование сохранено: `r2.uploadObject` навешивает `ServerSideEncryption: 'aws:kms'` + `SSEKMSKeyId` если KMS Key ID задан в "Системе".
- Старые роуты `POST /api/documents/upload-url` и `POST /api/documents/confirm` удалены (нигде больше не использовались).
- Лимит размера: 20 МБ (multer.memoryStorage).

### Файлы (бэкенд)
- `fot-server/src/services/r2.service.ts` — `+ uploadObject(key, body, contentType)`
- `fot-server/src/controllers/documents.controller.ts` — `+ uploadFile`, `- getUploadUrl`, `- confirmUpload`
- `fot-server/src/routes/documents.routes.ts` — `+ POST /upload` с multer, `- /upload-url`, `- /confirm`

### Файлы (фронтенд)
- `fot-app/src/services/documentService.ts` — `uploadFile` шлёт FormData на `/documents/upload`, удалены `getUploadUrl` и `confirmUpload`

### Опционально: CORS на бакете (страховка)
Скрипт `fot-server/scripts/setup-s3-cors.ts` ставит `PutBucketCors` на бакет — нужен только если в будущем снова понадобится прямая загрузка из браузера. На текущий фикс не влияет.
```bash
cd /var/www/fot/fot-server
npx tsx scripts/setup-s3-cors.ts
```

## PM2 команды
```bash
pm2 status              # статус процессов
pm2 logs fot-server     # логи сервера
pm2 restart fot-server  # перезапуск
pm2 stop fot-server     # остановка
```

## Nginx
```bash
# конфиги
/etc/nginx/sites-enabled/fotsu10
/etc/nginx/sites-enabled/odintsov1live

# проверка
nginx -t
```

### Предупреждения nginx

Если снова появится предупреждение о конфликтующем `server_name fotsu10.fvds.ru`, сначала проверь,
не лежит ли backup-конфиг FOT внутри `sites-enabled` (например, `fotsu10.bak.*`). Такой backup с теми
же server-block'ами не ломает текущий апстрим, но засоряет проверку конфига и путает следующие правки.

Правильное состояние:
- активный конфиг: `/etc/nginx/sites-enabled/fotsu10`
- backup хранить вне `sites-enabled` (например, `/etc/nginx/sites-disabled/` или `/root/`)

### Reload на этом сервере

На этом хосте `nginx.service` сейчас находится в `failed/inactive`, поэтому обычный
`systemctl reload nginx` не является рабочим путём. Кроме того, на сервере одновременно запущено
несколько `nginx/openresty` master-процессов, так что "вслепую" слать reload всем подряд нельзя.

Перед любым reload:
```bash
systemctl status nginx --no-pager
ps -C nginx -o pid,ppid,cmd
```

Если менялся именно FOT nginx-конфиг, это отдельная ops-задача: сначала определить, какой master
обслуживает `/etc/nginx/sites-enabled/fotsu10`, и только потом делать точечный reload.

### Статика и SPA-fallback (важно)

Чанки фронта именуются по content-hash (`StaffControlPage-<hash>.js`). После деплоя
старые имена с диска пропадают. Если общий `try_files $uri /index.html;` ловит и
`/assets/*.js`, браузер получит HTML с MIME `text/html`, отвалится строгий module
script check, и в консоли посыпется «Failed to load module script». Чтобы вместо
этого отдавался честный `404`, в server-block должен быть отдельный location до
SPA-fallback'а:

```nginx
# отдельный location для статики Vite — должен идти ДО общего try_files
location ~* ^/assets/ {
    root /var/www/fot/fot-app/dist;
    try_files $uri =404;
    expires 1y;
    add_header Cache-Control "public, immutable";
}

# SPA-fallback (как сейчас)
location / {
    root /var/www/fot/fot-app/dist;
    try_files $uri /index.html;
}
```

Фронт сам ловит ошибку загрузки чанка (`utils/staleChunkReload.ts`) и однократно
перезагружает страницу — после правки nginx это будет срабатывать чище (без
страшных MIME-warning'ов в консоли и Sentry).

После правки: `nginx -t && systemctl reload nginx` и `curl -I https://fotsu10.fvds.ru/assets/non-existent.js`
→ ожидаем `404`, не `200 + text/html`.

## .env файлы
Расположены на сервере, не в git:
- `/var/www/fot/fot-server/.env` — порт 4000, production, CORS, JWT, Sigur, `DATABASE_URL` (Yandex Managed PG), `DATABASE_POOL_MAX`, `DATABASE_STATEMENT_TIMEOUT_MS`, `DATABASE_SSL`, опционально `DATABASE_SSL_CA_PATH` (после Phase 10 переезда с Supabase Cloud).
- `/var/www/fot/fot-app/.env` — `VITE_API_URL` (фронт ходит только в API, без прямого подключения к БД).

## SSL
Для `fotsu10.fvds.ru` сертификат уже существует и подключён в отдельном HTTPS server-block на порту `4443`.

Текущие файлы сертификата:
```bash
/etc/letsencrypt/live/fotsu10.fvds.ru/fullchain.pem
/etc/letsencrypt/live/fotsu10.fvds.ru/privkey.pem
```

Текущий HTTPS endpoint:
```bash
https://fotsu10.fvds.ru:4443
```

Важно: сейчас `80` и `4443` живут параллельно, автоматического редиректа с HTTP на HTTPS нет.

Проверка:
```bash
curl -kI https://fotsu10.fvds.ru:4443
curl -I http://fotsu10.fvds.ru
```

Продление сертификата:
```bash
certbot renew --dry-run
```

Если сертификат нужно перевыпустить вручную:
```bash
certbot certonly --webroot -w /var/www/certbot -d fotsu10.fvds.ru
```

## Swap (для сборки Vite)
Добавлен 2GB swap-файл. Для сохранения после перезагрузки:
```bash
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

## Public Data API (FastAPI)

Отдельный read-only сервис `fot-data-api/` (Python, FastAPI). Внешние программисты ходят на `https://<домен>/external/v1/*` с заголовком `Authorization: Bearer fot_<prefix>_<secret>`. Управление ключами и whitelist таблиц/полей — через админ-вкладку «API-доступ» в FOT.

### Установка (первый раз)
```bash
sudo apt install -y python3.12 python3.12-venv
cd /var/www/fot/fot-data-api
python3.12 -m venv venv
venv/bin/pip install -r requirements.txt

# .env (значения из fot-server/.env, не коммитим)
cat > .env <<'EOF'
DATABASE_URL=postgresql://user:pass@host:6432/dbname
DATABASE_SSL=true
DATABASE_SSL_CA_PATH=/etc/ssl/yandex/root.crt
PORT=4001
DEFAULT_RATE_LIMIT_PER_MINUTE=60
EOF
chmod 600 .env
```

### Применение миграции
```bash
psql "$DATABASE_URL" -f /var/www/fot/docs/migrations/060_data_api.sql
```

### Запуск через PM2
```bash
pm2 start "venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 4001" \
  --name fot-data-api \
  --cwd /var/www/fot/fot-data-api
pm2 save
```

### Nginx
В существующий server-block (`/etc/nginx/sites-enabled/fotsu10` или `odintsov1live`) добавить:
```nginx
location /external/v1/ {
    proxy_pass http://127.0.0.1:4001/external/v1/;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_read_timeout 30s;
}
```
Перечитать конфиг: `nginx -t && systemctl reload nginx`.

### Проверка
```bash
curl https://<домен>/external/v1/health
# {"ok":true}
```
Swagger UI (только для отладки) — `https://<домен>/external/v1/docs`.

### PM2 команды
```bash
pm2 logs fot-data-api
pm2 restart fot-data-api
```
