-- Migration 046: удаление устаревших СКУД-страниц /skud-monitor и /skud-travel
--
-- Страница СКУД (/skud) больше не использует HubShell с вкладками.
-- /skud-monitor: содержимое перенесено в секцию "Подключение к Sigur"
--   настроек СКУД — кнопка "Копировать JSON" со счётчиком проблем.
-- /skud-travel: функциональность удалена (не использовалась в UI).
--
-- В отличие от миграции 045 (soft-disable), здесь выполняется полное удаление
-- записей каталога — роуты, компоненты и page_access удалены из кода.

BEGIN;

DELETE FROM access_pages
WHERE key IN ('/skud-monitor', '/skud-travel');

COMMIT;
