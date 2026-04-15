-- Migration 025: access catalog tables and sparse role access profile updates

BEGIN;

CREATE TABLE IF NOT EXISTS access_pages (
  key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  group_code TEXT NOT NULL,
  group_label TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('page', 'technical')),
  supports_edit BOOLEAN NOT NULL DEFAULT TRUE,
  requires_data_scope BOOLEAN NOT NULL DEFAULT FALSE,
  requires_employee_variant BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_system BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_pages_group_sort
  ON access_pages (group_code, sort_order, key);

CREATE TABLE IF NOT EXISTS access_capability_catalog (
  group_code TEXT NOT NULL,
  option_code TEXT NOT NULL,
  group_label TEXT NOT NULL,
  group_description TEXT NOT NULL DEFAULT '',
  option_label TEXT NOT NULL,
  option_description TEXT NOT NULL DEFAULT '',
  exclusive BOOLEAN NOT NULL DEFAULT FALSE,
  group_sort_order INTEGER NOT NULL DEFAULT 0,
  option_sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_code, option_code)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_access_capability_catalog_option_code
  ON access_capability_catalog (option_code);

INSERT INTO access_pages (
  key,
  label,
  group_code,
  group_label,
  surface,
  supports_edit,
  requires_data_scope,
  requires_employee_variant,
  sort_order,
  is_active,
  is_system
)
VALUES
  ('/employee', 'Личный кабинет', 'employee', 'Личный кабинет', 'page', false, true, true, 10, true, true),
  ('/employee/requests', 'Мои заявления', 'employee', 'Личный кабинет', 'page', true, true, false, 20, true, true),
  ('/employee/payslips', 'Расчётные листки', 'employee', 'Личный кабинет', 'page', false, true, false, 30, true, true),
  ('/employee/payments', 'История выплат', 'employee', 'Личный кабинет', 'page', false, true, false, 40, true, true),
  ('/employee/documents', 'Мои документы', 'employee', 'Личный кабинет', 'page', true, true, false, 50, true, true),
  ('/employee/timesheet', 'Мой табель', 'employee', 'Личный кабинет', 'page', true, true, false, 60, true, true),
  ('/employee/history', 'Моя история', 'employee', 'Личный кабинет', 'page', false, true, false, 70, true, true),
  ('/employee/salary-raise', 'Повышение оклада', 'employee', 'Личный кабинет', 'page', true, true, false, 80, true, true),
  ('/dashboard', 'Дашборд', 'operations', 'Управление', 'page', false, true, false, 90, true, true),
  ('/timesheet', 'Табель', 'operations', 'Управление', 'page', true, true, false, 100, true, true),
  ('/timesheet-hr', 'Табели HR', 'operations', 'Управление', 'page', true, true, false, 110, true, true),
  ('/leave-requests', 'Заявления', 'operations', 'Управление', 'page', true, true, false, 120, true, true),
  ('/salary-raise-review', 'Проверка заявок на повышение', 'operations', 'Управление', 'page', true, true, false, 130, true, true),
  ('/discipline', 'Дисциплина', 'operations', 'Управление', 'page', false, true, false, 140, true, true),
  ('/employees', 'Сотрудники', 'operations', 'Управление', 'page', true, true, false, 150, true, true),
  ('/staff-control', 'Управление кадрами', 'operations', 'Управление', 'page', true, true, false, 160, true, true),
  ('/skud-travel', 'Передвижения', 'skud', 'СКУД', 'page', true, true, false, 170, true, true),
  ('/skud-raw', 'Просмотр СКУД', 'skud', 'СКУД', 'page', false, true, false, 180, true, true),
  ('/skud-db', 'СКУД (база)', 'skud', 'СКУД', 'page', false, true, false, 190, true, true),
  ('/skud-monitor', 'Монитор Sigur', 'skud', 'СКУД', 'page', false, true, false, 200, true, true),
  ('/skud-settings', 'Настройки СКУД', 'skud', 'СКУД', 'page', true, false, false, 210, true, true),
  ('/admin/users', 'Управление пользователями', 'admin', 'Администрирование', 'page', true, false, false, 220, true, true),
  ('/admin/audit', 'Аудит данных', 'admin', 'Администрирование', 'page', false, false, false, 230, true, true),
  ('/admin/roles', 'Управление ролями', 'admin', 'Администрирование', 'page', true, false, false, 240, true, true),
  ('/admin/settings', 'Системные настройки', 'admin', 'Администрирование', 'page', true, false, false, 250, true, true),
  ('/admin/schedules', 'Графики работы', 'admin', 'Администрирование', 'page', true, false, false, 260, true, true),
  ('/admin/payslips', 'Управление расчётными листками', 'admin', 'Администрирование', 'page', true, true, false, 270, true, true),
  ('/admin/payments', 'Управление выплатами', 'technical', 'Технические доступы', 'technical', true, true, false, 280, true, true)
ON CONFLICT (key) DO UPDATE
SET
  label = EXCLUDED.label,
  group_code = EXCLUDED.group_code,
  group_label = EXCLUDED.group_label,
  surface = EXCLUDED.surface,
  supports_edit = EXCLUDED.supports_edit,
  requires_data_scope = EXCLUDED.requires_data_scope,
  requires_employee_variant = EXCLUDED.requires_employee_variant,
  sort_order = EXCLUDED.sort_order,
  is_active = EXCLUDED.is_active,
  is_system = EXCLUDED.is_system,
  updated_at = NOW();

INSERT INTO access_capability_catalog (
  group_code,
  option_code,
  group_label,
  group_description,
  option_label,
  option_description,
  exclusive,
  group_sort_order,
  option_sort_order,
  is_active
)
VALUES
  (
    'portal.employee.variant',
    'portal.employee.variant.office',
    'Вариант кабинета /employee',
    'Определяет, какой личный кабинет открывать пользователю на маршруте /employee.',
    'Обычный кабинет',
    'Обычный личный кабинет для офисных сотрудников и остальных ролей.',
    true,
    10,
    10,
    true
  ),
  (
    'portal.employee.variant',
    'portal.employee.variant.object',
    'Вариант кабинета /employee',
    'Определяет, какой личный кабинет открывать пользователю на маршруте /employee.',
    'Кабинет рабочего',
    'Отдельный личный кабинет рабочего на объекте.',
    true,
    10,
    20,
    true
  ),
  (
    'data.scope',
    'data.scope.self',
    'Область данных',
    'Определяет, какие данные пользователя доступны внутри страниц.',
    'Только свои данные',
    'Пользователь видит только свои данные и свои документы.',
    true,
    20,
    10,
    true
  ),
  (
    'data.scope',
    'data.scope.department',
    'Область данных',
    'Определяет, какие данные пользователя доступны внутри страниц.',
    'Только свой отдел',
    'Пользователь видит данные своего отдела.',
    true,
    20,
    20,
    true
  ),
  (
    'data.scope',
    'data.scope.all',
    'Область данных',
    'Определяет, какие данные пользователя доступны внутри страниц.',
    'Все данные',
    'Пользователь видит данные всей организации.',
    true,
    20,
    30,
    true
  )
ON CONFLICT (group_code, option_code) DO UPDATE
SET
  group_label = EXCLUDED.group_label,
  group_description = EXCLUDED.group_description,
  option_label = EXCLUDED.option_label,
  option_description = EXCLUDED.option_description,
  exclusive = EXCLUDED.exclusive,
  group_sort_order = EXCLUDED.group_sort_order,
  option_sort_order = EXCLUDED.option_sort_order,
  is_active = EXCLUDED.is_active,
  updated_at = NOW();

DELETE FROM role_page_access
WHERE COALESCE(can_view, false) = false
  AND COALESCE(can_edit, false) = false;

CREATE OR REPLACE FUNCTION replace_role_access_profile(
  p_role_code TEXT,
  p_permissions JSONB DEFAULT '[]'::jsonb,
  p_page_access JSONB DEFAULT '[]'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_role_id UUID;
  v_permissions JSONB;
BEGIN
  SELECT id
  INTO v_role_id
  FROM system_roles
  WHERE code = p_role_code;

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'Role not found: %', p_role_code;
  END IF;

  v_permissions := CASE
    WHEN jsonb_typeof(COALESCE(p_permissions, '[]'::jsonb)) = 'array' THEN COALESCE(p_permissions, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  UPDATE system_roles
  SET
    permissions = v_permissions,
    updated_at = NOW()
  WHERE code = p_role_code;

  DELETE FROM role_page_access
  WHERE system_role_id = v_role_id
     OR role_code = p_role_code;

  INSERT INTO role_page_access (
    role_code,
    system_role_id,
    page_path,
    can_view,
    can_edit
  )
  SELECT
    p_role_code,
    v_role_id,
    prepared.page_key,
    prepared.can_view,
    prepared.can_edit
  FROM (
    SELECT
      entry->>'key' AS page_key,
      BOOL_OR(entry->>'mode' IN ('view', 'edit')) AS can_view,
      BOOL_OR(entry->>'mode' = 'edit') AS can_edit
    FROM jsonb_array_elements(COALESCE(p_page_access, '[]'::jsonb)) AS entry
    WHERE entry->>'key' IS NOT NULL
      AND entry->>'key' <> ''
      AND entry->>'mode' IN ('view', 'edit')
    GROUP BY entry->>'key'
  ) AS prepared;
END;
$$;

COMMIT;
