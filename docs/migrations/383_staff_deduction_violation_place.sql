-- 383: «Удержания» → место и дата нарушения у вида «Нарушение техники безопасности».
--
-- Зачем (решения пользователя 27.11.2026):
--   ОТиТБ вносят штрафы во вкладке «Удержания» кадров (галочка «Удержания» в назначениях, миграция 351) и указывают,
--   где и когда было нарушение: объект из списка skud_objects («ЖК Сад 69») + необязательное уточнение текстом
--   («корпус 2, 5 этаж») + дата. Поля — только у видов с признаком requires_place_date (сейчас — один вид).
--
--   payroll_deduction_kinds.requires_place_date — у вида обязательны объект и дата нарушения. В справочнике видов
--     в портале не меняется: только этой миграцией или SQL. Привязан к виду (id), переименование его не снимает.
--   staff_deductions.violation_object_id — объект нарушения. ON DELETE RESTRICT: удалить объект из справочника,
--     пока на него ссылается удержание, нельзя (сервер отвечает понятной ошибкой — архивируйте объект).
--   staff_deductions.violation_place — уточнение места, до 200 символов.
--   staff_deductions.violation_date — дата нарушения (не позже сегодня — проверяет API).
--
--   Обязательность проверяет API (staff-deductions.service.ts), не БД: прежние строки вида (52 на 27.11) остаются
--   без места и даты и правятся, не заполняя их. На суммы и расчёт зарплаты поля не влияют.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (deploy-server.sh migrate). Повторный запуск безопасен. Откат — docs/rollbacks/383_*.
-- Номер 383: 382 — 382_employee_team_salary_access.sql (параллельная сессия).

BEGIN;

ALTER TABLE public.payroll_deduction_kinds
  ADD COLUMN IF NOT EXISTS requires_place_date boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.payroll_deduction_kinds.requires_place_date IS
  'У удержания этого вида обязательны объект и дата нарушения (миграция 383). Только SQL, в портале не меняется.';

UPDATE public.payroll_deduction_kinds
   SET requires_place_date = true
 WHERE name = 'Нарушение техники безопасности'
   AND requires_place_date IS DISTINCT FROM true;

ALTER TABLE public.staff_deductions
  ADD COLUMN IF NOT EXISTS violation_object_id uuid NULL,
  ADD COLUMN IF NOT EXISTS violation_place text NULL,
  ADD COLUMN IF NOT EXISTS violation_date date NULL;

ALTER TABLE public.staff_deductions DROP CONSTRAINT IF EXISTS staff_deductions_violation_object_fk;
ALTER TABLE public.staff_deductions ADD CONSTRAINT staff_deductions_violation_object_fk
  FOREIGN KEY (violation_object_id) REFERENCES public.skud_objects(id) ON DELETE RESTRICT;

ALTER TABLE public.staff_deductions DROP CONSTRAINT IF EXISTS staff_deductions_violation_place_len;
ALTER TABLE public.staff_deductions ADD CONSTRAINT staff_deductions_violation_place_len
  CHECK (violation_place IS NULL OR char_length(violation_place) <= 200);

COMMENT ON COLUMN public.staff_deductions.violation_object_id IS
  'Объект нарушения (skud_objects), миграция 383; ON DELETE RESTRICT.';
COMMENT ON COLUMN public.staff_deductions.violation_place IS
  'Уточнение места нарушения, до 200 символов (миграция 383).';
COMMENT ON COLUMN public.staff_deductions.violation_date IS
  'Дата нарушения (миграция 383).';

-- Поиск ссылок при удалении объекта (skud-travel.service.ts → deleteTravelObject).
CREATE INDEX IF NOT EXISTS staff_deductions_violation_object_idx
  ON public.staff_deductions (violation_object_id)
  WHERE violation_object_id IS NOT NULL;

COMMIT;
