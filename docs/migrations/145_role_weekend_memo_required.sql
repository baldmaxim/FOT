-- 145_role_weekend_memo_required.sql
--
-- Настраиваемый флаг роли «Требовать служебку о работе в выходные».
-- Раньше функция была зашита по role_code='manager_obj'. Теперь поведение
-- проверяется по полю роли, а не по её коду — любая роль может получить
-- требование служебки независимо (см. блок corrections_* в миграции 132).
--
--   weekend_memo_required — true → подача табеля с работой в выходные/праздники
--   блокируется (WEEKEND_MEMO_REQUIRED), пока к timesheet_approval не прикреплён
--   файл-подтверждение; также открывает доступ к xlsx-шаблону служебки.
--
-- Дефолт выключен. Включаем для manager_obj (сохраняем прежнее поведение)
-- и site_supervisor (роль «Начальник участка», созданная 2026-05-28, на которую
-- перевели бывших manager_obj — для них кнопка «приложить файл» пропала).

BEGIN;

ALTER TABLE public.system_roles
  ADD COLUMN IF NOT EXISTS weekend_memo_required BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.system_roles.weekend_memo_required IS
  'true → подача табеля с работой в выходные требует прикреплённой служебки (файл-подтверждение); открывает доступ к xlsx-шаблону служебки.';

UPDATE public.system_roles
   SET weekend_memo_required = true
 WHERE code IN ('manager_obj', 'site_supervisor');

NOTIFY pgrst, 'reload schema';

COMMIT;
