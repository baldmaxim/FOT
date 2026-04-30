-- Migration 066: удаление промежуточного слоя «категория труда» из системы графиков работы.
-- Применяется после 065_role_page_access_view_implies_edit.sql.
--
-- Что делает:
--   1) Backfill: для активных сотрудников без личного назначения, у которых есть
--      work_category и активная привязка category_schedules, создаёт персональную
--      запись employee_schedule_assignments с тем же schedule_id и effective_from = CURRENT_DATE.
--   2) Удаляет таблицу category_schedules.
--   3) Снимает FK employees.work_category и удаляет колонку work_category.
--   4) Удаляет таблицу work_categories.
--
-- После применения резолвер графика становится двухуровневым: employee → default.

BEGIN;

-- 1) Backfill категорийных назначений в персональные
INSERT INTO employee_schedule_assignments (employee_id, schedule_id, effective_from, created_at)
SELECT e.id, cs.schedule_id, CURRENT_DATE, NOW()
FROM employees e
JOIN category_schedules cs
  ON cs.category = e.work_category
 AND cs.effective_from <= CURRENT_DATE
 AND (cs.effective_to IS NULL OR cs.effective_to >= CURRENT_DATE)
WHERE e.employment_status = 'active'
  AND e.work_category IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM employee_schedule_assignments esa
    WHERE esa.employee_id = e.id
      AND esa.effective_from <= CURRENT_DATE
      AND (esa.effective_to IS NULL OR esa.effective_to >= CURRENT_DATE)
  );

-- 2) Удаляем привязки категорий к графикам
DROP TABLE IF EXISTS category_schedules;

-- 3) Удаляем колонку work_category (FK снимется автоматически при DROP COLUMN)
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_work_category_fkey;
ALTER TABLE employees DROP CONSTRAINT IF EXISTS employees_work_category_check;
ALTER TABLE employees DROP COLUMN IF EXISTS work_category;

-- 4) Удаляем справочник категорий труда
DROP TABLE IF EXISTS work_categories;

COMMIT;
