WITH call_stats AS (
  SELECT m.employee_id,
         COUNT(c.id)::bigint AS calls,
         COALESCE(SUM(c.duration_sec), 0)::bigint AS total_sec
    FROM mts_business_cdr c
    JOIN mts_business_number_map m ON m.msisdn_hash = c.msisdn_hash
   WHERE m.employee_id IS NOT NULL
   GROUP BY m.employee_id
),
dept_stats AS (
  SELECT e.org_department_id AS dept_id,
         od.name AS dept_name,
         SUM(cs.calls)::bigint AS calls,
         SUM(cs.total_sec)::bigint AS total_sec,
         COUNT(DISTINCT e.id)::int AS employees_with_calls
    FROM call_stats cs
    JOIN employees e ON e.id = cs.employee_id
    JOIN org_departments od ON od.id = e.org_department_id
   WHERE e.employment_status <> 'fired'
     AND COALESCE(e.is_archived, false) = false
   GROUP BY e.org_department_id, od.name
)
SELECT dept_name,
       employees_with_calls,
       calls,
       ROUND(calls::numeric / NULLIF(employees_with_calls, 0), 1) AS calls_per_employee,
       total_sec,
       ROUND(total_sec / 3600.0, 1) AS total_hours,
       ROUND((total_sec::numeric / NULLIF(employees_with_calls, 0)) / 60.0, 1) AS minutes_per_employee
  FROM dept_stats
 ORDER BY total_sec DESC, calls DESC
 LIMIT 10;
