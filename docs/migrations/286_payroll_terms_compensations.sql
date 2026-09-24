-- 286: Условия оплаты — компенсации проезда и связи, ежемесячное удержание.
--
-- Зачем. Карточка сотрудника в «Зарплата → Условия оплаты» показывает раздел «Компенсация»:
-- проживание (колонка из 282), проезд, связь и удержание. Все суммы — часть условий: меняются
-- вместе с ними и историчны так же (новая строка условий с effective_from).
--
-- Суммы ₽/мес, необязательные. В расчёте зарплаты пока НЕ участвуют — справочно до этапа расчёта.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_compensation_terms
  ADD COLUMN IF NOT EXISTS travel_compensation NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS communication_compensation NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS deduction_amount NUMERIC(12,2);

ALTER TABLE payroll_compensation_terms
  DROP CONSTRAINT IF EXISTS payroll_terms_travel_non_negative,
  DROP CONSTRAINT IF EXISTS payroll_terms_communication_non_negative,
  DROP CONSTRAINT IF EXISTS payroll_terms_deduction_non_negative;

ALTER TABLE payroll_compensation_terms
  ADD CONSTRAINT payroll_terms_travel_non_negative
    CHECK (travel_compensation IS NULL OR travel_compensation >= 0),
  ADD CONSTRAINT payroll_terms_communication_non_negative
    CHECK (communication_compensation IS NULL OR communication_compensation >= 0),
  ADD CONSTRAINT payroll_terms_deduction_non_negative
    CHECK (deduction_amount IS NULL OR deduction_amount >= 0);

COMMENT ON COLUMN payroll_compensation_terms.travel_compensation IS
  'Компенсация проезда, ₽/мес. NULL — не задана. В расчёте зарплаты пока не участвует.';
COMMENT ON COLUMN payroll_compensation_terms.communication_compensation IS
  'Компенсация связи, ₽/мес. NULL — не задана. В расчёте зарплаты пока не участвует.';
COMMENT ON COLUMN payroll_compensation_terms.deduction_amount IS
  'Ежемесячное удержание, ₽/мес, положительное число. NULL — не задано. В расчёте зарплаты пока '
  'не участвует; основания и лимит — ст. 137–138 ТК, проверяются при расчёте, а не здесь.';

COMMIT;
