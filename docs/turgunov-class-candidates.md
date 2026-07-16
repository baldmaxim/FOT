# Реестр «класса Тургунова» — переводы с неполной историей назначений

Снято с прода (read-only, **2026-07-16**).

## Контекст

При переводе сотрудника, у которого **нет истории** `employee_assignments` («snapshot-only»),
`changeDepartment` раньше вставлял только строку нового отдела и не записывал прежний.
Из-за этого табель за прошлые месяцы терял старую бригаду, а snapshot «протекал» в новую
(кейс Тургунова 2495: июнь показывался у Макшанова вместо Стеняева).

**Исправлено кодом** (см. миграция-независимую часть):
- резолвер табеля стал period-aware (`timesheet-department-assignments.service.ts`) — snapshot
  больше не тянет в прошлые месяцы того, кто вошёл в участок позже;
- `changeDepartment` теперь пишет полную пару (`employee-changes.service.ts`) — новые переводы
  snapshot-only сотрудников класс не воспроизводят.

**Требует точечного бэкфилла данных** — только уже сделанные переводы (эта таблица).

## Кандидат = ?

Активный сотрудник, у которого ровно одна строка `employee_assignments` (открытая, в текущем
snapshot-отделе), вход `> hire_date + 7 дней`, и нет строки прежнего отдела. Всего таких **364**.
Из них **21** имеют аудит `MOVE_EMPLOYEE_DEPARTMENT`, доказывающий смену отдела (ниже).
Остальные ~343 без аудита — вероятно не переводы (freeze-артефакты / прямой ввод) → **watch-list,
авто-правки не делать**.

## Как чинить

Для строки из раздела «Затронуты» — точечная **fail-fast** миграция по образцу
[`docs/migrations/222_backfill_turgunov_2495_prev_dept.sql`](migrations/222_backfill_turgunov_2495_prev_dept.sql):
вставить закрытую строку `old_dept [hire_date .. transfer_date-1]`, с предусловиями/постусловиями
(проверка пересечений через `daterange && daterange`).

⚠️ **Перед бэкфиллом** проверить, не был ли старый месяц уже подан/утверждён без сотрудника —
иначе изменится состав утверждённого табеля (часы не пострадают, но состав да).

---

## Затронуты (перевод в видимом окне, июнь 2026+) — приоритет

| emp_id | ФИО | old_dept (вернуть прошлые мес.) | new_dept | transfer_date | source | статус |
|---|---|---|---|---|---|---|
| 2495 | Тургунов Махаммаджон Холдарали Угли | бр.Амонов А.М | бр.Амонов Акмалжон М. | 2026-07-01 | sigur | **миграция 222 готова** |
| 2516 | Абдурахимов Ахмаджон Анвар Угли | Электрики | Участок электромонтажных работ | 2026-06-30 | timesheet_team_management | ждёт бэкфилла |
| 2308 | Абдусаламов Шахзод Вахоб Угли | Электрики | Участок электромонтажных работ | 2026-06-30 | timesheet_team_management | ждёт бэкфилла |
| 8911 | Кадиров Салим Мамирович | Электрики | Участок электромонтажных работ | 2026-06-30 | timesheet_team_management | ждёт бэкфилла |
| 8912 | Нарбутаев Акбарали Бердикулович | Электрики | Участок электромонтажных работ | 2026-07-01 | timesheet_team_management | ждёт бэкфилла |
| 8913 | Раззоков Абдумутал Шухрат Угли | Электрики | Участок электромонтажных работ | 2026-07-01 | timesheet_team_management | ждёт бэкфилла |
| 8930 | Гоибов Джамшед Сафарович | бр.Гоибова Д.Б.(2) | бр.Лашкарова Ф.Ф. | 2026-07-01 | sigur | ждёт бэкфилла |
| 4734 | Сайдуллаев Бехруз Лутфулла Угли | НК СТРОЙ СИТИ ООО | бр.Амонов Акмалжон М. | 2026-07-06 | sigur | ждёт бэкфилла |

> Примечание: 6 из «Электрики → Участок электромонтажных работ» можно закрыть одной групповой
> fail-fast миграцией (перечислить id, у всех transfer_date 30.06/01.07).

## Не затронуты (перевод датой 20–21.04.2026 — до старта табелей) — проверять только по жалобе

| emp_id | ФИО | old_dept | new_dept | transfer_date |
|---|---|---|---|---|
| 80 | Агаркова Виктория Владимировна | Отдел контрактного сопровождения | Сметно-технический отдел | 2026-04-20 |
| 135 | Алюшева Динара Рифатовна | Бухгалтерия СУ-10 (ООО) | Бухгалтерия | 2026-04-20 |
| 159 | Арлашкина Анна Борисовна | Отдел по управлению персоналом | Архив | 2026-04-20 |
| 293 | Битунова Александра Владимировна | Комендантская служба | Отдел по управлению персоналом | 2026-04-21 |
| 440 | Гладкая Алина Романовна | Комендантская служба | Отдел табельного учёта | 2026-04-21 |
| 496 | Гурулёва София Романовна | Строительный участок | Департамент информационных технологий | 2026-04-20 |
| 577 | Ельшина Светлана Владимировна | Комендантская служба | Отдел табельного учёта | 2026-04-21 |
| 811 | Квасова Татьяна Геннадьевна | Отдел по управлению персоналом | Архив | 2026-04-20 |
| 1239 | Набока Татьяна Евгеньевна | Комендантская служба | Отдел табельного учёта | 2026-04-21 |
| 1348 | Орешкина Анастасия Романовна | Отдел цифровой трансформации | Отдел по управлению персоналом | 2026-04-20 |
| 1897 | Федянов Александр Александрович | Архив | Экономический сектор | 2026-04-20 |
| 122 | Аликулов Музроб Элёр Угли | ⚠ неизвестен (from_dept=null) | СТРОЙСЕРВИС ООО | 2026-04-21 |
| 219 | Бадалов Фирдавс Эсамурод Угли | ⚠ неизвестен (from_dept=null) | СТРОЙСЕРВИС ООО | 2026-04-21 |

> ⚠ У 122/219 старый отдел в аудите пуст — бэкфилл только после ручного определения прежнего отдела.

## Диагностический запрос (актуализировать список)

```sql
WITH a AS (
  SELECT employee_id, COUNT(*) AS cnt,
         BOOL_OR(effective_to IS NULL) AS has_open,
         MAX(CASE WHEN effective_to IS NULL THEN org_department_id::text END) AS open_dept,
         MAX(CASE WHEN effective_to IS NULL THEN effective_from END) AS open_from
  FROM employee_assignments GROUP BY employee_id
),
cand AS (
  SELECT e.id, e.full_name, e.hire_date::date AS hire_date, a.open_dept, a.open_from
  FROM a JOIN employees e ON e.id = a.employee_id
  WHERE e.employment_status='active' AND NOT e.is_archived
    AND a.cnt=1 AND a.has_open AND a.open_dept = e.org_department_id::text
    AND a.open_from > (e.hire_date::date + INTERVAL '7 day')
),
aud AS (
  SELECT DISTINCT ON (al.entity_id::int) al.entity_id::int AS emp_id,
         al.details->>'from_department_id' AS from_dept, al.details->>'source' AS source,
         al.created_at::date AS audit_date
  FROM audit_logs al
  WHERE al.action='MOVE_EMPLOYEE_DEPARTMENT' AND al.entity_type='employee'
  ORDER BY al.entity_id::int, al.created_at DESC
)
SELECT cand.id, cand.full_name, cand.hire_date,
       to_char(cand.open_from,'YYYY-MM-DD') AS transfer_date,
       od.name AS old_dept, nd.name AS new_dept, aud.source, aud.audit_date
FROM cand JOIN aud ON aud.emp_id = cand.id
  AND aud.from_dept IS NOT NULL AND aud.from_dept <> cand.open_dept
LEFT JOIN org_departments od ON od.id = aud.from_dept::uuid
LEFT JOIN org_departments nd ON nd.id = cand.open_dept::uuid
ORDER BY cand.full_name;
-- watch-list (без аудита): заменить JOIN aud на LEFT JOIN ... WHERE aud.from_dept IS NULL
```
