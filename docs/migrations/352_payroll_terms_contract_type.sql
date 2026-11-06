-- 352_payroll_terms_contract_type.sql
-- Тип договора в условиях оплаты: «Трудовой» или «ГПХ» (договор гражданско-правового характера).
--
-- Часть условий, как вид оплаты и округление оклада (миграция 331): меняется с «Действует с» и историчен —
-- «Расчёты» за прошлый месяц показывают тот договор, что действовал тогда. Пока только пометка:
-- в карточке «Зарплаты», под ФИО в «Расчётах» и в их экспорте; суммы, проезд и отпуска не меняет.
--
-- Сохранение карточки без поля (прежний клиент) берёт договор прежних условий — ГПХ не сбрасывается.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: бэкенд читает колонку в списке «Расчётов» и пишет её при сохранении.
-- Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_compensation_terms
  ADD COLUMN IF NOT EXISTS contract_type TEXT NOT NULL DEFAULT 'labor';
ALTER TABLE payroll_compensation_terms DROP CONSTRAINT IF EXISTS payroll_terms_contract_type;
ALTER TABLE payroll_compensation_terms ADD CONSTRAINT payroll_terms_contract_type
  CHECK (contract_type IN ('labor', 'gph'));

COMMENT ON COLUMN payroll_compensation_terms.contract_type IS
  'Тип договора: labor — трудовой, gph — ГПХ. Пометка в карточке и «Расчётах», в расчёте не участвует. '
  'См. миграцию 352.';

COMMIT;
