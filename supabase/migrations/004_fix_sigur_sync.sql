-- Миграция 004: Исправление синхронизации Sigur + очистка избыточных сущностей
-- Дата: 2026-02-20

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
-- 8. Удалить таблицы org_subdivisions и org_companies
-- ============================================
DROP TABLE IF EXISTS public.org_subdivisions;
DROP TABLE IF EXISTS public.org_companies;

-- ============================================
-- Комментарии
-- ============================================
COMMENT ON COLUMN public.positions.sigur_position_id IS 'ID должности в Sigur для идемпотентной синхронизации';
COMMENT ON COLUMN public.employees.position_id IS 'Должность из справочника positions (FK)';
