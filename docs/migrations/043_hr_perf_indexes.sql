-- 043_hr_perf_indexes.sql
-- Индексы для ускорения страниц «Управление кадрами» и «Табели HR → Назначенные».
--
-- 1) idx_employees_active_nonarchived
--    Партиальный индекс под частый фильтр «активные не архивные» в /api/employees,
--    /api/employees/counts и collectAssignedEmployees().
--
-- 2) idx_eda_active_by_dept
--    Поддерживает выборку назначенных сотрудников по managed_department_ids
--    (новая реализация /api/timesheet/assigned-employees).
--
-- 3) idx_esa_employee_effective
--    Ускоряет loadEmployeeScheduleRowsBatch() и точечные выборки графиков
--    по диапазону effective_from / effective_to.

CREATE INDEX IF NOT EXISTS idx_employees_active_nonarchived
  ON employees (is_archived, employment_status)
  WHERE is_archived = false AND employment_status = 'active';

CREATE INDEX IF NOT EXISTS idx_eda_active_by_dept
  ON employee_department_access (department_id, employee_id)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_esa_employee_effective
  ON employee_schedule_assignments (employee_id, effective_from, effective_to);
