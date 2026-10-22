-- 325: Зарплата — «Оплачено»: все столбцы «Сводной ведомости» ЗУП (все отделы) — своей статьёй.
--
-- Зачем. В ведомости за август 2026 (ИТР и офис) часть начислений и удержаний не ложилась ни в одну
-- статью — «Начислено» и «Удержано» в ФОТ были бы меньше ведомости. Решение пользователя 22.10.2026:
-- каждый такой столбец — новая статья, с названием как в ЗУП.
--
-- Доп. начисления: kpi (1.2 «Начислено по KPI» — итог четырёх KPI), premium «Премия»,
-- premium_contract «Премия % по договору», gph «Выплата по договору ГПХ», extra_work «Допработы»,
-- substitution «Замещение», car_compensation «Компенсация использования личного а/м», deposit «Депонент».
-- Удержано: vacation_deduction «Оплата отпуска», loan_repayment «Займ» (погашение), loan_interest
-- «% Займа», apartment «Квартиры», imprest «Подотчет», third_party «Удержание из ЗП сотрудника в пользу
-- третьего лица», transport «Транспортные затраты», mobile «Моб.телефон», bank_fees «Банковские
-- издержки по исп. листам». Минус — по-прежнему только у recalc_prev.
--
-- Номера столбцов в ведомостях ЗУП разные (пустые столбцы 1С не выводит, нумерация сдвигается),
-- поэтому статьи сопоставляются по названию столбца, а не по номеру.
--
-- Данные не трогает. Список кодов продублирован в fot-server/src/services/payroll/payroll-paid.service.ts,
-- fot-app/src/services/payrollService.ts и fot-app/src/utils/payrollPaid.ts — новый код добавлять во все места.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА (прежний бэкенд новые статьи не показывает, но и не ломается).
-- Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_item_code;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_item_code CHECK (item_code IN (
  'contract', 'bonus', 'sick_leave', 'vacation',
  'housing', 'travel', 'overtime', 'recalc_prev', 'severance', 'supplement', 'planned_supplement', 'loan',
  'kpi', 'premium', 'premium_contract', 'gph', 'extra_work', 'substitution', 'car_compensation', 'deposit',
  'meals', 'workwear', 'safety_fine', 'fines', 'writ_deduction',
  'vacation_deduction', 'loan_repayment', 'loan_interest', 'apartment', 'imprest', 'third_party',
  'transport', 'mobile', 'bank_fees'));

COMMENT ON COLUMN payroll_paid_amounts.item_code IS
  'Статья «Сводной ведомости» ЗУП — по названию столбца. Начислено: contract «Начислено по графику», '
  'bonus «Ежемесячные доплаты и премии», sick_leave «Оплата больничных листов», vacation «Оплата отпуска», '
  'housing «Компенсация проживания» (+ в общежитии), travel «Проезд», overtime «Переработано», '
  'recalc_prev «Перерасчет за предыдущий период», severance «Выходное пособие при увольнении», '
  'supplement «Доплата», planned_supplement (плановая доплата), loan «Займ», kpi «Начислено по KPI», '
  'premium «Премия», premium_contract «Премия % по договору», gph «Выплата по договору ГПХ», '
  'extra_work «Допработы», substitution «Замещение», car_compensation «Компенсация использования личного а/м», '
  'deposit «Депонент». Удержано: meals «Питание», workwear «Спецодежда», safety_fine «Удержание за нарушение '
  'техники безопасности», fines «Штрафы», writ_deduction «Удержание по исп. листу», vacation_deduction '
  '«Оплата отпуска», loan_repayment «Займ», loan_interest «% Займа», apartment «Квартиры», imprest «Подотчет», '
  'third_party «Удержание из ЗП сотрудника в пользу третьего лица», transport «Транспортные затраты», '
  'mobile «Моб.телефон», bank_fees «Банковские издержки по исп. листам».';

COMMIT;
