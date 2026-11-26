-- Откат 381: статус «Неактивный» и флаги учёток.
--
-- Порядок: сначала старый фронтенд, затем старый бэкенд (он читает колонки), и только потом — этот файл.
-- Старый код колонки 381 не читает, поэтому откат кода можно делать и без этого файла: колонки безвредны.
--
-- Вместе с колонками пропадут ручные метки «Неактивный» (кто и когда переведён) и флаги учёток (право Чепикова,
-- исключение учётки проживания). История остаётся в audit_logs (EMPLOYEE_DEACTIVATED / EMPLOYEE_REACTIVATED).
-- Повторное применение 381 после отката безопасно, флаги ставятся заново разовым SQL.

BEGIN;

ALTER TABLE public.employees
  DROP COLUMN IF EXISTS staff_inactive_by,
  DROP COLUMN IF EXISTS staff_inactive_at;

ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS login_when_staff_inactive,
  DROP COLUMN IF EXISTS can_manage_staff_inactive;

COMMIT;
