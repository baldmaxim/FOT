# .migration/ — миграционные артефакты

Эта директория используется скриптами в `scripts/yandex-migration/` и
`fot-server/scripts/yandex-migration/` как рабочая папка для credentials,
дампов, и отчётов.

**Большая часть содержимого `.gitignore`'нута**, в репо коммитятся только:
- `README.md` (этот файл)
- `yandex.env.example` (шаблон credentials)

Всё остальное создаётся на лету при запуске пайплайна.

## Файлы

| Файл | Что |
|---|---|
| `yandex.env` | Real credentials. Никогда не коммитить. Скопировать из `.example`. |
| `yandex-ca.pem` | Yandex root CA для verify-full. Скачать: `curl -fsSL https://storage.yandexcloud.net/cloud-certs/CA.pem -o .migration/yandex-ca.pem` |
| `supabase_schema.sql` | Schema dump из source (`export-public-schema.sh`). |
| `yandex_schema.sql` / `yandex_schema_pre_data.sql` / `yandex_schema_post_data.sql` | Transformed schema (`prepare-yandex-schema.mjs`). |
| `supabase_public_data.dir/` | Data dump из source (`export-public-data-dir.sh` или `export-public-data.sh`). |
| `schema_transform_report.md` | Отчёт по transform. |
| `auth_users_report.{json,md}` | Отчёт `migrate-auth-users`. |
| `sequences_report.md` | Отчёт `fix-sequences`. |
| `verify_public_data_report.{json,md}` | Отчёт `verify-public-data`. |
| `yandex_preflight_report.{json,md}` | Отчёт `preflight-yandex-db`. |
| `storage_migration_report.{json,md}` | Отчёт `migrate-skud-object-maps`. |
| `skud_events_chunks_report.{json,md}` | Отчёт `migrate-skud-events-chunked`. |

## Загрузка credentials

```bash
cp .migration/yandex.env.example .migration/yandex.env
# отредактировать .migration/yandex.env (вписать пароли/URL'ы)
set -a; source .migration/yandex.env; set +a
```

## Последовательность пайплайна

См. [../docs/yandex-postgres-migration/STAGING_REHEARSAL_REPORT.md](../docs/yandex-postgres-migration/STAGING_REHEARSAL_REPORT.md).
