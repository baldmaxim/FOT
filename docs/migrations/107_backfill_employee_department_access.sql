-- 107_backfill_employee_department_access.sql
--
-- Проблема: руководитель получает 403 на GET /api/skud/employee-events/:id
-- (и аналогичных scope-проверках). canAccessEmployeeInScope() сверяет отделы
-- по таблице employee_department_access (membership-строки source='sigur_sync'),
-- а НЕ по employees.org_department_id. Эти строки создаёт только
-- upsertTechnicalDepartmentAccess(), вызываемый ИСКЛЮЧИТЕЛЬНО когда sigur-sync
-- ДЕТЕКТИРУЕТ смену отдела (sigur-sync-employees.service.ts:697) или вставляет
-- НОВОГО сотрудника (:802). Сотрудники, заведённые/привязанные ДО появления
-- membership-трекинга и с тех пор не менявшие отдел, не имеют ни одной строки
-- employee_department_access → их руководители не видят (403), хотя
-- employees.org_department_id указывает на корректный активный отдел.
--
-- На момент написания: 146 активных сотрудников (не archived, не fired, не
-- excluded_from_timesheet) на АКТИВНОМ отделе без единой активной строки
-- employee_department_access; 0 из них «застряли» на is_active=false отделе
-- (это чинит отдельная миграция 106, здесь не пересекается). Пример: emp 2517
-- «Панкратова У.И.», отдел «(ОСП) Отдел по сопровождению подрядчиков».
--
-- Эта миграция (одноразово, ВРУЧНУЮ через psql на проде) воспроизводит
-- семантику upsertTechnicalDepartmentAccess() для текущего отдела сотрудника:
--   1) если строка (employee_id, current_dept) есть, но is_active=false —
--      реактивирует (UPDATE is_active=true);
--   2) если строки нет — вставляет (source как в коде: sigur_sync при
--      наличии sigur_employee_id, иначе portal_lifecycle; is_active=true).
-- Чужие/устаревшие строки сотрудника НЕ трогаются (минимальный фикс: для
-- доступа нужно лишь пересечение по текущему отделу). Идемпотентна.
--
-- Не зависит от миграции 106 и порядок с ней не критичен.
--
-- Откат: всё в одной транзакции. Перед COMMIT глазами проверить блок
-- «КОНТРОЛЬ ПОСЛЕ»; при сомнении — ROLLBACK.

BEGIN;

-- Целевые сотрудники: видимые в табеле, на существующем активном отделе.
CREATE TEMP TABLE eda_backfill_targets ON COMMIT DROP AS
SELECT e.id AS employee_id,
       e.org_department_id AS department_id,
       CASE WHEN e.sigur_employee_id IS NOT NULL THEN 'sigur_sync'
            ELSE 'portal_lifecycle' END AS source
  FROM employees e
  JOIN org_departments od ON od.id = e.org_department_id
 WHERE e.is_archived = false
   AND e.excluded_from_timesheet = false
   AND e.employment_status <> 'fired'
   AND od.is_active = true
   AND NOT EXISTS (
     SELECT 1 FROM employee_department_access x
      WHERE x.employee_id = e.id AND x.is_active = true);

CREATE INDEX ON eda_backfill_targets (employee_id);

-- КОНТРОЛЬ ДО.
\echo '== целевых сотрудников (без активной eda, на активном отделе) =='
SELECT count(*) AS targets_before FROM eda_backfill_targets;
\echo '== контроль: emp 2517 в выборке (ожидается 1 строка) =='
SELECT * FROM eda_backfill_targets WHERE employee_id = 2517;

-- 1. Реактивация: строка на ТЕКУЩИЙ отдел есть, но погашена.
UPDATE employee_department_access a
   SET is_active = true, updated_at = now()
  FROM eda_backfill_targets t
 WHERE a.employee_id = t.employee_id
   AND a.department_id = t.department_id
   AND a.is_active = false;

-- 2. Вставка отсутствующих. ON CONFLICT (employee_id, department_id) —
--    защита от гонки/повтора (UNIQUE-ключ таблицы); пункт 1 уже разобрал
--    случай существующей погашенной строки на текущий отдел.
INSERT INTO employee_department_access
       (employee_id, department_id, source, is_active, created_at, updated_at)
SELECT t.employee_id, t.department_id, t.source, true, now(), now()
  FROM eda_backfill_targets t
ON CONFLICT (employee_id, department_id) DO NOTHING;

-- КОНТРОЛЬ ПОСЛЕ (всё должно быть 0 / доступ есть).
\echo '== осталось целевых без активной eda (ожидается 0) =='
SELECT count(*) AS targets_after
  FROM employees e
  JOIN org_departments od ON od.id = e.org_department_id
 WHERE e.is_archived = false
   AND e.excluded_from_timesheet = false
   AND e.employment_status <> 'fired'
   AND od.is_active = true
   AND NOT EXISTS (
     SELECT 1 FROM employee_department_access x
      WHERE x.employee_id = e.id AND x.is_active = true);

\echo '== контроль: активные eda emp 2517 (ожидается строка на (ОСП)...) =='
SELECT a.employee_id, a.department_id, a.source, a.is_active, od.name, od.is_active AS dept_active
  FROM employee_department_access a
  JOIN org_departments od ON od.id = a.department_id
 WHERE a.employee_id = 2517 AND a.is_active = true;

COMMIT;
