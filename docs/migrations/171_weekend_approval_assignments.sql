-- 171_weekend_approval_assignments.sql
-- Адресная маршрутизация согласований работы в выходной/праздник.
--
-- Ответственный (responsible_employee_id) согласует выходные дни для:
--   - конкретного сотрудника (target_employee_id), либо
--   - всех сотрудников отдела (target_department_id).
-- Ровно один таргет на строку (CHECK XOR). Назначать имеет смысл только внутри
-- whitelist-отделов (correction_approval_required_department_ids) — валидируется
-- на бэке, не в БД.
--
-- Эксклюзивно: один активный таргет (сотрудник/отдел) имеет ровно одного
-- активного ответственного (PARTIAL UNIQUE WHERE is_active = true). Смена
-- ответственного — мягкая деактивация старой строки + новая/реактивация.
--
-- Применяется вручную через psql на проде (авто-миграций нет). Идемпотентно.

BEGIN;

CREATE TABLE IF NOT EXISTS public.weekend_approval_assignments (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  responsible_employee_id  BIGINT NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  target_department_id     UUID NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  target_employee_id       BIGINT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  assigned_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by              UUID NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  unassigned_at            TIMESTAMPTZ NULL,
  deactivated_by           UUID NULL REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  note                     TEXT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT weekend_target_xor CHECK (
    (target_department_id IS NOT NULL) <> (target_employee_id IS NOT NULL)
  )
);

-- Эксклюзивность таргета: один активный сотрудник / отдел — один ответственный.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_weekend_target_employee
  ON public.weekend_approval_assignments(target_employee_id)
  WHERE is_active = TRUE AND target_employee_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_weekend_target_department
  ON public.weekend_approval_assignments(target_department_id)
  WHERE is_active = TRUE AND target_department_id IS NOT NULL;

-- Быстрый список «что согласует ответственный».
CREATE INDEX IF NOT EXISTS idx_weekend_by_responsible
  ON public.weekend_approval_assignments(responsible_employee_id)
  WHERE is_active = TRUE;

NOTIFY pgrst, 'reload schema';

COMMIT;
