-- 336_brigade_salary_object_outputs.sql
-- «Табель → Зарплата по объектам»: «Выработка» бригады вводится по каждому объекту месяца и делится между
-- рабочими этой бригады на этом объекте по КТУ × учтённые часы на объекте. КТУ — по-прежнему один на месяц
-- (brigade_salary_ktu).
--
-- brigade_salary_object_outputs — выработка бригады на объекте за месяц. Нет строки — «не внесена».
--   object_key — skud_objects.id::text, '__unknown_object__' («Не определён») или '__current_activity__';
--   ссылки на skud_objects нет намеренно: объект из снимка закрытого табеля остаётся, даже если его убрали
--   из справочника. object_name — имя на момент ввода (для выработки на объекте, которого больше нет в разбивке).
-- brigade_salary_results.objects — замороженные по объектам выработка, имя и Σ весов расчёта; format 2 — строки
--   с разбивкой по объектам (format 1 — до 336, такой результат пересчитывается или не показывается).
--
-- brigade_salary_outputs (330) больше не читается. Её единственная строка на проде — тестовая (бр.Ходжакулов С.Ж.,
-- сентябрь 2026, 2 000 000, решение пользователя 29.10.2026) — удаляется; любая другая строка останавливает миграцию:
-- это выработка, внесённая по-старому, нужно ручное решение. Откат кода безопасен только до первой записи через
-- новый интерфейс.
--
-- updated_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285, audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.brigade_salary_object_outputs (
  department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  month date NOT NULL,
  object_key text NOT NULL,
  object_name text NOT NULL,
  amount numeric(12,2) NOT NULL,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, month, object_key),
  CONSTRAINT brigade_salary_object_outputs_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT brigade_salary_object_outputs_amount_non_negative CHECK (amount >= 0),
  CONSTRAINT brigade_salary_object_outputs_object_key CHECK (
    object_key IN ('__unknown_object__', '__current_activity__')
    OR object_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  )
);

COMMENT ON TABLE public.brigade_salary_object_outputs IS
  'Выработка бригады на объекте за месяц (₽): делится между рабочими бригады на объекте по КТУ × учтённые часы '
  'на объекте. Нет строки — не внесена.';

ALTER TABLE public.brigade_salary_results
  ADD COLUMN IF NOT EXISTS objects jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.brigade_salary_results
  ADD COLUMN IF NOT EXISTS format smallint NOT NULL DEFAULT 1;
ALTER TABLE public.brigade_salary_results
  ADD COLUMN IF NOT EXISTS distribution text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'brigade_salary_results_format'
       AND conrelid = 'public.brigade_salary_results'::regclass
  ) THEN
    ALTER TABLE public.brigade_salary_results
      ADD CONSTRAINT brigade_salary_results_format CHECK (format IN (1, 2));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'brigade_salary_results_distribution'
       AND conrelid = 'public.brigade_salary_results'::regclass
  ) THEN
    ALTER TABLE public.brigade_salary_results
      ADD CONSTRAINT brigade_salary_results_distribution
      CHECK (distribution IS NULL OR distribution IN ('ok', 'no_output', 'nothing_to_distribute', 'error'));
  END IF;
END $$;

COMMENT ON COLUMN public.brigade_salary_results.objects IS
  'Замороженные объекты расчёта: [{object_key, object_name, output, total_weight}]; rows[].objects — дни, минуты, '
  'вес и доля сотрудника на объекте.';
COMMENT ON COLUMN public.brigade_salary_results.format IS
  '1 — расчёт до 336 (одна выработка на бригаду), 2 — по объектам.';
COMMENT ON COLUMN public.brigade_salary_results.distribution IS
  'Итог распределения format 2: error → no_output → nothing_to_distribute → ok; у format 1 — NULL.';

DO $$
DECLARE
  leftover text;
BEGIN
  DELETE FROM public.brigade_salary_outputs
   WHERE department_id = 'bc645c62-4ff1-4f9e-a1ce-503196b1eb8e'
     AND month = DATE '2026-09-01'
     AND amount = 2000000.00;

  SELECT string_agg(format('%s / %s / %s', department_id, month, amount::text), '; ' ORDER BY department_id, month)
    INTO leftover
    FROM public.brigade_salary_outputs;
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'brigade_salary_outputs: есть выработка, внесённая по-старому (%), нужно ручное решение', leftover;
  END IF;
END $$;

COMMENT ON TABLE public.brigade_salary_outputs IS
  'Не используется с 336: выработка вводится по объектам (brigade_salary_object_outputs).';

COMMIT;
