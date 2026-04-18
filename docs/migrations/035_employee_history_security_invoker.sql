-- Включаем security_invoker для view public.employee_history.
-- Advisor закрывает: security_definer_view.
-- security_invoker=true (PG15+) заставляет view исполняться с правами вызывающего,
-- а не владельца, — устраняет обход прав.

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
ORDER BY 1, 5 DESC;
