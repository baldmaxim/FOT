-- 297: Зарплата — «Оплачено»: статьи удержаний и выплат, компенсация проживания.
--
-- Зачем. Карточка «Зарплата → Подробно» показывает «Оплачено» свёрнутым — по месяцам три
-- итога, как в «Сводной ведомости» ЗУП: Начислено (раздел 1), Удержано (3), Выплачено (8).
-- У рабочих (КТУ) из начисленного удерживают питание, спецодежду, штрафы — без этих статей
-- «Начислено» и «Выплачено» в карточке не сходились (бр. Менгбоев, июль 2026:
-- 89 336,14 − 8 298,51 = 81 037,87 на Л/С).
--
-- Новые статьи (код — столбец отчёта ЗУП):
--   доп. начисления:
--     housing       — 1.3.11 + 1.3.12 Компенсация проживания (в т.ч. в общежитии)
--   удержано:
--     meals         — 3.13 Питание
--     workwear      — 3.15 Спецодежда
--     safety_fine   — 3.18 Удержание за нарушение техники безопасности
--     mobile        — 3.9  Моб. телефон
--     fines         — 3.21 Штрафы
--     writ_deduction — 3.20 Удержание по исп. листу (код прежний, статья переехала из начислений)
--   выплачено:
--     fss           — 8.2 Выплаты ФСС
--     advance       — 8.3 Аванс
--     bank_transfer — 8.4 Выплачено на Р/С (Л/С)
--     bonus_payout  — 8.5 Премии
-- Список кодов продублирован в fot-server/src/services/payroll/payroll-paid.service.ts
-- и fot-app/src/utils/payrollPaid.ts — новый код добавлять во все три места.
--
-- Суммы удержаний и выплат — положительные; минус по-прежнему только у перерасчёта.
-- Данных переносить не нужно: на момент миграции таблица пуста.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_item_code;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_item_code CHECK (item_code IN (
  'contract', 'bonus', 'sick_leave',
  'overtime', 'recalc_prev', 'severance', 'supplement', 'loan', 'vacation', 'travel', 'housing',
  'meals', 'workwear', 'safety_fine', 'mobile', 'fines', 'writ_deduction',
  'fss', 'advance', 'bank_transfer', 'bonus_payout'));

COMMENT ON TABLE payroll_paid_amounts IS
  'Оплачено по месяцам: суммы статей «Сводной ведомости» ЗУП (начислено, удержано, выплачено), вносятся '
  'вручную в карточке «Зарплата → Подробно». Пустая ячейка — строки нет. В расчёте зарплаты не участвуют.';
COMMENT ON COLUMN payroll_paid_amounts.item_code IS
  'Статья отчёта ЗУП. Начислено: contract 1.1.1, bonus 1.1.5, sick_leave 1.1.4, overtime 1.1.2, '
  'recalc_prev 1.1.6, severance 1.3.2, supplement 1.3.5, loan 1.3.7, vacation 1.3.13, travel 1.3.16, '
  'housing 1.3.11+1.3.12. Удержано: meals 3.13, workwear 3.15, safety_fine 3.18, mobile 3.9, fines 3.21, '
  'writ_deduction 3.20. Выплачено: fss 8.2, advance 8.3, bank_transfer 8.4, bonus_payout 8.5.';

COMMIT;
