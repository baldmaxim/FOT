# Patch: 026_skud_object_maps.sql на Yandex

> Этот патч актуален только при **ручном последовательном прогоне**
> миграций на свежем Yandex-кластере. При штатном пути через
> `pg_dump --schema-only` + `prepare-yandex-schema.mjs` патч **не нужен**:
> трансформер автоматически стрипает `INSERT INTO storage.buckets`.

## Что не работает на Yandex

[`docs/migrations/026_skud_object_maps.sql`](../../migrations/026_skud_object_maps.sql)
в самом конце содержит:

```sql
INSERT INTO storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
)
VALUES (
  'skud-object-maps', 'skud-object-maps', false, 10485760,
  ARRAY['image/png', 'image/jpeg', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET …;
```

Это запись в таблицу `storage.buckets` из Supabase-schema `storage`,
которой **на Yandex Managed PG нет** (схема `storage` — часть Supabase
Storage-сервиса, не часть PostgreSQL). При прогоне на чистом Yandex
этот блок упадёт с `schema "storage" does not exist`.

## Что делать

1. **Пропустить** блок `INSERT INTO storage.buckets … COMMIT;` при ручном
   применении 026 на Yandex. Остальное содержимое миграции (ALTER TABLE,
   CREATE TABLE, CREATE INDEX) применять без изменений.

   Удобный способ:

   ```bash
   awk '/^INSERT INTO storage\.buckets/ {skip=1} !skip; /^COMMIT;/ {skip=0}' \
     docs/migrations/026_skud_object_maps.sql \
   | psql "$YANDEX_DB_URL" -v ON_ERROR_STOP=1
   ```

   (этот awk пропускает блок от `INSERT INTO storage.buckets` до строки
   с `COMMIT;`; затем нужно отдельно выполнить финальный `COMMIT;` —
   проще обернуть всё в одну транзакцию вручную).

2. **Создать бакет `skud-object-maps` в Yandex Object Storage** отдельно
   — через UI / `yc storage bucket create` / Terraform. Подробно — в
   [`../06_storage.md`](../06_storage.md), §2-3.

3. Бэкенд (`fot-server`) обращается к этому бакету через
   [`fot-server/src/services/object-map-storage.service.ts`](../../../fot-server/src/services/object-map-storage.service.ts)
   — S3-клиент, никаких `storage.buckets` ему не нужно.

## Почему так, а не «убрать INSERT из 026»

`docs/migrations/026_skud_object_maps.sql` — исторический артефакт. Он
уже применён в боевом Supabase, где `INSERT INTO storage.buckets`
**отрабатывает корректно** и создаёт нужный бакет. Удалять этот блок
из исторической миграции значит:

- ввести расхождение между «что в репо» и «что было применено на проде»;
- сломать reproducibility восстановления Supabase-окружения из миграций
  (например, в dev-инстансе);
- запутать команду — git-blame покажет правку «после применения».

См. [`README.md`](README.md) в этой папке для общих правил.
