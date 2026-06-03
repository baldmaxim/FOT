-- 167_employee_department_access_view_level.sql
--
-- Уровень доступа на назначении отдела руководителю: 'full' (по умолчанию —
-- видит И редактирует/согласует) либо 'view' (только просмотр на всех экранах,
-- но write/approve по сотрудникам отдела запрещены — 403).
--
-- Зачем: руководителю строительства (manager_obj) нужно ВИДЕТЬ чужие отделы
-- (напр. «Линия», «Линия-общестрой») для контроля, не получив права их править
-- и согласовывать, при этом сохранив редактирование своего объекта. Право edit
-- на /timesheet задаётся на уровне роли — отдельная read-only роль отняла бы
-- редактирование своего объекта, поэтому различаем уровень на самом назначении.
--
-- Видимость (resolveAccessibleDepartmentIds / 4 экрана) не зависит от уровня —
-- view-отделы видны как обычно. Гейты записи/согласования читают отдельный
-- «editable»-подскоуп (только access_level='full').
--
-- Все существующие строки получают 'full' → поведение не меняется.
-- Применяется вручную через psql на проде (авто-миграций нет). Идемпотентно.

BEGIN;

ALTER TABLE public.employee_department_access
  ADD COLUMN IF NOT EXISTS access_level text NOT NULL DEFAULT 'full'
    CHECK (access_level IN ('full', 'view'));

COMMENT ON COLUMN public.employee_department_access.access_level IS
  'full → руководитель видит и редактирует/согласует сотрудников отдела; view → только просмотр (write/approve запрещены). Дефолт full. Применяется только к ручным назначениям (source <> sigur_sync).';

NOTIFY pgrst, 'reload schema';

COMMIT;
