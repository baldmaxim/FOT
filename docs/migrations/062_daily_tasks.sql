-- Миграция: Ежедневные задачи сотрудника
-- Дата: 2026-04-29

BEGIN;

-- 1. Таблица записей. Одна запись на сотрудника в день.
CREATE TABLE IF NOT EXISTS daily_tasks (
  id           BIGSERIAL PRIMARY KEY,
  employee_id  INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  task_date    DATE NOT NULL,
  content      TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, task_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_tasks_employee_date
  ON daily_tasks (employee_id, task_date DESC);

-- 2. Лог дедупликации напоминаний (одно напоминание на сотрудника в сутки).
CREATE TABLE IF NOT EXISTS daily_tasks_reminder_log (
  employee_id   INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  reminder_date DATE NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (employee_id, reminder_date)
);

-- 3. Регистрируем страницу в каталоге доступа.
INSERT INTO access_pages (
  key, label, group_code, group_label, surface,
  supports_edit, requires_data_scope, requires_employee_variant,
  sort_order, is_active, is_system
)
VALUES
  ('/employee/tasks', 'Мои задачи', 'employee', 'Личный кабинет', 'page',
    true, true, false, 75, true, true)
ON CONFLICT (key) DO UPDATE
SET label = EXCLUDED.label,
    group_code = EXCLUDED.group_code,
    group_label = EXCLUDED.group_label,
    surface = EXCLUDED.surface,
    supports_edit = EXCLUDED.supports_edit,
    requires_data_scope = EXCLUDED.requires_data_scope,
    sort_order = EXCLUDED.sort_order,
    is_active = EXCLUDED.is_active,
    is_system = EXCLUDED.is_system,
    updated_at = NOW();

-- 4. Сидируем доступ для офисных ролей и админов. worker (на объекте) не получает.
INSERT INTO role_page_access (role_code, page_path, can_view, can_edit)
VALUES
  ('office',  '/employee/tasks', true, true),
  ('manager', '/employee/tasks', true, true),
  ('admin',   '/employee/tasks', true, true)
ON CONFLICT (role_code, page_path) DO UPDATE
SET can_view = role_page_access.can_view OR EXCLUDED.can_view,
    can_edit = role_page_access.can_edit OR EXCLUDED.can_edit;

NOTIFY pgrst, 'reload schema';

COMMIT;
