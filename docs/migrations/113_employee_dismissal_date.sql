-- 113: Дата увольнения сотрудника (последний рабочий день).
-- Заполняется через POST /api/employees/:id/fire.
-- Если dismissal_date > today → отложенное увольнение,
-- сотрудник остаётся active до даты, scheduler применяет полное увольнение в день D.

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS dismissal_date DATE NULL;

COMMENT ON COLUMN employees.dismissal_date IS
  'Последний рабочий день. После этой даты сотрудник исключается из табеля. Заполняется при увольнении (немедленном или отложенном).';

-- Для scheduler-а: найти сотрудников, у которых пора применять увольнение
CREATE INDEX IF NOT EXISTS idx_employees_dismissal_pending
  ON employees (dismissal_date)
  WHERE employment_status = 'active' AND dismissal_date IS NOT NULL;

-- Для фильтра табеля: ускоряет (employment_status='fired' AND dismissal_date >= X)
CREATE INDEX IF NOT EXISTS idx_employees_fired_dismissal_date
  ON employees (dismissal_date)
  WHERE employment_status = 'fired';

-- Журнал событий увольнения (отдельная таблица, т.к. employee_history — VIEW).
CREATE TABLE IF NOT EXISTS employee_dismissal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  dismissal_date DATE NOT NULL,
  scheduled BOOLEAN NOT NULL DEFAULT false,
  cancelled BOOLEAN NOT NULL DEFAULT false,
  rehired BOOLEAN NOT NULL DEFAULT false,
  applied_from_scheduled BOOLEAN NOT NULL DEFAULT false,
  prev_date DATE NULL,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID NULL
);

CREATE INDEX IF NOT EXISTS idx_employee_dismissal_events_employee
  ON employee_dismissal_events(employee_id, created_at DESC);

COMMENT ON TABLE employee_dismissal_events IS
  'События увольнения/отмены/восстановления сотрудника. Видны в employee_history как event_type=''dismissal''.';

-- Расширяем view employee_history третьим UNION-ом для событий увольнения.
-- security_invoker сохраняется (PG15+), see миграция 035.
CREATE OR REPLACE VIEW public.employee_history
WITH (security_invoker = true) AS
SELECT
    e.id AS employee_id,
    e.full_name,
    'assignment'::text AS event_type,
    a.id::text AS event_id,
    a.effective_from AS event_date,
    a.effective_to AS event_end_date,
    json_build_object(
        'department_id', a.org_department_id,
        'site_id', a.org_site_id,
        'position_id', a.position_id,
        'is_primary', a.is_primary,
        'type', a.assignment_type,
        'reason', a.change_reason,
        'order_number', a.order_number
    ) AS event_data,
    a.created_at,
    a.created_by
FROM employees e
JOIN employee_assignments a ON e.id = a.employee_id
UNION ALL
SELECT
    e.id AS employee_id,
    e.full_name,
    'salary'::text AS event_type,
    sh.id::text AS event_id,
    sh.effective_date AS event_date,
    NULL::date AS event_end_date,
    json_build_object(
        'salary', sh.salary,
        'reason', sh.change_reason,
        'order_number', sh.order_number,
        'note', sh.note
    ) AS event_data,
    sh.created_at,
    sh.created_by
FROM employees e
JOIN salary_history sh ON e.id = sh.employee_id
UNION ALL
SELECT
    e.id AS employee_id,
    e.full_name,
    'dismissal'::text AS event_type,
    de.id::text AS event_id,
    de.dismissal_date AS event_date,
    NULL::date AS event_end_date,
    json_build_object(
        'dismissal_date', de.dismissal_date,
        'scheduled', de.scheduled,
        'cancelled', de.cancelled,
        'rehired', de.rehired,
        'applied_from_scheduled', de.applied_from_scheduled,
        'prev_date', de.prev_date,
        'reason', de.reason
    ) AS event_data,
    de.created_at,
    de.created_by
FROM employees e
JOIN employee_dismissal_events de ON e.id = de.employee_id
ORDER BY 1, 5 DESC;
