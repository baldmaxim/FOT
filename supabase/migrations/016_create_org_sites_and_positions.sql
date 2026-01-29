-- Миграция: Создание org_sites, positions и system_roles
-- Версия: 016
-- Дата: 2026-01-29
-- Описание: Добавляем строительные участки, справочник должностей и таблицу системных ролей

-- ============================================
-- 1. Таблица org_sites (строительные участки)
-- ============================================
CREATE TABLE IF NOT EXISTS org_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Гибкие связи (все nullable для гибкой иерархии)
  company_id UUID REFERENCES org_companies(id) ON DELETE SET NULL,
  department_id UUID REFERENCES org_departments(id) ON DELETE SET NULL,

  name_encrypted TEXT NOT NULL,
  code TEXT,                       -- Внутренний код участка
  description_encrypted TEXT,
  address TEXT,                    -- Адрес объекта
  manager_id INTEGER REFERENCES employees(id) ON DELETE SET NULL,

  start_date DATE,
  planned_end_date DATE,
  status TEXT DEFAULT 'active' CHECK (status IN ('planning', 'active', 'completed', 'suspended')),

  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для org_sites
CREATE INDEX IF NOT EXISTS idx_org_sites_organization ON org_sites(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_sites_company ON org_sites(company_id);
CREATE INDEX IF NOT EXISTS idx_org_sites_department ON org_sites(department_id);
CREATE INDEX IF NOT EXISTS idx_org_sites_manager ON org_sites(manager_id);
CREATE INDEX IF NOT EXISTS idx_org_sites_status ON org_sites(status) WHERE is_active = TRUE;

-- Комментарии
COMMENT ON TABLE org_sites IS 'Строительные участки/объекты';
COMMENT ON COLUMN org_sites.company_id IS 'Компания (nullable для гибкой иерархии)';
COMMENT ON COLUMN org_sites.department_id IS 'Отдел (nullable для гибкой иерархии)';
COMMENT ON COLUMN org_sites.manager_id IS 'Начальник участка';
COMMENT ON COLUMN org_sites.status IS 'Статус: planning, active, completed, suspended';

-- ============================================
-- 2. Добавить связь с участком в org_subdivisions
-- ============================================
ALTER TABLE org_subdivisions
  ADD COLUMN IF NOT EXISTS site_id UUID REFERENCES org_sites(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_org_subdivisions_site ON org_subdivisions(site_id);

COMMENT ON COLUMN org_subdivisions.site_id IS 'Строительный участок (nullable для гибкой иерархии)';

-- ============================================
-- 3. Таблица positions (справочник должностей)
-- ============================================
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  name_encrypted TEXT NOT NULL,
  category TEXT CHECK (category IN ('worker', 'engineer', 'manager', 'admin', 'other')),
  grade INTEGER,                   -- Разряд/грейд

  is_active BOOLEAN DEFAULT TRUE,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для positions
CREATE INDEX IF NOT EXISTS idx_positions_organization ON positions(organization_id);
CREATE INDEX IF NOT EXISTS idx_positions_category ON positions(category);
CREATE INDEX IF NOT EXISTS idx_positions_active ON positions(organization_id) WHERE is_active = TRUE;

-- Комментарии
COMMENT ON TABLE positions IS 'Справочник должностей организации';
COMMENT ON COLUMN positions.category IS 'Категория: worker, engineer, manager, admin, other';
COMMENT ON COLUMN positions.grade IS 'Разряд или грейд должности';

-- ============================================
-- 4. Заполнить positions из уникальных должностей employees
-- ============================================
INSERT INTO positions (organization_id, name_encrypted)
SELECT DISTINCT organization_id, position_encrypted
FROM employees
WHERE position_encrypted IS NOT NULL
  AND position_encrypted != ''
ON CONFLICT DO NOTHING;

-- ============================================
-- 5. Таблица system_roles (системные роли для прав доступа)
-- ============================================
CREATE TABLE IF NOT EXISTS system_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  code TEXT UNIQUE NOT NULL,          -- 'worker', 'header', 'admin', 'super_admin'
  name TEXT NOT NULL,                 -- 'Сотрудник', 'Руководитель'
  description TEXT,
  permissions JSONB DEFAULT '[]',     -- Список разрешений
  level INTEGER DEFAULT 0,            -- Уровень доступа (для сортировки и иерархии)

  is_active BOOLEAN DEFAULT TRUE,
  is_system BOOLEAN DEFAULT FALSE,    -- Системная роль (нельзя удалить)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для system_roles
CREATE INDEX IF NOT EXISTS idx_system_roles_code ON system_roles(code);
CREATE INDEX IF NOT EXISTS idx_system_roles_level ON system_roles(level);

-- Комментарии
COMMENT ON TABLE system_roles IS 'Системные роли для управления правами доступа';
COMMENT ON COLUMN system_roles.code IS 'Уникальный код роли';
COMMENT ON COLUMN system_roles.permissions IS 'JSON массив разрешений';
COMMENT ON COLUMN system_roles.level IS 'Уровень доступа (чем выше, тем больше прав)';
COMMENT ON COLUMN system_roles.is_system IS 'Системная роль - нельзя удалить';

-- ============================================
-- 6. Миграция из ENUM в таблицу system_roles
-- ============================================
INSERT INTO system_roles (code, name, description, level, permissions, is_system) VALUES
  ('worker', 'Сотрудник', 'Базовый доступ - просмотр своего профиля', 1,
   '["view_own_profile", "view_own_salary", "view_own_timesheet"]'::jsonb, TRUE),
  ('header', 'Руководитель', 'Начальник участка/отдела - управление подчинёнными', 2,
   '["view_own_profile", "view_own_salary", "view_own_timesheet", "view_subordinates", "manage_timesheet", "view_site_employees"]'::jsonb, TRUE),
  ('admin', 'Администратор', 'Администратор организации - управление сотрудниками', 3,
   '["view_all_employees", "manage_employees", "manage_structure", "view_all_salaries", "manage_timesheet", "generate_reports"]'::jsonb, TRUE),
  ('super_admin', 'Супер-админ', 'Полный доступ ко всем функциям системы', 4,
   '["*"]'::jsonb, TRUE)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  level = EXCLUDED.level,
  permissions = EXCLUDED.permissions,
  is_system = EXCLUDED.is_system,
  updated_at = NOW();

-- ============================================
-- 7. Добавить FK system_role_id в user_profiles
-- ============================================
ALTER TABLE user_profiles
  ADD COLUMN IF NOT EXISTS system_role_id UUID REFERENCES system_roles(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_user_profiles_system_role ON user_profiles(system_role_id);

COMMENT ON COLUMN user_profiles.system_role_id IS 'Системная роль (заменяет position_type ENUM)';

-- ============================================
-- 8. Заполнить system_role_id из position_type ENUM
-- ============================================
UPDATE user_profiles up
SET system_role_id = sr.id
FROM system_roles sr
WHERE sr.code = up.position_type::TEXT
  AND up.system_role_id IS NULL;

-- ============================================
-- 9. Триггер для обновления updated_at
-- ============================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Триггеры для новых таблиц
DROP TRIGGER IF EXISTS update_org_sites_updated_at ON org_sites;
CREATE TRIGGER update_org_sites_updated_at
  BEFORE UPDATE ON org_sites
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_positions_updated_at ON positions;
CREATE TRIGGER update_positions_updated_at
  BEFORE UPDATE ON positions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_system_roles_updated_at ON system_roles;
CREATE TRIGGER update_system_roles_updated_at
  BEFORE UPDATE ON system_roles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
