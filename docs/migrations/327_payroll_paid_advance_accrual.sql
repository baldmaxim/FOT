-- 327: Зарплата — «Оплачено»: статья «Аванс (начисление)» (39 → 40).
--
-- Зачем. В ведомости бригады за май 2026 (бр.Аюби М.С.) столбец «Аванс» — доначисление зарплаты: в итоговом блоке
-- «Доп. начислено: Начисление З/П БД № 482». Своей статьи не было, сумма легла в «По трудовому договору». Решение
-- пользователя 26.10.2026 — отдельной строкой.
--
-- Код advance_accrual, а не advance: advance — статья 8.3 «Аванс» раздела «Выплачено», удалённая миграцией 298
-- (выплаты ФОТ не хранит); «Аванс» как часть выплаты (Л/С + аванс) по-прежнему не вносится.
--
-- Данные не трогает. Список кодов продублирован в fot-server/src/services/payroll/payroll-paid.service.ts,
-- fot-app/src/services/payrollService.ts и fot-app/src/utils/payrollPaid.ts — новый код добавлять во все места.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (прежний бэкенд новую статью не показывает, но и не ломается).
-- Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_item_code;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_item_code CHECK (item_code IN (
  'contract', 'bonus', 'sick_leave', 'vacation',
  'housing', 'travel', 'overtime', 'recalc_prev', 'severance', 'supplement', 'planned_supplement', 'loan',
  'kpi', 'premium', 'premium_contract', 'gph', 'extra_work', 'substitution', 'car_compensation', 'deposit',
  'day_rate', 'workwear_accrual', 'advance_accrual',
  'meals', 'workwear', 'safety_fine', 'fines', 'writ_deduction',
  'vacation_deduction', 'loan_repayment', 'loan_interest', 'apartment', 'imprest', 'third_party',
  'transport', 'mobile', 'bank_fees',
  'alimony', 'tmc', 'car_rent'));

COMMENT ON COLUMN payroll_paid_amounts.item_code IS
  'Статья «Сводной ведомости» ЗУП — по названию столбца. Начислено: contract «Начислено по графику», '
  'bonus «Ежемесячные доплаты и премии», sick_leave «Оплата больничных листов», vacation «Оплата отпуска», '
  'housing «Компенсация проживания» (+ в общежитии), travel «Проезд», overtime «Переработано», '
  'recalc_prev «Перерасчет за предыдущий период», severance «Выходное пособие при увольнении», '
  'supplement «Доплата», planned_supplement (плановая доплата), loan «Займ», kpi «Начислено по KPI», '
  'premium «Премия», premium_contract «Премия % по договору», gph «Выплата по договору ГПХ», '
  'extra_work «Допработы», substitution «Замещение», car_compensation «Компенсация использования личного а/м», '
  'deposit «Депонент», day_rate «Оплата по дневному тарифу», workwear_accrual «Спецодежда» (начисление), '
  'advance_accrual «Аванс» (начисление в ведомости бригады). '
  'Удержано: meals «Питание», workwear «Спецодежда», safety_fine «Удержание за нарушение техники безопасности», '
  'fines «Штрафы», writ_deduction «Удержание по исп. листу», vacation_deduction «Оплата отпуска», '
  'loan_repayment «Займ», loan_interest «% Займа», apartment «Квартиры», imprest «Подотчет», '
  'third_party «Удержание из ЗП сотрудника в пользу третьего лица», transport «Транспортные затраты», '
  'mobile «Моб.телефон», bank_fees «Банковские издержки по исп. листам», alimony «Алименты», tmc «ТМЦ», '
  'car_rent «Удержание по договору аренды а/м».';

COMMIT;
