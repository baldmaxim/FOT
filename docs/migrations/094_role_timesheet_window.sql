-- Миграция 094: per-role окно доступных месяцев табеля.
--
-- Зачем: до этой миграции фронт жёстко ограничивал руководителя (scope=department)
-- двумя месяцами — предыдущим и текущим. Бэк уже разрешал [current-1..current+1],
-- но фронт сужал. Теперь окно настраивается на уровне роли: сколько месяцев назад
-- и сколько вперёд от текущего доступно. Применяется только когда роль не админ
-- (is_admin=false) — для админа ограничений нет. Дефолт 1/1 даёт окно
-- [previous, current, next] — это решает задачу «открыть следующий месяц»
-- сразу после применения миграции.

ALTER TABLE system_roles
  ADD COLUMN IF NOT EXISTS timesheet_months_back INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS timesheet_months_forward INTEGER NOT NULL DEFAULT 1;

ALTER TABLE system_roles
  DROP CONSTRAINT IF EXISTS system_roles_timesheet_months_back_chk,
  ADD CONSTRAINT system_roles_timesheet_months_back_chk
    CHECK (timesheet_months_back BETWEEN 0 AND 12);

ALTER TABLE system_roles
  DROP CONSTRAINT IF EXISTS system_roles_timesheet_months_forward_chk,
  ADD CONSTRAINT system_roles_timesheet_months_forward_chk
    CHECK (timesheet_months_forward BETWEEN 0 AND 12);

COMMENT ON COLUMN system_roles.timesheet_months_back IS
  'Сколько месяцев назад от текущего доступно для просмотра/редактирования табеля. Применяется только когда роль не админ (is_admin=false). Дефолт 1 = доступен предыдущий месяц.';

COMMENT ON COLUMN system_roles.timesheet_months_forward IS
  'Сколько месяцев вперёд от текущего доступно для просмотра/редактирования табеля. Применяется только когда роль не админ (is_admin=false). Дефолт 1 = доступен следующий месяц.';
