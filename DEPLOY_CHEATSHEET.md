# DEPLOY CHEATSHEET

Подробности — в [`DEPLOY.md`](DEPLOY.md). Здесь — самые частые сценарии готовыми командами.

Прод: `ssh root@45.80.128.254`. Build-контекст `/opt/fot-build`, конфиг сайта `/srv/sites/fot.su10.ru`.

---

## 1. Деплой только кода (без миграций)

```bash
cd /opt/fot-build
git fetch personal main && git reset --hard personal/main && git log -1 --oneline
bash scripts/deploy-server.sh both
```

- `both` = backend (TSC + PM2 restart) + frontend (Vite build + sourcemaps в Sentry).
- Альтернативы: `backend`, `frontend`, `--check` (только проверка без билда).

---

## 2. Деплой с миграцией БД

**Порядок: сначала миграция, потом код.** Иначе новый бэк может упасть на старой схеме.

```bash
# A. Подтянуть последний код в build-контекст
cd /opt/fot-build
git fetch personal main && git reset --hard personal/main && git log -1 --oneline

# B. Посмотреть какие новые миграции пришли
git --no-pager log --name-only --pretty=format:'%h %s' -- docs/migrations/ | head -30

# C. Применить миграцию (подставь номер NNN_<name>.sql)
PGSSLROOTCERT=/opt/fot-build/.migration/yandex-ca.pem \
psql "$(grep ^DATABASE_URL= /srv/sites/fot.su10.ru/fot-server/.env | cut -d= -f2- | tr -d '\"')" \
  -v ON_ERROR_STOP=1 \
  -f /opt/fot-build/docs/migrations/NNN_<name>.sql

# D. Задеплоить код
bash scripts/deploy-server.sh both
```

Если миграция с блоком `КОНТРОЛЬ ПОСЛЕ` (нужна проверка перед `COMMIT`) — см. подробный flow в [`DEPLOY.md` → «Миграции БД»](DEPLOY.md).

---

## 3. Только миграция (без передеплоя кода)

Если миграция чисто SQL-функция, идемпотентный бэкфилл и т.п. — деплой кода не обязателен.

```bash
cd /opt/fot-build
git fetch personal main && git reset --hard personal/main && git log -1 --oneline

PGSSLROOTCERT=/opt/fot-build/.migration/yandex-ca.pem \
psql "$(grep ^DATABASE_URL= /srv/sites/fot.su10.ru/fot-server/.env | cut -d= -f2- | tr -d '\"')" \
  -v ON_ERROR_STOP=1 \
  -f /opt/fot-build/docs/migrations/NNN_<name>.sql
```

---

## 4. Backfill-скрипт (.mjs / .ts)

Одноразовые скрипты лежат в `fot-server/scripts/`. Запуск с подгрузкой `.env` рантайма:

```bash
cd /opt/fot-build/fot-server
FOT_ENV_FILE=/srv/sites/fot.su10.ru/fot-server/.env \
  node scripts/<name>.mjs --dry-run

# если устраивает результат — без флага
FOT_ENV_FILE=/srv/sites/fot.su10.ru/fot-server/.env \
  node scripts/<name>.mjs
```

`.ts`-скрипты — то же, но `npx tsx scripts/<name>.ts ...`.

---

## 5. Хелперы

```bash
# Read-only SQL-запрос к проду
PGSSLROOTCERT=/opt/fot-build/.migration/yandex-ca.pem \
psql "$(grep ^DATABASE_URL= /srv/sites/fot.su10.ru/fot-server/.env | cut -d= -f2- | tr -d '\"')" \
  --pset=pager=off -c "SELECT now();"

# Проверка статуса PM2
pm2 list
pm2 logs fot-server --lines 50

# Если PM2 упал
pm2 restart fot-server
pm2 restart fot-data-api

# Полный health-check без билда
bash /opt/fot-build/scripts/deploy-server.sh --check
```

---

## 6. После деплоя

1. На фронте: **Hard refresh (Ctrl+Shift+R)** — Vite-бандлы по hash, но сервис-воркер может удержать старый `index.html`.
2. Проверить `pm2 list` — бэк `online`, restarts count не растёт.
3. Открыть `https://fot.su10.ru` и golden-path фичи.
4. Sentry — посмотреть нет ли новых ошибок в release `<commit-hash>`.

---

## Если что-то пошло не так

Откат — `git reset --hard <prev-commit>` в `/opt/fot-build` и повторный `deploy-server.sh both`. БД-миграции не откатываются автоматически — для каждой нужен ручной revert (обычно отдельный `.sql`).
