-- 332: Зарплата — справочно «Долги прошлых месяцев» из ведомостей бригад (решение пользователя 27.10.2026).
--
-- Зачем. «К выплате» в ФОТ = начислено − удержано за месяц. Из зарплаты месяца 1С ещё удерживает долги прошлых
-- месяцев (аванс «Оклад по дням», корректировки удержаний, спецодежда, ТМЦ…), поэтому на счёт приходит меньше.
-- Эти переносы в «Оплачено» не вносятся; здесь они хранятся справочно — как в ведомости:
--   debt_*          — «Перенос удержаний с предыдущих периодов» по видам (столбцы, у которых итог бригады = −сумма людей):
--                     day_salary «Оклад по дням», correction «Корректировка удержаний», workwear «Спецодежда», tmc «ТМЦ»,
--                     property_damage «Порча имущества», advance «Аванс», fines «Акт нарушений из Витрины», meals «Питание»;
--   written_off     — закрыто документом 1С без удержания (столбцы «X, сумма N. За: …»);
--   carried_forward — «Перенос удержаний на следующий период».
-- «Погашено из зарплаты месяца» = долг − закрыто − перенесено (не меньше 0) считает фронт. В «Оплачено», «К выплате»,
-- «Расчёты» и «Свод» не входит. Пользователей не хранит (данные — из ведомостей скриптом).
--
-- Данные не трогает. ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS payroll_paid_debts (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month       DATE NOT NULL,
  line_code   TEXT NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_paid_debts_pkey PRIMARY KEY (employee_id, month, line_code),
  CONSTRAINT payroll_paid_debts_month_first_day CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT payroll_paid_debts_amount_positive CHECK (amount > 0),
  CONSTRAINT payroll_paid_debts_line_code CHECK (line_code IN (
    'debt_day_salary', 'debt_correction', 'debt_workwear', 'debt_tmc', 'debt_property_damage', 'debt_advance',
    'debt_fines', 'debt_meals', 'written_off', 'carried_forward'))
);

COMMENT ON TABLE payroll_paid_debts IS
  'Справочно к «Оплачено»: долги прошлых месяцев из ведомостей бригад 1С — перенос с прошлых периодов по видам, '
  'закрыто документом 1С, перенос на следующий период. В начислено/удержано/к выплате не входит.';

COMMIT;
