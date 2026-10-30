-- 341_brigade_salary_brigade_outputs.sql
-- «Табель → Бригады»: выработку бригады вносят ИЛИ одной суммой на бригаду за месяц, ИЛИ по объектам (336), но не
-- обе сразу (решение пользователя 30.10.2026). Сумма бригаде делится на всех рабочих бригады по КТУ × учтённые часы
-- за месяц, объекты не учитываются.
--
-- brigade_salary_brigade_outputs — сумма бригаде за месяц. Нет строки — не внесена. Старую brigade_salary_outputs
--   (330) не используем: 336 при повторном прогоне останавливается на любой её строке.
-- «Или — или» — триггером на обеих таблицах выработки: он берёт тот же advisory-замок (бригада, месяц), что
--   фиксация расчёта и запись через API (brigade-salary.service / timesheet-salary.controller), и отказывает, если
--   в другой таблице есть строка того же (бригада, месяц). Две одновременные записи в разные таблицы не проходят
--   обе — в том числе ручным SQL. Ключ замка — 'brigade_salary:<department_id>:<ГГГГ-ММ>', как в коде.
-- brigade_salary_results.mode — по какой выработке посчитан зафиксированный результат: objects (по объектам, 336)
--   или brigade (сумма бригаде; output_amount — эта сумма). Старые строки — objects.
--
-- updated_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285, audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.brigade_salary_brigade_outputs (
  department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  month date NOT NULL,
  amount numeric(12,2) NOT NULL,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, month),
  CONSTRAINT brigade_salary_brigade_outputs_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT brigade_salary_brigade_outputs_amount_non_negative CHECK (amount >= 0)
);

COMMENT ON TABLE public.brigade_salary_brigade_outputs IS
  'Выработка бригады за месяц одной суммой (₽): делится на всех рабочих по КТУ × учтённые часы за месяц. '
  'Взаимоисключающая с выработкой по объектам (brigade_salary_object_outputs) — следит триггер. Нет строки — не внесена.';

-- Отказ, если у (бригада, месяц) уже внесена выработка другим способом. Замок — тот же, что у фиксации и API.
CREATE OR REPLACE FUNCTION public.brigade_salary_output_mode_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    format('brigade_salary:%s:%s', NEW.department_id, to_char(NEW.month, 'YYYY-MM')), 0));
  IF TG_TABLE_NAME = 'brigade_salary_brigade_outputs' THEN
    IF EXISTS (
      SELECT 1 FROM public.brigade_salary_object_outputs
       WHERE department_id = NEW.department_id AND month = NEW.month
    ) THEN
      RAISE EXCEPTION 'Внесена выработка по объектам — сотрите её, чтобы внести на бригаду'
        USING ERRCODE = 'P0001', HINT = 'OUTPUT_MODE_CONFLICT';
    END IF;
  ELSIF EXISTS (
    SELECT 1 FROM public.brigade_salary_brigade_outputs
     WHERE department_id = NEW.department_id AND month = NEW.month
  ) THEN
    RAISE EXCEPTION 'Внесена выработка бригаде — сотрите её, чтобы вносить по объектам'
      USING ERRCODE = 'P0001', HINT = 'OUTPUT_MODE_CONFLICT';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS brigade_salary_brigade_outputs_mode_guard ON public.brigade_salary_brigade_outputs;
CREATE TRIGGER brigade_salary_brigade_outputs_mode_guard
  BEFORE INSERT OR UPDATE ON public.brigade_salary_brigade_outputs
  FOR EACH ROW EXECUTE FUNCTION public.brigade_salary_output_mode_guard();

DROP TRIGGER IF EXISTS brigade_salary_object_outputs_mode_guard ON public.brigade_salary_object_outputs;
CREATE TRIGGER brigade_salary_object_outputs_mode_guard
  BEFORE INSERT OR UPDATE ON public.brigade_salary_object_outputs
  FOR EACH ROW EXECUTE FUNCTION public.brigade_salary_output_mode_guard();

ALTER TABLE public.brigade_salary_results
  ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'objects';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'brigade_salary_results_mode'
       AND conrelid = 'public.brigade_salary_results'::regclass
  ) THEN
    ALTER TABLE public.brigade_salary_results
      ADD CONSTRAINT brigade_salary_results_mode CHECK (mode IN ('objects', 'brigade'));
  END IF;
END $$;

COMMENT ON COLUMN public.brigade_salary_results.mode IS
  'По какой выработке посчитан результат: objects — по объектам (336), brigade — одной суммой на бригаду '
  '(output_amount — эта сумма, доля = сумма × КТУ × минуты за месяц / Σ).';

COMMIT;
