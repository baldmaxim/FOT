-- 086: удаление страницы /skud-raw из каталога access_pages.
-- Страница не используется (функционал перенесён на вкладку
-- «Ошибочные события» в /skud-settings). На фронте роут и компонент удалены.

BEGIN;

-- Снимаем права (если ещё есть) и удаляем запись из каталога.
DELETE FROM role_page_access WHERE page_path = '/skud-raw';
DELETE FROM access_pages WHERE key = '/skud-raw';

COMMIT;
