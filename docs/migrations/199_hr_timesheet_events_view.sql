-- Миграция 199: роль hr получает просмотр вкладки «События СКУД» в модалке дня Табеля.
-- Без этого гранта модалка дня для hr была бы пустой (hideSkudTab по /timesheet/events).
-- Право только на просмотр (can_edit=false) — как у manager/timekeeper.

BEGIN;

INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES ('hr', '/timesheet/events', true, false)
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = true, can_edit = false;

COMMIT;
