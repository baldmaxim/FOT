-- 301: Зарплата — «Оплачено»: статья «Плановая доплата», удержания «Оплачено» — в справочнике видов.
--
-- Зачем. «Оплачено» в карточке «Подробно» теперь только показывает суммы (ввод убран — данные придут
-- из 1С API или выгрузкой) и в новом порядке статей. Среди «Доп. начислений» появилась «Плановая
-- доплата» (planned_supplement), «Доплата» (supplement) показывается как «Разовая доплата».
--
-- Удержания из «Оплачено» добавляются в справочник видов удержаний («Расчёты», миграция 299),
-- чтобы списки совпадали: «Питание», «Спецодежда», «Штрафы» в нём уже есть, новые — «Нарушение
-- техники безопасности» и «Удержание по исп. листу».
--
-- Долг миграции 300: колонка payroll_compensation_terms.deduction_kind_id не используется —
-- удаляется (бэкенд с 361c7832 её не читает).
--
-- Список кодов продублирован в fot-server/src/services/payroll/payroll-paid.service.ts
-- и fot-app/src/utils/payrollPaid.ts — новый код добавлять во все три места.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_paid_amounts DROP CONSTRAINT IF EXISTS payroll_paid_item_code;
ALTER TABLE payroll_paid_amounts ADD CONSTRAINT payroll_paid_item_code CHECK (item_code IN (
  'contract', 'bonus', 'sick_leave', 'vacation',
  'housing', 'travel', 'overtime', 'recalc_prev', 'severance', 'supplement', 'planned_supplement', 'loan',
  'meals', 'workwear', 'safety_fine', 'fines', 'writ_deduction'));

COMMENT ON COLUMN payroll_paid_amounts.item_code IS
  'Статья отчёта ЗУП. Начислено: contract 1.1.1, bonus 1.1.5, sick_leave 1.1.4, vacation 1.3.13, '
  'housing 1.3.11+1.3.12, travel 1.3.16, overtime 1.1.2, recalc_prev 1.1.6, severance 1.3.2, '
  'supplement 1.3.5 (разовая доплата), planned_supplement (плановая доплата), loan 1.3.7. '
  'Удержано: meals 3.13, workwear 3.15, safety_fine 3.18, fines 3.21, writ_deduction 3.20.';

INSERT INTO payroll_deduction_kinds (name, sort_order) VALUES
  ('Нарушение техники безопасности', 70),
  ('Удержание по исп. листу',        80)
ON CONFLICT DO NOTHING;

ALTER TABLE payroll_compensation_terms DROP COLUMN IF EXISTS deduction_kind_id;

COMMIT;
