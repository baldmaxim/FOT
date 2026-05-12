# Patch: 060_data_api.sql — comment correction

Этот патч **не меняет SQL** миграции — он фиксирует фактически неверные
комментарии в исторической миграции
[`docs/migrations/060_data_api.sql`](../../migrations/060_data_api.sql).
Сам файл миграции остаётся как есть (он уже применён в проде; SQL
работает корректно).

## Что описано неверно в комментариях 060

### `key_prefix`

Комментарий в миграции:

```sql
-- Первые 8 символов секрета — публичный идентификатор для быстрого lookup.
key_prefix TEXT NOT NULL UNIQUE,
```

Фактически выпускающий ключи код в FOT (Express-сервис, admin-вкладка
«API-доступ») и проверяющий код в `fot-data-api`
([`app/services/auth.py`](../../../fot-data-api/app/services/auth.py))
оперируют **16 hex-символами** как префиксом. Формат токена в коде —
`fot_<16-hex-prefix>_<48-hex-secret>` (regex
`^fot_([0-9a-f]{16})_([0-9a-f]{48})$`).

Колонка `key_prefix` в БД хранит именно эти 16 hex-символов.

### `key_hash`

Комментарий в миграции:

```sql
-- bcrypt-хеш полного секрета (plaintext возвращается клиенту ровно один раз).
key_hash TEXT NOT NULL,
```

Фактически `key_hash` хранит **SHA-256(secret)** в hex-виде, не bcrypt.
См. проверку в
[`fot-data-api/app/services/auth.py`](../../../fot-data-api/app/services/auth.py):

```python
def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()

# ...
if not hmac.compare_digest(expected, _sha256_hex(secret)):
    raise HTTPException(...)
```

Дизайн-обоснование: API-токены создаются один раз и не ротируются
(rotation = новый ключ + revoke старого), поэтому затраты на bcrypt-cost
не оправданы. SHA-256 + `hmac.compare_digest` даёт constant-time compare
и достаточный уровень защиты для длинного (48 hex = 192 бита энтропии)
секрета.

`plaintext` возвращается клиенту ровно один раз при создании ключа —
эта часть комментария верна.

## Что делать

Ничего — корректная информация выше. Этот документ существует, чтобы
разработчик при чтении 060 знал про расхождение комментариев и кода и
не пытался искать «bcrypt» там, где работает SHA-256.

См. [`README.md`](README.md) этой папки — почему историческую миграцию
не правим даже ради комментариев.
