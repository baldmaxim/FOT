-- 329: Зарплата — «Оплачено»: статьи «Возврат штрафа» (начисление) и «Порча имущества» (удержание) (40 → 42).
--
-- Зачем. В ведомостях бригад за июнь 2026 появились два столбца, которым нет своей статьи:
--   «Возврат штрафа» — доначисление («Доп. начислено: Дополнительное начисление № 3216, 3217 от 06.08.2026»),
--     бр.Ортиков Шерзод А. и Участок по гарантийным работам — 3 чел., 36 046,45;
--   «Порча имущества» — удержание с сотрудника, бр.Бахритдинов П.М. — 8 000.
-- Решение пользователя 27.10.2026 — своими строками, как «Аванс (начисление)» (327), а не в «Доплате» и «Штрафах».
--
-- Список кодов продублирован в fot-server/src/services/payroll/payroll-paid.service.ts,
-- fot-app/src/services/payrollService.ts и fot-app/src/utils/payrollPaid.ts — новый код добавлять во все места.
-- 42 статьи — 50 столбцов в xlsx «Свода», ровно лимит снимка (table-snapshot-export.ts).
--
-- Номер 329: 328 занят 328_payroll_1c_payouts.sql (таблицы ведомостей выплаты 1С, этот CHECK не трогает).
-- Данные не трогает. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (прежний бэкенд новые статьи не показывает, но и не ломается).
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
  'alimony', 'tmc', 'car_rent', 'property_damage'));

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
  'car_rent «Удержание по договору аренды а/м», property_damage «Порча имущества» (удержание в ведомости бригады).';

COMMIT;
