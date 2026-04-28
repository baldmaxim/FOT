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
| `http://odintsov1.live.fvds.ru` | Odintsov Live |

## Быстрый деплой (фронтенд)
```bash
ssh vds
cd /var/www/fot && git pull
export VITE_SENTRY_RELEASE=$(git rev-parse --short HEAD)
cd fot-app && NODE_OPTIONS='--max-old-space-size=1024' npm run build
```

## Быстрый деплой (бэкенд)
```bash
ssh vds
cd /var/www/fot && git pull
export SENTRY_RELEASE=$(git rev-parse --short HEAD)
cd fot-server && npm run build && npm run sentry:sourcemaps
pm2 restart fot-server --update-env
```

## Полный деплой (оба)
```bash
ssh vds
cd /var/www/fot && git pull
export SENTRY_RELEASE=$(git rev-parse --short HEAD)
export VITE_SENTRY_RELEASE=$SENTRY_RELEASE
cd fot-server && npm ci && npm run build && npm run sentry:sourcemaps && pm2 restart fot-server --update-env
cd ../fot-app && npm ci && NODE_OPTIONS='--max-old-space-size=1024' npm run build
```

> `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT` подгружаются из `.env` соответствующего проекта
> (см. [docs/sentry.md](docs/sentry.md)). Если они не заданы, sourcemaps не загружаются — сборка не падает,
> но в Sentry стек-трейсы будут поверх минифицированного кода.
>
> `pm2 restart … --update-env` нужен, чтобы PM2 подхватил новый `SENTRY_RELEASE` из shell.

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

# проверка и перезагрузка
nginx -t && systemctl reload nginx
```

## .env файлы
Расположены на сервере, не в git:
- `/var/www/fot/fot-server/.env` — порт 4000, production, CORS, Supabase, JWT, Sigur
- `/var/www/fot/fot-app/.env` — VITE_API_URL, Supabase ключи

## SSL
Сертификат для `fotsu10.fvds.ru` не получен (rate limit Let's Encrypt). HTTPS-заглушка редиректит на HTTP. Для получения:
```bash
certbot certonly --webroot -w /var/www/certbot -d fotsu10.fvds.ru
```
После получения — обновить nginx конфиг на полноценный HTTPS.

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
SUPABASE_URL=https://...supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
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
