-- 360: Какие отпуска уже вычтены в остатке 1С — граница и точечный список заявлений.
--
-- Зачем. 1С вычитает отпуск целиком по дате приказа, а не по дням: в остатке на 31.10.2026 уже вычтены
-- ноябрьские отпуска с приказом в октябре (Сигаев 03–24.11), а отпуск, начатый в сентябре, вычтен ещё на 30.09.
-- ФОТ вычитает отпуск целиком в день начала (payroll-vacation.service.ts) и не должен вычесть учтённое 1С второй раз:
--  - vacations_through — граница: отпуска, начавшиеся по эту дату включительно, уже в остатке 1С. NULL = as_of_date.
--    Раньше as_of_date — только для отпуска, начатого в дату остатка, но 1С ещё не учтённого (Овакова 31.10 → 30.10);
--  - payroll_vacation_balance_counted_leaves — будущие заявления, которые 1С уже вычла в этом снимке. Точечно,
--    а не датой: иначе учтённый поздний отпуск скрыл бы поданное позже заявление на более ранний.
--
-- ПРИМЕНЯТЬ ДО ДЕПЛОЯ БЭКЕНДА: новый бэкенд читает колонку и таблицу в каждой карточке «Отпуска».
-- Повторный запуск безопасен.

BEGIN;

ALTER TABLE payroll_vacation_balances ADD COLUMN IF NOT EXISTS vacations_through DATE;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payroll_vacation_balances_vacations_through_check') THEN
    ALTER TABLE payroll_vacation_balances
      ADD CONSTRAINT payroll_vacation_balances_vacations_through_check
      CHECK (vacations_through IS NULL OR vacations_through <= as_of_date);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS payroll_vacation_balance_counted_leaves (
  employee_id INTEGER NOT NULL,
  as_of_date DATE NOT NULL,
  leave_request_id BIGINT NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (employee_id, as_of_date, leave_request_id),
  FOREIGN KEY (employee_id, as_of_date)
    REFERENCES payroll_vacation_balances (employee_id, as_of_date) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS payroll_vacation_balance_counted_leaves_leave_idx
  ON payroll_vacation_balance_counted_leaves (leave_request_id);

COMMENT ON COLUMN payroll_vacation_balances.as_of_date IS
  'Дата остатка 1С: начисление ФОТ — с 1-го числа следующего месяца; отпуска — после границы vacations_through '
  'и не из payroll_vacation_balance_counted_leaves.';
COMMENT ON COLUMN payroll_vacation_balances.days IS
  'Остаток 1С в календарных днях на конец as_of_date с вычетом всех отпусков, учтённых 1С (в т.ч. будущих по приказу); '
  'отрицательный — отпуск авансом.';
COMMENT ON COLUMN payroll_vacation_balances.vacations_through IS
  'Отпуска, начавшиеся по эту дату включительно, уже вычтены 1С. NULL = as_of_date.';
COMMENT ON TABLE payroll_vacation_balance_counted_leaves IS
  'Заявления на отпуск с началом после границы, которые 1С уже вычла в остатке этого снимка: ФОТ их не вычитает.';

COMMIT;
