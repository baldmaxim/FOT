# Ручные SQL-правки данных

Файлы этого каталога **не применяются** автоматически: `scripts/deploy-server.sh migrate`
и `fot-server/scripts/run-migrations.mjs` читают только `docs/migrations/` и шлют SQL через
драйвер `pg`, где psql-мета-команды (`\if`, `\set`, `\endif`) недопустимы.

Здесь лежат разовые правки данных, которые обязаны выполняться вручную и осознанно —
с предпросмотром, бэкапом БД и проверкой результата. Запуск описан в шапке каждого файла;
как правило это:

```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <файл>              # предпросмотр (ROLLBACK)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v apply=on -f <файл>  # применение
```

Файлы отката к ним — в `docs/rollbacks/`.
