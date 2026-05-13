-- 090_site_supervisor.sql
-- Явный флаг «начальник участка» на user_profiles + таблица прямого
-- назначения отдельных сотрудников начальнику участка.
--
-- До этой миграции «участок» был UI-концепцией: любой manager с записями
-- в employee_department_access (source <> 'sigur_sync') автоматически
-- считался начальником участка, а выгрузка табелей жёстко ограничивалась
-- бригадами (od.kind='brigade').
--
-- Теперь:
--   * is_site_supervisor — явный маркер (для UI и фильтрации).
--   * user_employee_access — назначения «начальник → отдельные сотрудники»
--     (для случая, когда сотрудник не привязан к бригаде/отделу).
--
-- Бригады и отделы продолжают жить в employee_department_access
-- (через user.employee_id → eda.employee_id). Просто на стороне
-- кода/UI снимается фильтр по kind='brigade'.

BEGIN;

-- ── 1. Флаг начальника участка ───────────────────────────────────────────────
ALTER TABLE public.user_profiles
  ADD COLUMN IF NOT EXISTS is_site_supervisor boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_user_profiles_is_site_supervisor
  ON public.user_profiles(is_site_supervisor)
  WHERE is_site_supervisor = true;

-- ── 2. Прямое назначение сотрудников начальнику участка ──────────────────────
CREATE TABLE IF NOT EXISTS public.user_employee_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  employee_id bigint NOT NULL REFERENCES public.employees(id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES app_auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_employee_access_unique UNIQUE (user_id, employee_id)
);

CREATE INDEX IF NOT EXISTS user_employee_access_user_active_idx
  ON public.user_employee_access(user_id)
  WHERE is_active = true;
CREATE INDEX IF NOT EXISTS user_employee_access_employee_active_idx
  ON public.user_employee_access(employee_id)
  WHERE is_active = true;

COMMIT;
