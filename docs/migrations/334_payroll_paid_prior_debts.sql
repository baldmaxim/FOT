-- 334: Зарплата — «Оплачено»: статья «Погашение долгов прошлых месяцев» (удержание, 42 → 43); «К выплате» = факт.
--
-- Зачем. Решение пользователя 27.10.2026: «Начислено» — то, что рассчитано, «К выплате» — то, что выплачено.
-- У бригад 1С удерживает из зарплаты месяца долги прошлых месяцев (аванс «Оклад по дням», корректировки удержаний,
-- спецодежда, ТМЦ…) и переносит неудержанное на следующий месяц, поэтому выплачено (на Л/С + «К выдаче») ≠
-- начислено − удержано. Статья = долг с прошлых месяцев − закрыто документом 1С − перенесено на следующий месяц
-- (расшифровка — payroll_paid_debts, миграция 332). С ней «Начислено − Удержано = К выплате» = выплачено по ведомости.
-- Минус — перенесено больше долга (выдано больше заработанного): знак разрешён, как у recalc_prev.
--
-- Номер 334: 333 занят другой сессией (333_payroll_1c_vacations.sql).
-- Список кодов продублирован в fot-server/src/services/payroll/payroll-paid.service.ts,
-- fot-app/src/services/payrollService.ts и fot-app/src/utils/payrollPaid.ts — новый код добавлять во все места.
-- 43 статьи — 51 столбец в xlsx «Свода»; лимит снимка поднят до 60 (table-snapshot-export.ts).
--
-- Данные не трогает. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (прежний бэкенд новую статью не показывает, но и не ломается).
-- Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_item_code;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_item_code CHECK (item_code IN (
  'contract', 'bonus', 'sick_leave', 'vacation',
  'housing', 'travel', 'overtime', 'recalc_prev', 'severance', 'supplement', 'planned_supplement', 'loan',
  'kpi', 'premium', 'premium_contract', 'gph', 'extra_work', 'substitution', 'car_compensation', 'deposit',
  'day_rate', 'workwear_accrual', 'advance_accrual', 'fine_refund',
  'meals', 'workwear', 'safety_fine', 'fines', 'writ_deduction',
  'vacation_deduction', 'loan_repayment', 'loan_interest', 'apartment', 'imprest', 'third_party',
  'transport', 'mobile', 'bank_fees',
  'alimony', 'tmc', 'car_rent', 'property_damage', 'prior_debts'));

COMMENT ON COLUMN payroll_paid_amounts.item_code IS
  'Статья «Сводной ведомости» ЗУП — по названию столбца. Начислено: contract «Начислено по графику», '
  'bonus «Ежемесячные доплаты и премии», sick_leave «Оплата больничных листов», vacation «Оплата отпуска», '
  'housing «Компенсация проживания» (+ в общежитии), travel «Проезд», overtime «Переработано», '
  'recalc_prev «Перерасчет за предыдущий период», severance «Выходное пособие при увольнении», '
  'supplement «Доплата», planned_supplement (плановая доплата), loan «Займ», kpi «Начислено по KPI», '
  'premium «Премия», premium_contract «Премия % по договору», gph «Выплата по договору ГПХ», '
  'extra_work «Допработы», substitution «Замещение», car_compensation «Компенсация использования личного а/м», '
  'deposit «Депонент», day_rate «Оплата по дневному тарифу», workwear_accrual «Спецодежда» (начисление), '
  'advance_accrual «Аванс» (начисление в ведомости бригады), fine_refund «Возврат штрафа» (начисление в ведомости бригады). '
  'Удержано: meals «Питание», workwear «Спецодежда», safety_fine «Удержание за нарушение техники безопасности», '
  'fines «Штрафы», writ_deduction «Удержание по исп. листу», vacation_deduction «Оплата отпуска», '
  'loan_repayment «Займ», loan_interest «% Займа», apartment «Квартиры», imprest «Подотчет», '
  'third_party «Удержание из ЗП сотрудника в пользу третьего лица», transport «Транспортные затраты», '
  'mobile «Моб.телефон», bank_fees «Банковские издержки по исп. листам», alimony «Алименты», tmc «ТМЦ», '
  'car_rent «Удержание по договору аренды а/м», property_damage «Порча имущества» (удержание в ведомости бригады), '
  'prior_debts «Погашение долгов прошлых месяцев» (перенос удержаний в ведомости бригады, нетто; бывает с минусом).';

ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_amount_sign;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_amount_sign
  CHECK (amount >= 0 OR item_code IN ('recalc_prev', 'prior_debts'));

COMMIT;
