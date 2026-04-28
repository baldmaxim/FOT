# fot-data-api

Read-only публичный Data API на FastAPI. Внешние программисты получают
API-ключ через админ-вкладку «API-доступ» в FOT (Express + React) и читают
данные разрешённых таблиц/полей из Supabase.

## Локальный запуск

```bash
cd fot-data-api
python -m venv .venv
.venv/Scripts/activate          # Windows
# . .venv/bin/activate          # Linux/Mac

pip install -r requirements.txt
cp .env.example .env            # заполнить SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY
uvicorn app.main:app --reload --port 4001
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
- Никакого raw SQL — только цепочка builder-методов supabase-py.
- Rate limit per-key через slowapi, лимит — `rate_limit_per_minute` ключа.
- Каждый запрос пишется в `data_api_request_logs` (best-effort).

## Деплой

См. `DEPLOY.md` в корне репозитория, секция «Public Data API (FastAPI)».
