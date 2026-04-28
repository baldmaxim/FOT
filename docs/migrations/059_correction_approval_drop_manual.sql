-- Миграция: согласование требуется только для work/remote в выходной/праздник.
-- Уточнение к 058: убираем из pending всё кроме work/remote (manual/absent
-- /прочие статусы не требуют согласования — это не «фактическая работа»).
-- Дата: 2026-04-28

BEGIN;

UPDATE attendance_adjustments
SET approval_status = 'auto_approved',
    approved_by = NULL,
    approved_at = NULL,
    approval_comment = NULL
WHERE approval_status = 'pending'
  AND status NOT IN ('work', 'remote');

NOTIFY pgrst, 'reload schema';

COMMIT;
