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
cd fot-app && NODE_OPTIONS='--max-old-space-size=1024' npm run build
```

## Быстрый деплой (бэкенд)
```bash
ssh vds
cd /var/www/fot && git pull
cd fot-server && npm run build
pm2 restart fot-server
```

## Полный деплой (оба)
```bash
ssh vds
cd /var/www/fot && git pull
cd fot-server && npm ci && npm run build && pm2 restart fot-server
cd ../fot-app && npm ci && NODE_OPTIONS='--max-old-space-size=1024' npm run build
```

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
