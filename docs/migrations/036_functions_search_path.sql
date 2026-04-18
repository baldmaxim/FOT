-- Закрепляем search_path у 11 функций, которые advisor флажит как function_search_path_mutable.
-- Без этого злоумышленник с правами на создание объектов в одной из схем в search_path мог бы
-- перехватить вызов функции через тень схемы.

ALTER FUNCTION public.sync_user_profile_role_fields() SET search_path = pg_catalog, public;
ALTER FUNCTION public.sync_role_page_access_role_fields() SET search_path = pg_catalog, public;
ALTER FUNCTION public.replace_role_access_profile(p_role_code text, p_permissions jsonb, p_page_access jsonb) SET search_path = pg_catalog, public;

ALTER FUNCTION public.ensure_no_overlapping_employee_assignments() SET search_path = pg_catalog, public;
ALTER FUNCTION public.ensure_no_overlapping_employee_schedule_assignments() SET search_path = pg_catalog, public;
ALTER FUNCTION public.ensure_no_overlapping_object_schedule_assignments() SET search_path = pg_catalog, public;
ALTER FUNCTION public.ensure_no_overlapping_category_schedules() SET search_path = pg_catalog, public;

ALTER FUNCTION public.try_acquire_sigur_runtime_lease(p_key text, p_owner text, p_ttl_seconds integer, p_meta jsonb) SET search_path = pg_catalog, public;
ALTER FUNCTION public.release_sigur_runtime_lease(p_key text, p_owner text) SET search_path = pg_catalog, public;
ALTER FUNCTION public.heartbeat_sigur_runtime_lease(p_key text, p_owner text, p_ttl_seconds integer, p_meta jsonb) SET search_path = pg_catalog, public;
ALTER FUNCTION public.merge_sigur_runtime_state(p_key text, p_checkpoint_at timestamp with time zone, p_meta jsonb, p_owner text) SET search_path = pg_catalog, public;
