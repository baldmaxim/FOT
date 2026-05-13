# fot-data-api

Read-only публичный Data API на FastAPI. Внешние программисты получают
API-ключ через админ-вкладку «API-доступ» в FOT (Express + React) и читают
данные разрешённых таблиц/полей напрямую из PostgreSQL (Yandex Managed PG /
любой Postgres-совместимый хост).

## Локальный запуск

```bash
cd fot-data-api
python -m venv .venv
.venv/Scripts/activate          # Windows
# . .venv/bin/activate          # Linux/Mac

pip install -r requirements.txt
cp .env.example .env            # заполнить DATABASE_URL, DATABASE_SSL и др.
uvicorn app.main:app --reload --port 4001
```

`.env` (минимальный набор):

```
DATABASE_URL=postgresql://user:pass@host:6432/dbname
DATABASE_SSL=true
# Опционально — путь к корневому CA для verify-full (Yandex Managed PG):
# DATABASE_SSL_CA_PATH=/etc/ssl/yandex/root.crt
PORT=4001
DEFAULT_RATE_LIMIT_PER_MINUTE=60
```

Swagger UI: <http://localhost:4001/external/v1/docs>

## Endpoints

Все запросы требуют заголовка `Authorization: Bearer fot_<prefix>_<secret>`,
кроме `/external/v1/health`.

| Метод | Путь | Описание |
|---|---|---|
| GET | `/external/v1/health` | Health check, без auth. |
| GET | `/external/v1/tables` | Список таблиц, разрешённых ключу. |
| GET | `/external/v1/tables/{name}/schema` | Список полей таблицы (только разрешённые). |
| GET | `/external/v1/tables/{name}` | Чтение данных таблицы. |

Поддерживаемые query-параметры для чтения:

- `limit` (1..1000, default 100)
- `offset` (default 0)
- `order=column.asc` / `order=column.desc`
- Фильтры: `eq.column=v`, `neq.`, `gt.`, `gte.`, `lt.`, `lte.`, `like.`,
  `ilike.`, `in.column=v1,v2,v3`. Колонка должна быть в whitelist.

## Безопасность

- Имена таблиц проверяются по `data_api_key_tables`, неразрешённые → 404.
- Поля в фильтрах/сортировке должны быть в `allowed_fields`, иначе 400.
- SQL собирается через `psycopg.sql.Identifier` для таблиц/колонок и через
  параметры (`%s`) для значений — никаких f-string в запросах.
- Rate limit per-key через slowapi, лимит — `rate_limit_per_minute` ключа.
- Каждый запрос пишется в `data_api_request_logs` (best-effort).

## Архитектура runtime (Phase 10G)

- AsyncConnectionPool psycopg 3.x (`app/lib/postgres.py`) поднимается через
  FastAPI lifespan и закрывается при остановке.
- Все обращения к БД (`fetch_one`/`fetch_all`/`execute`) — async, не блокируют
  event loop.
- До Phase 10G сервис использовал `@supabase/supabase-js` Python SDK
  (`app/lib/supabase.py` + builder-цепочки PostgREST). Файл удалён,
  dependency `supabase` снята из `requirements.txt`.

## Деплой

См. `DEPLOY.md` в корне репозитория, секция «Public Data API (FastAPI)».
