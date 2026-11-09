-- 355_brigade_salary_fixed_shares.sql
-- «Табель → Зарплата по объектам»: КТУ 0,0…2,2 и «Доля», вписанная вручную.
--
-- brigade_salary_ktu: КТУ рабочего за месяц — теперь 0,0…2,2 с шагом 0,1 (было 0,5…2,0); тип numeric(2,1) вмещает.
--
-- brigade_salary_fixed_shares — доля рабочего, вписанная рублями на объекте (object_key выработки по объектам) или
-- на бригаде целиком ('__brigade__', выработка одной суммой, 341). У вписанного — ровно эта сумма, остаток выработки
-- объекта делится между остальными по КТУ × учтённые минуты; КТУ вписанного показывается расчётный. Нет строки —
-- доля по формуле. Снимается выбором КТУ и вместе со стёртой выработкой своего ключа.
--
-- brigade_salary_results.share_conflicts — конфликты вписанных долей зафиксированного расчёта (больше выработки,
-- остаток некому распределить, расчётный КТУ выше 2,2, доля без часов на объекте): долей на таком объекте нет.
--
-- updated_by — авторская колонка с NULL: ON DELETE SET NULL без DEFAULT (политика 284/285, стережёт
-- npm run audit:user-fk).
--
-- Применять ДО деплоя бэкенда. Идемпотентно.

BEGIN;

ALTER TABLE public.brigade_salary_ktu DROP CONSTRAINT IF EXISTS brigade_salary_ktu_range;
ALTER TABLE public.brigade_salary_ktu
  ADD CONSTRAINT brigade_salary_ktu_range CHECK (ktu BETWEEN 0 AND 2.2);

COMMENT ON TABLE public.brigade_salary_ktu IS
  'КТУ рабочего в бригаде за месяц, 0,0…2,2 с шагом 0,1. Нет строки — 1,0.';

CREATE TABLE IF NOT EXISTS public.brigade_salary_fixed_shares (
  department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  month date NOT NULL,
  object_key text NOT NULL,
  employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  amount numeric(12,2) NOT NULL,
  updated_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (department_id, month, object_key, employee_id),
  CONSTRAINT brigade_salary_fixed_shares_month_first_day CHECK (EXTRACT(DAY FROM month) = 1),
  CONSTRAINT brigade_salary_fixed_shares_amount_non_negative CHECK (amount >= 0)
);

COMMENT ON TABLE public.brigade_salary_fixed_shares IS
  'Доля рабочего, вписанная рублями на объекте бригады (или ''__brigade__'' при сумме бригаде) за месяц. '
  'Нет строки — доля по КТУ × учтённые минуты.';

ALTER TABLE public.brigade_salary_results
  ADD COLUMN IF NOT EXISTS share_conflicts jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.brigade_salary_results.share_conflicts IS
  'Конфликты вписанных долей расчёта: object_key, code, amount, employee_id, ktu. На таком объекте долей нет.';

COMMIT;
