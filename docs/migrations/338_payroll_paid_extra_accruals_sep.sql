-- 338: Зарплата — «Оплачено»: статьи «Резерв», «Матпомощь», «Перерасход п/о средств», «Зарплата (доп. начисление)»
-- (начисления, 43 → 47).
--
-- Зачем. В выгрузке ЗУП «ДополнительныеНачисления_Премия_ЗУП_упр_Сентябрь.xlsx» (152 строки, сентябрь 2026) четыре
-- вида расчёта без своей статьи:
--   «Резерв» — бригады Аллакулова, Прозорова, Файзова, 9 чел., 927 868,81;
--   «Матпомощь» — 1 чел., 100 000;
--   «Перерасход п/о средств» — возмещение перерасхода подотчёта (начисление, не удержание «Подотчёт»), 6 строк, 67 034,90;
--   «Зарплата» — доначисление зарплаты отдельным документом, 2 чел., 11 925,86 (не contract: его даст ведомость месяца).
-- Как в августе (решение пользователя): вид 1С без статьи — новая статья с названием 1С.
--
-- Номер 338: 337 занят 337_payroll_planned_supplement_rewrite.sql (плановые доплаты, этот CHECK не трогает).
-- Список кодов продублирован в fot-server/src/services/payroll/payroll-paid.service.ts,
-- fot-app/src/services/payrollService.ts и fot-app/src/utils/payrollPaid.ts — новый код добавлять во все места.
-- 47 статей — 55 столбцов в xlsx «Свода», лимит снимка 60 (table-snapshot-export.ts).
--
-- Данные не трогает. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (прежний бэкенд новые статьи не показывает, но и не ломается).
-- Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_item_code;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_item_code CHECK (item_code IN (
  'contract', 'bonus', 'sick_leave', 'vacation',
  'housing', 'travel', 'overtime', 'recalc_prev', 'severance', 'supplement', 'planned_supplement', 'loan',
  'kpi', 'premium', 'premium_contract', 'gph', 'extra_work', 'substitution', 'car_compensation', 'deposit',
  'day_rate', 'workwear_accrual', 'advance_accrual', 'fine_refund',
  'reserve', 'material_aid', 'imprest_overspend', 'salary_extra',
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
  'advance_accrual «Аванс» (начисление в ведомости бригады), fine_refund «Возврат штрафа» (начисление в ведомости бригады), '
  'reserve «Резерв», material_aid «Матпомощь», imprest_overspend «Перерасход п/о средств», '
  'salary_extra «Зарплата» (дополнительное начисление). '
  'Удержано: meals «Питание», workwear «Спецодежда», safety_fine «Удержание за нарушение техники безопасности», '
  'fines «Штрафы», writ_deduction «Удержание по исп. листу», vacation_deduction «Оплата отпуска», '
  'loan_repayment «Займ», loan_interest «% Займа», apartment «Квартиры», imprest «Подотчет», '
  'third_party «Удержание из ЗП сотрудника в пользу третьего лица», transport «Транспортные затраты», '
  'mobile «Моб.телефон», bank_fees «Банковские издержки по исп. листам», alimony «Алименты», tmc «ТМЦ», '
  'car_rent «Удержание по договору аренды а/м», property_damage «Порча имущества» (удержание в ведомости бригады), '
  'prior_debts «Погашение долгов прошлых месяцев» (перенос удержаний в ведомости бригады, нетто; бывает с минусом).';

COMMIT;
