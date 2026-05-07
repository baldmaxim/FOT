-- 082_employee_direct_reports.sql
-- Прямые связи "руководитель ячейки → отдельный сотрудник".
-- Дополняет employee_department_access для случаев, когда подчинённого
-- нельзя выразить как "целый отдел" (например, рукстрой → один экономист
-- из общего отдела экономистов).
-- Эксклюзивно: один активный подчинённый имеет ровно одного активного начальника
-- (PARTIAL UNIQUE WHERE is_active = true).

CREATE TABLE IF NOT EXISTS public.employee_direct_reports (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subordinate_employee_id  BIGINT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  manager_employee_id      BIGINT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  assigned_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by              UUID NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  unassigned_at            TIMESTAMPTZ NULL,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  note                     TEXT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT no_self_report CHECK (subordinate_employee_id <> manager_employee_id)
);

-- Эксклюзивность: один активный подчинённый — один активный начальник.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_direct_reports_active_subordinate
  ON public.employee_direct_reports(subordinate_employee_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_direct_reports_manager_active
  ON public.employee_direct_reports(manager_employee_id)
  WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS idx_direct_reports_subordinate
  ON public.employee_direct_reports(subordinate_employee_id);
