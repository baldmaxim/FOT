-- 218_employee_sim_forwarding_edit.sql
-- Самообслуживание переадресации в ЛК «Моя SIM»: право edit на /employee/sim
-- = «сотрудник может сам включать/менять переадресацию своего номера».
-- В 217 страница заведена как view-only (supports_edit=false) — открываем edit
-- и выдаём его тем же офисным ролям, что уже видят страницу.
--
-- ПРИМЕНЯТЬ ДО деплоя бэкенда.

BEGIN;

UPDATE access_pages
   SET supports_edit = true,
       updated_at = NOW()
 WHERE key = '/employee/sim';

INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('office',  '/employee/sim', true, true),
  ('manager', '/employee/sim', true, true),
  ('admin',   '/employee/sim', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
    can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
