WITH tender_dept AS (
  SELECT id FROM public.get_descendant_department_ids(
    ARRAY['cfb01a32-86e8-47e3-bfff-7aec07bf6eae'::uuid]
  )
),
tender_employees AS (
  SELECT e.id, e.full_name, e.tab_number, od.name AS dept_name
    FROM employees e
    JOIN org_departments od ON od.id = e.org_department_id
   WHERE e.org_department_id IN (SELECT id FROM tender_dept)
     AND e.employment_status = 'active'
),
stats AS (
  SELECT te.id,
         te.full_name,
         te.tab_number,
         te.dept_name,
         COUNT(c.id)::bigint AS calls,
         COALESCE(SUM(c.duration_sec), 0)::bigint AS total_sec
    FROM tender_employees te
    JOIN mts_business_number_map nm ON nm.employee_id = te.id
    JOIN mts_business_cdr c ON c.msisdn_hash = nm.msisdn_hash
   GROUP BY te.id, te.full_name, te.tab_number, te.dept_name
)
SELECT full_name, tab_number, dept_name, calls, total_sec
  FROM stats
 ORDER BY total_sec DESC, calls DESC
 LIMIT 15;
