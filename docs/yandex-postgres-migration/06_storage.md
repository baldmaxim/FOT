# 06 — Перенос файлового хранилища (Supabase Storage → S3-совместимое)

В системе ровно одно использование Supabase Storage — карты объектов СКУД
(бакет `skud-object-maps`). После миграции бэкенд ходит за этими файлами
в S3-совместимое хранилище (Yandex Object Storage по умолчанию; AWS S3 /
Cloudflare R2 / MinIO тоже совместимы).

Связанные файлы:

- [fot-server/src/services/object-map-storage.service.ts](../../fot-server/src/services/object-map-storage.service.ts) — рантайм-сервис.
- [fot-server/scripts/yandex-migration/migrate-skud-object-maps-storage.ts](../../fot-server/scripts/yandex-migration/migrate-skud-object-maps-storage.ts) — перевозка файлов.
- [docs/migrations/026_skud_object_maps.sql](../migrations/026_skud_object_maps.sql) — историческая миграция БД (как есть; содержит `INSERT INTO storage.buckets` для Supabase — на Yandex этот блок не применяется, см. [patches/026_skud_object_maps.md](patches/026_skud_object_maps.md)).

## 1. Что изменилось в коде

| Было | Стало |
|---|---|
| `fot-server/src/services/supabase-storage.service.ts` | удалён |
| `import { SKUD_OBJECT_MAPS_BUCKET, supabaseStorageService } from './supabase-storage.service.js'` | `import { SKUD_OBJECT_MAPS_BUCKET, objectMapStorageService } from './object-map-storage.service.js'` |
| `supabase.storage.from(bucket)` | `@aws-sdk/client-s3` ↔ S3-совместимый endpoint |
| `INSERT INTO storage.buckets ...` в миграции 026 | **остаётся в исторической миграции**; на Yandex блок пропускается ([patches/026_skud_object_maps.md](patches/026_skud_object_maps.md)) либо автоматически стрипается `prepare-yandex-schema.mjs` при работе через dump |

API сервиса не изменился — те же методы:

- `buildObjectMapPath(objectId, fileName)` — `travel-objects/<id>/<uuid>.<ext>`
- `createSignedUploadUrl(bucketAlias, storagePath)` → `{ signedUrl, path, token: '' }`
- `createSignedDownloadUrl(bucketAlias, storagePath, expiresIn?)` → URL
- `ensureObjectExists(bucketAlias, storagePath)` → throws если нет
- `removeObject(bucketAlias, storagePath)` — idempotent (404 = no-op)

`bucketAlias` валидируется по allowlist (на сегодня единственный
`SKUD_OBJECT_MAPS_BUCKET = 'skud-object-maps'`) — посторонние alias'ы
бросают исключение, чтобы случайно не записать в чужой бакет.

`SKUD_OBJECT_MAPS_BUCKET` оставлен как const-alias и одновременно служит
именем реального S3-бакета (т. е. оператор создаёт бакет с этим именем
в Yandex Object Storage).

## 2. Создать бакет в Yandex Object Storage

### Через UI

Yandex Cloud → Object Storage → **Create bucket** → name `skud-object-maps`,
storage class `Standard`, access — **Private** (без публичного доступа), без
ACL. Регион — тот же, что у Yandex Managed PG (обычно `ru-central1`).

### Через CLI

```bash
yc storage bucket create \
  --name skud-object-maps \
  --default-storage-class STANDARD \
  --max-size 10737418240
```

### Через Terraform

```hcl
resource "yandex_storage_bucket" "skud_object_maps" {
  bucket = "skud-object-maps"
  access_key = yandex_iam_service_account_static_access_key.fot.access_key
  secret_key = yandex_iam_service_account_static_access_key.fot.secret_key

  anonymous_access_flags {
    read = false
    list = false
  }
}
```

## 3. Сервисный аккаунт + ключи

Бэкенду нужен доступ на чтение/запись в бакет. Через service-аккаунт:

```bash
yc iam service-account create --name fot-storage
yc storage bucket update --name skud-object-maps \
  --grant role-id=storage.editor \
            subject-type=serviceAccount \
            subject-id=<sa-id>
yc iam access-key create --service-account-name fot-storage \
  --format json > ~/.fot/yc-storage-key.json
```

Этот же ключ потом попадёт в `OBJECT_STORAGE_ACCESS_KEY_ID` /
`OBJECT_STORAGE_SECRET_ACCESS_KEY` на бэкенде.

## 4. Настройка бэкенда (env)

Добавьте в `fot-server/.env` (или прод-окружение):

```dotenv
OBJECT_STORAGE_ENDPOINT=https://storage.yandexcloud.net
OBJECT_STORAGE_REGION=ru-central1
OBJECT_STORAGE_ACCESS_KEY_ID=YCAJ...
OBJECT_STORAGE_SECRET_ACCESS_KEY=YCN...
# По умолчанию false (virtual-hosted style: https://<bucket>.storage.yandexcloud.net).
# Включайте только для MinIO или прокси, который не поддерживает vhost-style.
OBJECT_STORAGE_FORCE_PATH_STYLE=false
```

### Параметры для других провайдеров

| Provider | OBJECT_STORAGE_ENDPOINT | REGION | FORCE_PATH_STYLE |
|---|---|---|---|
| Yandex Object Storage | `https://storage.yandexcloud.net` | `ru-central1` | `false` |
| AWS S3 | `https://s3.<region>.amazonaws.com` | реальный | `false` |
| Cloudflare R2 | `https://<acct>.r2.cloudflarestorage.com` | `auto` | `false` |
| MinIO (self-hosted) | `http://minio:9000` | `us-east-1` (любой) | `true` |

## 5. Перевозка существующих файлов (если в Supabase Storage уже есть данные)

`fot-server/scripts/yandex-migration/migrate-skud-object-maps-storage.ts`
читает `public.skud_objects.map_storage_path`, скачивает каждый объект
из `skud-object-maps` Supabase Storage и заливает в целевой S3.

### ENV

```bash
# Источник
export SOURCE_DATABASE_URL='postgres://...@db.<project>.supabase.co:5432/postgres?sslmode=require'
export SOURCE_SUPABASE_URL='https://<project>.supabase.co'
export SOURCE_SUPABASE_SERVICE_ROLE_KEY='eyJ...'

# Цель
export TARGET_OBJECT_STORAGE_ENDPOINT='https://storage.yandexcloud.net'
export TARGET_OBJECT_STORAGE_ACCESS_KEY_ID='YCAJ...'
export TARGET_OBJECT_STORAGE_SECRET_ACCESS_KEY='YCN...'
export TARGET_OBJECT_STORAGE_REGION='ru-central1'
# TARGET_BUCKET по умолчанию совпадает с источником ('skud-object-maps').
```

### Запуск

```bash
cd fot-server

# Dry-run по умолчанию — посмотреть план.
npm run migrate:yandex:skud-object-maps -- --dry-run

# Реальная перевозка.
npm run migrate:yandex:skud-object-maps -- --apply
```

### Поведение

- Идемпотентно: если объект уже есть в target (HeadObject 200) → `skipped_exists`.
- Параллельность — `BATCH_SIZE` (по умолчанию 25).
- Скачивание через `supabase.storage.from(bucket).download(path)`, заливка
  через `@aws-sdk/client-s3` `PutObjectCommand`.
- `ContentType` сохраняется из Supabase (image/png|jpeg|webp).
- Отчёт: `.migration/storage_migration_report.{json,md}` — totals + first 5
  successful samples + first 50 failures.

### Exit codes

- `0` — все объекты успешно (migrated или skipped)
- `1` — есть failed
- `2` — fatal (ENV / коннект)

## 6. Что делать с `docs/migrations/026_skud_object_maps.sql`

Файл миграции **остаётся неизменённым** — он замёрз как исторический
артефакт, применённый в боевом Supabase. На Yandex штатный путь —
через `pg_dump --schema-only` + `prepare-yandex-schema.mjs`, который
автоматически вычистит `INSERT INTO storage.buckets`.

Если по какой-то причине прогоняете 026 на Yandex напрямую (например,
поднимаете dev-инстанс из чистых миграций) — пропустите блок
`INSERT INTO storage.buckets … COMMIT;` руками. Подробная инструкция и
готовый awk-фильтр — в [patches/026_skud_object_maps.md](patches/026_skud_object_maps.md).

Бакет создаётся вне БД — см. §2.

## 7. Чек-лист перехода на новый storage

- [ ] Создан бакет `skud-object-maps` в Yandex Object Storage.
- [ ] Создан service-аккаунт с правами `storage.editor` на бакет.
- [ ] `OBJECT_STORAGE_*` env-переменные заполнены на бэкенде.
- [ ] Если в Supabase Storage уже есть файлы — выполнен
      `migrate:yandex:skud-object-maps -- --apply`, отчёт без failures.
- [ ] Открыта страница «Карта объекта» в админке — карта загружается
      (signed download URL работает), upload новой карты тоже работает.
- [ ] (опционально) Supabase Storage бакет можно оставить как
      read-only / cold-archive до момента полного перехода — на случай
      отката. После недели работы — удалить.

## 8. Где грабли

- **CORS на новом бакете.** Если фронт грузит/тянет файлы напрямую по
  signed-URL — нужно настроить CORS у бакета (Yandex Console →
  Bucket → CORS-конфигурация → разрешить `PUT`, `GET` из вашего домена).
- **Размер файла.** В прежней схеме был лимит 10 MB через
  `file_size_limit` в `storage.buckets`. В S3 такого лимита нет — оператор
  настраивает на уровне CORS-policy или валидации на бэкенде. Уже есть в
  коде: `MAX_TRAVEL_OBJECT_MAP_FILE_SIZE = 10 MiB` в
  `skud-travel.service.ts` — оставлено как есть.
- **MIME-types.** Прежняя схема ограничивала `image/png|jpeg|webp` через
  `storage.buckets.allowed_mime_types`. На S3 это не enforced — оставлен
  валидатор в коде (`TRAVEL_OBJECT_MAP_ALLOWED_MIME_TYPES`).
- **forcePathStyle=true для MinIO**. Если разворачиваете dev-стенд с
  MinIO, выставьте `OBJECT_STORAGE_FORCE_PATH_STYLE=true` — иначе
  S3-клиент попытается ходить по vhost-стилю
  (`bucket.minio:9000`), что обычно не работает.
