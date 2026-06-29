-- 192_leave_request_cancellation_audit.sql
-- След отмены заявления (кто/когда/почему). Используется и управленческой отменой
-- согласованного отпуска (revoke-approval), и самоотменой сотрудника (cancel).
-- Аудита для leave_requests нет — эти поля и есть источник «кто отменил и когда».
--   cancelled_by    — user_profiles.id инициатора отмены (NULL = ещё не отменяли);
--   cancelled_at    — момент отмены;
--   cancel_reason   — необязательная причина (управленческая отмена).
-- reviewer_id НЕ трогаем — это исторический факт «кто согласовал».

BEGIN;

ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS cancelled_by  UUID NULL REFERENCES user_profiles(id),
  ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT NULL;

COMMIT;
