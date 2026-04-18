-- Удаляем legacy колонку system_role_id из role_page_access.
-- role_code (text) — теперь единственный ключ связи с system_roles. Все 87 строк имеют role_code.
-- Убираем также триггер/функцию, которая синхронизировала role_code ↔ system_role_id.

DROP TRIGGER IF EXISTS trg_sync_role_page_access_role_fields ON public.role_page_access;
DROP FUNCTION IF EXISTS public.sync_role_page_access_role_fields();

ALTER TABLE public.role_page_access
  DROP CONSTRAINT IF EXISTS role_page_access_system_role_id_fkey;

ALTER TABLE public.role_page_access
  DROP COLUMN IF EXISTS system_role_id;
