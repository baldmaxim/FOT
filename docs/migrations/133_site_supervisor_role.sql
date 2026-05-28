-- 133_site_supervisor_role.sql
--
-- Выводит «начальника участка» в полноценную роль site_supervisor (клон
-- manager_obj с включёнными ограничениями корректировок). Backfill:
-- пользователи с user_profiles.is_site_supervisor=true переключаются на
-- новую роль и им бамплен token_version (форс relogin, см. миграцию 095).
--
-- Старая колонка user_profiles.is_site_supervisor НЕ удаляется здесь —
-- удаление в миграции 135 (post-deploy), после того как код перестанет
-- её читать.
--
-- Идемпотентно: повторный запуск не дублирует строки.

BEGIN;

-- 1) Сама роль (клон manager_obj по структурным полям + включённые ограничения).
INSERT INTO public.system_roles (
  code, name, description,
  is_admin, employee_variant, show_actual_hours,
  hide_sidebar,
  timesheet_months_back, timesheet_months_forward, timesheet_show_full_period,
  corrections_anomalies_only,
  corrections_cap_by_schedule_norm,
  corrections_allow_zero_short_attendance,
  corrections_disable_bulk,
  max_corrections_per_month,
  is_active
)
SELECT
  'site_supervisor',
  'Начальник участка',
  'Начальник участка. Корректировки доступны только в дни-аномалии СКУД (orphan exit, открытый entry, ошибки СКУД, пропуск скана при рабочем дне), в пределах плановых часов дня. Дополнительно разрешено обнуление дней с явкой < 4 часов. Лимит корректировок аномалий — настраивается на роли.',
  is_admin, employee_variant, show_actual_hours,
  hide_sidebar,
  timesheet_months_back, timesheet_months_forward, timesheet_show_full_period,
  true,    -- corrections_anomalies_only
  true,    -- corrections_cap_by_schedule_norm
  true,    -- corrections_allow_zero_short_attendance
  true,    -- corrections_disable_bulk
  NULL,    -- max_corrections_per_month — админ задаёт в UI
  true
FROM public.system_roles
WHERE code = 'manager_obj'
ON CONFLICT (code) DO NOTHING;

-- 2) Копия page_access с manager_obj (только если у site_supervisor пусто).
INSERT INTO public.role_page_access (role_code, page_path, can_view, can_edit)
SELECT 'site_supervisor', page_path, can_view, can_edit
  FROM public.role_page_access
 WHERE role_code = 'manager_obj'
   AND NOT EXISTS (
     SELECT 1 FROM public.role_page_access WHERE role_code = 'site_supervisor'
   )
ON CONFLICT (role_code, page_path) DO NOTHING;

-- 3) Backfill: пользователи с is_site_supervisor=true → роль site_supervisor.
--    Bump token_version форсит relogin (N1.b session revocation).
UPDATE public.user_profiles
   SET system_role_id = (SELECT id FROM public.system_roles WHERE code = 'site_supervisor'),
       token_version  = token_version + 1,
       updated_at     = NOW()
 WHERE is_site_supervisor = true
   AND system_role_id <> (SELECT id FROM public.system_roles WHERE code = 'site_supervisor');

NOTIFY pgrst, 'reload schema';

COMMIT;
