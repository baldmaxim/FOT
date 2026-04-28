-- Дата, с которой сотрудник скрыт в табеле.
-- В отличие от excluded_from_timesheet_at (TIMESTAMPTZ — момент клика по «Исключить»),
-- excluded_from_timesheet_date хранит ЛОГИЧЕСКУЮ дату отсечения: до неё сотрудник
-- виден в табеле как обычно, с неё включительно — ячейки серые/перечёркнутые.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS excluded_from_timesheet_date DATE NULL;

COMMENT ON COLUMN employees.excluded_from_timesheet_date IS
  'Дата (включительно), с которой сотрудник перестаёт отображаться в табеле; NULL = не исключён.';

-- Бэкфилл: для уже исключённых сотрудников считаем датой отсечения дату из excluded_from_timesheet_at.
UPDATE employees
SET excluded_from_timesheet_date = excluded_from_timesheet_at::DATE
WHERE excluded_from_timesheet = TRUE
  AND excluded_from_timesheet_date IS NULL
  AND excluded_from_timesheet_at IS NOT NULL;
