-- Снимок состава сотрудников на момент подачи табеля на согласование.
-- Нужен, чтобы HR видел ровно тех, кого подал руководитель, даже если
-- назначения отдела изменились после submit. full_name хранится исторически —
-- переименование или удаление сотрудника не ломает карточку согласования.

BEGIN;

CREATE TABLE IF NOT EXISTS timesheet_approval_employees (
  approval_id  BIGINT NOT NULL REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
  employee_id  BIGINT NOT NULL,
  full_name    TEXT   NOT NULL,
  PRIMARY KEY (approval_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_tae_approval ON timesheet_approval_employees(approval_id);

COMMIT;
