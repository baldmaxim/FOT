-- 300: Зарплата — удержания сотрудника: несколько видов из справочника.
--
-- Зачем. На вкладке «Расчёты» у каждого сотрудника столбец «Удержание» — выпадающий список
-- с галочками: можно отметить несколько видов из справочника (миграция 299) и там же добавить
-- новый вид. Те же виды — в «Удержании» карточки «Подробно».
--
-- Виды сотрудника — не версия условий оплаты: отмечаются прямо в таблице, и у сотрудника
-- без условий тоже. Поэтому отдельная таблица «сотрудник × вид». Вид в условиях оплаты
-- (deduction_kind_id из 299) больше не используется: снимается CHECK «вид и сумма вместе» —
-- сумма удержания ₽/мес (deduction_amount, миграция 286) сохраняется без вида. Саму колонку
-- прежний бэкенд ещё читает, поэтому она остаётся до следующей миграции после деплоя.
--
-- Автора отметки не храним (без FK на пользователя) — изменения пишутся в аудит.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА. Прежний бэкенд с ней работает. Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS payroll_employee_deductions (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  kind_id     INTEGER NOT NULL REFERENCES payroll_deduction_kinds(id) ON DELETE RESTRICT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (employee_id, kind_id)
);

CREATE INDEX IF NOT EXISTS payroll_employee_deductions_kind_idx ON payroll_employee_deductions (kind_id);

COMMENT ON TABLE payroll_employee_deductions IS
  'Виды удержаний сотрудника («Зарплата → Расчёты», «Подробно → Удержание»). Строка — отмеченный вид.';

ALTER TABLE payroll_compensation_terms DROP CONSTRAINT IF EXISTS payroll_terms_deduction_pair;
COMMENT ON COLUMN payroll_compensation_terms.deduction_kind_id IS
  'Не используется с миграции 300 (виды — в payroll_employee_deductions); удалить отдельной миграцией.';

REVOKE ALL ON TABLE public.payroll_employee_deductions FROM PUBLIC;

COMMIT;
