-- 362: Плановые удержания (миграция 357) — другая сумма в последнем месяце периода.
--
-- Пример: займ 100 000 — 30 000 ₽/мес с ноября по февраль, в феврале 10 000. last_month_amount удерживается в
-- месяце month_to вместо amount; в остальных месяцах — amount. Развёртка по месяцам одна для всех расчётов
-- (payroll-month-deductions.sql.ts). NULL — во всех месяцах одна сумма (как до миграции).
--
-- Только у периода с концом, длиннее месяца, и с суммой, отличной от ежемесячной: у бессрочного последнего месяца
-- нет, у периода в один месяц «последний» — единственный. «Убрать» идущего (период закрывается прошлым месяцем)
-- снимает сумму последнего месяца — прошлый месяц, уже удержанный обычной суммой, не пересчитывается.
--
-- История карточки (payroll_planned_deduction_changes) — сумма последнего месяца «стало» и «было».
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (новый бэкенд читает колонки). Прежний бэкенд с ними работает.
-- Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_planned_deductions ADD COLUMN IF NOT EXISTS last_month_amount NUMERIC(12,2);

ALTER TABLE payroll_planned_deductions DROP CONSTRAINT IF EXISTS payroll_planned_deduction_last_month;
ALTER TABLE payroll_planned_deductions ADD CONSTRAINT payroll_planned_deduction_last_month CHECK (
  last_month_amount IS NULL
  OR (last_month_amount > 0 AND last_month_amount <> amount AND month_to IS NOT NULL AND month_to > month_from)
);

COMMENT ON COLUMN payroll_planned_deductions.last_month_amount IS
  'Сумма в последнем месяце (month_to) вместо amount; NULL — как в остальных. См. миграцию 362.';

ALTER TABLE payroll_planned_deduction_changes ADD COLUMN IF NOT EXISTS last_month_amount NUMERIC(12,2);
ALTER TABLE payroll_planned_deduction_changes ADD COLUMN IF NOT EXISTS prev_last_month_amount NUMERIC(12,2);

COMMIT;
