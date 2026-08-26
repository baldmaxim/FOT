-- 255_leave_dismissals_access_page.sql
-- Вкладка «Увольнения» в разделе «Заявления» (отдел кадров + админ).
--
-- Отдельный маркер доступа /leave-dismissals: тот же круг ролей, что и у
-- «Отпусков» (/leave-vacations, миграция 191), но право выдаётся независимо —
-- в админке ролей его можно давать/забирать отдельно. Колонки отметки
-- hr_acknowledged_at/by переиспользуются (191), тип 'dismissal' уже в CHECK (239).
--
-- group_code = 'overview': запись из БД переопределяет программный каталог
-- (access-control.service.ts), поэтому группа должна совпадать с
-- DEFAULT_ACCESS_PAGE_CATALOG («Обзор и заявления»), а не 'mine' как в 191.

BEGIN;

INSERT INTO access_pages (key, label, group_code, group_label, surface, supports_edit, sort_order, is_active, is_system)
VALUES ('/leave-dismissals', 'Заявления — Увольнения (отдел кадров)', 'overview', 'Обзор и заявления', 'page', true, 33, true, true)
ON CONFLICT (key) DO UPDATE
  SET label = EXCLUDED.label,
      group_code = EXCLUDED.group_code,
      group_label = EXCLUDED.group_label,
      surface = EXCLUDED.surface,
      supports_edit = EXCLUDED.supports_edit,
      sort_order = EXCLUDED.sort_order,
      is_active = EXCLUDED.is_active;

INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('admin', '/leave-dismissals', true, true),
  ('hr',    '/leave-dismissals', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE
  SET can_view = true,
      can_edit = true;

COMMIT;
