-- Индекс под единый замок закрытого табеля (timesheet-lock.service.ts).
--
-- Гард ищет подачи ПО СОТРУДНИКУ: `EXISTS (SELECT 1 FROM timesheet_approval_employees
-- WHERE approval_id = a.id AND employee_id = $1)`. PK таблицы — (approval_id, employee_id),
-- по ведущему employee_id он не работает. Существующий idx_tae_approval дублирует
-- префикс PK и здесь бесполезен.
--
-- CREATE INDEX CONCURRENTLY не работает внутри транзакции — файл намеренно БЕЗ BEGIN/COMMIT.
-- Запускать по одному выражению за раз.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tae_employee_approval
  ON timesheet_approval_employees (employee_id, approval_id);
