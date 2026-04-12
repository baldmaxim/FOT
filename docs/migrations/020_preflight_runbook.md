# Runbook: Preflight for Migration 020

Этот документ нужен перед запуском [020_attendance_access_refactor.sql](/Users/odintsovlive/Desktop/Project/008%20FOT/docs/migrations/020_attendance_access_refactor.sql).

## Что такое preflight

Preflight - это безопасственная проверка базы **до** миграции.

Он ничего не меняет в данных. Он только отвечает на вопрос:

- есть ли дубли, которые сломают `UNIQUE INDEX`
- есть ли пересечения периодов, которые сломают новые ограничения
- есть ли legacy-данные, которые нужно учитывать до включения новой схемы
- есть ли строки, которые нельзя корректно сопоставить с `system_roles`

Для migration `020` preflight лежит в [020_attendance_access_refactor_preflight.sql](/Users/odintsovlive/Desktop/Project/008%20FOT/docs/migrations/020_attendance_access_refactor_preflight.sql).

Если хочется максимально простой вывод одной таблицей, используй [020_attendance_access_refactor_preflight_summary.sql](/Users/odintsovlive/Desktop/Project/008%20FOT/docs/migrations/020_attendance_access_refactor_preflight_summary.sql).

## Где запускать

Сначала запускать на `staging`.

`staging` - это отдельная тестовая база, максимально похожая на production, но безопасная для проверки миграций.

Если отдельного staging-проекта в Supabase нет:

1. Не запускать миграцию сразу на production.
2. Сначала сделать backup production.
3. По возможности поднять временный staging/clone.
4. Только после этого прогонять preflight и саму миграцию.

## Самый простой способ: через Supabase SQL Editor

1. Открыть Supabase Dashboard нужного проекта.
2. Перейти в `SQL Editor`.
3. Создать новый query.
4. Открыть файл [020_attendance_access_refactor_preflight.sql](/Users/odintsovlive/Desktop/Project/008%20FOT/docs/migrations/020_attendance_access_refactor_preflight.sql).
5. Скопировать весь SQL в редактор.
6. Нажать `Run`.

Для более удобного вывода можно вместо этого открыть [020_attendance_access_refactor_preflight_summary.sql](/Users/odintsovlive/Desktop/Project/008%20FOT/docs/migrations/020_attendance_access_refactor_preflight_summary.sql). Он вернёт один итоговый result set.

## Как читать результат

Для этого preflight нормальный результат такой:

- первые блоки с проблемами возвращают `0 rows`
- sanity-check блоки возвращают понятные служебные значения

### Что должно быть пустым

Эти выборки должны вернуть `0 rows`:

- `skud_daily_summary duplicates`
- `payslips duplicates`
- `role_page_access duplicates by system role target`
- `user_profiles without matching system role`
- `role_page_access without matching system role`
- `employee_assignments overlap`
- `employee_schedule_assignments overlap`
- `category_schedules overlap`
- `skud_events rows missing event_date/time for event_at backfill`

### Что может вернуть не ноль и это не ошибка само по себе

- `tender_timesheet rows to backfill`
  Это означает, что legacy-данные есть и migration `020` перенесёт их в `attendance_adjustments`.

- `skud_access_point_settings has organization_id`
- `skud_sync_employee_filter has organization_id`
  Если здесь `1`, значит колонка ещё существует и migration `020` её уберёт.

- `attendance_adjustments already exists`
  Если здесь `1`, значит migration уже применялась полностью или частично, и надо отдельно проверить текущее состояние базы перед повторным запуском.

## Что делать после preflight

### Если все проблемные выборки пустые

1. На том же `staging` открыть новый SQL query.
2. Вставить содержимое [020_attendance_access_refactor.sql](/Users/odintsovlive/Desktop/Project/008%20FOT/docs/migrations/020_attendance_access_refactor.sql).
3. Запустить миграцию.
4. После миграции проверить:
   - табель
   - расчётные листки
   - payments
   - роли и доступы

### Если preflight вернул строки

Миграцию не применять сразу.

Нужно сначала разобрать результат:

- дубли в `skud_daily_summary` или `payslips` надо дедуплицировать
- незамапленные роли надо добавить в `system_roles` или исправить `position_type/role_code`
- пересекающиеся периоды надо разрулить вручную
- если `attendance_adjustments already exists = 1`, сначала сравнить текущую схему с migration `020`

## Минимальный безопасный порядок

1. Backup staging.
2. Run preflight.
3. Исправить проблемы, если они есть.
4. Backup ещё раз, если были ручные правки.
5. Run migration `020`.
6. Проверить backend и ключевые пользовательские сценарии.
7. Повторить тот же порядок на production.

## Что важно для текущего проекта

Сейчас приложение ещё умеет работать с fallback на `tender_timesheet`, поэтому отсутствие migration `020` не всегда приводит к немедленному падению.

Но migration уже нужна, потому что именно она:

- вводит `attendance_adjustments`
- добавляет `event_at`
- создаёт нужные индексы
- нормализует `role_page_access` через `system_role_id`
- убирает legacy-хвосты `organization_id`

Без неё refactor работает в совместимом, но временном режиме.
