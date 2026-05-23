-- 125: Доследование миграции 124 — она пропустила manual-записи.
-- Руководители ставят часы в выходной не только через одобрение заявлений,
-- но и напрямую через UI табеля (source_type='manual'). До появления фичи
-- двухступенчатого согласования (миграция 054 + e7fcc79) такие manual-записи
-- создавались с дефолтным approval_status='auto_approved' и не попадали
-- в админскую очередь /approvals.
--
-- Эта миграция повторяет логику 124, но без фильтра source_type — соответствует
-- поведению reapproveAdjustmentsForRange (см. timesheet.controller.ts:341).
-- Правило по DOW по-прежнему грубое: Sat/Sun. Cycle-графики и праздничные
-- субботы доводятся через UI «Настройки согласования → Сохранить».

BEGIN;

WITH setting AS (
  SELECT value
    FROM system_settings
   WHERE key = 'correction_approval_required_department_ids'
),
whitelist AS (
  SELECT jsonb_array_elements_text(value::jsonb) AS dept_id
    FROM setting
   WHERE value IS NOT NULL
     AND TRIM(value) <> ''
     AND value::jsonb <> '[]'::jsonb
  UNION
  SELECT id::text AS dept_id
    FROM org_departments
   WHERE kind = 'department'
     AND NOT EXISTS (
       SELECT 1 FROM setting
        WHERE value IS NOT NULL
          AND TRIM(value) <> ''
          AND value::jsonb <> '[]'::jsonb
     )
),
month_bounds AS (
  SELECT date_trunc('month', NOW() AT TIME ZONE 'Europe/Moscow')::date AS month_start,
         (date_trunc('month', NOW() AT TIME ZONE 'Europe/Moscow') + INTERVAL '1 month - 1 day')::date AS month_end
),
candidates AS (
  SELECT aa.id
    FROM attendance_adjustments aa
    JOIN employees e ON e.id = aa.employee_id
    JOIN whitelist w ON w.dept_id = e.org_department_id::text
   CROSS JOIN month_bounds mb
   WHERE aa.approval_status = 'auto_approved'
     AND aa.status IN ('work', 'remote')
     AND aa.work_date >= mb.month_start
     AND aa.work_date <= mb.month_end
     AND COALESCE(aa.hours_override, 1) <> 0
     AND EXTRACT(DOW FROM aa.work_date) IN (0, 6)
)
UPDATE attendance_adjustments aa
   SET approval_status = 'pending',
       updated_at = NOW()
  FROM candidates c
 WHERE aa.id = c.id;

COMMIT;
