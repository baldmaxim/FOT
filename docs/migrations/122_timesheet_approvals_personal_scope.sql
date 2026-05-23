-- 122_timesheet_approvals_personal_scope.sql
-- Персональная подача руководителя «по людям» (direct-reports-only):
--   department_id = NULL, manager_employee_id = NOT NULL
-- Полная подача отдела (как было):
--   department_id = NOT NULL, manager_employee_id = NULL
-- Снимок состава timesheet_approval_employees наполняется явным списком (см. snapshotApprovalEmployees).

BEGIN;

-- 1. Делаем department_id опциональным.
ALTER TABLE timesheet_approvals
  ALTER COLUMN department_id DROP NOT NULL;

-- 2. Новая колонка-маркер «персональной» подачи.
--    ON DELETE RESTRICT: сотрудники физически не удаляются (только архивация),
--    но если такое произойдёт — XOR-constraint иначе будет нарушен.
ALTER TABLE timesheet_approvals
  ADD COLUMN manager_employee_id BIGINT NULL
    REFERENCES employees(id) ON DELETE RESTRICT;

COMMENT ON COLUMN timesheet_approvals.manager_employee_id IS
  'NULL = полная подача отдела (department_id NOT NULL); '
  'NOT NULL = персональная подача руководителя «по людям» (department_id NULL).';

-- 3. Ровно одно из (department_id, manager_employee_id) должно быть NOT NULL.
ALTER TABLE timesheet_approvals
  ADD CONSTRAINT timesheet_approvals_scope_xor
  CHECK ((department_id IS NULL) <> (manager_employee_id IS NULL));

-- 4. Индекс под выборку «мои персональные подачи».
CREATE INDEX IF NOT EXISTS idx_timesheet_approvals_manager_range
  ON timesheet_approvals (manager_employee_id, start_date, end_date)
  WHERE manager_employee_id IS NOT NULL;

-- 5. Переписываем exclusion-constraint.
--    Старый timesheet_approvals_no_overlap покрывал только department_id WITH =,
--    что при NULL даёт UNKNOWN и не ловит пересечения персональных подач.
--    Делим на два partial-constraint: для отдельной и для персональной подач.
ALTER TABLE timesheet_approvals
  DROP CONSTRAINT IF EXISTS timesheet_approvals_no_overlap;

ALTER TABLE timesheet_approvals
  ADD CONSTRAINT timesheet_approvals_dept_no_overlap
  EXCLUDE USING gist (
    department_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('submitted', 'approved', 'returned') AND department_id IS NOT NULL);

ALTER TABLE timesheet_approvals
  ADD CONSTRAINT timesheet_approvals_personal_no_overlap
  EXCLUDE USING gist (
    manager_employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  ) WHERE (status IN ('submitted', 'approved', 'returned') AND manager_employee_id IS NOT NULL);

-- 6. Журнал событий: тоже разрешаем department_id NULL — для персональных
--    подач история сохраняется без отдела.
ALTER TABLE timesheet_approval_events
  ALTER COLUMN department_id DROP NOT NULL;

COMMIT;
