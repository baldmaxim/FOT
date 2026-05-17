-- 104: удаление страницы /skud-db из каталога access_pages.
-- Функционал перенесён на вкладку «База» в /skud-settings
-- (повтор паттерна миграции 086 для /skud-raw).
-- На фронте роут и компонент удалены; доступ к данным теперь под /skud-settings.
-- Гранты НЕ переносятся: запись просто удаляется, доступ остаётся у тех,
-- у кого есть /skud-settings (у admin/super_admin он есть).

BEGIN;

DELETE FROM role_page_access WHERE page_path = '/skud-db';
DELETE FROM access_pages WHERE key = '/skud-db';

COMMIT;
