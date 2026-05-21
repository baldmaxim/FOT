-- 117_brigade_corrections_auto_approve.sql
-- Снимаем pending с корректировок сотрудников бригад: правило согласования
-- к бригадам не применяется. Безопасна к повторному прогону (где нет pending — no-op).
UPDATE attendance_adjustments AS a
   SET approval_status  = 'auto_approved',
       approved_by      = NULL,
       approved_at      = NULL,
       approval_comment = NULL,
       updated_at       = NOW()
  FROM employees e
  JOIN org_departments d ON d.id = e.org_department_id
 WHERE a.employee_id      = e.id
   AND d.kind             = 'brigade'
   AND a.approval_status  = 'pending';
