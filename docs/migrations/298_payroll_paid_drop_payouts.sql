-- 298: Зарплата — «Оплачено»: статьи «Выплачено» и «Моб. телефон» удалены.
--
-- Зачем. Карточка «Зарплата → Подробно» показывает «Оплачено» за один выбранный месяц и только
-- разделы «Начислено» и «Удержано»: группа «Выплачено» (fss 8.2, advance 8.3, bank_transfer 8.4,
-- bonus_payout 8.5) и удержание mobile (3.9) убраны из карточки и из API.
--
-- Данные: суммы этих статей удаляются (на момент миграции — выплаты за август 2026, Тендерный
-- отдел; mobile пуст). Начисления и остальные удержания не трогаются — из них столбец
-- «Начисления» в списке условий оплаты.
--
-- Список кодов продублирован в fot-server/src/services/payroll/payroll-paid.service.ts
-- и fot-app/src/utils/payrollPaid.ts — новый код добавлять во все три места.
--
-- ПРИМЕНЯТЬ ПОСЛЕ ДЕПЛОЯ БЭКЕНДА (новый бэкенд эти статьи уже не принимает). Повторный запуск безопасен.

BEGIN;

DELETE FROM payroll_paid_amounts
 WHERE item_code IN ('fss', 'advance', 'bank_transfer', 'bonus_payout', 'mobile');

ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_item_code;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_item_code CHECK (item_code IN (
  'contract', 'bonus', 'sick_leave',
  'overtime', 'recalc_prev', 'severance', 'supplement', 'loan', 'vacation', 'travel', 'housing',
  'meals', 'workwear', 'safety_fine', 'fines', 'writ_deduction'));

COMMENT ON TABLE payroll_paid_amounts IS
  'Оплачено по месяцам: суммы статей «Сводной ведомости» ЗУП (начислено, удержано), вносятся '
  'вручную в карточке «Зарплата → Подробно». Пустая ячейка — строки нет. В расчёте зарплаты не участвуют.';
COMMENT ON COLUMN payroll_paid_amounts.item_code IS
  'Статья отчёта ЗУП. Начислено: contract 1.1.1, bonus 1.1.5, sick_leave 1.1.4, overtime 1.1.2, '
  'recalc_prev 1.1.6, severance 1.3.2, supplement 1.3.5, loan 1.3.7, vacation 1.3.13, travel 1.3.16, '
  'housing 1.3.11+1.3.12. Удержано: meals 3.13, workwear 3.15, safety_fine 3.18, fines 3.21, '
  'writ_deduction 3.20.';

COMMIT;
