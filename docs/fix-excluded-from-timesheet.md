# Фикс: сотрудник не видит табель в ЛК (excluded_from_timesheet баг)

## Проблема

При реактивации увольненного сотрудника через Sigur-синхронизацию флаг `excluded_from_timesheet` не сбрасывается. Результат:
- **Администратор**: видит реальные дни прохода в карточке (через отдельный СКУД-API)
- **Сотрудник в ЛК**: видит "Н" (неявка) везде, хотя проходит

## Причина

При увольнении (`employment_status = 'fired'`) в контроллере `employee-lifecycle` ставится `excluded_from_timesheet = true`. При реактивации через `sigur-sync-employees` этот флаг не сбрасывается, хотя сбрасывается `dismissal_date`.

## Решение

### 1. Кодовый фикс (уже применен в коммите)

**Файл:** `fot-server/src/services/sigur-sync-employees.service.ts`

Две локации исправлены:
- **Строки 514-517**: при реактивации fired-сотрудника добавлен сброс `excluded_from_timesheet = false` + `excluded_from_timesheet_date = NULL`
- **Строки 580-583**: при автолинке portal-only сотрудника к Sigur добавлен тот же сброс

### 2. Дата-фикс для конкретного сотрудника (ручное выполнение на проде)

Применить на прод-БД:
```sql
UPDATE employees
SET excluded_from_timesheet = false,
    excluded_from_timesheet_date = NULL
WHERE id = 493
  AND employment_status = 'active';
```

### 3. Поиск других затронутых сотрудников

Перед применением UPDATE выполнить диагностический запрос:
```sql
SELECT id, full_name, employment_status, excluded_from_timesheet_date
FROM employees
WHERE employment_status = 'active'
  AND excluded_from_timesheet = true
ORDER BY full_name;
```

Если результат не пустой, применить UPDATE для всех затронутых:
```sql
UPDATE employees
SET excluded_from_timesheet = false,
    excluded_from_timesheet_date = NULL
WHERE employment_status = 'active'
  AND excluded_from_timesheet = true;
```

## Проверка

### На локальной dev-БД (тестирование)

1. Убедиться что кодовый фикс применен (коммит в бэкенде)
2. Запустить тесты: `cd fot-server && npm run test` (все должны пройти)
3. Уволить тестового сотрудника через карточку — проверить что `excluded_from_timesheet = true`
4. Реактивировать его через Sigur-sync (запустить scheduler): `POST /api/admin/sigur-structure/sync`
5. Проверить БД: `SELECT ... WHERE id = 493;` — должны быть оба флага в false

### На продакшене

1. Перед деплоем кодового фикса применить SQL-дата-фикс для сотрудника 493 (см. выше)
2. Деплоить бэкенд с кодовым фиксом
3. В ЛК сотрудника 493 проверить что табель отображается корректно (дни прохода видны, не "Н")
4. На основе результата диагностического запроса исправить остальных затронутых сотрудников

## Миграция БД

Фикс не требует миграции — это исправление логики синхронизации.
