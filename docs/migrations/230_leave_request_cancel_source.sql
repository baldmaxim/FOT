-- 230_leave_request_cancel_source.sql
-- Источник отмены заявления: кто инициировал (сотрудник / руководитель / администратор).
-- Нужен, чтобы отдел кадров в списках видел «Отменено сотрудником» vs «Отменено руководителем»
-- (сейчас оба сценария дают неразличимый статус 'cancelled').
--   employee — самоотмена автором (PATCH /:id/cancel);
--   manager  — отзыв согласования тем, кто согласовывал (PATCH /:id/revoke-approval);
--   admin    — отзыв согласования администратором, который сам не согласовывал;
--   NULL     — легаси-отмены до этой миграции, следа не осталось.

BEGIN;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS cancel_source TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leave_requests_cancel_source_check'
  ) THEN
    ALTER TABLE leave_requests
      ADD CONSTRAINT leave_requests_cancel_source_check
      CHECK (cancel_source IS NULL OR cancel_source IN ('employee','manager','admin'));
  END IF;
END $$;

-- Бэкфилл: все существующие cancelled_by — самоотмена автором
-- (проверено на проде 21.07.2026: 132/132 строк, up.employee_id = lr.employee_id).
UPDATE leave_requests lr
   SET cancel_source = 'employee'
  FROM user_profiles up
 WHERE up.id = lr.cancelled_by
   AND up.employee_id = lr.employee_id
   AND lr.status = 'cancelled'
   AND lr.cancel_source IS NULL;

COMMIT;
