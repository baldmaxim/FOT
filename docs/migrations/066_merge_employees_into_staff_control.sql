-- 066_merge_employees_into_staff_control.sql
-- Сливаем legacy-ключ /employees с /staff-control. Фронт-страница /employees
-- удалена, остался только бэк-алиас в requireAnyPageAccess. Унифицируем
-- матрицу доступа на одном ключе.
--
-- Применяется вручную через psql на проде:
--   psql "$DATABASE_URL" -f docs/migrations/066_merge_employees_into_staff_control.sql

BEGIN;

-- 1. Поднять /staff-control до max-режима тех ролей, где он либо отсутствует,
--    либо имеет более слабый режим, чем /employees. BOOL_OR за счёт
--    primary key (role_code, page_path) сольёт обе записи в одну на роль.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
SELECT role_code, '/staff-control',
       BOOL_OR(can_view OR can_edit),
       BOOL_OR(can_edit)
FROM role_page_access
WHERE page_path IN ('/employees', '/staff-control')
GROUP BY role_code
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
      can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

-- 2. Удалить все записи legacy-ключа.
DELETE FROM role_page_access WHERE page_path = '/employees';

-- 3. Если /employees был засеян в access_pages — убрать.
DELETE FROM access_pages WHERE key = '/employees';

COMMIT;
