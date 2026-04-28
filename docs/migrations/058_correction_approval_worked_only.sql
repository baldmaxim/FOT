-- Миграция: согласование требуется только для work/remote/manual в выходной/праздник.
-- Бытовые статусы (vacation/sick/dayoff/unpaid/educational_leave/absent) в выходной
-- больше не висят в очереди админа — переводим существующие pending в auto_approved.
-- Дата: 2026-04-28

BEGIN;

UPDATE attendance_adjustments
SET approval_status = 'auto_approved',
    approved_by = NULL,
    approved_at = NULL,
    approval_comment = NULL
WHERE approval_status = 'pending'
  AND status NOT IN ('work', 'remote', 'manual');

NOTIFY pgrst, 'reload schema';

COMMIT;
