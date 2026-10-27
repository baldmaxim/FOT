-- 330_brigade_salary.sql
-- «Табель → Зарплата»: «Выработка» бригады за месяц делится между рабочими по КТУ и учтённым
-- часам. Вводят выработку и КТУ только те, кому открыт раздел «Зарплата» (payroll_section_access).
--
-- brigade_salary_outputs — выработка бригады за месяц. Нет строки — «не введена» (это не 0,00:
-- ноль даёт всем 0,00, а «не введена» — суммы нет).
-- brigade_salary_ktu — КТУ рабочего в бригаде за месяц, 0,5…2,0 с шагом 0,1. Нет строки — 1,0.
-- brigade_salary_results — зафиксированный расчёт закрытого месяца: строки, редакции табеля
-- (approval_id → version_id) и отпечаток выработки/КТУ, по которым он сделан. Пересчитывается
-- только при новой редакции или новых выработке/КТУ: правка графика задним числом сумму не меняет.
--
-- updated_by / computed_by — авторские колонки с NULL: ON DELETE SET NULL без DEFAULT
-- (политика 284/285, стережёт npm run audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.brigade_salary_outputs (
  department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  month date NOT NULL,
  amount numeric(12,2) NOT NULL,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, month),
  CONSTRAINT brigade_salary_outputs_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT brigade_salary_outputs_amount_non_negative CHECK (amount >= 0)
);

COMMENT ON TABLE public.brigade_salary_outputs IS
  'Выработка бригады за месяц (₽), делится по КТУ × учтённые часы. Нет строки — не введена.';

CREATE TABLE IF NOT EXISTS public.brigade_salary_ktu (
  department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  month date NOT NULL,
  employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  ktu numeric(2,1) NOT NULL,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, month, employee_id),
  CONSTRAINT brigade_salary_ktu_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT brigade_salary_ktu_range CHECK (ktu BETWEEN 0.5 AND 2.0)
);

COMMENT ON TABLE public.brigade_salary_ktu IS
  'КТУ рабочего в бригаде за месяц, 0,5…2,0 с шагом 0,1. Нет строки — 1,0.';

CREATE TABLE IF NOT EXISTS public.brigade_salary_results (
  department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  month date NOT NULL,
  status text NOT NULL,
  output_amount numeric(12,2),
  inputs_hash text NOT NULL,
  versions jsonb NOT NULL,
  errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  rows jsonb NOT NULL,
  computed_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, month),
  CONSTRAINT brigade_salary_results_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT brigade_salary_results_status CHECK (status IN ('fixed', 'error'))
);

COMMENT ON TABLE public.brigade_salary_results IS
  'Зафиксированный расчёт бригады по закрытому табелю: rows (employee_id, counted_minutes, ktu, amount строкой, '
  'source version|live), versions (approval_id → version_id), inputs_hash — отпечаток выработки и КТУ.';

COMMIT;
