-- Миграция 004: Исправление синхронизации Sigur + очистка избыточных сущностей
-- Дата: 2026-02-20

-- ============================================
-- 0. Удалить зависимые views (пересоздадим ниже)
-- ============================================
DROP VIEW IF EXISTS public.org_structure_tree;
DROP VIEW IF EXISTS public.employees_current;
DROP VIEW IF EXISTS public.employee_current_assignments;
DROP VIEW IF EXISTS public.employee_history;

-- ============================================
-- 1. Добавить sigur_position_id в positions
-- ============================================
ALTER TABLE public.positions ADD COLUMN IF NOT EXISTS sigur_position_id integer;
CREATE UNIQUE INDEX IF NOT EXISTS idx_positions_sigur_id
  ON public.positions(organization_id, sigur_position_id) WHERE sigur_position_id IS NOT NULL;

-- ============================================
-- 2. Добавить position_id FK в employees
-- ============================================
ALTER TABLE public.employees ADD COLUMN IF NOT EXISTS position_id uuid REFERENCES public.positions(id) ON DELETE SET NULL;

-- ============================================
-- 3. Убрать org_company_id и org_subdivision_id из employees
-- ============================================
ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_org_company_id_fkey;
ALTER TABLE public.employees DROP CONSTRAINT IF EXISTS employees_org_subdivision_id_fkey;
ALTER TABLE public.employees DROP COLUMN IF EXISTS org_company_id;
ALTER TABLE public.employees DROP COLUMN IF EXISTS org_subdivision_id;

-- ============================================
-- 4. Убрать position_encrypted (заменяется position_id FK)
-- ============================================
ALTER TABLE public.employees DROP COLUMN IF EXISTS position_encrypted;

-- ============================================
-- 5. Убрать company_id из org_departments
-- ============================================
ALTER TABLE public.org_departments DROP CONSTRAINT IF EXISTS org_departments_company_id_fkey;
ALTER TABLE public.org_departments DROP COLUMN IF EXISTS company_id;

-- ============================================
-- 6. Убрать FK из org_sites на org_companies
-- ============================================
ALTER TABLE public.org_sites DROP CONSTRAINT IF EXISTS org_sites_company_id_fkey;
ALTER TABLE public.org_sites DROP COLUMN IF EXISTS company_id;

-- ============================================
-- 7. Убрать org_company_id и org_subdivision_id из employee_assignments
-- ============================================
ALTER TABLE public.employee_assignments DROP CONSTRAINT IF EXISTS employee_assignments_org_company_id_fkey;
ALTER TABLE public.employee_assignments DROP COLUMN IF EXISTS org_company_id;
ALTER TABLE public.employee_assignments DROP CONSTRAINT IF EXISTS employee_assignments_org_subdivision_id_fkey;
ALTER TABLE public.employee_assignments DROP COLUMN IF EXISTS org_subdivision_id;

-- ============================================
-- 8. Удалить индексы на удалённые колонки
-- ============================================
DROP INDEX IF EXISTS public.idx_assignments_company;
DROP INDEX IF EXISTS public.idx_assignments_org_structure;
DROP INDEX IF EXISTS public.idx_assignments_subdivision;
DROP INDEX IF EXISTS public.idx_employees_company;
DROP INDEX IF EXISTS public.idx_employees_subdivision;
DROP INDEX IF EXISTS public.idx_org_companies_org;
DROP INDEX IF EXISTS public.idx_org_departments_company;
DROP INDEX IF EXISTS public.idx_org_sites_company;
DROP INDEX IF EXISTS public.idx_org_subdivisions_dept;
DROP INDEX IF EXISTS public.idx_org_subdivisions_org;
DROP INDEX IF EXISTS public.idx_org_subdivisions_site;

-- ============================================
-- 9. Удалить таблицы org_subdivisions и org_companies
-- ============================================
DROP TABLE IF EXISTS public.org_subdivisions;
DROP TABLE IF EXISTS public.org_companies;

-- ============================================
-- 10. Пересоздать views без company/subdivision
-- ============================================

-- View: employee_current_assignments (без company/subdivision)
CREATE OR REPLACE VIEW public.employee_current_assignments AS
 SELECT ea.id AS assignment_id,
    ea.employee_id,
    ea.org_department_id,
    ea.org_site_id,
    ea.position_id,
    ea.effective_from,
    ea.is_primary,
    ea.assignment_type,
    d.name_encrypted AS department_name,
    s.name_encrypted AS site_name,
    p.name_encrypted AS position_name,
    p.category AS position_category
   FROM (((employee_assignments ea
     LEFT JOIN org_departments d ON ((ea.org_department_id = d.id)))
     LEFT JOIN org_sites s ON ((ea.org_site_id = s.id)))
     LEFT JOIN positions p ON ((ea.position_id = p.id)))
  WHERE (ea.effective_to IS NULL);

-- View: employee_history (без company/subdivision)
CREATE OR REPLACE VIEW public.employee_history AS
 SELECT e.id AS employee_id,
    e.full_name_encrypted,
    'assignment'::text AS event_type,
    (a.id)::text AS event_id,
    a.effective_from AS event_date,
    a.effective_to AS event_end_date,
    json_build_object('department_id', a.org_department_id, 'site_id', a.org_site_id, 'position_id', a.position_id, 'is_primary', a.is_primary, 'type', a.assignment_type, 'reason', a.change_reason, 'order_number', a.order_number) AS event_data,
    a.created_at,
    a.created_by
   FROM (employees e
     JOIN employee_assignments a ON ((e.id = a.employee_id)))
UNION ALL
 SELECT e.id AS employee_id,
    e.full_name_encrypted,
    'salary'::text AS event_type,
    (sh.id)::text AS event_id,
    sh.effective_date AS event_date,
    NULL::date AS event_end_date,
    json_build_object('salary_encrypted', sh.salary_encrypted, 'reason', sh.change_reason, 'order_number', sh.order_number, 'note', sh.note_encrypted) AS event_data,
    sh.created_at,
    sh.created_by
   FROM (employees e
     JOIN tender_salary_history sh ON ((e.id = sh.employee_id)))
  ORDER BY 1, 5 DESC;

-- View: employees_current (без company/subdivision)
CREATE OR REPLACE VIEW public.employees_current AS
 SELECT e.id,
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
    a.id AS assignment_id,
    a.org_department_id,
    a.org_site_id,
    a.position_id,
    a.effective_from AS assignment_from,
    a.assignment_type,
    d.name_encrypted AS department_name,
    s.name_encrypted AS site_name,
    p.name_encrypted AS position_name,
    p.category AS position_category,
    ( SELECT sh.salary_encrypted
           FROM tender_salary_history sh
          WHERE (sh.employee_id = e.id)
          ORDER BY sh.effective_date DESC
         LIMIT 1) AS current_salary_encrypted,
    ( SELECT sh.effective_date
           FROM tender_salary_history sh
          WHERE (sh.employee_id = e.id)
          ORDER BY sh.effective_date DESC
         LIMIT 1) AS salary_effective_date,
    ( SELECT count(*) AS count
           FROM employee_assignments a2
          WHERE ((a2.employee_id = e.id) AND (a2.effective_to IS NULL))) AS active_assignments_count,
    ( SELECT json_agg(json_build_object('id', a2.id, 'department_id', a2.org_department_id, 'site_id', a2.org_site_id, 'position_id', a2.position_id, 'is_primary', a2.is_primary, 'type', a2.assignment_type, 'from', a2.effective_from)) AS json_agg
           FROM employee_assignments a2
          WHERE ((a2.employee_id = e.id) AND (a2.effective_to IS NULL))) AS all_assignments,
    e.created_at,
    e.updated_at
   FROM ((((employees e
     LEFT JOIN employee_assignments a ON (((e.id = a.employee_id) AND (a.effective_to IS NULL) AND (a.is_primary = true))))
     LEFT JOIN org_departments d ON ((a.org_department_id = d.id)))
     LEFT JOIN org_sites s ON ((a.org_site_id = s.id)))
     LEFT JOIN positions p ON ((a.position_id = p.id)))
  WHERE (e.is_archived = false);

-- View: org_structure_tree (только departments + sites)
CREATE OR REPLACE VIEW public.org_structure_tree AS
 WITH structure AS (
         SELECT d.id,
            d.organization_id,
            'department'::text AS unit_type,
            d.name_encrypted,
            d.description_encrypted,
            d.parent_id,
            d.sort_order,
            d.is_active,
            ( SELECT count(*) AS count
                   FROM (employees e
                     JOIN employee_assignments ea ON ((e.id = ea.employee_id)))
                  WHERE ((ea.org_department_id = d.id) AND (ea.effective_to IS NULL) AND (e.is_archived = false))) AS employee_count
           FROM org_departments d
        UNION ALL
         SELECT s.id,
            s.organization_id,
            'site'::text AS unit_type,
            s.name_encrypted,
            s.description_encrypted,
            s.department_id AS parent_id,
            s.sort_order,
            s.is_active,
            ( SELECT count(*) AS count
                   FROM (employees e
                     JOIN employee_assignments ea ON ((e.id = ea.employee_id)))
                  WHERE ((ea.org_site_id = s.id) AND (ea.effective_to IS NULL) AND (e.is_archived = false))) AS employee_count
           FROM org_sites s
        )
 SELECT id,
    organization_id,
    unit_type,
    name_encrypted,
    description_encrypted,
    parent_id,
    sort_order,
    is_active,
    employee_count
   FROM structure;

-- ============================================
-- Комментарии
-- ============================================
COMMENT ON COLUMN public.positions.sigur_position_id IS 'ID должности в Sigur для идемпотентной синхронизации';
COMMENT ON COLUMN public.employees.position_id IS 'Должность из справочника positions (FK)';
