-- 323: Остатки отпуска из 1С — начальная точка расчёта остатка в карточке «Зарплата → Отпуска».
--
-- Зачем. Дальше отпуска считаются в ФОТ: остаток на сегодня = остаток 1С на дату as_of_date
-- + 2,33 дн. за каждый месяц после − отгулено по табелю после (payroll-vacation.service.ts).
-- История до as_of_date берётся из 1С: табель ФОТ за прошлые периоды неполный.
-- Первая загрузка — «Расчёт компенсации сводный на 30.09.2026» (scripts/import-vacation-balances-1c-2026-09.sql).
--
-- days — календарные дни, до сотых, как в 1С; отрицательный остаток — отпуск авансом.
-- Новая выгрузка 1С — новые строки с новой датой: берётся последняя as_of_date не позже сегодня.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый бэкенд читает таблицу в каждой карточке «Отпуска».
-- Повторный запуск безопасен.

BEGIN;

CREATE TABLE IF NOT EXISTS payroll_vacation_balances (
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  as_of_date DATE NOT NULL,
  days NUMERIC(6,2) NOT NULL,
  source TEXT NOT NULL DEFAULT '1c' CHECK (source IN ('1c')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, as_of_date)
);

COMMENT ON TABLE payroll_vacation_balances IS
  'Остаток ежегодного отпуска из 1С на дату — начальная точка расчёта остатка в ФОТ.';
COMMENT ON COLUMN payroll_vacation_balances.as_of_date IS
  'Дата остатка включительно: начисление и отгулянные дни ФОТ считает со следующего дня.';
COMMENT ON COLUMN payroll_vacation_balances.days IS
  'Остаток в календарных днях на конец as_of_date; отрицательный — отпуск авансом.';

COMMIT;
