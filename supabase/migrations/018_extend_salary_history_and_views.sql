-- Миграция: Расширение tender_salary_history и создание VIEW employees_current
-- Версия: 018
-- Дата: 2026-01-29
-- Описание: Добавляем поля аудита в историю зарплат и создаём сводный VIEW

-- ============================================
-- 1. Расширение таблицы tender_salary_history
-- ============================================
ALTER TABLE tender_salary_history
  ADD COLUMN IF NOT EXISTS change_reason TEXT,
  ADD COLUMN IF NOT EXISTS order_number TEXT,
  ADD COLUMN IF NOT EXISTS order_date DATE,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

-- Индексы для новых столбцов
CREATE INDEX IF NOT EXISTS idx_salary_history_employee ON tender_salary_history(employee_id);
CREATE INDEX IF NOT EXISTS idx_salary_history_date ON tender_salary_history(effective_date DESC);
CREATE INDEX IF NOT EXISTS idx_salary_history_created_by ON tender_salary_history(created_by);

-- Комментарии
COMMENT ON COLUMN tender_salary_history.change_reason IS 'Причина изменения зарплаты';
COMMENT ON COLUMN tender_salary_history.order_number IS 'Номер приказа об изменении';
COMMENT ON COLUMN tender_salary_history.order_date IS 'Дата приказа';
COMMENT ON COLUMN tender_salary_history.created_by IS 'Кто внёс изменение';

-- ============================================
-- 2. VIEW employees_current - текущее состояние сотрудника
-- ============================================
CREATE OR REPLACE VIEW employees_current AS
SELECT
  e.id,
  e.organization_id,
  e.full_name_encrypted,
  e.birth_date_encrypted,
  e.pension_number_encrypted,
  e.hire_date_encrypted,
  e.country_encrypted,
  e.patent_issue_date_encrypted,
  e.patent_expiry_date_encrypted,
  e.is_archived,
  e.archived_at,

  -- Основное назначение (из employee_assignments)
  a.id AS assignment_id,
  a.org_company_id,
  a.org_department_id,
  a.org_site_id,
  a.org_subdivision_id,
  a.position_id,
  a.effective_from AS assignment_from,
  a.assignment_type,

  -- Названия из справочников (для удобства)
  c.name_encrypted AS company_name,
  d.name_encrypted AS department_name,
  s.name_encrypted AS site_name,
  sub.name_encrypted AS subdivision_name,
  p.name_encrypted AS position_name,
  p.category AS position_category,

  -- Текущая зарплата (последняя запись)
  (
    SELECT salary_encrypted
    FROM tender_salary_history sh
    WHERE sh.employee_id = e.id
    ORDER BY sh.effective_date DESC
    LIMIT 1
  ) AS current_salary_encrypted,

  (
    SELECT effective_date
    FROM tender_salary_history sh
    WHERE sh.employee_id = e.id
    ORDER BY sh.effective_date DESC
    LIMIT 1
  ) AS salary_effective_date,

  -- Количество активных назначений (для множественных)
  (
    SELECT COUNT(*)
    FROM employee_assignments a2
    WHERE a2.employee_id = e.id AND a2.effective_to IS NULL
  ) AS active_assignments_count,

  -- Все текущие назначения (JSON для множественных)
  (
    SELECT json_agg(json_build_object(
      'id', a2.id,
      'company_id', a2.org_company_id,
      'department_id', a2.org_department_id,
      'site_id', a2.org_site_id,
      'subdivision_id', a2.org_subdivision_id,
      'position_id', a2.position_id,
      'is_primary', a2.is_primary,
      'type', a2.assignment_type,
      'from', a2.effective_from
    ))
    FROM employee_assignments a2
    WHERE a2.employee_id = e.id AND a2.effective_to IS NULL
  ) AS all_assignments,

  e.created_at,
  e.updated_at

FROM employees e
-- Основное назначение
LEFT JOIN employee_assignments a ON e.id = a.employee_id
  AND a.effective_to IS NULL
  AND a.is_primary = TRUE
-- Справочники
LEFT JOIN org_companies c ON a.org_company_id = c.id
LEFT JOIN org_departments d ON a.org_department_id = d.id
LEFT JOIN org_sites s ON a.org_site_id = s.id
LEFT JOIN org_subdivisions sub ON a.org_subdivision_id = sub.id
LEFT JOIN positions p ON a.position_id = p.id
WHERE e.is_archived = FALSE;

COMMENT ON VIEW employees_current IS 'Текущее состояние сотрудников с основным назначением и зарплатой';

-- ============================================
-- 3. VIEW employee_history - полная история изменений
-- ============================================
CREATE OR REPLACE VIEW employee_history AS
SELECT
  e.id AS employee_id,
  e.full_name_encrypted,

  -- История назначений
  'assignment' AS event_type,
  a.id::TEXT AS event_id,
  a.effective_from AS event_date,
  a.effective_to AS event_end_date,
  json_build_object(
    'company_id', a.org_company_id,
    'department_id', a.org_department_id,
    'site_id', a.org_site_id,
    'subdivision_id', a.org_subdivision_id,
    'position_id', a.position_id,
    'is_primary', a.is_primary,
    'type', a.assignment_type,
    'reason', a.change_reason,
    'order_number', a.order_number
  ) AS event_data,
  a.created_at,
  a.created_by

FROM employees e
JOIN employee_assignments a ON e.id = a.employee_id

UNION ALL

SELECT
  e.id AS employee_id,
  e.full_name_encrypted,

  -- История зарплат
  'salary' AS event_type,
  sh.id::TEXT AS event_id,
  sh.effective_date AS event_date,
  NULL::DATE AS event_end_date,
  json_build_object(
    'salary_encrypted', sh.salary_encrypted,
    'reason', sh.change_reason,
    'order_number', sh.order_number,
    'note', sh.note_encrypted
  ) AS event_data,
  sh.created_at,
  sh.created_by

FROM employees e
JOIN tender_salary_history sh ON e.id = sh.employee_id

ORDER BY employee_id, event_date DESC;

COMMENT ON VIEW employee_history IS 'Полная история изменений сотрудника (назначения + зарплаты)';

-- ============================================
-- 4. VIEW org_structure_tree - дерево организационной структуры
-- ============================================
CREATE OR REPLACE VIEW org_structure_tree AS
WITH structure AS (
  -- Компании
  SELECT
    c.id,
    c.organization_id,
    'company' AS unit_type,
    c.name_encrypted,
    c.description_encrypted,
    NULL::UUID AS parent_id,
    c.sort_order,
    c.is_active,
    (SELECT COUNT(*) FROM employees e
     JOIN employee_assignments ea ON e.id = ea.employee_id
     WHERE ea.org_company_id = c.id AND ea.effective_to IS NULL AND e.is_archived = FALSE
    ) AS employee_count
  FROM org_companies c

  UNION ALL

  -- Отделы
  SELECT
    d.id,
    d.organization_id,
    'department' AS unit_type,
    d.name_encrypted,
    d.description_encrypted,
    d.company_id AS parent_id,
    d.sort_order,
    d.is_active,
    (SELECT COUNT(*) FROM employees e
     JOIN employee_assignments ea ON e.id = ea.employee_id
     WHERE ea.org_department_id = d.id AND ea.effective_to IS NULL AND e.is_archived = FALSE
    ) AS employee_count
  FROM org_departments d

  UNION ALL

  -- Участки
  SELECT
    s.id,
    s.organization_id,
    'site' AS unit_type,
    s.name_encrypted,
    s.description_encrypted,
    COALESCE(s.department_id, s.company_id) AS parent_id,
    s.sort_order,
    s.is_active,
    (SELECT COUNT(*) FROM employees e
     JOIN employee_assignments ea ON e.id = ea.employee_id
     WHERE ea.org_site_id = s.id AND ea.effective_to IS NULL AND e.is_archived = FALSE
    ) AS employee_count
  FROM org_sites s

  UNION ALL

  -- Подразделения
  SELECT
    sub.id,
    sub.organization_id,
    'subdivision' AS unit_type,
    sub.name_encrypted,
    sub.description_encrypted,
    COALESCE(sub.site_id, sub.department_id) AS parent_id,
    sub.sort_order,
    sub.is_active,
    (SELECT COUNT(*) FROM employees e
     JOIN employee_assignments ea ON e.id = ea.employee_id
     WHERE ea.org_subdivision_id = sub.id AND ea.effective_to IS NULL AND e.is_archived = FALSE
    ) AS employee_count
  FROM org_subdivisions sub
)
SELECT * FROM structure
ORDER BY organization_id, unit_type, sort_order;

COMMENT ON VIEW org_structure_tree IS 'Плоское представление дерева организационной структуры';
