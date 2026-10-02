-- 295: Зарплата — «Оплачено» по месяцам в карточке сотрудника.
--
-- Зачем. Карточка «Зарплата → Подробно» показывает таблицу «Оплачено»: статьи отчёта
-- ЗУП «Начислено…» строками, месяцы столбцами. Суммы вносятся вручную, по одному
-- сотруднику и месяцу; импорт отчёта — отдельным шагом.
--
-- Статьи (код — столбец отчёта ЗУП):
--   contract       — 1.1.1  Начислено по графику («По трудовому договору»)
--   bonus          — 1.1.5  Ежемесячные доплаты и премии («Премиальная»)
--   sick_leave     — 1.1.4  Оплата больничных листов («Больничный»)
--   overtime       — 1.1.2  Переработано
--   recalc_prev    — 1.1.6  Перерасчёт за предыдущий период
--   severance      — 1.3.2  Выходное пособие при увольнении
--   supplement     — 1.3.5  Доплата
--   loan           — 1.3.7  Займ
--   vacation       — 1.3.13 Оплата отпуска
--   travel         — 1.3.16 Проезд
--   writ_deduction — 1.3.18 Удержание по исп. листу
-- Список кодов продублирован в fot-server/src/services/payroll/payroll-paid.service.ts
-- и fot-app/src/utils/payrollPaid.ts — новый код добавлять во все три места.
--
-- Ключевые решения:
--   * Одна строка — сотрудник × месяц × статья. Пустая ячейка — строки нет (удаляется).
--   * Месяц — DATE первого числа: сравнения и диапазоны без разбора строк.
--   * Минус допустим только у перерасчёта (сторно прошлого периода).
--   * Не payroll_item_types: каталог 271 — виды будущего расчёта, у статей отчёта ЗУП
--     другие границы (например, «Ежемесячные доплаты и премии» одной суммой).
--
-- Справочно: в расчёте зарплаты суммы НЕ участвуют.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS payroll_paid_amounts (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  month       DATE NOT NULL,
  item_code   TEXT NOT NULL,
  amount      NUMERIC(12,2) NOT NULL,
  -- Автор в колонке с NULL: ON DELETE SET NULL без DEFAULT (политика миграции 285).
  updated_by  UUID REFERENCES user_profiles(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (employee_id, month, item_code),
  CONSTRAINT payroll_paid_month_first_day CHECK (month = date_trunc('month', month)::date),
  CONSTRAINT payroll_paid_item_code CHECK (item_code IN (
    'contract', 'bonus', 'sick_leave', 'overtime', 'recalc_prev', 'severance',
    'supplement', 'loan', 'vacation', 'travel', 'writ_deduction')),
  CONSTRAINT payroll_paid_amount_sign CHECK (amount >= 0 OR item_code = 'recalc_prev')
);

COMMENT ON TABLE payroll_paid_amounts IS
  'Оплачено по месяцам: суммы статей отчёта ЗУП «Начислено…», вносятся вручную в карточке '
  '«Зарплата → Подробно». Пустая ячейка — строки нет. В расчёте зарплаты не участвуют.';
COMMENT ON COLUMN payroll_paid_amounts.month IS 'Месяц начисления — первое число месяца.';
COMMENT ON COLUMN payroll_paid_amounts.item_code IS
  'Статья отчёта ЗУП: contract 1.1.1, bonus 1.1.5, sick_leave 1.1.4, overtime 1.1.2, recalc_prev 1.1.6, '
  'severance 1.3.2, supplement 1.3.5, loan 1.3.7, vacation 1.3.13, travel 1.3.16, writ_deduction 1.3.18.';

REVOKE ALL ON TABLE public.payroll_paid_amounts FROM PUBLIC;

COMMIT;
