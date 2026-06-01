-- 158: Сохраняем отдел, из которого уволен сотрудник (для связности истории периодов).
-- При увольнении реальный отдел затирался на «Уволенные» во всех таблицах.
-- Теперь храним from_department_id в событии увольнения; основная история периодов
-- ведётся в employee_assignments (закрытый реальный отдел + открытая «Уволенные»).

ALTER TABLE employee_dismissal_events
  ADD COLUMN IF NOT EXISTS from_department_id uuid NULL;

COMMENT ON COLUMN employee_dismissal_events.from_department_id IS
  'Отдел, в котором сотрудник работал на момент увольнения (до перевода в «Уволенные»). Для связности истории.';

-- Расширяем view employee_history: в dismissal-блок добавляем from_department_id.
-- security_invoker сохраняется (PG15+), см. миграции 035, 113.
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
        'reason', de.reason,
        'from_department_id', de.from_department_id
    ) AS event_data,
    de.created_at,
    de.created_by
FROM employees e
JOIN employee_dismissal_events de ON e.id = de.employee_id
ORDER BY 1, 5 DESC;
