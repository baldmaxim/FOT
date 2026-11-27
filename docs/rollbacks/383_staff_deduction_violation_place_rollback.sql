-- Откат 383: место и дата нарушения у удержаний. Введённые место и дата теряются; суммы удержаний не меняются.
-- Откатывать после отката бэкенда (новый бэкенд читает эти колонки).

BEGIN;

DROP INDEX IF EXISTS public.staff_deductions_violation_object_idx;

ALTER TABLE public.staff_deductions DROP CONSTRAINT IF EXISTS staff_deductions_violation_place_len;
ALTER TABLE public.staff_deductions DROP CONSTRAINT IF EXISTS staff_deductions_violation_object_fk;

ALTER TABLE public.staff_deductions
  DROP COLUMN IF EXISTS violation_date,
  DROP COLUMN IF EXISTS violation_place,
  DROP COLUMN IF EXISTS violation_object_id;

ALTER TABLE public.payroll_deduction_kinds DROP COLUMN IF EXISTS requires_place_date;

COMMIT;
