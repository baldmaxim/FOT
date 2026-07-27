-- 233_employee_induction_program_a.sql
-- Программа А «Общие вопросы охраны труда и функционирования системы охраны труда»
-- для своих сотрудников (вкладка «Управление кадрами → Вводный инструктаж»).
--
-- Вид обучения требуется ТОЛЬКО для ИТР — у подрядчиков-рабочих его нет, поэтому он живёт
-- колонкой в employee_inductions, а не в contractor_person_trainings (миграция 232).
--
-- inducted_on становится nullable: у сотрудника может быть программа А без вводного
-- инструктажа. Инвариант «пустая строка не живёт» держит CHECK; сервис удаляет строку,
-- когда сняты обе даты.
--
-- ВНИМАНИЕ (откат): бэкенд ДО этого релиза при очистке вводного инструктажа удаляет всю
-- строку — откат на него после начала записи программы А сотрёт её. Точка отката —
-- только релиз, который умеет оба поля.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.
-- ПЕРЕД ПРИМЕНЕНИЕМ — дамп employee_inductions и контрольный count(*).

BEGIN;

ALTER TABLE public.employee_inductions ALTER COLUMN inducted_on DROP NOT NULL;

ALTER TABLE public.employee_inductions
  ADD COLUMN IF NOT EXISTS program_a_on date NULL;

COMMENT ON COLUMN public.employee_inductions.program_a_on IS
  'Программа А «Общие вопросы охраны труда» (только ИТР). Периодичность 3 года, срок пока не считается.';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employee_inductions_any_date_chk'
  ) THEN
    ALTER TABLE public.employee_inductions
      ADD CONSTRAINT employee_inductions_any_date_chk
      CHECK (inducted_on IS NOT NULL OR program_a_on IS NOT NULL);
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Сверка после применения (должно быть 0):
--   SELECT count(*) FROM employee_inductions WHERE inducted_on IS NULL AND program_a_on IS NULL;
