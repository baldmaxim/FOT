-- 099_contractor_org_access.sql
-- Привязка пользователя-подрядчика к ОДНОЙ подрядной организации.
-- «Подрядная организация» = прямой ребёнок корневого синтетического узла
-- org_departments с name='подрядные организации' (создаётся в Sigur и
-- синхронизируется в org_departments). Зеркало 083_user_company_access.sql,
-- но UNIQUE(user_id) — одна организация на подрядчика.

BEGIN;

CREATE TABLE IF NOT EXISTS public.contractor_org_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  org_department_id uuid NOT NULL REFERENCES public.org_departments(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  CONSTRAINT contractor_org_access_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS contractor_org_access_user_idx
  ON public.contractor_org_access(user_id);
CREATE INDEX IF NOT EXISTS contractor_org_access_org_idx
  ON public.contractor_org_access(org_department_id);

-- Триггер: org_department_id обязан быть прямым ребёнком корневого
-- «подрядные организации» (зеркало user_company_access_validate_root).
CREATE OR REPLACE FUNCTION public.contractor_org_access_validate_root()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_root_id uuid;
  v_parent uuid;
BEGIN
  SELECT id INTO v_root_id
    FROM org_departments
   WHERE parent_id IS NULL AND name = 'подрядные организации'
   LIMIT 1;

  IF v_root_id IS NULL THEN
    RAISE EXCEPTION 'Root department "подрядные организации" not found';
  END IF;

  SELECT parent_id INTO v_parent
    FROM org_departments
   WHERE id = NEW.org_department_id;

  IF v_parent IS DISTINCT FROM v_root_id THEN
    RAISE EXCEPTION 'org_department_id must be a direct child of root "подрядные организации"';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contractor_org_access_validate_root_trg ON public.contractor_org_access;
CREATE TRIGGER contractor_org_access_validate_root_trg
  BEFORE INSERT OR UPDATE ON public.contractor_org_access
  FOR EACH ROW EXECUTE FUNCTION public.contractor_org_access_validate_root();

ALTER TABLE public.contractor_org_access ENABLE ROW LEVEL SECURITY;

-- RPC get_descendant_department_ids(uuid[]) переиспользуется из 083.

NOTIFY pgrst, 'reload schema';

COMMIT;
