-- 283_department_access_deputy_level.sql
--
-- Третий уровень назначения отдела: 'deputy' — «заместитель начальника отдела».
--
-- Зачем: человеку нужно вести табель отдела (корректировки, подача, заявления
-- «Корректировка табеля») и подавать заявки на поиск, НЕ становясь начальником
-- отдела. Начальник отдела в коде — это ровно access_level='full'
-- (departmentManagerConditionSql), поэтому 'deputy' автоматически не попадает
-- ни в маршруты согласований, ни в снимок руководителей для 1С.
--
-- Роль пользователя при этом не меняется: уровень живёт на назначении, а не на
-- роли (у пользователя роль одна, а начальником одного отдела и заместителем
-- другого один и тот же человек быть может).
--
-- Право на страницу /timesheet и /leave-requests такому назначению выдаёт
-- авто-грант в resolveEffectivePageAccess, а не матрица роли.
--
-- Применять ДО деплоя бэкенда. Идемпотентно, существующие строки не меняются.

BEGIN;

DO $$
DECLARE
  constraint_name text;
BEGIN
  -- Имя CHECK'а в 167 не задавалось явно — ищем его по таблице и колонке.
  SELECT c.conname INTO constraint_name
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public'
     AND t.relname = 'employee_department_access'
     AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) ILIKE '%access_level%'
   LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.employee_department_access DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE public.employee_department_access
  ADD CONSTRAINT employee_department_access_access_level_check
  CHECK (access_level IN ('full', 'view', 'deputy'));

COMMENT ON COLUMN public.employee_department_access.access_level IS
  'full → начальник отдела: видит, правит табель, согласует, уходит в 1С как руководитель; deputy → заместитель: правит и подаёт табель, решает заявления «Корректировка табеля», подаёт заявки на поиск, но НЕ согласует остальное и НЕ руководитель в 1С; view → только просмотр. Дефолт full. Применяется к ручным назначениям (source <> sigur_sync).';

NOTIFY pgrst, 'reload schema';

COMMIT;
