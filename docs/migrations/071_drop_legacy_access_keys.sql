-- 071_drop_legacy_access_keys.sql
--
-- Чистка раздела «Технические доступы» в управлении ролями.
--
-- 1) Удаляем мёртвые ключи /admin/payments и /employees/structure-manage:
--    под этими путями нет UI (только бэк-эндпоинты, которые теперь защищены
--    через requireAdmin / другие живые ключи).
-- 2) Переименовываем /timesheet/team-management → timesheet-team-management:
--    функционал живёт как модалка внутри /timesheet, а сам ключ-«путь» с
--    слэшами вводил в заблуждение (выглядел как несуществующий URL).
-- 3) На всякий случай повторяем DELETE из миграции 046 для /skud-travel и
--    /skud-monitor — на части БД миграция 046 могла быть пропущена.
--
-- Применяется вручную через psql на проде:
--   psql "$DATABASE_URL" -f docs/migrations/071_drop_legacy_access_keys.sql

BEGIN;

-- 1. Удаляем мёртвые ключи из каталога и из назначений ролям.
DELETE FROM role_page_access
WHERE page_path IN ('/admin/payments', '/employees/structure-manage');

DELETE FROM access_pages
WHERE key IN ('/admin/payments', '/employees/structure-manage');

-- 2. Переименование /timesheet/team-management → timesheet-team-management.
UPDATE access_pages
SET key = 'timesheet-team-management',
    updated_at = NOW()
WHERE key = '/timesheet/team-management';

UPDATE role_page_access
SET page_path = 'timesheet-team-management'
WHERE page_path = '/timesheet/team-management';

-- 3. Подстраховка: добиваем legacy /skud-travel и /skud-monitor (из миграции 046).
DELETE FROM role_page_access
WHERE page_path IN ('/skud-travel', '/skud-monitor');

DELETE FROM access_pages
WHERE key IN ('/skud-travel', '/skud-monitor');

COMMIT;
