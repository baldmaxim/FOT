-- 135_drop_user_profiles_is_site_supervisor.sql
--
-- ПОСТ-ДЕПЛОЙ. Применять только после того, как боевой код перестал читать
-- колонку user_profiles.is_site_supervisor (миграция 133 уже перевела всех
-- пользователей с этой галкой на роль site_supervisor, дальнейшее поведение
-- триггерится через system_roles.code и блок флагов «Ограничения корректировок»).
--
-- Логику группировки и выгрузки по «участкам» теперь обеспечивает роль
-- site_supervisor — см. timesheet-approval.controller.ts и
-- timesheet-assigned-export.controller.ts.

BEGIN;

DROP INDEX IF EXISTS public.idx_user_profiles_is_site_supervisor;

ALTER TABLE public.user_profiles
  DROP COLUMN IF EXISTS is_site_supervisor;

NOTIFY pgrst, 'reload schema';

COMMIT;
