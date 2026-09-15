-- 282: Условия оплаты — премиальная часть и компенсация проживания.
--
-- Зачем. Экран «Зарплата → Условия оплаты» показывает состав оплаты сотрудника: оклад,
-- премиальную часть и компенсацию проживания. Обе суммы — часть условий: меняются вместе
-- с ними и историчны так же (новая строка условий с effective_from).
--
-- Суммы ₽/мес, необязательные. В расчёте зарплаты пока НЕ участвуют — справочно до этапа расчёта.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_compensation_terms
  ADD COLUMN IF NOT EXISTS bonus_amount NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS housing_compensation NUMERIC(12,2);

ALTER TABLE payroll_compensation_terms
  DROP CONSTRAINT IF EXISTS payroll_terms_bonus_non_negative,
  DROP CONSTRAINT IF EXISTS payroll_terms_housing_non_negative;

ALTER TABLE payroll_compensation_terms
  ADD CONSTRAINT payroll_terms_bonus_non_negative
    CHECK (bonus_amount IS NULL OR bonus_amount >= 0),
  ADD CONSTRAINT payroll_terms_housing_non_negative
    CHECK (housing_compensation IS NULL OR housing_compensation >= 0);

COMMENT ON COLUMN payroll_compensation_terms.bonus_amount IS
  'Премиальная часть, ₽/мес. NULL — не задана. В расчёте зарплаты пока не участвует.';
COMMENT ON COLUMN payroll_compensation_terms.housing_compensation IS
  'Компенсация проживания, ₽/мес. NULL — не задана. В расчёте зарплаты пока не участвует.';

COMMIT;
