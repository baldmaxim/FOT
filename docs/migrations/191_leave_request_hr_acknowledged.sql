-- 191_leave_request_hr_acknowledged.sql
-- Вкладка «Отпуска» (отдел кадров) + отметка «Отдел кадров ознакомлен».
--
-- 1) Колонки отметки на leave_requests:
--      hr_acknowledged_at — момент ознакомления (NULL = ещё не ознакомлены);
--      hr_acknowledged_by — user_profiles.id сотрудника отдела кадров, нажавшего отметку.
--    Проставляется во вкладке «Отпуска». После отметки зелёная галочка
--    «Отдел кадров ознакомлен» видна сотруднику в ЛК и его руководителю.
--    Идемпотентно (COALESCE в контроллере фиксирует первую отметку).
--
-- 2) Выделенный маркер доступа /leave-vacations для вкладки «Отпуска».
--    Гейт строго «админ + отдел кадров»: /timesheet-hr на проде есть и у других
--    ролей/только у admin и над-экспонирует страницу «Табели HR», поэтому заводим
--    отдельный page-маркер и выдаём его ровно admin и hr.

BEGIN;

-- 1) Колонки отметки -----------------------------------------------------------
ALTER TABLE leave_requests
  ADD COLUMN IF NOT EXISTS hr_acknowledged_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS hr_acknowledged_by UUID NULL REFERENCES user_profiles(id);

-- 2) Маркер доступа /leave-vacations (каталог) --------------------------------
INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active, is_system)
VALUES ('/leave-vacations', 'Заявления — Отпуска (отдел кадров)', 'mine', 'Моё', 'page', true, 32, true, true)
ON CONFLICT (key) DO UPDATE
  SET label = EXCLUDED.label,
      group_code = EXCLUDED.group_code,
      group_label = EXCLUDED.group_label,
      surface = EXCLUDED.surface,
      supports_edit = EXCLUDED.supports_edit,
      sort_order = EXCLUDED.sort_order,
      is_active = EXCLUDED.is_active;

-- 2) Гранты ролям: только admin (полный) и hr (отдел кадров) -------------------
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('admin', '/leave-vacations', true, true),
  ('hr',    '/leave-vacations', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = true,
      can_edit = true;

COMMIT;
