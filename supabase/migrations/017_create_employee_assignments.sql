-- Миграция: Создание таблицы employee_assignments
-- Версия: 017
-- Дата: 2026-01-29
-- Описание: Таблица назначений сотрудников с историей изменений

-- ============================================
-- 1. Таблица employee_assignments (история назначений)
-- ============================================
CREATE TABLE IF NOT EXISTS employee_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id INTEGER NOT NULL REFERENCES employees(id) ON DELETE CASCADE,

  -- Гибкие связи на все справочники (все nullable для гибкости)
  org_company_id UUID REFERENCES org_companies(id) ON DELETE SET NULL,
  org_department_id UUID REFERENCES org_departments(id) ON DELETE SET NULL,
  org_site_id UUID REFERENCES org_sites(id) ON DELETE SET NULL,
  org_subdivision_id UUID REFERENCES org_subdivisions(id) ON DELETE SET NULL,

  -- Должность из справочника
  position_id UUID REFERENCES positions(id) ON DELETE SET NULL,

  -- Период действия назначения
  effective_from DATE NOT NULL,
  effective_to DATE,              -- NULL = текущее активное назначение

  -- Тип назначения
  is_primary BOOLEAN DEFAULT TRUE,  -- Основное место работы
  assignment_type TEXT DEFAULT 'main' CHECK (assignment_type IN ('main', 'secondary', 'temp', 'part_time')),

  -- Аудит
  change_reason TEXT,             -- Причина изменения: "Перевод", "Повышение", "Реорганизация"
  order_number TEXT,              -- Номер приказа
  order_date DATE,                -- Дата приказа
  notes TEXT,                     -- Примечания

  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 2. Индексы для производительности
-- ============================================

-- Основные индексы
CREATE INDEX IF NOT EXISTS idx_assignments_employee ON employee_assignments(employee_id);
CREATE INDEX IF NOT EXISTS idx_assignments_company ON employee_assignments(org_company_id);
CREATE INDEX IF NOT EXISTS idx_assignments_department ON employee_assignments(org_department_id);
CREATE INDEX IF NOT EXISTS idx_assignments_site ON employee_assignments(org_site_id);
CREATE INDEX IF NOT EXISTS idx_assignments_subdivision ON employee_assignments(org_subdivision_id);
CREATE INDEX IF NOT EXISTS idx_assignments_position ON employee_assignments(position_id);

-- Индекс для текущих назначений (частый запрос)
CREATE INDEX IF NOT EXISTS idx_assignments_current
  ON employee_assignments(employee_id)
  WHERE effective_to IS NULL;

-- Индекс для основных назначений
CREATE INDEX IF NOT EXISTS idx_assignments_primary
  ON employee_assignments(employee_id)
  WHERE is_primary = TRUE AND effective_to IS NULL;

-- Индекс для поиска по периоду
CREATE INDEX IF NOT EXISTS idx_assignments_period
  ON employee_assignments(effective_from, effective_to);

-- Составной индекс для фильтрации по орг.структуре
CREATE INDEX IF NOT EXISTS idx_assignments_org_structure
  ON employee_assignments(org_company_id, org_department_id, org_site_id)
  WHERE effective_to IS NULL;

-- ============================================
-- 3. Комментарии
-- ============================================
COMMENT ON TABLE employee_assignments IS 'История назначений сотрудников (должность, отдел, участок)';
COMMENT ON COLUMN employee_assignments.employee_id IS 'Сотрудник';
COMMENT ON COLUMN employee_assignments.org_company_id IS 'Компания (nullable для гибкости)';
COMMENT ON COLUMN employee_assignments.org_department_id IS 'Отдел (nullable для гибкости)';
COMMENT ON COLUMN employee_assignments.org_site_id IS 'Строительный участок (nullable)';
COMMENT ON COLUMN employee_assignments.org_subdivision_id IS 'Подразделение (nullable)';
COMMENT ON COLUMN employee_assignments.position_id IS 'Должность из справочника';
COMMENT ON COLUMN employee_assignments.effective_from IS 'Дата начала назначения';
COMMENT ON COLUMN employee_assignments.effective_to IS 'Дата окончания (NULL = текущее)';
COMMENT ON COLUMN employee_assignments.is_primary IS 'Основное место работы';
COMMENT ON COLUMN employee_assignments.assignment_type IS 'Тип: main, secondary, temp, part_time';
COMMENT ON COLUMN employee_assignments.change_reason IS 'Причина изменения';
COMMENT ON COLUMN employee_assignments.order_number IS 'Номер приказа';

-- ============================================
-- 4. Триггер для обновления updated_at
-- ============================================
DROP TRIGGER IF EXISTS update_employee_assignments_updated_at ON employee_assignments;
CREATE TRIGGER update_employee_assignments_updated_at
  BEFORE UPDATE ON employee_assignments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================
-- 5. Примечание: автозакрытие НЕ используется
-- ============================================
-- Сотрудник может иметь несколько активных назначений одновременно.
-- Поле is_primary - информационное, не влияет на автозакрытие.
-- Закрытие назначений происходит вручную через API.

-- ============================================
-- 6. Миграция существующих данных из employees
-- ============================================
INSERT INTO employee_assignments (
  employee_id,
  org_company_id,
  org_department_id,
  org_subdivision_id,
  position_id,
  effective_from,
  is_primary,
  assignment_type,
  change_reason
)
SELECT
  e.id,
  e.org_company_id,
  e.org_department_id,
  e.org_subdivision_id,
  p.id,
  CURRENT_DATE,
  TRUE,
  'main',
  'Миграция из существующих данных'
FROM employees e
LEFT JOIN positions p ON p.organization_id = e.organization_id
  AND p.name_encrypted = e.position_encrypted
WHERE e.is_archived = FALSE
  AND NOT EXISTS (
    SELECT 1 FROM employee_assignments ea
    WHERE ea.employee_id = e.id
  )
ON CONFLICT DO NOTHING;

-- ============================================
-- 7. VIEW для списка текущих назначений сотрудника
-- ============================================
CREATE OR REPLACE VIEW employee_current_assignments AS
SELECT
  ea.id AS assignment_id,
  ea.employee_id,
  ea.org_company_id,
  ea.org_department_id,
  ea.org_site_id,
  ea.org_subdivision_id,
  ea.position_id,
  ea.effective_from,
  ea.is_primary,
  ea.assignment_type,
  c.name_encrypted AS company_name,
  d.name_encrypted AS department_name,
  s.name_encrypted AS site_name,
  sub.name_encrypted AS subdivision_name,
  p.name_encrypted AS position_name,
  p.category AS position_category
FROM employee_assignments ea
LEFT JOIN org_companies c ON ea.org_company_id = c.id
LEFT JOIN org_departments d ON ea.org_department_id = d.id
LEFT JOIN org_sites s ON ea.org_site_id = s.id
LEFT JOIN org_subdivisions sub ON ea.org_subdivision_id = sub.id
LEFT JOIN positions p ON ea.position_id = p.id
WHERE ea.effective_to IS NULL;

COMMENT ON VIEW employee_current_assignments IS 'Текущие активные назначения сотрудников';
