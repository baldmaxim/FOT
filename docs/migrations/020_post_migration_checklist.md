# Checklist: What to Verify After Migration 020

Этот чеклист нужен сразу после успешного применения
[020_attendance_access_refactor.sql](/Users/odintsovlive/Desktop/Project/008%20FOT/docs/migrations/020_attendance_access_refactor.sql)
на `staging`.

## 1. Проверка БД

### 1.1. Legacy rows действительно попали в attendance_adjustments

```sql
select source_type, count(*) as rows_count
from attendance_adjustments
group by 1
order by 1;
```

Ожидание:

- есть строки с `source_type = 'legacy_tender_timesheet'`
- их количество соответствует ожидаемому backfill

### 1.2. Посмотреть сами backfill-строки

```sql
select employee_id, work_date, status, hours_override, reason, source_type, source_id, created_at
from attendance_adjustments
where source_type = 'legacy_tender_timesheet'
order by work_date desc, employee_id
limit 20;
```

Ожидание:

- видны те строки, которые были в `tender_timesheet`
- даты, статусы и часы выглядят разумно

### 1.3. event_at заполнен

```sql
select count(*) as missing_event_at
from skud_events
where event_at is null;
```

Ожидание:

- `0`

### 1.4. Role canonicalization заполнена

```sql
select count(*) as user_profiles_missing_system_role_id
from user_profiles
where position_type is not null
  and system_role_id is null;
```

```sql
select count(*) as role_page_access_missing_system_role_id
from role_page_access
where role_code is not null
  and system_role_id is null;
```

Ожидание:

- оба результата `0`

### 1.5. Legacy org columns действительно ушли

```sql
select table_name, column_name
from information_schema.columns
where table_name in ('skud_access_point_settings', 'skud_sync_employee_filter')
  and column_name = 'organization_id';
```

Ожидание:

- `0 rows`

## 2. Проверка ключевого пользовательского сценария

### 2.1. Найти сотрудника и дату, которые попали в backfill

```sql
select employee_id, work_date, status, hours_override, reason
from attendance_adjustments
where source_type = 'legacy_tender_timesheet'
order by work_date desc, employee_id;
```

Выбери одного сотрудника и один месяц из результата.

### 2.2. Проверить табель этого сотрудника в staging UI

Проверить:

- страница открывается без `500`
- нужный день виден
- статус дня совпадает с `attendance_adjustments.status`
- если задан `hours_override`, он отражается в табеле корректно

### 2.3. Проверить карточку сотрудника

Проверить:

- карточка сотрудника открывается
- месячная сводка attendance не выглядит пустой или сломанной
- значения не противоречат табелю за тот же месяц

### 2.4. Проверить отпускной flow

Если есть тестовая заявка:

- открыть leave requests
- попробовать approve/review
- убедиться, что страница и API не падают

## 3. Проверка компенсационных страниц

Проверить на staging:

- `/admin/payslips`
- `/admin/payments`

Ожидание:

- страницы открываются
- данные грузятся
- нет `403` там, где у администратора доступ должен быть

## 4. Проверка прав доступа

Минимум два логина:

- администратор
- обычный сотрудник

Проверить:

- администратор видит `payslips/payments`
- обычный сотрудник не видит чужие данные
- employee-scoped страницы не открывают чужого сотрудника по прямому URL

## 5. Что считать успешным результатом

Можно считать migration `020` принятой на staging, если:

- SQL-проверки выше зелёные
- `event_at` заполнен
- backfill в `attendance_adjustments` на месте
- ключевые страницы не падают
- права доступа ведут себя ожидаемо

После этого уже можно переходить к следующему блоку работ:

- добить отказ от client-side attendance расчётов
- затем phone-first refactor тяжёлых экранов
