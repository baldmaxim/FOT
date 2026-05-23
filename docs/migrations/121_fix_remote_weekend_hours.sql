-- 121_fix_remote_weekend_hours.sql
-- Удалёнка (remote) в выходной день, созданная до фикса || 8 (коммит 46d5e6f),
-- сохранена с hours_override = 0 (для выходного график даёт work_hours = 0, а
-- `?? 8` не подменяет 0). Из-за нулевых часов resolveAdjustmentApprovalStatus
-- ставил auto_approved вместо pending — запись не попадала на согласование.
-- Чиним: 0 ч → 8 ч, auto_approved → pending. Только отделы kind='department'
-- (бригады согласование не проходят). Решения руководителя (approved/rejected)
-- не трогаем. Безопасна к повторному прогону (нет remote с 0 ч — no-op).
UPDATE attendance_adjustments AS a
   SET hours_override   = 8,
       approval_status  = 'pending',
       updated_at       = NOW()
  FROM employees e
 WHERE a.employee_id     = e.id
   AND a.status          = 'remote'
   AND a.source_type     = 'manual'
   AND a.hours_override  = 0
   AND a.approval_status = 'auto_approved'
   AND e.org_department_id IN (SELECT id FROM org_departments WHERE kind = 'department');
