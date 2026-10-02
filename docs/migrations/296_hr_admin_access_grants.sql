-- 296: Кадровый админ (hr_admin) — права, без которых перевод на роль ломает работу.
--
-- Проверено по аудиту прода на Андрусевич и Фетисовой (обе пока admin):
--
-- /admin/users/access (view+edit) — смена роли, назначение отделов и папок табельщиц.
--   Миграция 270 ключ у hr_admin удаляла; на проде он выдан вручную через «Роли», и без
--   него кадровый админ теряет эти действия. Закрепляем как осознанную смену политики:
--   чужие роли ограничены allowlist (HR_ASSIGNABLE_ROLE_CODES), привязка к компаниям,
--   «Зарплата» и учётки админов остаются только у системного администратора.
--
-- /admin/timesheet-transfers (view+edit) — чип «Переводы» в табеле и раздел «Переводы и
--   исключения»: бэкенд требует ключ И глобальный скоуп роли (all_departments_scope).
--
-- /skud-presence/all-objects (view) — «Сотрудники на объектах» по всем объектам. Без него
--   у роли без приписанных объектов экран пустой.
--
-- Только hr_admin. Применять ДО деплоя фронтенда (чип «Переводы» смотрит на ключ).
-- Повторный запуск безопасен.

BEGIN;

INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('hr_admin', '/admin/users/access',        true, true),
  ('hr_admin', '/admin/timesheet-transfers', true, true),
  ('hr_admin', '/skud-presence/all-objects', true, false)
ON CONFLICT (role_code, page_path) DO UPDATE SET
  can_view = EXCLUDED.can_view,
  can_edit = EXCLUDED.can_edit;

COMMIT;
